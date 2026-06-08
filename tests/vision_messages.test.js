#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildTmuxVisualOcrRunLine,
  cleanVisionTmuxOcrText,
  getVisionAvailability,
  handleVisionMessage,
  parseVisionDoneFromText,
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
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const command = args[0] || "";
const statePath = path.join(__dirname, "state.json");
const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { typed: "", page: 0, copyMode: false, donePrefix: "", startMarker: "", exitCode: 0, failPage: false, omitStart: false };
  }
};
const writeState = (state) => fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
};
const emit = (obj, code = 0) => {
  console.log(JSON.stringify(obj));
  process.exit(code);
};
const ocrRows = (lines, status) => {
  const results = [];
  lines.forEach((line, index) => {
    results.push({ text: line, confidence: 0.98, bbox: { x: 10, y: 32 + index * 18, width: Math.max(80, line.length * 8), height: 12 } });
  });
  if (status) {
    results.push({ text: status, confidence: 0.98, bbox: { x: 20, y: 570, width: Math.max(220, status.length * 8), height: 14 } });
  }
  return { ok: true, image: { width: 800, height: 600 }, results };
};
if (process.env.FAKE_VISION_PERMISSION_DENIED === "1") {
  emit({ ok: false, errorCode: "accessibility-denied", error: "Accessibility permission is required." }, 1);
}
if (command === "list-windows") {
  const windows = [
    { windowId: 42, appName: "Terminal", title: "AI_VISION_TEST_TITLE", pid: 123, bounds: { x: 1, y: 2, width: 800, height: 600 } },
    { windowId: 44, appName: "Ghostty", title: "ForAI host", pid: 789, bounds: { x: 10, y: 20, width: 900, height: 700 } },
    { windowId: 43, appName: "Google Chrome", title: "VMware Horizon", pid: 456, bounds: { x: 20, y: 40, width: 1200, height: 800 } }
  ];
  const appName = valueAfter("--app");
  emit({ ok: true, windows: appName ? windows.filter((windowInfo) => windowInfo.appName === appName) : windows });
}
if (command === "capture") {
  const windowId = Number(valueAfter("--window-id"));
  const windowsById = {
    42: { windowId, appName: "Terminal", title: "AI_VISION_TEST_TITLE" },
    44: { windowId, appName: "Ghostty", title: "ForAI host" },
    43: { windowId, appName: "Google Chrome", title: "VMware Horizon" }
  };
  if (!windowsById[windowId]) emit({ ok: false, errorCode: "invalid-window", error: "bad window" }, 1);
  emit({ ok: true, window: windowsById[windowId], image: { mimeType: "image/png", base64: Buffer.from("fake").toString("base64"), width: 10, height: 10 } });
}
if (command === "ocr") {
  const state = readState();
  if (state.donePrefix && !state.copyMode) {
    emit(ocrRows(["RUN_OUTPUT_WAIT_SCREEN"], "[0] " + state.donePrefix + state.exitCode));
  }
  if (state.copyMode) {
    if (state.failPage) {
      emit({ ok: false, errorCode: "fake-ocr-page-failed", error: "fake OCR page failed" }, 1);
    }
    if (state.repeatPage) {
      const pages = [
        [...(state.omitStart ? [] : [state.startMarker]), "REPEAT001", "REPEAT002"],
        ["REPEAT001", "REPEAT002"],
        ["REPEAT001", "REPEAT002"],
        ["REPEAT001", "REPEAT002"]
      ];
      emit(ocrRows(pages[Math.min(state.page, pages.length - 1)], "[pos 9] " + state.donePrefix + state.exitCode));
    } else if (state.statusSuffix) {
      const pages = [
        [...(state.omitStart ? [] : [state.startMarker]), "REAL OUTPUT [1/2]", "KEPT"],
        ["REAL OUTPUT [1/2]", "KEPT"],
        ["REAL OUTPUT [1/2]", "KEPT"]
      ];
      emit(ocrRows(pages[Math.min(state.page, pages.length - 1)], "[0/0] " + state.donePrefix + state.exitCode));
    } else {
      const pages = [
        [...(state.omitStart ? [] : [state.startMarker]), "AIVIS001", "AIVIS002", "AIVIS003"],
        ["AIVIS002", "AIVIS003", "AIVIS004"],
        ["AIVIS002", "AIVIS003", "AIVIS004"]
      ];
      emit(ocrRows(pages[Math.min(state.page, pages.length - 1)], "[0/0] " + state.donePrefix + state.exitCode));
    }
  }
  emit({ ok: true, image: { width: 10, height: 10 }, results: [{ text: "READY_TERMINAL_OCR_123 AI_VISION_LOOP_OK", confidence: 0.99, bbox: { x: 0, y: 0, width: 10, height: 4 } }] });
}
if (command === "type") {
  const text = valueAfter("--text");
  const state = readState();
  state.typed = (state.typed || "") + text;
  const fullText = state.typed;
  if (text.includes("tmux copy-mode")) {
    state.copyMode = true;
    state.page = 0;
  }
  const startMatch = fullText.match(/AIVRSTART[A-Z]+/);
  if (startMatch) {
    state.startMarker = startMatch[0];
  }
  const doneMatch = fullText.match(/tmux rename-window "([A-Z0-9_]+)\\$\\{__AI_VISION_EXIT_CODE\\}"/);
  if (doneMatch) {
    state.donePrefix = doneMatch[1];
    state.exitCode = fullText.includes("exit 7") ? 7 : 0;
    state.failPage = fullText.includes("FAIL_OCR_PAGE");
    state.omitStart = fullText.includes("NO_START_MARKER");
    state.repeatPage = fullText.includes("REPEAT_PAGE");
    state.statusSuffix = fullText.includes("STATUS_SUFFIX");
    state.copyMode = false;
    state.page = 0;
    state.typed = "";
  }
  writeState(state);
  emit({ ok: true, typedChars: text.length, windowId: Number(valueAfter("--window-id")) });
}
if (command === "key") {
  const key = valueAfter("--key");
  const state = readState();
  if (key === "page-down") {
    state.page = (state.page || 0) + 1;
  }
  if (key === "escape") {
    state.copyMode = false;
  }
  writeState(state);
  emit({ ok: true, key, windowId: Number(valueAfter("--window-id")) });
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
  const originalLowLevelVision = process.env.AI_CHAT_SHELL_ENABLE_LOW_LEVEL_VISION;
  const fake = makeFakeHelper();

  try {
    process.env.AI_CHAT_SHELL_VISION_HELPER = fake.helper;
    delete process.env.FAKE_VISION_PERMISSION_DENIED;
    delete process.env.AI_CHAT_SHELL_ENABLE_LOW_LEVEL_VISION;

    assert.equal(validateVisionTextInput("hello"), "hello");
    assert.equal(validateVisionAppName("Google Chrome"), "Google Chrome");
    assert.throws(() => validateVisionAppName("bad\napp"), /invalid/);
    assert.throws(() => validateVisionTextInput("x".repeat(513)), /too long/);
    assert.throws(() => validateVisionTextInput("line\nbreak"), /control characters/);
    assert.equal(validateVisionKey("Enter"), "enter");
    assert.equal(validateVisionKey("page-down"), "page-down");
    assert.equal(validateVisionKey("ctrl-c"), "ctrl-c");
    assert.throws(() => validateVisionKey("space"), /Unsupported/);
    const visualOcrLine = buildTmuxVisualOcrRunLine({
      cmd: "printf ok",
      runWindowName: "AIVRRUNABCDEFGH",
      donePrefix: "AIVRDONEABCDEFGH"
    });
    assert.equal(visualOcrLine.includes("tmux rename-window 'AIVRRUNABCDEFGH' && tmux set-option -w history-limit 200000 && clear && tmux clear-history && printf '\\n' && /bin/sh -c 'printf ok';"), true);
    const visualOcrStartLine = buildTmuxVisualOcrRunLine({
      cmd: "printf ok",
      runWindowName: "AIVRRUNSTART",
      donePrefix: "AIVRDONESTART",
      startMarker: "AIVRSTARTABCDEFGH",
      historyLimit: 200000
    });
    assert.equal(visualOcrStartLine.includes("printf '%s\\n' 'AIVRSTARTABCDEFGH' && /bin/sh -c 'printf ok';"), true);
    const visualOcrCommentLine = buildTmuxVisualOcrRunLine({
      cmd: "printf before # comment",
      runWindowName: "AIVRRUNCOMMENT",
      donePrefix: "AIVRDONECOMMENT"
    });
    assert.equal(visualOcrCommentLine.includes("/bin/sh -c 'printf before # comment'; __AI_VISION_EXIT_CODE=$?;"), true);
    assert.equal(parseVisionDoneFromText("AIVR DONE ABCDEFGH 7", "AIVRDONEABCDEFGH").exitCode, 7);
    const missingDoneStatus = parseVisionDoneFromText("AIVR DONE ABCDEFGH", "AIVRDONEABCDEFGH");
    assert.equal(missingDoneStatus.exitCode, 124);
    assert.equal(missingDoneStatus.exitCodeKnown, false);
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
      const blocked = await handleVisionMessage({ type: "vision-list-windows" });
      assert.equal(blocked.ok, false);
      assert.equal(blocked.errorCode, "low-level-vision-disabled");
    }

    {
      const blockedOcr = await handleVisionMessage({ type: "vision-ocr", imageBase64: Buffer.from("fake").toString("base64") });
      assert.equal(blockedOcr.ok, false);
      assert.equal(blockedOcr.errorCode, "low-level-vision-disabled");
    }

    {
      const blockedSelfTest = await handleVisionMessage({ type: "vision-terminal-self-test", windowId: 42 });
      assert.equal(blockedSelfTest.ok, false);
      assert.equal(blockedSelfTest.errorCode, "low-level-vision-disabled");
    }

    process.env.AI_CHAT_SHELL_ENABLE_LOW_LEVEL_VISION = "1";

    {
      const listed = await handleVisionMessage({ type: "vision-list-windows" });
      assert.equal(listed.ok, true);
      assert.equal(listed.windows[0].appName, "Terminal");
      assert.equal(listed.windows.some((windowInfo) => windowInfo.appName === "Google Chrome"), true);
    }

    {
      const surfaces = await handleVisionMessage({ type: "vision-list-tmux-windows" });
      assert.equal(surfaces.ok, true);
      assert.deepEqual(surfaces.supportedApps, ["Terminal", "Ghostty"]);
      assert.equal(surfaces.count, 2);
      assert.deepEqual(surfaces.windows.map((windowInfo) => windowInfo.appName), ["Terminal", "Ghostty"]);
      assert.equal(surfaces.windows.every((windowInfo) => windowInfo.visualAdapter === "tmux-ocr"), true);
      assert.equal(surfaces.windows.every((windowInfo) => windowInfo.supportedApp === true), true);
      assert.equal(surfaces.windows.every((windowInfo) => windowInfo.tmuxVerified === false), true);
      assert.equal(surfaces.windows.some((windowInfo) => windowInfo.appName === "Google Chrome"), false);
    }

    {
      const surfaces = await handleVisionMessage({ type: "vision-list-visual-surfaces", appName: "Ghostty" });
      assert.equal(surfaces.ok, true);
      assert.equal(surfaces.count, 1);
      assert.equal(surfaces.windows[0].appName, "Ghostty");
    }

    {
      const unsupported = await handleVisionMessage({ type: "vision-list-tmux-windows", appName: "Google Chrome" });
      assert.equal(unsupported.ok, false);
      assert.equal(unsupported.errorCode, "unsupported-visual-app");
      assert.deepEqual(unsupported.supportedApps, ["Terminal", "Ghostty"]);
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
      const unsupported = await handleVisionMessage({
        type: "vision-tmux-ocr-run-line",
        windowId: 43,
        appName: "Google Chrome",
        cmd: "echo ok"
      });
      assert.equal(unsupported.ok, false);
      assert.equal(unsupported.errorCode, "unsupported-visual-app");
    }

    {
      const omittedApp = await handleVisionMessage({
        type: "vision-tmux-ocr-run-line",
        windowId: 43,
        cmd: "echo ok"
      });
      assert.equal(omittedApp.ok, false);
      assert.equal(omittedApp.errorCode, "unsupported-visual-app");
    }

    {
      const invalidWindow = await handleVisionMessage({ type: "vision-capture", windowId: 99 });
      assert.equal(invalidWindow.ok, false);
      assert.equal(invalidWindow.errorCode, "invalid-window");
    }

    {
      delete process.env.AI_CHAT_SHELL_ENABLE_LOW_LEVEL_VISION;
      const success = await handleVisionMessage({
        type: "vision-tmux-ocr-run-line",
        windowId: 44,
        appName: "Ghostty",
        cmd: "printf AIVIS001; exit 7",
        maxPages: 5,
        pageDelayMs: 100,
        timeoutMs: 5000,
        callKey: `vision-ocr-success-${Date.now()}`
      });
      assert.equal(success.ok, true);
      assert.equal(success.exitCode, 7);
      assert.equal(success.exitCodeKnown, true);
      assert.equal(success.truncated, false);
      assert.equal(success.paginationEnded, true);
      assert.equal(success.historyStartFound, true);
      assert.equal(success.historyLimit, 200000);
      assert.equal(success.ocrText, "AIVIS001\nAIVIS002\nAIVIS003\nAIVIS004");
      assert.equal(success.ocrPages.length, 2);
      process.env.AI_CHAT_SHELL_ENABLE_LOW_LEVEL_VISION = "1";
    }

    {
      delete process.env.AI_CHAT_SHELL_ENABLE_LOW_LEVEL_VISION;
      const truncated = await handleVisionMessage({
        type: "vision-tmux-ocr-run-line",
        windowId: 44,
        appName: "Ghostty",
        cmd: "printf AIVIS001",
        maxPages: 1,
        pageDelayMs: 100,
        timeoutMs: 5000,
        callKey: `vision-ocr-truncated-${Date.now()}`
      });
      assert.equal(truncated.ok, true);
      assert.equal(truncated.exitCode, 0);
      assert.equal(truncated.truncated, true);
      assert.equal(truncated.paginationEnded, false);
      assert.equal(truncated.historyStartFound, true);
      assert.equal(truncated.ocrPages.length, 1);
      process.env.AI_CHAT_SHELL_ENABLE_LOW_LEVEL_VISION = "1";
    }

    {
      delete process.env.AI_CHAT_SHELL_ENABLE_LOW_LEVEL_VISION;
      const missingStart = await handleVisionMessage({
        type: "vision-tmux-ocr-run-line",
        windowId: 44,
        appName: "Ghostty",
        cmd: "printf NO_START_MARKER",
        maxPages: 5,
        pageDelayMs: 100,
        timeoutMs: 5000,
        callKey: `vision-ocr-missing-start-${Date.now()}`
      });
      assert.equal(missingStart.ok, true);
      assert.equal(missingStart.paginationEnded, true);
      assert.equal(missingStart.historyStartFound, false);
      assert.equal(missingStart.truncated, true);
      process.env.AI_CHAT_SHELL_ENABLE_LOW_LEVEL_VISION = "1";
    }

    {
      delete process.env.AI_CHAT_SHELL_ENABLE_LOW_LEVEL_VISION;
      const pageFailure = await handleVisionMessage({
        type: "vision-tmux-ocr-run-line",
        windowId: 44,
        appName: "Ghostty",
        cmd: "printf FAIL_OCR_PAGE",
        maxPages: 5,
        pageDelayMs: 100,
        timeoutMs: 5000,
        callKey: `vision-ocr-page-failure-${Date.now()}`
      });
      assert.equal(pageFailure.ok, false);
      assert.equal(pageFailure.errorCode, "fake-ocr-page-failed");
      assert.equal(pageFailure.truncated, true);
      assert.equal(pageFailure.failedPage, 1);
      process.env.AI_CHAT_SHELL_ENABLE_LOW_LEVEL_VISION = "1";
    }

    {
      delete process.env.AI_CHAT_SHELL_ENABLE_LOW_LEVEL_VISION;
      const repeated = await handleVisionMessage({
        type: "vision-tmux-ocr-run-line",
        windowId: 44,
        appName: "Ghostty",
        cmd: "printf REPEAT_PAGE",
        maxPages: 4,
        pageDelayMs: 100,
        timeoutMs: 5000,
        callKey: `vision-ocr-repeat-page-${Date.now()}`
      });
      assert.equal(repeated.ok, true);
      assert.equal(repeated.paginationEnded, false);
      assert.equal(repeated.repeatSignatureDetected, true);
      assert.equal(repeated.truncated, true);
      assert.equal(repeated.ocrCleanupLossy, true);
      assert.deepEqual(repeated.ocrFullOverlapPages, [2, 3, 4]);
      process.env.AI_CHAT_SHELL_ENABLE_LOW_LEVEL_VISION = "1";
    }

    {
      delete process.env.AI_CHAT_SHELL_ENABLE_LOW_LEVEL_VISION;
      const lossyCleanup = await handleVisionMessage({
        type: "vision-tmux-ocr-run-line",
        windowId: 44,
        appName: "Ghostty",
        cmd: "printf STATUS_SUFFIX",
        maxPages: 5,
        pageDelayMs: 100,
        timeoutMs: 5000,
        callKey: `vision-ocr-status-suffix-${Date.now()}`
      });
      assert.equal(lossyCleanup.ok, true);
      assert.equal(lossyCleanup.paginationEnded, true);
      assert.equal(lossyCleanup.ocrCleanupLossy, true);
      assert.equal(lossyCleanup.truncated, true);
      process.env.AI_CHAT_SHELL_ENABLE_LOW_LEVEL_VISION = "1";
    }

    {
      fs.rmSync(path.join(fake.dir, "state.json"), { force: true });
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
    if (originalLowLevelVision === undefined) {
      delete process.env.AI_CHAT_SHELL_ENABLE_LOW_LEVEL_VISION;
    } else {
      process.env.AI_CHAT_SHELL_ENABLE_LOW_LEVEL_VISION = originalLowLevelVision;
    }
    fs.rmSync(fake.dir, { recursive: true, force: true });
  }

  console.log("vision message tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
