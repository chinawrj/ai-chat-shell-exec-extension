#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  ensureForAiTmuxLayout,
  handleMessageText,
  listTmuxPanes,
  resolveBoardPane,
  resolveDefaultShellPane
} = require("../server/shell_server.js");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-forai-setup-"));
const socketPath = path.join(tmpDir, "tmux.sock");
const originalEnv = {
  socket: process.env.AI_CHAT_SHELL_TMUX_SOCKET,
  session: process.env.AI_CHAT_SHELL_TMUX_SESSION,
  host: process.env.AI_CHAT_SHELL_HOST_WINDOW,
  board: process.env.AI_CHAT_SHELL_BOARD_WINDOW
};

process.env.AI_CHAT_SHELL_TMUX_SOCKET = socketPath;
process.env.AI_CHAT_SHELL_TMUX_SESSION = "ForAI";
process.env.AI_CHAT_SHELL_HOST_WINDOW = "host";
process.env.AI_CHAT_SHELL_BOARD_WINDOW = "board";

main()
  .then(() => {
    console.log("tmux ForAI setup integration tests passed");
  })
  .finally(() => {
    spawnSync("tmux", ["-S", socketPath, "kill-session", "-t", "ForAI"], { encoding: "utf8" });
    restoreEnv("AI_CHAT_SHELL_TMUX_SOCKET", originalEnv.socket);
    restoreEnv("AI_CHAT_SHELL_TMUX_SESSION", originalEnv.session);
    restoreEnv("AI_CHAT_SHELL_HOST_WINDOW", originalEnv.host);
    restoreEnv("AI_CHAT_SHELL_BOARD_WINDOW", originalEnv.board);
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
  assert.equal(first.createdSession, true);
  assert.deepEqual(first.createdWindows.sort(), ["board", "host"]);
  assert.ok(first.defaultTarget, "Expected default host target after setup.");
  assert.ok(first.boardTarget, "Expected default board target after setup.");

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
}

function commandExists(command) {
  return spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).status === 0;
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
