#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.join(__dirname, "..");
const serverPath = path.join(repoRoot, "server", "shell_server.js");
const serverDir = path.dirname(serverPath);
const stateDir = path.join(repoRoot, ".state");
const ledgerPath = path.join(stateDir, "shell-ledger.json");
const source = fs.readFileSync(serverPath, "utf8");
const originalStateDir = process.env.AI_CHAT_SHELL_STATE_DIR;

const hadLedger = fs.existsSync(ledgerPath);
const ledgerBackup = hadLedger ? fs.readFileSync(ledgerPath, "utf8") : "";
fs.mkdirSync(stateDir, { recursive: true });
process.env.AI_CHAT_SHELL_STATE_DIR = stateDir;

function writeLedger(calls) {
  fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, calls }, null, 2));
}

function loadServerContext() {
  const context = {
    Buffer,
    clearTimeout,
    console,
    module: { exports: {} },
    exports: {},
    process,
    require,
    setTimeout,
    __dirname: serverDir,
    __filename: serverPath
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "shell_server.js" });
  return context;
}

try {
  writeLedger({});
  const completedContext = loadServerContext();
  const firstClaim = completedContext.claimServerShellCall("first-pane-a", {
    cmd: "echo same-command",
    cwd: "/tmp",
    target: "%1",
    executionTarget: "tmux-pane:server-a:%1",
    timeoutMs: 30000,
    callMeta: {}
  });
  assert.equal(firstClaim.action, "run");
  completedContext.completeServerShellCall(firstClaim.ledgerKey, {
    exitCode: 0,
    durationMs: 4,
    timedOut: false,
    truncated: false
  });
  const duplicateClaim = completedContext.claimServerShellCall("second-pane-a", {
    cmd: "echo same-command",
    cwd: "/tmp",
    target: "%1",
    executionTarget: "tmux-pane:server-a:%1",
    timeoutMs: 30000,
    callMeta: {}
  });
  assert.equal(duplicateClaim.action, "skip");
  assert.equal(duplicateClaim.reason, "already-executed-on-target");
  assert.equal(duplicateClaim.previousCallKey, "first-pane-a");
  const completedLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(completedLedger.calls[firstClaim.ledgerKey].state, "completed");
  assert.equal(completedLedger.calls[firstClaim.ledgerKey].callKey, "first-pane-a");
  assert.equal(Object.values(completedLedger.calls).some((entry) => entry.callKey === "second-pane-a"), false);

  writeLedger({});
  const interruptedContext = loadServerContext();
  const interruptedClaim = interruptedContext.claimServerShellCall("interrupted-first", {
    cmd: "sleep 60",
    cwd: "/tmp",
    target: "%1",
    executionTarget: "tmux-pane:server-a:%1",
    timeoutMs: 30000,
    callMeta: {}
  });
  interruptedContext.completeServerShellCall(interruptedClaim.ledgerKey, {
    exitCode: 130,
    durationMs: 800,
    timedOut: false,
    truncated: false,
    interrupted: true,
    interruptSignal: "INT"
  });
  const duplicateAfterInterrupt = interruptedContext.claimServerShellCall("interrupted-second", {
    cmd: "sleep 60",
    cwd: "/tmp",
    target: "%1",
    executionTarget: "tmux-pane:server-a:%1",
    timeoutMs: 30000,
    callMeta: {}
  });
  assert.equal(duplicateAfterInterrupt.action, "skip", "An actually started command interrupted by Ctrl+C is executed history.");
  const interruptedDuplicateResponse = interruptedContext.buildExecutedDuplicateResponse({
    message: { id: "interrupted-second" },
    callKey: "interrupted-second",
    claim: duplicateAfterInterrupt,
    cmd: "sleep 60",
    cwd: "/tmp",
    pane: { id: "%1", label: "ForAI:host.0" },
    timeoutMs: 30000
  });
  assert.equal(interruptedDuplicateResponse.exitCode, 130);
  assert.equal(interruptedDuplicateResponse.previousInterrupted, true);
  assert.equal(interruptedDuplicateResponse.previousInterruptSignal, "INT");
  const interruptedLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(interruptedLedger.calls[interruptedClaim.ledgerKey].state, "completed");
  assert.equal(interruptedLedger.calls[interruptedClaim.ledgerKey].interrupted, true);
  assert.equal(interruptedLedger.calls[interruptedClaim.ledgerKey].interruptSignal, "INT");

  const otherPaneClaim = completedContext.claimServerShellCall("first-pane-b", {
    cmd: "echo same-command",
    cwd: "/tmp",
    target: "%2",
    executionTarget: "tmux-pane:server-a:%2",
    timeoutMs: 30000,
    callMeta: {}
  });
  assert.equal(otherPaneClaim.action, "run");

  const otherCwdClaim = completedContext.claimServerShellCall("other-cwd-pane-a", {
    cmd: "echo same-command",
    cwd: "/var/tmp",
    target: "%1",
    executionTarget: "tmux-pane:server-a:%1",
    timeoutMs: 30000,
    callMeta: {}
  });
  assert.equal(otherCwdClaim.action, "run");

  writeLedger({});
  const runningContext = loadServerContext();
  const runningClaim = runningContext.claimServerShellCall("running-first", {
    cmd: "echo running",
    cwd: "/tmp",
    target: "%2",
    executionTarget: "tmux-pane:server-a:%2",
    timeoutMs: 30000,
    callMeta: {}
  });
  assert.equal(runningClaim.action, "run");
  const concurrentClaim = runningContext.claimServerShellCall("running-second", {
    cmd: "echo running",
    cwd: "/tmp",
    target: "%2",
    executionTarget: "tmux-pane:server-a:%2",
    timeoutMs: 30000,
    callMeta: {}
  });
  assert.equal(concurrentClaim.action, "run", "A merely claimed/running command is not an executed duplicate.");
  const runningLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(runningLedger.calls[runningClaim.ledgerKey].state, "running");
  assert.equal(runningLedger.calls[concurrentClaim.ledgerKey].state, "running");

  writeLedger({});
  const collidingContext = loadServerContext();
  const collidingPaneA = collidingContext.claimServerShellCall("same-client-key", {
    cmd: "echo colliding",
    cwd: "/tmp",
    target: "%10",
    executionTarget: "tmux-pane:server-a:%10",
    timeoutMs: 30000,
    callMeta: {}
  });
  const collidingPaneB = collidingContext.claimServerShellCall("same-client-key", {
    cmd: "echo colliding",
    cwd: "/tmp",
    target: "%11",
    executionTarget: "tmux-pane:server-a:%11",
    timeoutMs: 30000,
    callMeta: {}
  });
  assert.notEqual(collidingPaneA.ledgerKey, collidingPaneB.ledgerKey);
  collidingContext.completeServerShellCall(collidingPaneA.ledgerKey, {
    exitCode: 0,
    durationMs: 1,
    timedOut: false,
    truncated: false
  });
  const paneBWhileRunning = collidingContext.claimServerShellCall("same-client-key", {
    cmd: "echo colliding",
    cwd: "/tmp",
    target: "%11",
    executionTarget: "tmux-pane:server-a:%11",
    timeoutMs: 30000,
    callMeta: {}
  });
  assert.equal(paneBWhileRunning.action, "run", "Completing pane A must not mark a colliding pane B attempt completed.");
  const paneADuplicate = collidingContext.claimServerShellCall("same-client-key", {
    cmd: "echo colliding",
    cwd: "/tmp",
    target: "%10",
    executionTarget: "tmux-pane:server-a:%10",
    timeoutMs: 30000,
    callMeta: {}
  });
  assert.equal(paneADuplicate.action, "skip");

  writeLedger({});
  const forcedContext = loadServerContext();
  const forcedOriginal = forcedContext.claimServerShellCall("forced-original", {
    cmd: "echo force",
    cwd: "/tmp",
    target: "%3",
    executionTarget: "tmux-pane:server-a:%3",
    timeoutMs: 30000,
    callMeta: {}
  });
  forcedContext.completeServerShellCall(forcedOriginal.ledgerKey, {
    exitCode: 0,
    durationMs: 1,
    timedOut: false,
    truncated: false
  });
  const forcedClaim = forcedContext.claimServerShellCall("forced-rerun", {
    cmd: "echo force",
    cwd: "/tmp",
    target: "%3",
    executionTarget: "tmux-pane:server-a:%3",
    timeoutMs: 30000,
    callMeta: { force: true }
  });
  assert.equal(forcedClaim.action, "run");
  const forcedLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(forcedLedger.calls[forcedClaim.ledgerKey].state, "running");
  assert.equal(forcedLedger.calls[forcedClaim.ledgerKey].forced, true);

  writeLedger({});
  const forcedRunningContext = loadServerContext();
  const forcedRunningClaim = forcedRunningContext.claimServerShellCall("forcedRunning", {
    cmd: "echo force-running",
    cwd: "/tmp",
    target: "%4",
    executionTarget: "tmux-pane:server-a:%4",
    timeoutMs: 30000,
    callMeta: { force: true }
  });
  assert.equal(forcedRunningClaim.action, "run");
  const forcedRunningLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(forcedRunningLedger.calls[forcedRunningClaim.ledgerKey].state, "running");
  assert.equal(forcedRunningLedger.calls[forcedRunningClaim.ledgerKey].forced, true);
  assert.equal(forcedRunningLedger.calls[forcedRunningClaim.ledgerKey].cmdHash, forcedRunningContext.hashText("echo force-running"));

  writeLedger({});
  const failedContext = loadServerContext();
  const failedClaim = failedContext.claimServerShellCall("failedAfterClaim", {
    cmd: "echo fail-after-claim",
    cwd: "/tmp",
    target: "%5",
    executionTarget: "tmux-pane:server-a:%5",
    timeoutMs: 30000,
    callMeta: {}
  });
  assert.equal(failedClaim.action, "run");
  failedContext.failServerShellCall(failedClaim.ledgerKey, new Error("executor failed"), { durationMs: 7 });
  const failedLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(failedLedger.calls[failedClaim.ledgerKey].state, "failed");
  assert.equal(failedLedger.calls[failedClaim.ledgerKey].exitCode, 1);
  assert.equal(failedLedger.calls[failedClaim.ledgerKey].durationMs, 7);
  assert.match(failedLedger.calls[failedClaim.ledgerKey].error, /executor failed/);
  const retryAfterFailure = failedContext.claimServerShellCall("retryAfterFailure", {
    cmd: "echo fail-after-claim",
    cwd: "/tmp",
    target: "%5",
    executionTarget: "tmux-pane:server-a:%5",
    timeoutMs: 30000,
    callMeta: {}
  });
  assert.equal(retryAfterFailure.action, "run", "Failed commands must remain retryable.");

  writeLedger({
    oldCompleted: { state: "completed", completedAt: Date.now() - (24 * 60 * 60 * 1000 + 1000) },
    freshCompleted: { state: "completed", completedAt: Date.now() - 1_000 }
  });
  loadServerContext();
  const prunedLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(Boolean(prunedLedger.calls.oldCompleted), false);
  assert.equal(Boolean(prunedLedger.calls.freshCompleted), true);

  console.log("server target-aware execution dedup tests passed");
} finally {
  if (originalStateDir === undefined) {
    delete process.env.AI_CHAT_SHELL_STATE_DIR;
  } else {
    process.env.AI_CHAT_SHELL_STATE_DIR = originalStateDir;
  }
  if (hadLedger) {
    fs.writeFileSync(ledgerPath, ledgerBackup);
  } else {
    fs.rmSync(ledgerPath, { force: true });
  }
}
