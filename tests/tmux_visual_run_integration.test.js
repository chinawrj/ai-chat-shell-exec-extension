#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  listTmuxPanes,
  runTmuxVisualLine,
  validateVisionTmuxCommand
} = require("../server/shell_server.js");

function commandExists(command) {
  return spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).status === 0;
}

function runTmux(socketPath, args, options = {}) {
  const result = spawnSync("tmux", ["-S", socketPath, ...args], {
    encoding: "utf8",
    ...options
  });
  assert.equal(result.status, 0, `tmux ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

(async () => {
  assert.equal(commandExists("tmux"), true, "tmux visual run integration tests require tmux on PATH.");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-visual-run-"));
  const socketPath = path.join(tmpDir, "tmux.sock");
  const sessionName = `visionrun_${Date.now()}`;
  const originalSocket = process.env.AI_CHAT_SHELL_TMUX_SOCKET;
  process.env.AI_CHAT_SHELL_TMUX_SOCKET = socketPath;

  try {
    runTmux(socketPath, ["new-session", "-d", "-s", sessionName, "-x", "80", "-y", "24"]);
    const paneId = runTmux(socketPath, ["display-message", "-p", "-t", sessionName, "#{pane_id}"]).trim();
    assert.ok(paneId, "Could not determine test tmux pane id.");

    runTmux(socketPath, ["send-keys", "-t", paneId, "-l", "printf 'OLD_OUTPUT_SHOULD_BE_CLEARED\\n'"]);
    runTmux(socketPath, ["send-keys", "-t", paneId, "Enter"]);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const panes = await listTmuxPanes();
    const pane = panes.find((candidate) => candidate.id === paneId);
    assert.ok(pane, "Could not list test tmux pane.");

    const result = await runTmuxVisualLine({
      cmd: "printf 'alpha\\n'; false || printf 'fallback\\n'; exit 7",
      pane,
      timeoutMs: 10000,
      maxOutputChars: 200000
    });

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 7);
    assert.equal(result.timedOut, false);
    assert.match(result.doneWindowName, /^AIVR_DONE_[A-Z]+_7$/);
    assert.equal(result.terminalText.includes("alpha"), true);
    assert.equal(result.terminalText.includes("fallback"), true);
    assert.equal(result.terminalText.includes("OLD_OUTPUT_SHOULD_BE_CLEARED"), false);
    assert.equal(result.lineCount > 0, true);

    assert.equal(validateVisionTmuxCommand("false && echo no || echo yes"), "false && echo no || echo yes");
    assert.throws(() => validateVisionTmuxCommand("echo one\necho two"), /one command line/);
  } finally {
    spawnSync("tmux", ["-S", socketPath, "kill-session", "-t", sessionName], { encoding: "utf8" });
    if (originalSocket === undefined) {
      delete process.env.AI_CHAT_SHELL_TMUX_SOCKET;
    } else {
      process.env.AI_CHAT_SHELL_TMUX_SOCKET = originalSocket;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("tmux visual run integration tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
