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
