#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  buildTmuxLiteralLineArgs,
  handleVisionMessage,
  listTmuxPanes,
  runTmuxShellQueued,
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
  const originalDirectVisualTmux = process.env.AI_CHAT_SHELL_ENABLE_DIRECT_VISUAL_TMUX;
  process.env.AI_CHAT_SHELL_TMUX_SOCKET = socketPath;
  delete process.env.AI_CHAT_SHELL_ENABLE_DIRECT_VISUAL_TMUX;

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
    assert.deepEqual(
      buildTmuxLiteralLineArgs(paneId, "printf 'ATOMIC_LINE\\n'"),
      [
        "send-keys", "-t", paneId, "-l", "printf 'ATOMIC_LINE\\n'",
        ";",
        "send-keys", "-t", paneId, "Enter"
      ],
      "Literal payload and Enter must be submitted in one tmux client command sequence."
    );

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

    const disabledVisualMessage = await handleVisionMessage({
      type: "vision-tmux-run-line",
      id: "vision-tmux-run-disabled",
      callKey: `vision-tmux-run-disabled-${Date.now()}`,
      target: paneId,
      cmd: "printf 'VISION_TMUX_DISABLED\\n'",
      timeoutMs: 10000
    });
    assert.equal(disabledVisualMessage.ok, false);
    assert.equal(disabledVisualMessage.errorCode, "direct-visual-tmux-disabled");

    process.env.AI_CHAT_SHELL_ENABLE_DIRECT_VISUAL_TMUX = "1";
    const visualMessage = await handleVisionMessage({
      type: "vision-tmux-run-line",
      id: "vision-tmux-run-message",
      callKey: `vision-tmux-run-message-${Date.now()}`,
      target: paneId,
      cmd: "printf 'VISION_TMUX_LEDGER_OK\\n'",
      timeoutMs: 10000
    });
    assert.equal(visualMessage.ok, true);
    assert.equal(visualMessage.exitCode, 0);
    assert.equal(visualMessage.terminalText.includes("VISION_TMUX_LEDGER_OK"), true);

    const duplicateVisualMessage = await handleVisionMessage({
      type: "vision-tmux-run-line",
      id: "vision-tmux-run-message",
      callKey: visualMessage.callKey,
      target: paneId,
      cmd: "printf 'VISION_TMUX_LEDGER_OK\\n'",
      timeoutMs: 10000
    });
    assert.equal(duplicateVisualMessage.ok, true);
    assert.equal(duplicateVisualMessage.duplicate, true);
    assert.equal(duplicateVisualMessage.skipped, true);
    assert.equal(duplicateVisualMessage.reason, "already-executed-on-target");
    assert.equal(duplicateVisualMessage.exitCode, 0);

    const forcedVisualMessage = await handleVisionMessage({
      type: "vision-tmux-run-line",
      id: "vision-tmux-run-message-forced",
      callKey: `vision-tmux-run-message-forced-${Date.now()}`,
      target: paneId,
      cmd: "printf 'VISION_TMUX_LEDGER_OK\\n'",
      timeoutMs: 10000,
      force: true
    });
    assert.equal(forcedVisualMessage.ok, true, JSON.stringify(forcedVisualMessage));
    assert.equal(forcedVisualMessage.duplicate, undefined);
    assert.equal(forcedVisualMessage.terminalText.includes("VISION_TMUX_LEDGER_OK"), true);

    const shellBeforeVisual = runTmuxShellQueued({
      cmd: "printf 'SHELL_BEFORE_VISUAL_STARTED\\n'; sleep 2; printf 'SHELL_BEFORE_VISUAL_DONE\\n'",
      cwd: pane.currentPath,
      pane,
      timeoutMs: 1000,
      maxOutputChars: 20000
    });
    await waitForPaneText(socketPath, paneId, "SHELL_BEFORE_VISUAL_STARTED", 5000);
    const queuedVisual = handleVisionMessage({
      type: "vision-tmux-run-line",
      id: "vision-tmux-run-behind-shell",
      callKey: `vision-tmux-run-behind-shell-${Date.now()}`,
      target: paneId,
      cmd: "printf 'VISUAL_AFTER_SHELL\\n'",
      timeoutMs: 1000
    });
    const shellBeforeVisualResult = await shellBeforeVisual;
    const queuedVisualResult = await queuedVisual;
    assert.equal(shellBeforeVisualResult.exitCode, 0, JSON.stringify(shellBeforeVisualResult));
    assert.equal(shellBeforeVisualResult.interrupted, false, JSON.stringify(shellBeforeVisualResult));
    assert.match(shellBeforeVisualResult.stdout, /SHELL_BEFORE_VISUAL_DONE/);
    assert.equal(queuedVisualResult.ok, true, JSON.stringify(queuedVisualResult));
    assert.equal(queuedVisualResult.queued, true, JSON.stringify(queuedVisualResult));
    assert.equal(queuedVisualResult.terminalText.includes("VISUAL_AFTER_SHELL"), true);

    const timeoutCmd = "sleep 2; printf 'VISUAL_TIMEOUT_FINISHED\\n'";
    const timedOutVisualMessage = await handleVisionMessage({
      type: "vision-tmux-run-line",
      id: "vision-tmux-run-timeout-first",
      callKey: `vision-tmux-run-timeout-first-${Date.now()}`,
      target: paneId,
      cmd: timeoutCmd,
      timeoutMs: 1000
    });
    assert.equal(timedOutVisualMessage.ok, true, JSON.stringify(timedOutVisualMessage));
    assert.equal(timedOutVisualMessage.timedOut, false, JSON.stringify(timedOutVisualMessage));
    assert.equal(timedOutVisualMessage.continuedAfterTimeout, true, JSON.stringify(timedOutVisualMessage));
    assert.equal(timedOutVisualMessage.executionCompleted, true, JSON.stringify(timedOutVisualMessage));

    const timeoutRetryVisualMessage = await handleVisionMessage({
      type: "vision-tmux-run-line",
      id: "vision-tmux-run-timeout-retry",
      callKey: `vision-tmux-run-timeout-retry-${Date.now()}`,
      target: paneId,
      cmd: timeoutCmd,
      timeoutMs: 5000
    });
    assert.equal(timeoutRetryVisualMessage.duplicate, true, "A visual command is dedupable only after its continued run obtains completion proof.");
    assert.equal(timeoutRetryVisualMessage.ok, true, JSON.stringify(timeoutRetryVisualMessage));
    assert.equal(timeoutRetryVisualMessage.skipped, true, JSON.stringify(timeoutRetryVisualMessage));

    const staleSideEffect = path.join(tmpDir, "stale-visual-buffer-ran");
    const staleRunWindowName = `AIVR_RUN_STALE_${Date.now()}`;
    const staleDonePrefix = `AIVR_DONE_STALE_${Date.now()}_`;
    const staleOwner = {
      version: 1,
      token: `stale-visual-${Date.now()}`,
      socketPath,
      serverPid: String(pane.serverPid || ""),
      paneId,
      kind: "visual",
      createdAt: Date.now() - 6000,
      runWindowName: staleRunWindowName,
      donePrefix: staleDonePrefix,
      statusPath: path.join(tmpDir, "missing-stale-visual.status"),
      executedPath: path.join(tmpDir, "missing-stale-visual.executed")
    };
    runTmux(socketPath, ["rename-window", "-t", paneId, staleRunWindowName]);
    runTmux(socketPath, ["send-keys", "-t", paneId, "-l", `touch ${shellQuote(staleSideEffect)}`]);
    runTmux(socketPath, [
      "set-option", "-p", "-t", paneId,
      "@ai_chat_shell_exec_owner",
      Buffer.from(JSON.stringify(staleOwner), "utf8").toString("base64url")
    ]);

    const staleFollower = await runTmuxShellQueued({
      cmd: "printf 'VISUAL_STALE_OWNER_RECOVERED\\n'",
      cwd: pane.currentPath,
      pane,
      timeoutMs: 1000,
      maxOutputChars: 20000
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(staleFollower.exitCode, 0, JSON.stringify(staleFollower));
    assert.match(staleFollower.stdout, /VISUAL_STALE_OWNER_RECOVERED/);
    assert.equal(fs.existsSync(staleSideEffect), false, "A buffered visual launcher without executed proof must be cancelled, never submitted later.");

    const selfTestOwner = {
      version: 1,
      token: `vision-self-test-${Date.now()}`,
      socketPath,
      serverPid: String(pane.serverPid || ""),
      paneId,
      kind: "vision-self-test",
      createdAt: Date.now() - 6000,
      processPid: process.pid
    };
    runTmux(socketPath, [
      "set-option", "-p", "-t", paneId,
      "@ai_chat_shell_exec_owner",
      Buffer.from(JSON.stringify(selfTestOwner), "utf8").toString("base64url")
    ]);
    let selfTestFollowerSettled = false;
    const selfTestFollowerPromise = runTmuxShellQueued({
      cmd: "printf 'VISION_SELF_TEST_OWNER_RELEASED\\n'",
      cwd: pane.currentPath,
      pane,
      timeoutMs: 1000,
      maxOutputChars: 20000
    }).finally(() => {
      selfTestFollowerSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(selfTestFollowerSettled, false, "A live Terminal vision self-test process must retain the pane beyond the generic stale-owner grace.");

    runTmux(socketPath, [
      "set-option", "-p", "-t", paneId,
      "@ai_chat_shell_exec_owner",
      Buffer.from(JSON.stringify({ ...selfTestOwner, processPid: 99999999 }), "utf8").toString("base64url")
    ]);
    const selfTestFollower = await selfTestFollowerPromise;
    assert.equal(selfTestFollower.exitCode, 0, JSON.stringify(selfTestFollower));
    assert.match(selfTestFollower.stdout, /VISION_SELF_TEST_OWNER_RELEASED/);
  } finally {
    spawnSync("tmux", ["-S", socketPath, "kill-session", "-t", sessionName], { encoding: "utf8" });
    if (originalSocket === undefined) {
      delete process.env.AI_CHAT_SHELL_TMUX_SOCKET;
    } else {
      process.env.AI_CHAT_SHELL_TMUX_SOCKET = originalSocket;
    }
    if (originalDirectVisualTmux === undefined) {
      delete process.env.AI_CHAT_SHELL_ENABLE_DIRECT_VISUAL_TMUX;
    } else {
      process.env.AI_CHAT_SHELL_ENABLE_DIRECT_VISUAL_TMUX = originalDirectVisualTmux;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("tmux visual run integration tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function waitForPaneText(socketPath, paneId, text, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const captured = runTmux(socketPath, ["capture-pane", "-p", "-S", "-200", "-t", paneId]);
    if (captured.includes(text)) {
      return captured;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for tmux pane text: ${text}`);
}

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}
