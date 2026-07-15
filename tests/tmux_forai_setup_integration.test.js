#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  ensureForAiTmuxLayout,
  getTmuxShellPaneQueueDepth,
  handleMessageText,
  listTmuxPanes,
  resolveBoardPane,
  resolveDefaultShellPane,
  resetForAiTmuxLayout
} = require("../server/shell_server.js");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-forai-setup-"));
const socketPath = path.join(tmpDir, "tmux.sock");
const forAiCwd = fs.mkdtempSync(path.join(tmpDir, "cwd-"));
const expectedForAiCwd = fs.realpathSync(forAiCwd);
const originalEnv = {
  socket: process.env.AI_CHAT_SHELL_TMUX_SOCKET,
  session: process.env.AI_CHAT_SHELL_TMUX_SESSION,
  host: process.env.AI_CHAT_SHELL_HOST_WINDOW,
  board: process.env.AI_CHAT_SHELL_BOARD_WINDOW,
  cwd: process.env.AI_CHAT_SHELL_FORAI_CWD
};

process.env.AI_CHAT_SHELL_TMUX_SOCKET = socketPath;
process.env.AI_CHAT_SHELL_TMUX_SESSION = "ForAI";
process.env.AI_CHAT_SHELL_HOST_WINDOW = "host";
process.env.AI_CHAT_SHELL_BOARD_WINDOW = "board";
process.env.AI_CHAT_SHELL_FORAI_CWD = forAiCwd;

