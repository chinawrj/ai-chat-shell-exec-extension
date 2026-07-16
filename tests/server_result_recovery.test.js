#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.join(__dirname, "..");
const serverPath = path.join(repoRoot, "server", "shell_server.js");
const serverDir = path.dirname(serverPath);
const source = fs.readFileSync(serverPath, "utf8");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "server-result-recovery-"));
const stateDir = path.join(tmpDir, "state");
const ledgerPath = path.join(stateDir, "shell-ledger.json");
const originalStateDir = process.env.AI_CHAT_SHELL_STATE_DIR;

fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, calls: {} }, null, 2));
process.env.AI_CHAT_SHELL_STATE_DIR = stateDir;

main()
  .then(() => {
    console.log("server result recovery tests passed");
  })
  .finally(() => {
    delete require.cache[require.resolve(serverPath)];
    if (originalStateDir === undefined) {
      delete process.env.AI_CHAT_SHELL_STATE_DIR;
    } else {
      process.env.AI_CHAT_SHELL_STATE_DIR = originalStateDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });

async function main() {
  const context = loadServerContext();

  const queuedReservation = context.reserveServerShellCall("status-queued", {
    cmd: "printf queued",
    target: "%0",
    timeoutMs: 30000,
    maxOutputChars: 20000,
    callMeta: {}
  });
  assert.equal(queuedReservation.action, "reserved");
  const queuedEntry = readLedger().calls[queuedReservation.ledgerKey];
  assert.equal(queuedEntry.state, "running");
  assert.equal(queuedEntry.phase, "queued");
  assert.equal(queuedEntry.executionKey, "", "A queued reservation must not become duplicate authority before pane/cwd adjudication.");
  assert.equal(queuedEntry.cwd, "");
  const queuedStatus = await queryStatus(context, "status-queued");
  assert.equal(queuedStatus.found, true, JSON.stringify(queuedStatus));
  assert.equal(queuedStatus.state, "running", JSON.stringify(queuedStatus));
  assert.equal(queuedStatus.phase, "queued", JSON.stringify(queuedStatus));
  assert.equal(queuedStatus.queued, true, JSON.stringify(queuedStatus));
  const adjudicatedReservation = context.adjudicateReservedServerShellCall(queuedReservation.ledgerKey, {
    cmd: "printf queued",
    cwd: "/tmp",
    target: "%0",
    executionTarget: "tmux-pane:server-a:%0",
    timeoutMs: 30000,
    maxOutputChars: 20000,
    callMeta: {}
  });
  assert.equal(adjudicatedReservation.action, "run");
  assert.equal(adjudicatedReservation.ledgerKey, queuedReservation.ledgerKey);
  assert.equal(adjudicatedReservation.attemptId, queuedReservation.attemptId);
  const adjudicatedEntry = readLedger().calls[queuedReservation.ledgerKey];
  assert.equal(adjudicatedEntry.phase, "running");
  assert.equal(adjudicatedEntry.cwd, "/tmp");
  assert.ok(adjudicatedEntry.executionKey, "Queue-head adjudication must attach the authoritative execution key.");
  context.failServerShellCall(queuedReservation.ledgerKey, new Error("test cleanup"));

  const runningClaim = claim(context, "status-running", "printf running", "tmux-pane:server-a:%1");
  assert.equal(runningClaim.action, "run");
  const runningCountBeforeStatus = ledgerCallCount();
  const runningStatus = await queryStatus(context, "status-running");
  assert.equal(runningStatus.ok, true, JSON.stringify(runningStatus));
  assert.equal(runningStatus.found, true, JSON.stringify(runningStatus));
  assert.equal(runningStatus.state, "running", JSON.stringify(runningStatus));
  assert.equal(Boolean(runningStatus.result), false, JSON.stringify(runningStatus));
  assert.equal(ledgerCallCount(), runningCountBeforeStatus, "run-status must not claim or execute another command.");
  assert.equal(readLedger().calls[runningClaim.ledgerKey].state, "running");

  const completedStdout = "recovered stdout line one\nrecovered stdout line two";
  const completedStderr = "recovered stderr";
  const completedClaim = claim(context, "status-completed", "printf completed", "tmux-pane:server-a:%2");
  context.completeServerShellCall(completedClaim.ledgerKey, {
    exitCode: 130,
    stdout: completedStdout,
    stderr: completedStderr,
    durationMs: 4321,
    timedOut: false,
    truncated: false,
    executed: true,
    executionCompleted: true,
    completionMarkerMissing: false,
    interrupted: true,
    interruptSignal: "INT",
    queued: true,
    queuedMs: 2100,
    continuedAfterTimeout: true,
    target: "%2",
    targetName: "ForAI:0.0 host"
  });

  const completedEntry = readLedger().calls[completedClaim.ledgerKey];
  assert.equal(completedEntry.state, "completed");
  assert.equal(completedEntry.stdout, completedStdout);
  assert.equal(completedEntry.stderr, completedStderr);
  assert.equal(completedEntry.exitCode, 130);
  assert.equal(completedEntry.durationMs, 4321);
  assert.equal(completedEntry.executed, true);
  assert.equal(completedEntry.executionCompleted, true);
  assert.equal(completedEntry.interrupted, true);
  assert.equal(completedEntry.interruptSignal, "INT");
  assert.equal(completedEntry.executionId, completedClaim.attemptId, "A real execution owns one canonical opaque executionId.");
  assert.equal(
    context.failServerShellCall(completedClaim.ledgerKey, new Error("late recovery failure")),
    false,
    "A late recovery/cleanup error must not downgrade authoritative completion proof."
  );
  assert.equal(readLedger().calls[completedClaim.ledgerKey].state, "completed");

  const completedStatus = await queryStatus(context, "status-completed");
  assertCompletedStatus(completedStatus, completedStdout, completedStderr);

  const largeStdout = "O".repeat(260000);
  const largeStderr = "E".repeat(270000);
  const boundedClaim = claim(context, "status-bounded", "printf bounded", "tmux-pane:server-a:%3");
  context.completeServerShellCall(boundedClaim.ledgerKey, {
    exitCode: 0,
    stdout: largeStdout,
    stderr: largeStderr,
    durationMs: 5,
    timedOut: false,
    truncated: true,
    executed: true,
    executionCompleted: true
  });
  const boundedEntry = readLedger().calls[boundedClaim.ledgerKey];
  assert.ok(boundedEntry.stdout.length > 0 && boundedEntry.stdout.length <= 200000, `Unexpected persisted stdout length: ${boundedEntry.stdout.length}`);
  assert.ok(boundedEntry.stderr.length > 0 && boundedEntry.stderr.length <= 200000, `Unexpected persisted stderr length: ${boundedEntry.stderr.length}`);
  assert.ok(boundedEntry.stdout.length < largeStdout.length, "Persistent stdout must be bounded.");
  assert.ok(boundedEntry.stderr.length < largeStderr.length, "Persistent stderr must be bounded.");
  assert.equal(boundedEntry.truncated, true);

  const boardReservation = context.reserveServerShellCall("status-board-completed", {
    kind: "board",
    cmd: "status",
    target: "%20",
    timeoutMs: 30000,
    maxOutputChars: 20000,
    callMeta: {}
  });
  const boardAdjudication = context.adjudicateReservedServerShellCall(boardReservation.ledgerKey, {
    cmd: "status",
    cwd: "/tmp",
    target: "%20",
    executionTarget: "",
    timeoutMs: 30000,
    maxOutputChars: 20000,
    callMeta: {}
  });
  assert.equal(boardAdjudication.action, "run");
  assert.equal(readLedger().calls[boardReservation.ledgerKey].executionKey, "", "Board completion must never become duplicate authority.");
  context.completeServerShellCall(boardReservation.ledgerKey, {
    ok: true,
    exitCode: 0,
    stdout: "board status ok\nBOARD> ",
    stderr: "",
    durationMs: 65000,
    timedOut: true,
    truncated: false,
    executed: true,
    executionCompleted: false,
    completionObserved: true,
    target: "%20",
    targetName: "ForAI:1.0 board"
  });
  const boardCallCountBeforeStatus = ledgerCallCount();
  const boardStatus = await queryStatus(context, "status-board-completed", "board");
  assert.equal(boardStatus.kind, "board", JSON.stringify(boardStatus));
  assert.equal(boardStatus.state, "completed", JSON.stringify(boardStatus));
  assert.equal(boardStatus.result.stdout, "board status ok\nBOARD> ", JSON.stringify(boardStatus));
  assert.equal(boardStatus.result.executed, true, JSON.stringify(boardStatus));
  assert.equal(boardStatus.result.executionCompleted, false, JSON.stringify(boardStatus));
  assert.equal(boardStatus.result.completionObserved, true, JSON.stringify(boardStatus));
  assert.equal(ledgerCallCount(), boardCallCountBeforeStatus, "Board status must not reserve or execute another attempt.");
  const wrongKindStatus = await queryStatus(context, "status-board-completed", "shell");
  assert.equal(wrongKindStatus.found, false, "A board call key must not be recovered through the shell status namespace.");

  const recoveredOwnerReservation = context.reserveServerShellCall("status-board-owner-recovered", {
    kind: "board",
    cmd: "long-status",
    target: "%21",
    timeoutMs: 1000,
    maxOutputChars: 20000,
    callMeta: {}
  });
  context.adjudicateReservedServerShellCall(recoveredOwnerReservation.ledgerKey, {
    cmd: "long-status",
    cwd: "/tmp",
    target: "%21",
    executionTarget: "",
    timeoutMs: 1000,
    maxOutputChars: 20000,
    callMeta: {}
  });
  assert.equal(context.completeRecoveredBoardOwner({
    ledgerKey: recoveredOwnerReservation.ledgerKey,
    createdAt: Date.now() - 2000
  }, {
    id: "%21",
    label: "ForAI:2.0 board"
  }, {
    bytesRead: 30,
    stdout: "owner recovered\nBOARD> ",
    truncated: false
  }), true);
  const recoveredOwnerStatus = await queryStatus(context, "status-board-owner-recovered", "board");
  assert.equal(recoveredOwnerStatus.state, "completed", JSON.stringify(recoveredOwnerStatus));
  assert.equal(recoveredOwnerStatus.result.stdout, "owner recovered\nBOARD> ", JSON.stringify(recoveredOwnerStatus));
  assert.equal(recoveredOwnerStatus.result.executionCompleted, false, JSON.stringify(recoveredOwnerStatus));
  assert.equal(recoveredOwnerStatus.result.completionObserved, true, JSON.stringify(recoveredOwnerStatus));
  assert.equal(recoveredOwnerStatus.result.timedOut, true, JSON.stringify(recoveredOwnerStatus));

  const repeatedBoardReservation = context.reserveServerShellCall("status-board-repeat", {
    kind: "board",
    cmd: "status",
    target: "%20",
    timeoutMs: 30000,
    maxOutputChars: 20000,
    callMeta: {}
  });
  const repeatedBoardAdjudication = context.adjudicateReservedServerShellCall(repeatedBoardReservation.ledgerKey, {
    cmd: "status",
    cwd: "/tmp",
    target: "%20",
    executionTarget: "",
    timeoutMs: 30000,
    maxOutputChars: 20000,
    callMeta: {}
  });
  assert.equal(repeatedBoardAdjudication.action, "run", "Stored board results must never suppress an explicit later board attempt.");
  context.failServerShellCall(repeatedBoardReservation.ledgerKey, new Error("test cleanup"));

  const duplicateClaim = context.claimServerShellCall("status-completed-duplicate", {
    cmd: "printf completed",
    cwd: "/tmp",
    target: "%2",
    executionTarget: "tmux-pane:server-a:%2",
    timeoutMs: 30000,
    callMeta: {}
  });
  assert.equal(duplicateClaim.action, "skip");
  const duplicateResponse = context.buildExecutedDuplicateResponse({
    message: { id: "status-completed-duplicate" },
    callKey: "status-completed-duplicate",
    claim: duplicateClaim,
    cmd: "printf completed",
    cwd: "/tmp",
    pane: { id: "%2", label: "ForAI:0.0 host" },
    timeoutMs: 30000
  });
  assert.equal(duplicateResponse.duplicate, true);
  assert.equal(duplicateResponse.skipped, true);
  assert.equal(duplicateResponse.replayedOutput, true, JSON.stringify(duplicateResponse));
  assert.equal(duplicateResponse.stdout, completedStdout);
  assert.equal(duplicateResponse.stderr, completedStderr);
  assert.equal(duplicateResponse.exitCode, 130);
  assert.equal(duplicateResponse.previousInterrupted, true);
  assert.equal(duplicateResponse.previousInterruptSignal, "INT");
  assert.equal(duplicateResponse.executionId, completedClaim.attemptId, "Duplicate replay must inherit the original execution identity.");
  assert.equal(duplicateResponse.previousResultPresented, false);

  const duplicateReservation = context.reserveServerShellCall("status-reserved-duplicate", {
    cmd: "printf completed",
    target: "%2",
    timeoutMs: 30000,
    maxOutputChars: 20000,
    callMeta: {}
  });
  const duplicateAdjudication = context.adjudicateReservedServerShellCall(duplicateReservation.ledgerKey, {
    cmd: "printf completed",
    cwd: "/tmp",
    target: "%2",
    executionTarget: "tmux-pane:server-a:%2",
    timeoutMs: 30000,
    maxOutputChars: 20000,
    callMeta: {}
  });
  assert.equal(duplicateAdjudication.action, "skip");
  const reservedDuplicateResponse = context.buildExecutedDuplicateResponse({
    message: { id: "status-reserved-duplicate" },
    callKey: "status-reserved-duplicate",
    claim: duplicateAdjudication,
    cmd: "printf completed",
    cwd: "/tmp",
    pane: { id: "%2", label: "ForAI:0.0 host" },
    timeoutMs: 30000
  });
  context.completeServerShellCall(duplicateReservation.ledgerKey, reservedDuplicateResponse);
  const reservedDuplicateStatus = await queryStatus(context, "status-reserved-duplicate");
  assert.equal(reservedDuplicateStatus.state, "completed", JSON.stringify(reservedDuplicateStatus));
  assert.equal(reservedDuplicateStatus.result.duplicate, true, JSON.stringify(reservedDuplicateStatus));
  assert.equal(reservedDuplicateStatus.result.skipped, true, JSON.stringify(reservedDuplicateStatus));
  assert.equal(reservedDuplicateStatus.result.replayedOutput, true, JSON.stringify(reservedDuplicateStatus));
  assert.equal(reservedDuplicateStatus.result.stdout, completedStdout, JSON.stringify(reservedDuplicateStatus));
  assert.equal(reservedDuplicateStatus.result.executionId, completedClaim.attemptId, JSON.stringify(reservedDuplicateStatus));

  const presentationReceipt = await context.handleMessageText(JSON.stringify({
    type: "run-result-presented",
    executionId: completedClaim.attemptId
  }));
  assert.equal(presentationReceipt.ok, true, JSON.stringify(presentationReceipt));
  assert.equal(presentationReceipt.found, true, JSON.stringify(presentationReceipt));
  assert.ok(presentationReceipt.matched >= 2, JSON.stringify(presentationReceipt));
  const presentedReservedDuplicateStatus = await queryStatus(context, "status-reserved-duplicate");
  assert.equal(presentedReservedDuplicateStatus.state, "completed", JSON.stringify(presentedReservedDuplicateStatus));
  assert.equal(presentedReservedDuplicateStatus.result.duplicate, true, JSON.stringify(presentedReservedDuplicateStatus));
  assert.equal(
    presentedReservedDuplicateStatus.result.previousResultPresented,
    true,
    "A canonical receipt must monotonically update status recovery for duplicate entries that were persisted before presentation."
  );
  const deliveredDuplicateClaim = context.claimServerShellCall("status-completed-presented-duplicate", {
    cmd: "printf completed",
    cwd: "/tmp",
    target: "%2",
    executionTarget: "tmux-pane:server-a:%2",
    timeoutMs: 30000,
    callMeta: {}
  });
  assert.equal(deliveredDuplicateClaim.action, "skip");
  const deliveredDuplicateResponse = context.buildExecutedDuplicateResponse({
    message: { id: "status-completed-presented-duplicate" },
    callKey: "status-completed-presented-duplicate",
    claim: deliveredDuplicateClaim,
    cmd: "printf completed",
    cwd: "/tmp",
    pane: { id: "%2", label: "ForAI:0.0 host" },
    timeoutMs: 30000
  });
  assert.equal(deliveredDuplicateResponse.executionId, completedClaim.attemptId);
  assert.equal(deliveredDuplicateResponse.previousResultPresented, true, "Server receipt must let the frontend silently consume an already-presented result.");

  const failedClaim = claim(context, "status-failed", "printf failed", "tmux-pane:server-a:%4");
  context.failServerShellCall(failedClaim.ledgerKey, new Error("executor failed before completion proof"), { durationMs: 17 });
  const failedStatus = await queryStatus(context, "status-failed");
  assert.equal(failedStatus.ok, true, JSON.stringify(failedStatus));
  assert.equal(failedStatus.found, true, JSON.stringify(failedStatus));
  assert.equal(failedStatus.state, "failed", JSON.stringify(failedStatus));
  assert.equal(Boolean(failedStatus.result), false, JSON.stringify(failedStatus));
  const retryAfterFailure = claim(context, "status-failed-retry", "printf failed", "tmux-pane:server-a:%4");
  assert.equal(retryAfterFailure.action, "run", "Failed execution must remain retryable.");

  const unconfirmedClaim = claim(context, "status-unconfirmed", "printf unconfirmed", "tmux-pane:server-a:%5");
  context.finishUnconfirmedServerShellCall(unconfirmedClaim.ledgerKey, {
    exitCode: 124,
    durationMs: 3000,
    timedOut: true,
    truncated: false,
    stdout: "not completion proof"
  });
  const unconfirmedStatus = await queryStatus(context, "status-unconfirmed");
  assert.equal(unconfirmedStatus.ok, true, JSON.stringify(unconfirmedStatus));
  assert.equal(unconfirmedStatus.found, true, JSON.stringify(unconfirmedStatus));
  assert.equal(unconfirmedStatus.state, "unconfirmed", JSON.stringify(unconfirmedStatus));
  assert.equal(Boolean(unconfirmedStatus.result), false, JSON.stringify(unconfirmedStatus));
  const retryAfterUnconfirmed = claim(context, "status-unconfirmed-retry", "printf unconfirmed", "tmux-pane:server-a:%5");
  assert.equal(retryAfterUnconfirmed.action, "run", "Unconfirmed execution must remain retryable.");

  const freshServer = freshRequireServer();
  const recoveredAfterFreshRequire = await queryStatus(freshServer, "status-completed");
  assertCompletedStatus(recoveredAfterFreshRequire, completedStdout, completedStderr);

  const freshContext = loadServerContext();
  const duplicateAfterFreshRequire = freshContext.claimServerShellCall("status-completed-fresh-duplicate", {
    cmd: "printf completed",
    cwd: "/tmp",
    target: "%2",
    executionTarget: "tmux-pane:server-a:%2",
    timeoutMs: 30000,
    callMeta: {}
  });
  assert.equal(duplicateAfterFreshRequire.action, "skip", "Completed execution proof must survive a server module reload.");
  const replayAfterFreshRequire = freshContext.buildExecutedDuplicateResponse({
    message: { id: "status-completed-fresh-duplicate" },
    callKey: "status-completed-fresh-duplicate",
    claim: duplicateAfterFreshRequire,
    cmd: "printf completed",
    cwd: "/tmp",
    pane: { id: "%2", label: "ForAI:0.0 host" },
    timeoutMs: 30000
  });
  assert.equal(replayAfterFreshRequire.replayedOutput, true, JSON.stringify(replayAfterFreshRequire));
  assert.equal(replayAfterFreshRequire.stdout, completedStdout);
  assert.equal(replayAfterFreshRequire.stderr, completedStderr);

  for (let index = 0; index < 30; index += 1) {
    const budgetClaim = claim(context, `status-replay-budget-${index}`, `printf budget-${index}`, `tmux-pane:server-budget:%${index}`);
    context.completeServerShellCall(budgetClaim.ledgerKey, {
      exitCode: 0,
      stdout: "O".repeat(200000),
      stderr: "E".repeat(200000),
      durationMs: 1,
      timedOut: false,
      truncated: false,
      executed: true,
      executionCompleted: true
    });
  }
  const budgetLedger = readLedger();
  const expiredReplayEntries = Object.values(budgetLedger.calls).filter((entry) => entry.resultExpired === true);
  assert.ok(expiredReplayEntries.length > 0, "Old replay payloads must expire once the global ledger replay budget is reached.");
  assert.ok(
    fs.statSync(ledgerPath).size < 12 * 1024 * 1024,
    `Ledger should stay close to its 10 MiB replay budget, got ${fs.statSync(ledgerPath).size} bytes.`
  );
  assert.ok(
    expiredReplayEntries.every((entry) => entry.state === "completed" && entry.executionKey && entry.stdout === "" && entry.stderr === ""),
    "Replay expiry must preserve authoritative completion/dedup metadata while dropping only stored output."
  );

  const syntheticCalls = {};
  for (let index = 0; index < 1005; index += 1) {
    syntheticCalls[`running-${index}`] = {
      callKey: `running-${index}`,
      state: "running",
      phase: index % 2 === 0 ? "queued" : "running",
      startedAt: index + 1
    };
  }
  for (let index = 0; index < 10; index += 1) {
    syntheticCalls[`failed-${index}`] = {
      callKey: `failed-${index}`,
      state: "failed",
      startedAt: index + 1,
      completedAt: index + 1
    };
  }
  vm.runInContext(`serverLedger = ${JSON.stringify({ version: 1, calls: syntheticCalls })};`, context);
  context.pruneServerLedger();
  const prunedSynthetic = JSON.parse(vm.runInContext("JSON.stringify(serverLedger)", context));
  assert.equal(
    Object.values(prunedSynthetic.calls).filter((entry) => entry.state === "running").length,
    1005,
    "The count limit must never prune queued or running execution attempts."
  );
  assert.equal(
    Object.values(prunedSynthetic.calls).filter((entry) => entry.state === "failed").length,
    0,
    "When nonterminal calls exceed the soft limit, only removable terminal audit entries may be pruned."
  );
}

function claim(context, callKey, cmd, executionTarget) {
  return context.claimServerShellCall(callKey, {
    cmd,
    cwd: "/tmp",
    target: executionTarget.split(":").at(-1),
    executionTarget,
    timeoutMs: 30000,
    callMeta: {}
  });
}

function assertCompletedStatus(response, stdout, stderr) {
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.found, true, JSON.stringify(response));
  assert.equal(response.state, "completed", JSON.stringify(response));
  assert.ok(response.result && typeof response.result === "object", JSON.stringify(response));
  assert.equal(response.result.stdout, stdout);
  assert.equal(response.result.stderr, stderr);
  assert.equal(response.result.exitCode, 130);
  assert.equal(response.result.durationMs, 4321);
  assert.equal(response.result.executed, true);
  assert.equal(response.result.executionCompleted, true);
  assert.equal(response.result.timedOut, false);
  assert.equal(response.result.truncated, false);
  assert.equal(response.result.interrupted, true);
  assert.equal(response.result.interruptSignal, "INT");
}

async function queryStatus(context, callKey, kind = "shell") {
  return context.handleMessageText(JSON.stringify({
    type: "run-status",
    callKey,
    kind
  }));
}

function ledgerCallCount() {
  return Object.keys(readLedger().calls || {}).length;
}

function readLedger() {
  return JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
}

function freshRequireServer() {
  delete require.cache[require.resolve(serverPath)];
  return require(serverPath);
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
