#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
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
  assert.match(failed.error, /prompt probe failed/);
  assert.doesNotMatch(failed.stdout, /SHOULD_NOT_BE_SENT/);
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
