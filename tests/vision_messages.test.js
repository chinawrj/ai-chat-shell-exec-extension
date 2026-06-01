#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  cleanVisionTmuxOcrText,
  getVisionAvailability,
  handleVisionMessage,
  validateVisionAppName,
  validateVisionKey,
  validateVisionTextInput,
  stitchOcrPages,
  visionOcrOutputText,
  visionOcrRows,
  visionOcrStatusText,
  visionOcrText,
  visionTextIncludes
} = require("../server/shell_server.js");

function makeFakeHelper() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vision-helper-test-"));
  const helper = path.join(dir, "fake-helper.js");
  fs.writeFileSync(helper, `#!/usr/bin/env node
const args = process.argv.slice(2);
const command = args[0] || "";
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
};
const emit = (obj, code = 0) => {
  console.log(JSON.stringify(obj));
  process.exit(code);
};
if (process.env.FAKE_VISION_PERMISSION_DENIED === "1") {
  emit({ ok: false, errorCode: "accessibility-denied", error: "Accessibility permission is required." }, 1);
}
if (command === "list-windows") {
  const windows = [
    { windowId: 42, appName: "Terminal", title: "AI_VISION_TEST_TITLE", pid: 123, bounds: { x: 1, y: 2, width: 800, height: 600 } },
    { windowId: 43, appName: "Google Chrome", title: "VMware Horizon", pid: 456, bounds: { x: 20, y: 40, width: 1200, height: 800 } }
  ];
  const appName = valueAfter("--app");
  emit({ ok: true, windows: appName ? windows.filter((windowInfo) => windowInfo.appName === appName) : windows });
}
if (command === "capture") {
  const windowId = Number(valueAfter("--window-id"));
  const windowsById = {
    42: { windowId, appName: "Terminal", title: "AI_VISION_TEST_TITLE" },
    43: { windowId, appName: "Google Chrome", title: "VMware Horizon" }
  };
  if (!windowsById[windowId]) emit({ ok: false, errorCode: "invalid-window", error: "bad window" }, 1);
  emit({ ok: true, window: windowsById[windowId], image: { mimeType: "image/png", base64: Buffer.from("fake").toString("base64"), width: 10, height: 10 } });
}
if (command === "ocr") {
  emit({ ok: true, image: { width: 10, height: 10 }, results: [{ text: "READY_TERMINAL_OCR_123 AI_VISION_LOOP_OK", confidence: 0.99, bbox: { x: 0, y: 0, width: 10, height: 4 } }] });
}
if (command === "type") {
  emit({ ok: true, typedChars: valueAfter("--text").length, windowId: Number(valueAfter("--window-id")) });
}
if (command === "key") {
  emit({ ok: true, key: valueAfter("--key"), windowId: Number(valueAfter("--window-id")) });
}
if (command === "--help") {
  emit({ ok: true, usage: ["fake"] });
}
emit({ ok: false, errorCode: "unsupported-command", error: command }, 1);
`, "utf8");
  fs.chmodSync(helper, 0o755);
  return { dir, helper };
}