main()
  .then(() => {
    console.log("tmux ForAI setup integration tests passed");
  })
  .finally(() => {
    spawnSync("tmux", ["-S", socketPath, "kill-session", "-t", "ForAI"], { encoding: "utf8" });
    spawnSync("tmux", ["-S", socketPath, "kill-session", "-t", "ForAI-slave-a"], { encoding: "utf8" });
    restoreEnv("AI_CHAT_SHELL_TMUX_SOCKET", originalEnv.socket);
    restoreEnv("AI_CHAT_SHELL_TMUX_SESSION", originalEnv.session);
    restoreEnv("AI_CHAT_SHELL_HOST_WINDOW", originalEnv.host);
    restoreEnv("AI_CHAT_SHELL_BOARD_WINDOW", originalEnv.board);
    restoreEnv("AI_CHAT_SHELL_FORAI_CWD", originalEnv.cwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });

async function main() {
  assert.equal(commandExists("tmux"), true, "tmux ForAI setup integration tests require tmux on PATH.");

  const first = await ensureForAiTmuxLayout();
  assert.equal(first.ok, true);
  assert.equal(first.sessionName, "ForAI");
  assert.equal(first.hostWindowName, "host");
  assert.equal(first.boardWindowName, "board");
  assert.equal(first.cwd, expectedForAiCwd);
  assert.equal(first.cwdSource, "AI_CHAT_SHELL_FORAI_CWD");
  assert.equal(first.createdSession, true);
  assert.deepEqual(first.createdWindows.sort(), ["board", "host"]);
  assert.ok(first.defaultTarget, "Expected default host target after setup.");
  assert.ok(first.boardTarget, "Expected default board target after setup.");
  assert.equal(first.defaultTargetCwd, expectedForAiCwd);
  assert.equal(first.boardTargetCwd, expectedForAiCwd);

  const panes = await listTmuxPanes();
  assert.equal(resolveDefaultShellPane(panes).pane.windowName, "host");
  assert.equal(resolveDefaultShellPane(panes).pane.session, "ForAI");
  assert.equal(resolveBoardPane(panes).pane.windowName, "board");
  assert.equal(resolveBoardPane(panes).pane.session, "ForAI");

  const second = await ensureForAiTmuxLayout();
  assert.equal(second.createdSession, false);
  assert.deepEqual(second.createdWindows, []);

  const token = `FORAI_DEFAULT_${Date.now()}`;
  const response = await handleMessageText(JSON.stringify({
    type: "run",
    id: "forai-default-run",
    callKey: `forai-default-run-${Date.now()}`,
    cmd: `printf '${token}\\n'`,
    timeoutMs: 10000,
    maxOutputChars: 20000
  }));
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.exitCode, 0, JSON.stringify(response));
  assert.match(response.stdout, new RegExp(token));
  assert.match(response.targetName, /ForAI:.* host/);
  assert.equal(response.cwd, expectedForAiCwd);

  const dedupToken = `FORAI_TARGET_DEDUP_${Date.now()}`;
  const dedupFile = path.join(expectedForAiCwd, `target-dedup-${Date.now()}.txt`);
  const dedupCommand = `printf '${dedupToken}\\n' >> ${shellQuote(dedupFile)}`;
  const firstDedupResponse = await handleMessageText(JSON.stringify({
    type: "run",
    id: "forai-target-dedup-first",
    callKey: `forai-target-dedup-first-${Date.now()}`,
    cmd: dedupCommand,
    timeoutMs: 10000,
    maxOutputChars: 20000
  }));
  assert.equal(firstDedupResponse.ok, true, JSON.stringify(firstDedupResponse));
  assert.equal(firstDedupResponse.duplicate, undefined, JSON.stringify(firstDedupResponse));

  const duplicateDedupResponse = await handleMessageText(JSON.stringify({
    type: "run",
    id: "forai-target-dedup-second",
    callKey: `forai-target-dedup-second-${Date.now()}`,
    cmd: dedupCommand,
    timeoutMs: 10000,
    maxOutputChars: 20000
  }));
  assert.equal(duplicateDedupResponse.ok, true, JSON.stringify(duplicateDedupResponse));
  assert.equal(duplicateDedupResponse.duplicate, true, JSON.stringify(duplicateDedupResponse));
  assert.equal(duplicateDedupResponse.skipped, true, JSON.stringify(duplicateDedupResponse));
  assert.equal(duplicateDedupResponse.reason, "already-executed-on-target");
  assert.equal(fs.readFileSync(dedupFile, "utf8"), `${dedupToken}\n`);

  const otherPaneDedupResponse = await handleMessageText(JSON.stringify({
    type: "run",
    id: "forai-target-dedup-agent",
    callKey: `forai-target-dedup-agent-${Date.now()}`,
    agentId: "slave-a",
    cmd: dedupCommand,
    timeoutMs: 10000,
    maxOutputChars: 20000
  }));
  assert.equal(otherPaneDedupResponse.ok, true, JSON.stringify(otherPaneDedupResponse));
  assert.equal(otherPaneDedupResponse.duplicate, undefined, JSON.stringify(otherPaneDedupResponse));
  assert.match(otherPaneDedupResponse.targetName, /ForAI-slave-a:.* host/);
  assert.equal(fs.readFileSync(dedupFile, "utf8"), `${dedupToken}\n${dedupToken}\n`);

  const longToken = `FORAI_LONG_${Date.now()}`;
  const longStarted = Date.now();
  const longResponse = await handleMessageText(JSON.stringify({
    type: "run",
    id: "forai-long-run",
    callKey: `forai-long-run-${Date.now()}`,
    cmd: `sleep 2\nprintf '${longToken}\\n'`,
    timeoutMs: 1000,
    maxOutputChars: 20000
  }));
  assert.equal(longResponse.ok, true, JSON.stringify(longResponse));
  assert.equal(longResponse.exitCode, 0, JSON.stringify(longResponse));
  assert.equal(longResponse.timedOut, false, JSON.stringify(longResponse));
  assert.equal(longResponse.continuedAfterTimeout, true, JSON.stringify(longResponse));
  assert.match(longResponse.stdout, new RegExp(longToken));
  assert.ok(Date.now() - longStarted >= 1500, JSON.stringify(longResponse));

  const refreshOldToken = `FORAI_REFRESH_OLD_${Date.now()}`;
  const refreshNewToken = `FORAI_REFRESH_NEW_${Date.now()}`;
  const refreshOldPromise = handleMessageText(JSON.stringify({
    type: "run",
    id: "forai-refresh-old-page",
    callKey: `forai-refresh-old-page-${Date.now()}`,
    cmd: `printf '${refreshOldToken}\\n'; sleep 4; printf 'FORAI_REFRESH_OLD_DONE\\n'`,
    timeoutMs: 1000,
    maxOutputChars: 20000
  }));
  const refreshHostPane = resolveDefaultShellPane(await listTmuxPanes()).pane;
  await waitForTmuxPaneText(refreshHostPane.id, refreshOldToken, 5000);
  const movedWindowIndex = refreshHostPane.windowIndex === "9" ? "8" : "9";
  runTmux([
    "move-window",
    "-s",
    `${refreshHostPane.session}:${refreshHostPane.windowIndex}`,
    "-t",
    `${refreshHostPane.session}:${movedWindowIndex}`
  ]);
  const movedRefreshHostPane = resolveDefaultShellPane(await listTmuxPanes()).pane;
  assert.equal(movedRefreshHostPane.id, refreshHostPane.id, "move-window must preserve the physical pane id used by the queue.");
  assert.notEqual(movedRefreshHostPane.address, refreshHostPane.address, "The regression requires the same busy pane to have a changed tmux address.");
  assert.equal(movedRefreshHostPane.serverPid, refreshHostPane.serverPid);

  let refreshNewSettled = false;
  const refreshNewStarted = Date.now();
  const refreshNewPromise = handleMessageText(JSON.stringify({
    type: "run",
    id: "forai-refresh-new-page",
    callKey: `forai-refresh-new-page-${Date.now()}`,
    cmd: `printf '${refreshNewToken}\\n'`,
    timeoutMs: 1000,
    maxOutputChars: 20000
  })).finally(() => {
    refreshNewSettled = true;
  });

  const otherPaneWhileQueuedPromise = handleMessageText(JSON.stringify({
    type: "run",
    id: "forai-refresh-other-pane",
    callKey: `forai-refresh-other-pane-${Date.now()}`,
    agentId: "slave-a",
    cmd: "printf 'FORAI_REFRESH_OTHER_PANE\\n'",
    timeoutMs: 1000,
    maxOutputChars: 20000
  }));
  const firstConcurrentCompletion = await Promise.race([
    otherPaneWhileQueuedPromise.then((response) => ({ kind: "other-pane", response })),
    refreshOldPromise.then((response) => ({ kind: "busy-pane", response }))
  ]);
  assert.equal(firstConcurrentCompletion.kind, "other-pane", JSON.stringify(firstConcurrentCompletion.response));
  const otherPaneWhileQueued = firstConcurrentCompletion.response;
  assert.equal(otherPaneWhileQueued.exitCode, 0, JSON.stringify(otherPaneWhileQueued));
  assert.equal(otherPaneWhileQueued.queued, false, JSON.stringify(otherPaneWhileQueued));

  await sleep(1200);
  assert.equal(refreshNewSettled, false, "The refreshed-page helper must remain queued instead of timing out before its runner starts.");
  const queuedPaneText = runTmux(["capture-pane", "-p", "-S", "-200", "-t", refreshHostPane.id]);
  assert.doesNotMatch(queuedPaneText, new RegExp(refreshNewToken), "The queued runner must not be typed into the busy pane.");

  const refreshOldResponse = await refreshOldPromise;
  const refreshNewResponse = await refreshNewPromise;
  assert.equal(refreshOldResponse.exitCode, 0, JSON.stringify(refreshOldResponse));
  assert.equal(refreshNewResponse.exitCode, 0, JSON.stringify(refreshNewResponse));
  assert.equal(refreshNewResponse.executed, true, JSON.stringify(refreshNewResponse));
  assert.equal(refreshNewResponse.executionCompleted, true, JSON.stringify(refreshNewResponse));
  assert.equal(refreshNewResponse.timedOut, false, JSON.stringify(refreshNewResponse));
  assert.equal(refreshNewResponse.queued, true, JSON.stringify(refreshNewResponse));
  assert.ok(refreshNewResponse.queuedMs >= 2500, JSON.stringify(refreshNewResponse));
  assert.ok(Date.now() - refreshNewStarted >= 3000, JSON.stringify(refreshNewResponse));
  assert.match(refreshNewResponse.stdout, new RegExp(refreshNewToken));

  const interruptToken = `FORAI_INTERRUPT_${Date.now()}`;
  const interruptCommand = `printf '${interruptToken}\\n'; sleep 60; printf 'INTERRUPT_SHOULD_NOT_FINISH\\n'`;
  const interruptPromise = handleMessageText(JSON.stringify({
    type: "run",
    id: "forai-interrupt-run",
    callKey: `forai-interrupt-run-${Date.now()}`,
    cmd: interruptCommand,
    timeoutMs: 30000,
    maxOutputChars: 20000
  }));
  const defaultHostPane = resolveDefaultShellPane(await listTmuxPanes()).pane;
  await waitForTmuxPaneText(defaultHostPane.id, interruptToken, 5000);
  const interruptFollowerToken = `FORAI_INTERRUPT_FOLLOWER_${Date.now()}`;
  const interruptFollowerPromise = handleMessageText(JSON.stringify({
    type: "run",
    id: "forai-interrupt-follower",
    callKey: `forai-interrupt-follower-${Date.now()}`,
    cmd: `printf '${interruptFollowerToken}\\n'`,
    timeoutMs: 1000,
    maxOutputChars: 20000
  }));
  await waitForCondition(
    () => getTmuxShellPaneQueueDepth(defaultHostPane) >= 2,
    5000,
    "Ctrl+C follower to enter the same-pane queue"
  );
  const interruptedAt = Date.now();
  runTmux(["send-keys", "-t", defaultHostPane.id, "C-c"]);
  const interruptResponse = await Promise.race([
    interruptPromise,
    sleep(3000).then(() => {
      throw new Error("Ctrl+C shell helper did not return within 3 seconds.");
    })
  ]);
  assert.equal(interruptResponse.ok, true, JSON.stringify(interruptResponse));
  assert.equal(interruptResponse.exitCode, 130, JSON.stringify(interruptResponse));
  assert.equal(interruptResponse.interrupted, true, JSON.stringify(interruptResponse));
  assert.equal(interruptResponse.interruptSignal, "INT", JSON.stringify(interruptResponse));
  assert.equal(interruptResponse.executed, true, JSON.stringify(interruptResponse));
  assert.equal(interruptResponse.executionCompleted, true, JSON.stringify(interruptResponse));
  assert.equal(interruptResponse.timedOut, false, JSON.stringify(interruptResponse));
  assert.match(interruptResponse.stderr, /Ctrl\+C \(SIGINT\)/);
  assert.match(interruptResponse.stdout, new RegExp(interruptToken));
  assert.doesNotMatch(interruptResponse.stdout, /INTERRUPT_SHOULD_NOT_FINISH/);
  assert.ok(Date.now() - interruptedAt < 2000, JSON.stringify(interruptResponse));
  const interruptFollowerResponse = await Promise.race([
    interruptFollowerPromise,
    sleep(3000).then(() => {
      throw new Error("Queued shell helper did not start promptly after Ctrl+C released its pane.");
    })
  ]);
  assert.equal(interruptFollowerResponse.exitCode, 0, JSON.stringify(interruptFollowerResponse));
  assert.equal(interruptFollowerResponse.queued, true, JSON.stringify(interruptFollowerResponse));
  assert.equal(interruptFollowerResponse.timedOut, false, JSON.stringify(interruptFollowerResponse));
  assert.match(interruptFollowerResponse.stdout, new RegExp(interruptFollowerToken));

  const interruptedDuplicate = await handleMessageText(JSON.stringify({
    type: "run",
    id: "forai-interrupt-duplicate",
    callKey: `forai-interrupt-duplicate-${Date.now()}`,
    cmd: interruptCommand,
    timeoutMs: 30000,
    maxOutputChars: 20000
  }));
  assert.equal(interruptedDuplicate.duplicate, true, JSON.stringify(interruptedDuplicate));
  assert.equal(interruptedDuplicate.skipped, true, JSON.stringify(interruptedDuplicate));
  assert.equal(interruptedDuplicate.exitCode, 130, JSON.stringify(interruptedDuplicate));
  assert.equal(interruptedDuplicate.previousInterrupted, true, JSON.stringify(interruptedDuplicate));
  assert.equal(interruptedDuplicate.previousInterruptSignal, "INT", JSON.stringify(interruptedDuplicate));

  const stalePaneOldToken = `FORAI_STALE_PANE_OLD_${Date.now()}`;
  const stalePaneNewToken = `FORAI_STALE_PANE_NEW_${Date.now()}`;
  const stalePaneOldPromise = handleMessageText(JSON.stringify({
    type: "run",
    id: "forai-stale-pane-old",
    callKey: `forai-stale-pane-old-${Date.now()}`,
    cmd: `printf '${stalePaneOldToken}\\n'; sleep 60`,
    timeoutMs: 30000,
    maxOutputChars: 20000
  }));
  const stalePaneBeforeReset = resolveDefaultShellPane(await listTmuxPanes()).pane;
  await waitForTmuxPaneText(stalePaneBeforeReset.id, stalePaneOldToken, 5000);
  const stalePaneQueuedResultPromise = handleMessageText(JSON.stringify({
    type: "run",
    id: "forai-stale-pane-queued",
    callKey: `forai-stale-pane-queued-${Date.now()}`,
    cmd: `printf '${stalePaneNewToken}\\n'`,
    timeoutMs: 1000,
    maxOutputChars: 20000
  })).then(
    (response) => ({ response, error: null }),
    (error) => ({ response: null, error })
  );
  await waitForCondition(
    () => getTmuxShellPaneQueueDepth(stalePaneBeforeReset) >= 2,
    5000,
    "stale-pane follower to enter the same-pane queue before tmux reset"
  );
  runTmux(["kill-server"]);
  await ensureForAiTmuxLayout();
  const stalePaneAfterReset = resolveDefaultShellPane(await listTmuxPanes()).pane;
  assert.notEqual(stalePaneAfterReset.serverPid, stalePaneBeforeReset.serverPid, "The stale-pane regression requires a new tmux server instance.");
  await Promise.race([
    stalePaneOldPromise,
    sleep(3000).then(() => {
      throw new Error("Old shell helper did not settle after its tmux server was killed.");
    })
  ]);
  const stalePaneQueuedResult = await Promise.race([
    stalePaneQueuedResultPromise,
    sleep(3000).then(() => {
      throw new Error("Queued shell helper did not fail promptly after its tmux pane instance was replaced.");
    })
  ]);
  assert.equal(stalePaneQueuedResult.response, null, JSON.stringify(stalePaneQueuedResult.response));
  assert.match(stalePaneQueuedResult.error?.message || "", /different tmux server instance|no longer exists/);

  const stalePaneRetry = await handleMessageText(JSON.stringify({
    type: "run",
    id: "forai-stale-pane-retry",
    callKey: `forai-stale-pane-retry-${Date.now()}`,
    cmd: `printf '${stalePaneNewToken}\\n'`,
    timeoutMs: 1000,
    maxOutputChars: 20000
  }));
  assert.equal(stalePaneRetry.exitCode, 0, JSON.stringify(stalePaneRetry));
  assert.equal(stalePaneRetry.queued, false, JSON.stringify(stalePaneRetry));
  assert.match(stalePaneRetry.stdout, new RegExp(stalePaneNewToken));

  const agentToken = `FORAI_AGENT_${Date.now()}`;
  const agentResponse = await handleMessageText(JSON.stringify({
    type: "run",
    id: "forai-agent-run",
    callKey: `forai-agent-run-${Date.now()}`,
    agentId: "slave-a",
    cmd: `printf '${agentToken}\\n'`,
    timeoutMs: 10000,
    maxOutputChars: 20000
  }));
  assert.equal(agentResponse.ok, true, JSON.stringify(agentResponse));
  assert.equal(agentResponse.agentId, "slave-a");
  assert.equal(agentResponse.exitCode, 0, JSON.stringify(agentResponse));
  assert.match(agentResponse.stdout, new RegExp(agentToken));
  assert.match(agentResponse.targetName, /ForAI-slave-a:.* host/);
  assert.equal(agentResponse.cwd, expectedForAiCwd);

  const ignoredTargetToken = `FORAI_IGNORED_TARGET_${Date.now()}`;
  const ignoredTargetResponse = await handleMessageText(JSON.stringify({
    type: "run",
    id: "forai-ignored-target-run",
    callKey: `forai-ignored-target-run-${Date.now()}`,
    target: "missing-target-should-be-ignored",
    cmd: `printf '${ignoredTargetToken}\\n'`,
    timeoutMs: 10000,
    maxOutputChars: 20000
  }));
  assert.equal(ignoredTargetResponse.ok, true, JSON.stringify(ignoredTargetResponse));
  assert.equal(ignoredTargetResponse.exitCode, 0, JSON.stringify(ignoredTargetResponse));
  assert.match(ignoredTargetResponse.stdout, new RegExp(ignoredTargetToken));
  assert.match(ignoredTargetResponse.targetName, /ForAI:.* host/);

  const pwdResponse = await handleMessageText(JSON.stringify({
    type: "run",
    id: "forai-default-pwd",
    callKey: `forai-default-pwd-${Date.now()}`,
    cmd: "pwd",
    timeoutMs: 10000,
    maxOutputChars: 20000
  }));
  assert.equal(pwdResponse.ok, true, JSON.stringify(pwdResponse));
  assert.equal(pwdResponse.exitCode, 0, JSON.stringify(pwdResponse));
  assert.equal(pwdResponse.stdout.trim(), expectedForAiCwd);

  const heredocFile = path.join(expectedForAiCwd, `helper-heredoc-${Date.now()}.txt`);
  const heredocResponse = await handleMessageText(JSON.stringify({
    type: "run",
    id: "forai-heredoc-run",
    callKey: `forai-heredoc-run-${Date.now()}`,
    cmd: [
      `cat > ${shellQuote(heredocFile)} <<'EOF'`,
      "HEREDOC_LINE_ONE",
      "HEREDOC_LINE_TWO",
      "EOF",
      "printf 'AFTER_HEREDOC\\n'",
      `wc -l < ${shellQuote(heredocFile)}`
    ].join("\n"),
    timeoutMs: 10000,
    maxOutputChars: 20000
  }));
  assert.equal(heredocResponse.ok, true, JSON.stringify(heredocResponse));
  assert.equal(heredocResponse.exitCode, 0, JSON.stringify(heredocResponse));
  assert.match(heredocResponse.stdout, /AFTER_HEREDOC/);
  assert.match(heredocResponse.stdout, /2/);
  assert.equal(fs.readFileSync(heredocFile, "utf8"), "HEREDOC_LINE_ONE\nHEREDOC_LINE_TWO\n");

  const reset = await resetForAiTmuxLayout();
  assert.equal(reset.ok, true);
  assert.equal(reset.reset, true);
  assert.equal(reset.killedExistingSession, true);
  assert.equal(reset.createdSession, true);
  assert.equal(reset.cwd, expectedForAiCwd);
  assert.equal(reset.defaultTargetCwd, expectedForAiCwd);
  assert.equal(reset.boardTargetCwd, expectedForAiCwd);

  const resetPaneDedupResponse = await handleMessageText(JSON.stringify({
    type: "run",
    id: "forai-target-dedup-reset",
    callKey: `forai-target-dedup-reset-${Date.now()}`,
    cmd: dedupCommand,
    timeoutMs: 10000,
    maxOutputChars: 20000
  }));
  assert.equal(resetPaneDedupResponse.ok, true, JSON.stringify(resetPaneDedupResponse));
  assert.equal(resetPaneDedupResponse.duplicate, undefined, JSON.stringify(resetPaneDedupResponse));
  assert.equal(fs.readFileSync(dedupFile, "utf8"), `${dedupToken}\n${dedupToken}\n${dedupToken}\n`);

  const resetToken = `FORAI_RESET_${Date.now()}`;
  const resetResponse = await handleMessageText(JSON.stringify({
    type: "run",
    id: "forai-reset-run",
    callKey: `forai-reset-run-${Date.now()}`,
    cmd: `printf '${resetToken}\\n'`,
    timeoutMs: 10000,
    maxOutputChars: 20000
  }));
  assert.equal(resetResponse.ok, true, JSON.stringify(resetResponse));
  assert.equal(resetResponse.exitCode, 0, JSON.stringify(resetResponse));
  assert.match(resetResponse.stdout, new RegExp(resetToken));
  assert.match(resetResponse.targetName, /ForAI:.* host/);

  spawnSync("tmux", ["-S", socketPath, "kill-session", "-t", "ForAI"], { encoding: "utf8" });
  const resetMissing = await resetForAiTmuxLayout();
  assert.equal(resetMissing.ok, true);
  assert.equal(resetMissing.reset, true);
  assert.equal(resetMissing.killedExistingSession, false);
  assert.equal(resetMissing.createdSession, true);
  assert.deepEqual(resetMissing.createdWindows.sort(), ["board", "host"]);
  assert.equal(resetMissing.defaultTargetCwd, expectedForAiCwd);
  assert.equal(resetMissing.boardTargetCwd, expectedForAiCwd);
}

function commandExists(command) {
  return spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).status === 0;
}

function runTmux(args) {
  const result = spawnSync("tmux", ["-S", socketPath, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `tmux ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

async function waitForTmuxPaneText(paneId, text, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const captured = runTmux(["capture-pane", "-p", "-S", "-200", "-t", paneId]);
    if (captured.includes(text)) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for tmux pane ${paneId} to contain ${text}.`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}
