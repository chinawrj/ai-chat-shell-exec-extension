#!/usr/bin/env node

const assert = require("node:assert/strict");
const {
  handleAgentHubMessage,
  resetAgentHubForTests
} = require("../server/shell_server");

resetAgentHubForTests();

let response = handleAgentHubMessage({
  type: "agent-register",
  agentId: "master",
  role: "master",
  origin: "https://chatgpt.com",
  pathname: "/c/1"
}, 1000);
assert.equal(response.ok, true);
assert.equal(response.agent.agentId, "master");
assert.equal(response.agent.role, "master");
assert.equal(response.agents.length, 1);

response = handleAgentHubMessage({
  type: "agent-register",
  agentId: "slave-a",
  role: "slave",
  origin: "https://localhost:17443",
  pathname: "/tmux-test-page.html"
}, 1100);
assert.equal(response.ok, true);
assert.deepEqual(response.agents.map((agent) => agent.agentId), ["master", "slave-a"]);

response = handleAgentHubMessage({ type: "agent-list" }, 1200);
assert.equal(response.ok, true);
assert.deepEqual(response.agents.map((agent) => agent.agentId), ["master", "slave-a"]);
assert.deepEqual(response.pending, {});

response = handleAgentHubMessage({
  type: "agent-send",
  from: "master",
  to: "slave-a",
  taskId: "task-001",
  body: "Inspect the parser and report back.",
  messageId: "msg-001"
}, 1300);
assert.equal(response.ok, true);
assert.equal(response.message.messageId, "msg-001");
assert.equal(response.message.from, "master");
assert.equal(response.message.to, "slave-a");
assert.equal(response.message.taskId, "task-001");
assert.equal(response.message.ackedAt, 0);

response = handleAgentHubMessage({ type: "agent-list" }, 1400);
assert.deepEqual(response.pending, { "slave-a": 1 });
assert.equal(response.agents.find((agent) => agent.agentId === "slave-a").pendingCount, 1);

response = handleAgentHubMessage({
  type: "agent-poll",
  agentId: "slave-a"
}, 1500);
assert.equal(response.ok, true);
assert.equal(response.registered, true);
assert.equal(response.messages.length, 1);
assert.equal(response.messages[0].body, "Inspect the parser and report back.");

response = handleAgentHubMessage({
  type: "agent-ack",
  agentId: "slave-a",
  messageId: "msg-001"
}, 1600);
assert.equal(response.ok, true);
assert.equal(response.ackedAt, 1600);

response = handleAgentHubMessage({
  type: "agent-poll",
  agentId: "slave-a"
}, 1700);
assert.equal(response.ok, true);
assert.equal(response.messages.length, 0);

response = handleAgentHubMessage({
  type: "agent-send",
  from: "master",
  to: "slave-missing",
  body: "hello",
  messageId: "msg-missing"
}, 1800);
assert.equal(response.ok, false);
assert.equal(response.errorCode, "recipient-not-registered");

response = handleAgentHubMessage({
  type: "agent-poll",
  agentId: "missing-agent"
}, 1900);
assert.equal(response.ok, true);
assert.equal(response.registered, false);

response = handleAgentHubMessage({
  type: "agent-send",
  from: "master-missing",
  to: "slave-a",
  body: "hello",
  messageId: "msg-missing-sender"
}, 2000);
assert.equal(response.ok, false);
assert.equal(response.errorCode, "sender-not-registered");

assert.throws(() => handleAgentHubMessage({
  type: "agent-register",
  agentId: "../bad",
  role: "slave"
}), /Invalid agentId/);

assert.throws(() => handleAgentHubMessage({
  type: "agent-register",
  agentId: "slave-b",
  role: "worker"
}), /Invalid agent role/);

resetAgentHubForTests();
response = handleAgentHubMessage({
  type: "agent-register",
  agentId: "heartbeat-slave",
  role: "slave"
}, 1000);
assert.equal(response.ok, true);
response = handleAgentHubMessage({
  type: "agent-poll",
  agentId: "heartbeat-slave"
}, 60_500);
assert.equal(response.registered, true);
response = handleAgentHubMessage({
  type: "agent-list"
}, 120_000);
assert.deepEqual(response.agents.map((agent) => agent.agentId), ["heartbeat-slave"]);

resetAgentHubForTests();
response = handleAgentHubMessage({
  type: "agent-register",
  agentId: "stale-slave",
  role: "slave"
}, 1000);
assert.equal(response.ok, true);
response = handleAgentHubMessage({
  type: "agent-list"
}, 61_001);
assert.deepEqual(response.agents, []);

console.log("agent hub tests passed");
