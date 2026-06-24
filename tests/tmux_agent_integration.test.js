#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-agent-ai-"));
const socketPath = path.join(tmpDir, "tmux.sock");
const stateDir = path.join(tmpDir, "state");
const originalEnv = {
  socket: process.env.AI_CHAT_SHELL_TMUX_SOCKET,
  state: process.env.AI_CHAT_SHELL_STATE_DIR
};

process.env.AI_CHAT_SHELL_TMUX_SOCKET = socketPath;
process.env.AI_CHAT_SHELL_STATE_DIR = stateDir;

const {
  handleAgentHubMessage,
  handleAgentHubMessageAsync,
  resetAgentHubForTests
} = require("../server/shell_server.js");

main()
  .then(() => {
    console.log("tmux agent integration tests passed");
  })
  .finally(() => {
    spawnSync("tmux", ["-S", socketPath, "kill-session", "-t", "AgentAITest"], { encoding: "utf8" });
    restoreEnv("AI_CHAT_SHELL_TMUX_SOCKET", originalEnv.socket);
    restoreEnv("AI_CHAT_SHELL_STATE_DIR", originalEnv.state);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });

async function main() {
  assert.equal(commandExists("tmux"), true, "tmux agent integration tests require tmux on PATH.");
  resetAgentHubForTests();
  runTmux(["new-session", "-d", "-s", "AgentAITest", "-n", "ai", "/bin/cat"]);

  let response = handleAgentHubMessage({
    type: "agent-register",
    agentId: "master",
    role: "master",
    origin: "https://chatgpt.com",
    pathname: "/c/agent-test"
  }, 1000);
  assert.equal(response.ok, true);

  response = await handleAgentHubMessageAsync({
    type: "agent-register-tmux-ai",
    agentId: "slave-tmux",
    role: "slave",
    target: "AgentAITest:0.0"
  }, 1100);
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.agent.agentId, "slave-tmux");
  assert.equal(response.agent.role, "slave");
  assert.equal(response.agent.surface, "tmux-ai");
  assert.equal(response.agent.replyMode, "cli");
  assert.match(response.agent.tmuxTargetName, /AgentAITest:0\.0/);

  const taskBody = [
    "Inspect the repository state.",
    "Reply with a concise summary."
  ].join("\n");
  response = await handleAgentHubMessageAsync({
    type: "agent-send",
    from: "master",
    to: "slave-tmux",
    taskId: "task-tmux-001",
    messageId: "msg-tmux-001",
    body: taskBody
  }, 1200);
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.message.deliverySurface, "tmux-ai");
  assert.equal(response.message.replyMode, "cli");
  assert.equal(response.message.ackedAt, 1200);
  assert.equal(response.delivery.status, "delivered");
  assert.match(response.delivery.replyBodyFile, /msg-tmux-001-slave-tmux\.md$/);
  assert.match(response.delivery.replyScriptFile, /msg-tmux-001-slave-tmux-reply\.sh$/);
  assert.match(response.delivery.replyCommand, /^sh '/);
  assert.match(response.delivery.replyCommand, /msg-tmux-001-slave-tmux-reply\.sh'/);
  assert.match(response.delivery.fullReplyCommand, /server\/agent_reply_cli\.js/);
  assert.match(response.delivery.fullReplyCommand, /--reply-to 'msg-tmux-001'/);
  assert.match(response.delivery.nextStep, /write its final answer/);
  const replyScript = fs.readFileSync(response.delivery.replyScriptFile, "utf8");
  assert.match(replyScript, /server\/agent_reply_cli\.js/);
  assert.match(replyScript, /--from 'slave-tmux'/);
  assert.match(replyScript, /--to 'master'/);
  assert.match(replyScript, /--reply-to 'msg-tmux-001'/);

  const paneText = capturePane("AgentAITest:0.0");
  assert.match(paneText, /You are registered as a local tmux AI agent/);
  assert.match(paneText, /Reply path is explicit/);
  assert.match(paneText, /Agent id: slave-tmux/);
  assert.match(paneText, /Task from: master/);
  assert.match(paneText, /Task id: task-tmux-001/);
  assert.match(paneText, /Message id: msg-tmux-001/);
  assert.match(paneText, /Inspect the repository state/);
  assert.match(paneText, /Reply command \(short\):/);
  assert.match(paneText, /Do not reconstruct or memorize the long agent_reply_cli\.js command/);
  assert.match(paneText, /msg-tmux-001-slave-tmux-reply\.sh/);
  assert.match(paneText, new RegExp(escapeRegExp(path.join(stateDir, "agent-replies", "msg-tmux-001-slave-tmux.md"))));

  response = handleAgentHubMessage({
    type: "agent-task-status",
    agentId: "master",
    messageId: "msg-tmux-001"
  }, 1250);
  assert.equal(response.ok, true);
  assert.equal(response.status, "waiting-for-tmux-ai-reply");
  assert.match(response.nextAction, /tmux-ai pane/);

  response = handleAgentHubMessage({
    type: "agent-reply",
    from: "slave-tmux",
    to: "master",
    taskId: "task-tmux-001",
    replyTo: "msg-tmux-001",
    messageId: "reply-tmux-001",
    body: "tmux AI completed the task."
  }, 1300);
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.message.from, "slave-tmux");
  assert.equal(response.message.to, "master");
  assert.equal(response.message.replyTo, "msg-tmux-001");

  response = handleAgentHubMessage({
    type: "agent-poll",
    agentId: "master"
  }, 1400);
  assert.equal(response.ok, true);
  assert.equal(response.messages.length, 1);
  assert.equal(response.messages[0].body, "tmux AI completed the task.");
  assert.equal(response.messages[0].replyTo, "msg-tmux-001");

  response = handleAgentHubMessage({
    type: "agent-reply",
    from: "slave-tmux",
    to: "master",
    taskId: "task-tmux-001",
    replyTo: "msg-tmux-001",
    body: "duplicate"
  }, 1500);
  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "duplicate-reply");

  response = await handleAgentHubMessageAsync({
    type: "agent-send",
    from: "master",
    to: "slave-tmux",
    taskId: "task-tmux-002",
    messageId: "msg-tmux-002",
    body: "Second task."
  }, 1550);
  assert.equal(response.ok, true, JSON.stringify(response));

  response = handleAgentHubMessage({
    type: "agent-register",
    agentId: "other-master",
    role: "master",
    origin: "https://chatgpt.com",
    pathname: "/c/other"
  }, 1560);
  assert.equal(response.ok, true);

  response = handleAgentHubMessage({
    type: "agent-reply",
    from: "slave-tmux",
    to: "other-master",
    taskId: "task-tmux-002",
    replyTo: "msg-tmux-002",
    body: "wrong recipient"
  }, 1570);
  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "reply-recipient-mismatch");

  response = handleAgentHubMessage({
    type: "agent-reply",
    from: "slave-tmux",
    to: "master",
    taskId: "task-wrong",
    replyTo: "msg-tmux-002",
    body: "wrong task"
  }, 1580);
  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "reply-task-mismatch");

  response = await handleAgentHubMessageAsync({
    type: "agent-register-tmux-ai",
    agentId: "missing-tmux",
    role: "slave",
    target: "AgentAITest:missing"
  }, 1600);
  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "tmux-target-not-found");

  response = handleAgentHubMessage({
    type: "agent-list"
  }, 70_000);
  assert.equal(response.ok, true);
  assert.ok(response.agents.some((agent) => agent.agentId === "slave-tmux" && agent.surface === "tmux-ai"));

  runTmux(["kill-session", "-t", "AgentAITest"]);
  response = await handleAgentHubMessageAsync({
    type: "agent-list"
  }, 70_100);
  assert.equal(response.ok, true);
  const staleAgent = response.agents.find((agent) => agent.agentId === "slave-tmux");
  assert.equal(staleAgent.surface, "tmux-ai");
  assert.equal(staleAgent.canReceiveTask, false);
  assert.equal(staleAgent.stale, true);
  assert.match(staleAgent.staleReason, /tmux pane/);
}

function runTmux(args) {
  const result = spawnSync("tmux", ["-S", socketPath, ...args], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, `tmux ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result;
}

function capturePane(target) {
  return runTmux(["capture-pane", "-p", "-J", "-S", "-200", "-t", target]).stdout;
}

function commandExists(command) {
  return spawnSync("which", [command], { encoding: "utf8" }).status === 0;
}

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