(async () => {
  const originalHelper = process.env.AI_CHAT_SHELL_VISION_HELPER;
  const originalDenied = process.env.FAKE_VISION_PERMISSION_DENIED;
  const fake = makeFakeHelper();

  try {
    process.env.AI_CHAT_SHELL_VISION_HELPER = fake.helper;
    delete process.env.FAKE_VISION_PERMISSION_DENIED;

    assert.equal(validateVisionTextInput("hello"), "hello");
    assert.equal(validateVisionAppName("Google Chrome"), "Google Chrome");
    assert.throws(() => validateVisionAppName("bad\napp"), /invalid/);
    assert.throws(() => validateVisionTextInput("x".repeat(513)), /too long/);
    assert.throws(() => validateVisionTextInput("line\nbreak"), /control characters/);
    assert.equal(validateVisionKey("Enter"), "enter");
    assert.equal(validateVisionKey("page-down"), "page-down");
    assert.equal(validateVisionKey("ctrl-c"), "ctrl-c");
    assert.throws(() => validateVisionKey("space"), /Unsupported/);
    assert.equal(stitchOcrPages(["alpha\nbeta\ngamma", "beta\ngamma\ndelta"]), "alpha\nbeta\ngamma\ndelta");
    assert.equal(
      stitchOcrPages([
        Array.from({ length: 59 }, (_, index) => `L${String(index + 1).padStart(3, "0")}`).join("\n"),
        Array.from({ length: 58 }, (_, index) => `L${String(index + 23).padStart(3, "0")}`).join("\n")
      ]).split("\n").length,
      80
    );
    assert.equal(
      cleanVisionTmuxOcrText([
        "Terminal title — tmux attach-session -t ai_vision",
        "AIVIS001",
        "[0/0]",
        "AIVIS002            [0/0]",
        "rjwang % tmux copy-mode \\\\; send-keys",
        "-X history-top",
        "[ai_vision0:AIVRDONEABCDEFGH0*",
        "AIVIS080"
      ].join("\n"), "AIVRDONEABCDEFGH"),
      "AIVIS001\nAIVIS002\nAIVIS080"
    );
    assert.equal(visionTextIncludes("AIVR DONE ABCDEFGH 7", "AIVRDONEABCDEFGH"), true);

    {
      const ocr = {
        ok: true,
        image: { width: 800, height: 600 },
        results: [
          { text: "[0] AIVRDONEABCDEFGH7", confidence: 0.96, bbox: { x: 20, y: 570, width: 220, height: 14 } },
          { text: "beta", confidence: 0.99, bbox: { x: 66, y: 34, width: 40, height: 12 } },
          { text: "second row", confidence: 0.99, bbox: { x: 10, y: 54, width: 90, height: 12 } },
          { text: "alpha", confidence: 0.99, bbox: { x: 10, y: 33, width: 50, height: 12 } }
        ]
      };
      assert.deepEqual(visionOcrRows(ocr).map((row) => row.text), [
        "alpha beta",
        "second row",
        "[0] AIVRDONEABCDEFGH7"
      ]);
      assert.equal(visionOcrText(ocr), "alpha beta\nsecond row\n[0] AIVRDONEABCDEFGH7");
      assert.equal(visionOcrOutputText(ocr), "alpha beta\nsecond row");
      assert.equal(visionOcrStatusText(ocr), "[0] AIVRDONEABCDEFGH7");
      assert.equal(visionTextIncludes(visionOcrStatusText(ocr), "AIVRDONEABCDEFGH"), true);
    }

    {
      const ocr = {
        ok: true,
        image: { width: 1716, height: 2168 },
        results: [
          { text: "tmux a", confidence: 0.9, bbox: { x: 230, y: 60, width: 100, height: 30 } },
          { text: "19:25:56 [23/23]", confidence: 0.9, bbox: { x: 1438, y: 0, width: 260, height: 40 } },
          { text: "GHOSTTYLINE001", confidence: 0.9, bbox: { x: 0, y: 44, width: 230, height: 28 } },
          { text: "[ai_vision0:AIVRDONEABCDEFGH0*", confidence: 0.9, bbox: { x: 0, y: 2110, width: 500, height: 35 } },
          { text: "\"MacBookPro.lan\" 19:57 01-Jun-26", confidence: 0.9, bbox: { x: 1100, y: 2110, width: 500, height: 35 } }
        ]
      };
      assert.equal(visionOcrOutputText(ocr), "GHOSTTYLINE001");
    }

    {
      const ocr = {
        ok: true,
        image: { width: 800, height: 600 },
        results: [
          { text: "typed command mentions AIVRDONEABCDEFGH0", confidence: 0.91, bbox: { x: 10, y: 32, width: 360, height: 12 } },
          { text: "[0] AIVRRUNABCDEFGH", confidence: 0.96, bbox: { x: 20, y: 570, width: 220, height: 14 } }
        ]
      };
      assert.equal(visionTextIncludes(visionOcrText(ocr), "AIVRDONEABCDEFGH"), true);
      assert.equal(visionTextIncludes(visionOcrStatusText(ocr), "AIVRDONEABCDEFGH"), false);
    }

    {
      const health = await handleVisionMessage({ type: "vision-health" });
      assert.equal(health.ok, true);
      assert.equal(health.available, true);
    }

    {
      const listed = await handleVisionMessage({ type: "vision-list-windows" });
      assert.equal(listed.ok, true);
      assert.equal(listed.windows[0].appName, "Terminal");
      assert.equal(listed.windows.some((windowInfo) => windowInfo.appName === "Google Chrome"), true);
    }

    {
      const listed = await handleVisionMessage({ type: "vision-list-windows", appName: "Google Chrome" });
      assert.equal(listed.ok, true);
      assert.equal(listed.windows.length, 1);
      assert.equal(listed.windows[0].appName, "Google Chrome");
    }

    {
      const captured = await handleVisionMessage({ type: "vision-capture", windowId: 42 });
      assert.equal(captured.ok, true);
      assert.equal(captured.window.appName, "Terminal");
      assert.equal(captured.image.mimeType, "image/png");
    }

    {
      const captured = await handleVisionMessage({ type: "vision-capture", windowId: 43 });
      assert.equal(captured.ok, true);
      assert.equal(captured.window.appName, "Google Chrome");
    }

    {
      const mismatch = await handleVisionMessage({ type: "vision-capture", windowId: 43, appName: "Terminal" });
      assert.equal(mismatch.ok, false);
      assert.equal(mismatch.errorCode, "unexpected-window-app");
    }

    {
      const mismatch = await handleVisionMessage({
        type: "vision-tmux-ocr-run-line",
        windowId: 43,
        appName: "Terminal",
        cmd: "echo ok"
      });
      assert.equal(mismatch.ok, false);
      assert.equal(mismatch.errorCode, "unexpected-window-app");
    }

    {
      const invalidWindow = await handleVisionMessage({ type: "vision-capture", windowId: 99 });
      assert.equal(invalidWindow.ok, false);
      assert.equal(invalidWindow.errorCode, "invalid-window");
    }

    {
      const ocr = await handleVisionMessage({ type: "vision-ocr", imageBase64: Buffer.from("fake").toString("base64") });
      assert.equal(ocr.ok, true);
      assert.equal(ocr.results[0].text.includes("AI_VISION_LOOP_OK"), true);
    }

    {
      const typed = await handleVisionMessage({ type: "vision-type", windowId: 42, text: "echo ok" });
      assert.equal(typed.ok, true);
      assert.equal(typed.typedChars, 7);
    }

    {
      const key = await handleVisionMessage({ type: "vision-key", windowId: 42, key: "enter" });
      assert.equal(key.ok, true);
      assert.equal(key.key, "enter");
    }

    {
      const tooLong = await handleVisionMessage({ type: "vision-type", windowId: 42, text: "x".repeat(513) });
      assert.equal(tooLong.ok, false);
      assert.equal(tooLong.errorCode, "input-too-long");
    }

    {
      const unsafe = await handleVisionMessage({ type: "vision-type", windowId: 42, text: "echo ok\n" });
      assert.equal(unsafe.ok, false);
      assert.equal(unsafe.errorCode, "unsafe-control-char");
    }

    {
      const invalidKey = await handleVisionMessage({ type: "vision-key", windowId: 42, key: "space" });
      assert.equal(invalidKey.ok, false);
      assert.equal(invalidKey.errorCode, "invalid-key");
    }

    {
      process.env.FAKE_VISION_PERMISSION_DENIED = "1";
      const denied = await handleVisionMessage({ type: "vision-key", windowId: 42, key: "enter" });
      assert.equal(denied.ok, false);
      assert.equal(denied.errorCode, "accessibility-denied");
      delete process.env.FAKE_VISION_PERMISSION_DENIED;
    }

    {
      process.env.AI_CHAT_SHELL_VISION_HELPER = path.join(fake.dir, "missing-helper");
      const missing = await handleVisionMessage({ type: "vision-list-windows" });
      assert.equal(missing.ok, false);
      assert.equal(missing.errorCode, "helper-missing");
      assert.equal(getVisionAvailability().available, false);
    }

    if (process.platform !== "darwin") {
      delete process.env.AI_CHAT_SHELL_VISION_HELPER;
      const health = await handleVisionMessage({ type: "vision-health" });
      assert.equal(health.ok, true);
      assert.equal(health.available, false);
      assert.equal(health.errorCode, "non-macos");
    }
  } finally {
    if (originalHelper === undefined) {
      delete process.env.AI_CHAT_SHELL_VISION_HELPER;
    } else {
      process.env.AI_CHAT_SHELL_VISION_HELPER = originalHelper;
    }
    if (originalDenied === undefined) {
      delete process.env.FAKE_VISION_PERMISSION_DENIED;
    } else {
      process.env.FAKE_VISION_PERMISSION_DENIED = originalDenied;
    }
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }

  console.log("vision message tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
