#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const {
  handleMessageText,
  listTmuxPanes,
  resolveBoardPane,
  runTmuxBoard
} = require("../server/shell_server.js");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-helper-board-integration-"));
const socketPath = path.join(tmpDir, "tmux.sock");
const originalSocket = process.env.AI_CHAT_SHELL_TMUX_SOCKET;
const originalSession = process.env.AI_CHAT_SHELL_TMUX_SESSION;
process.env.AI_CHAT_SHELL_TMUX_SOCKET = socketPath;

main()
  .then(() => {
    console.log("tmux board integration tests passed");
  })
  .finally(() => {
    killSession("board_success");
    killSession("board_probe_fail");
    if (originalSocket === undefined) {
      delete process.env.AI_CHAT_SHELL_TMUX_SOCKET;
    } else {
      process.env.AI_CHAT_SHELL_TMUX_SOCKET = originalSocket;
    }
    if (originalSession === undefined) {
      delete process.env.AI_CHAT_SHELL_TMUX_SESSION;
    } else {
      process.env.AI_CHAT_SHELL_TMUX_SESSION = originalSession;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });

async function main() {
  assert.equal(commandExists("tmux"), true, "tmux board integration tests require tmux on PATH.");

  process.env.AI_CHAT_SHELL_TMUX_SESSION = "board_success";
  runTmux(["new-session", "-d", "-s", "board_success", "-n", "board", "env PS1='BOARD> ' /bin/sh -i"]);
  runTmux(["new-window", "-d", "-t", "board_success", "-n", "board-R1", "env PS1='R1> ' /bin/sh -i"]);
  await sleep(1000);
  const successPane = resolveBoardPane(await listTmuxPanes()).pane;
  assert.ok(successPane, "Expected a unique board pane.");
  const success = await runTmuxBoard({
    cmd: "printf 'board-helper-ok\\n'",
    pane: successPane,
    timeoutMs: 10000,
    maxOutputChars: 20000
  });
  assert.equal(success.exitCode, 0, JSON.stringify(success));
  assert.equal(success.timedOut, false, JSON.stringify(success));
  assert.match(success.stdout, /board-helper-ok/);
  assert.match(success.stdout, /BOARD>/);
  assert.equal(success.executed, true);
  assert.equal(success.executionCompleted, false);
  assert.equal(success.completionObserved, true);

  const promptReturnedOwner = Buffer.from(JSON.stringify({
    version: 1,
    token: `board-prompt-returned-${Date.now()}`,
    socketPath,
    serverPid: String(successPane.serverPid || ""),
    paneId: successPane.id,
    kind: "board",
    processPid: process.pid,
    boardState: "prompt-returned",
    createdAt: Date.now()
  }), "utf8").toString("base64url");
  runTmux(["set-option", "-p", "-t", successPane.id, "@ai_chat_shell_exec_owner", promptReturnedOwner]);
  const afterPromptReturnedLease = await runTmuxBoard({
    cmd: "printf 'board-prompt-returned-lease-ok\\n'",
    pane: successPane,
    timeoutMs: 10000,
    maxOutputChars: 20000
  });
  assert.match(afterPromptReturnedLease.stdout, /board-prompt-returned-lease-ok/);

  const stalePreflightOwner = Buffer.from(JSON.stringify({
    version: 1,
    token: `board-stale-preflight-${Date.now()}`,
    socketPath,
    serverPid: String(successPane.serverPid || ""),
    paneId: successPane.id,
    kind: "board",
    createdAt: Date.now() - 6000
  }), "utf8").toString("base64url");
  runTmux(["set-option", "-p", "-t", successPane.id, "@ai_chat_shell_exec_owner", stalePreflightOwner]);
  const afterStalePreflight = await runTmuxBoard({
    cmd: "printf 'board-stale-preflight-recovered\\n'",
    pane: successPane,
    timeoutMs: 10000,
    maxOutputChars: 20000
  });
  assert.match(afterStalePreflight.stdout, /board-stale-preflight-recovered/);

  const stalePreparedLog = path.join(tmpDir, "stale-prepared-board.log");
  fs.writeFileSync(stalePreparedLog, "");
  const stalePreparedOwner = Buffer.from(JSON.stringify({
    version: 1,
    token: `board-stale-prepared-${Date.now()}`,
    socketPath,
    serverPid: String(successPane.serverPid || ""),
    paneId: successPane.id,
    kind: "board",
    createdAt: Date.now() - 6000,
    processPid: 99999999,
    boardLogPath: stalePreparedLog,
    boardOffset: 0,
    boardPrompt: "BOARD>",
    boardShellPrompt: true,
    boardState: "prepared"
  }), "utf8").toString("base64url");
  runTmux(["set-option", "-p", "-t", successPane.id, "@ai_chat_shell_exec_owner", stalePreparedOwner]);
  const afterStalePrepared = await runTmuxBoard({
    cmd: "printf 'board-stale-prepared-recovered\\n'",
    pane: successPane,
    timeoutMs: 10000,
    maxOutputChars: 20000
  });
  assert.match(afterStalePrepared.stdout, /board-stale-prepared-recovered/);

  const staleSentLog = path.join(tmpDir, "stale-sent-board.log");
  fs.writeFileSync(staleSentLog, "completed output\nBOARD> ");
  const oldLogTime = new Date(Date.now() - 2000);
  fs.utimesSync(staleSentLog, oldLogTime, oldLogTime);
  const staleSentOwner = Buffer.from(JSON.stringify({
    version: 1,
    token: `board-stale-sent-${Date.now()}`,
    socketPath,
    serverPid: String(successPane.serverPid || ""),
    paneId: successPane.id,
    kind: "board",
    createdAt: Date.now() - 6000,
    processPid: process.pid,
    boardLogPath: staleSentLog,
    boardOffset: 0,
    boardPrompt: "BOARD>",
    boardShellPrompt: true,
    boardState: "sent"
  }), "utf8").toString("base64url");
  runTmux(["set-option", "-p", "-t", successPane.id, "@ai_chat_shell_exec_owner", staleSentOwner]);
  const afterStaleSent = await runTmuxBoard({
    cmd: "printf 'board-stale-sent-recovered\\n'",
    pane: successPane,
    timeoutMs: 10000,
    maxOutputChars: 20000
  });
  assert.match(afterStaleSent.stdout, /board-stale-sent-recovered/);

  const handledSuccess = await handleMessageText(JSON.stringify({
    type: "run-board",
    id: "board-handler-success-first",
    callKey: `board-handler-success-first-${Date.now()}`,
    cmd: "printf 'board-handler-dedup-ok\\n'",
    timeoutMs: 10000,
    maxOutputChars: 20000
  }));
  assert.equal(handledSuccess.ok, true, JSON.stringify(handledSuccess));
  assert.equal(handledSuccess.duplicate, undefined);
  const handledRepeat = await handleMessageText(JSON.stringify({
    type: "run-board",
    id: "board-handler-success-second",
    callKey: `board-handler-success-second-${Date.now()}`,
    cmd: "printf 'board-handler-dedup-ok\\n'",
    timeoutMs: 10000,
    maxOutputChars: 20000
  }));
  assert.equal(handledRepeat.ok, true, JSON.stringify(handledRepeat));
  assert.equal(handledRepeat.duplicate, undefined, "Board prompt observation is not authoritative enough for duplicate suppression.");
  assert.match(handledRepeat.stdout, /board-handler-dedup-ok/);

  const changedCwd = path.join(tmpDir, "board-changed-cwd");
  fs.mkdirSync(changedCwd);
  const changeCwd = await handleMessageText(JSON.stringify({
    type: "run-board",
    id: "board-handler-change-cwd",
    callKey: `board-handler-change-cwd-${Date.now()}`,
    cmd: `cd ${changedCwd}`,
    timeoutMs: 10000,
    maxOutputChars: 20000
  }));
  assert.equal(changeCwd.ok, true, JSON.stringify(changeCwd));
  const sameCommandAfterCwdChange = await handleMessageText(JSON.stringify({
    type: "run-board",
    id: "board-handler-same-command-new-cwd",
    callKey: `board-handler-same-command-new-cwd-${Date.now()}`,
    cmd: "printf 'board-handler-dedup-ok\\n'",
    timeoutMs: 10000,
    maxOutputChars: 20000
  }));
  assert.equal(sameCommandAfterCwdChange.ok, true, JSON.stringify(sameCommandAfterCwdChange));
  assert.equal(sameCommandAfterCwdChange.duplicate, undefined, "The same board command in a different actual cwd must execute.");
  assert.equal(fs.realpathSync(sameCommandAfterCwdChange.cwd), fs.realpathSync(changedCwd));

  const timeoutCommand = "sleep 2; printf 'board-timeout-finished\\n'";
  const timedOutBoard = await handleMessageText(JSON.stringify({
    type: "run-board",
    id: "board-handler-timeout-first",
    callKey: `board-handler-timeout-first-${Date.now()}`,
    cmd: timeoutCommand,
    timeoutMs: 1000,
    maxOutputChars: 20000
  }));
  assert.equal(timedOutBoard.timedOut, true, JSON.stringify(timedOutBoard));
  assert.equal(timedOutBoard.executionCompleted, false, JSON.stringify(timedOutBoard));
  const timeoutRetry = await handleMessageText(JSON.stringify({
    type: "run-board",
    id: "board-handler-timeout-retry",
    callKey: `board-handler-timeout-retry-${Date.now()}`,
    cmd: timeoutCommand,
    timeoutMs: 5000,
    maxOutputChars: 20000
  }));
  assert.equal(timeoutRetry.duplicate, undefined, "A timed-out, unconfirmed board execution must remain retryable.");
  assert.equal(timeoutRetry.executionCompleted, false, JSON.stringify(timeoutRetry));
  assert.equal(timeoutRetry.completionObserved, true, JSON.stringify(timeoutRetry));

  const serializationPath = path.join(tmpDir, "board-serialization-order.txt");
  const serializedLeaderStartedAt = Date.now();
  const serializedLeader = handleMessageText(JSON.stringify({
    type: "run-board",
    id: "board-handler-serialized-leader",
    callKey: `board-handler-serialized-leader-${Date.now()}`,
    cmd: `printf 'leader-start\\n' >> ${serializationPath}; sleep 2; printf 'leader-end\\n' >> ${serializationPath}`,
    timeoutMs: 1000,
    maxOutputChars: 20000
  }));
  await sleep(1200);
  const serializedFollowerStartedAt = Date.now();
  const serializedFollower = handleMessageText(JSON.stringify({
    type: "run-board",
    id: "board-handler-serialized-follower",
    callKey: `board-handler-serialized-follower-${Date.now()}`,
    cmd: `printf 'follower\\n' >> ${serializationPath}`,
    timeoutMs: 5000,
    maxOutputChars: 20000
  }));
  const [leaderResult, followerResult] = await Promise.all([serializedLeader, serializedFollower]);
  assert.equal(leaderResult.timedOut, true, JSON.stringify(leaderResult));
  assert.equal(leaderResult.completionObserved, true, JSON.stringify(leaderResult));
  assert.equal(followerResult.ok, true, JSON.stringify(followerResult));
  assert.equal(
    fs.readFileSync(serializationPath, "utf8"),
    "leader-start\nleader-end\nfollower\n",
    "A follower must not be injected after the response timeout while the first board command still owns the pane."
  );
  assert.ok(
    Date.now() - serializedFollowerStartedAt >= 1500,
    "The follower should remain queued until the long-running leader returns to its prompt."
  );
  assert.ok(Date.now() - serializedLeaderStartedAt >= 2000);

  const restartOrderPath = path.join(tmpDir, "board-restart-order.txt");
  const childScript = [
    `const { runTmuxBoard } = require(${JSON.stringify(path.join(__dirname, "../server/shell_server.js"))});`,
    `const pane = ${JSON.stringify(successPane)};`,
    `runTmuxBoard({ cmd: ${JSON.stringify(`printf 'restart-leader-start\\n' >> ${restartOrderPath}; sleep 2; printf 'restart-leader-end\\n' >> ${restartOrderPath}`)}, pane, timeoutMs: 1000, maxOutputChars: 20000 })`,
    `.then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });`
  ].join("\n");
  const previousOwner = spawn(process.execPath, ["-e", childScript], {
    env: {
      ...process.env,
      AI_CHAT_SHELL_TMUX_SOCKET: socketPath,
      AI_CHAT_SHELL_TMUX_SESSION: "board_success"
    },
    stdio: "ignore"
  });
  await waitForFileContains(restartOrderPath, "restart-leader-start", 10000);
  previousOwner.kill("SIGKILL");
  await waitForChildExit(previousOwner);
  const restartFollowerStartedAt = Date.now();
  const restartFollower = await handleMessageText(JSON.stringify({
    type: "run-board",
    id: "board-handler-restart-follower",
    callKey: `board-handler-restart-follower-${Date.now()}`,
    cmd: `printf 'restart-follower\\n' >> ${restartOrderPath}`,
    timeoutMs: 5000,
    maxOutputChars: 20000
  }));
  assert.equal(restartFollower.ok, true, JSON.stringify(restartFollower));
  assert.equal(
    fs.readFileSync(restartOrderPath, "utf8"),
    "restart-leader-start\nrestart-leader-end\nrestart-follower\n",
    "A fresh server process must adopt the persistent board lease and wait for the old command's prompt."
  );
  assert.ok(
    Date.now() - restartFollowerStartedAt >= 1500,
    "Persistent board ownership should survive the process that originally dispatched the command."
  );

  const promptSpoofCommand = "printf 'BOARD> '; sleep 2; printf 'ACTUALLY_DONE\\n'";
  const promptSpoofFirst = await handleMessageText(JSON.stringify({
    type: "run-board",
    id: "board-handler-prompt-spoof-first",
    callKey: `board-handler-prompt-spoof-first-${Date.now()}`,
    cmd: promptSpoofCommand,
    timeoutMs: 1000,
    maxOutputChars: 20000
  }));
  assert.equal(promptSpoofFirst.executionCompleted, false, JSON.stringify(promptSpoofFirst));
  assert.ok(promptSpoofFirst.durationMs >= 2000, "Prompt-like command output must not release a shell-backed board pane before its foreground process exits.");
  assert.match(promptSpoofFirst.stdout, /ACTUALLY_DONE/);
  const promptSpoofRetry = await handleMessageText(JSON.stringify({
    type: "run-board",
    id: "board-handler-prompt-spoof-retry",
    callKey: `board-handler-prompt-spoof-retry-${Date.now()}`,
    cmd: promptSpoofCommand,
    timeoutMs: 5000,
    maxOutputChars: 20000
  }));
  assert.equal(promptSpoofRetry.duplicate, undefined, "A prompt-spoofed running board command must never create a duplicate verdict.");

  const missingTargetCommand = "MISSING_BOARD_TARGET_COMMAND";
  const missingTargetFirst = await handleMessageText(JSON.stringify({
    type: "run-board",
    id: "board-missing-target-first",
    callKey: `board-missing-target-first-${Date.now()}`,
    boardName: "board-MISSING",
    cmd: missingTargetCommand,
    timeoutMs: 2000,
    maxOutputChars: 20000
  }));
  assert.equal(missingTargetFirst.ok, false, JSON.stringify(missingTargetFirst));
  assert.equal(missingTargetFirst.duplicate, undefined);
  const missingTargetRetry = await handleMessageText(JSON.stringify({
    type: "run-board",
    id: "board-missing-target-retry",
    callKey: `board-missing-target-retry-${Date.now()}`,
    boardName: "board-MISSING",
    cmd: missingTargetCommand,
    timeoutMs: 2000,
    maxOutputChars: 20000
  }));
  assert.equal(missingTargetRetry.ok, false, JSON.stringify(missingTargetRetry));
  assert.equal(missingTargetRetry.duplicate, undefined, "An unavailable target must never create an execution duplicate.");

  const namedPane = resolveBoardPane(await listTmuxPanes(), "", "board-R1").pane;
  assert.ok(namedPane, "Expected a unique named board pane.");
  const named = await runTmuxBoard({
    cmd: "printf 'named-board-helper-ok\\n'",
    pane: namedPane,
    timeoutMs: 10000,
    maxOutputChars: 20000
  });
  assert.equal(named.exitCode, 0, JSON.stringify(named));
  assert.equal(named.timedOut, false, JSON.stringify(named));
  assert.match(named.stdout, /named-board-helper-ok/);
  assert.match(named.stdout, /R1>/);
  killSession("board_success");

  process.env.AI_CHAT_SHELL_TMUX_SESSION = "board_probe_fail";
  runTmux(["new-session", "-d", "-s", "board_probe_fail", "-n", "board", "/bin/cat"]);
  await sleep(1000);
  const failPane = resolveBoardPane(await listTmuxPanes()).pane;
  assert.ok(failPane, "Expected a unique board pane for probe failure.");
  const failed = await runTmuxBoard({
    cmd: "SHOULD_NOT_BE_SENT",
    pane: failPane,
    timeoutMs: 2000,
    maxOutputChars: 20000
  });
  assert.equal(failed.ok, false, JSON.stringify(failed));
  assert.equal(failed.executed, false, JSON.stringify(failed));
  assert.match(failed.error, /prompt probe failed/);
  assert.doesNotMatch(failed.stdout, /SHOULD_NOT_BE_SENT/);

  const failedHandlerCommand = "SHOULD_NOT_BE_SENT_BY_HANDLER";
  const failedHandlerFirst = await handleMessageText(JSON.stringify({
    type: "run-board",
    id: "board-handler-failed-first",
    callKey: `board-handler-failed-first-${Date.now()}`,
    cmd: failedHandlerCommand,
    timeoutMs: 2000,
    maxOutputChars: 20000
  }));
  assert.equal(failedHandlerFirst.ok, false, JSON.stringify(failedHandlerFirst));
  assert.equal(failedHandlerFirst.duplicate, undefined);
  const failedHandlerRetry = await handleMessageText(JSON.stringify({
    type: "run-board",
    id: "board-handler-failed-retry",
    callKey: `board-handler-failed-retry-${Date.now()}`,
    cmd: failedHandlerCommand,
    timeoutMs: 2000,
    maxOutputChars: 20000
  }));
  assert.equal(failedHandlerRetry.ok, false, JSON.stringify(failedHandlerRetry));
  assert.equal(failedHandlerRetry.duplicate, undefined, "A board command that was never sent must remain retryable.");
}

function runTmux(args) {
  const result = spawnSync("tmux", ["-S", socketPath, ...args], {
    encoding: "utf8"
  });
  assert.equal(result.status, 0, `tmux ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result;
}

function killSession(sessionName) {
  spawnSync("tmux", ["-S", socketPath, "kill-session", "-t", sessionName], {
    encoding: "utf8"
  });
}

function commandExists(command) {
  return spawnSync("which", [command], { encoding: "utf8" }).status === 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFileContains(filePath, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8").includes(needle)) {
      return;
    }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${needle} in ${filePath}.`);
}

function waitForChildExit(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", resolve);
    child.once("error", reject);
  });
}
