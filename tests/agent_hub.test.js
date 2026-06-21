#!/usr/bin/env node

const assert = require("node:assert/strict");
const {
  handleAgentHubMessage,
  pruneAgentMailboxItems,
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
assert.equal(response.agent.surface, "web");
assert.equal(response.agent.replyMode, "poll");
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
  type: "agent-send",
  from: "slave-a",
  to: "master",
  taskId: "task-001",
  replyTo: "msg-001",
  body: "Parser inspected; no issue found.",
  messageId: "reply-msg-001"
}, 1650);
assert.equal(response.ok, true);
assert.equal(response.message.replyTo, "msg-001");
assert.equal(response.message.deliverySurface, "web");
assert.equal(response.message.replyMode, "poll");

response = handleAgentHubMessage({
  type: "agent-poll",
  agentId: "master"
}, 1660);
assert.equal(response.ok, true);
assert.equal(response.messages.length, 1);
assert.equal(response.messages[0].replyTo, "msg-001");
assert.equal(response.messages[0].body, "Parser inspected; no issue found.");

response = handleAgentHubMessage({
  type: "agent-send",
  from: "slave-a",
  to: "master",
  taskId: "task-001",
  replyTo: "msg-001",
  body: "duplicate report",
  messageId: "reply-msg-001-duplicate"
}, 1665);
assert.equal(response.ok, false);
assert.equal(response.errorCode, "duplicate-reply");
assert.match(response.nextAction, /Do not rerun/);

response = handleAgentHubMessage({
  type: "agent-send",
  from: "slave-a",
  to: "master",
  taskId: "task-missing",
  replyTo: "msg-not-found",
  body: "cannot correlate",
  messageId: "reply-msg-missing"
}, 1666);
assert.equal(response.ok, false);
assert.equal(response.errorCode, "reply-target-not-found");
assert.match(response.nextAction, /Copy the reply-to value/);

response = handleAgentHubMessage({
  type: "agent-send",
  from: "master",
  to: "slave-a",
  taskId: "task-002",
  body: "Second task for mismatch tests.",
  messageId: "msg-002"
}, 1667);
assert.equal(response.ok, true);

response = handleAgentHubMessage({
  type: "agent-register",
  agentId: "other-master",
  role: "master",
  origin: "https://chatgpt.com",
  pathname: "/c/other"
}, 1668);
assert.equal(response.ok, true);

response = handleAgentHubMessage({
  type: "agent-send",
  from: "slave-a",
  to: "other-master",
  taskId: "task-002",
  replyTo: "msg-002",
  body: "wrong master route",
  messageId: "reply-msg-wrong-master"
}, 1669);
assert.equal(response.ok, false);
assert.equal(response.errorCode, "reply-recipient-mismatch");
assert.match(response.hint, /route does not match/);

response = handleAgentHubMessage({
  type: "agent-send",
  from: "slave-a",
  to: "master",
  taskId: "task-wrong",
  replyTo: "msg-002",
  body: "wrong task",
  messageId: "reply-msg-wrong-task"
}, 1670);
assert.equal(response.ok, false);
assert.equal(response.errorCode, "reply-task-mismatch");
assert.match(response.nextAction, /Copy the task-id/);

response = handleAgentHubMessage({
  type: "agent-ack",
  agentId: "slave-a",
  messageId: "msg-002"
}, 1675);
assert.equal(response.ok, true);

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
assert.match(response.hint, /target agent is not online/);
assert.match(response.nextAction, /Agent Check|Roster/);

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
handleAgentHubMessage({ type: "agent-register", agentId: "master", role: "master" }, 3000);
handleAgentHubMessage({ type: "agent-register", agentId: "slave-a", role: "slave" }, 3010);
response = handleAgentHubMessage({
  type: "agent-send",
  from: "master",
  to: "slave-a",
  taskId: "task-status",
  messageId: "msg-status",
  body: "Long running status task."
}, 3020);
assert.equal(response.ok, true);
response = handleAgentHubMessage({
  type: "agent-task-status",
  agentId: "master",
  messageId: "msg-status"
}, 3030);
assert.equal(response.ok, true);
assert.equal(response.status, "waiting-for-recipient-poll");
assert.match(response.nextAction, /Wait for slave-a to poll/);
handleAgentHubMessage({ type: "agent-ack", agentId: "slave-a", messageId: "msg-status" }, 3040);
response = handleAgentHubMessage({
  type: "agent-task-status",
  agentId: "master",
  taskId: "task-status"
}, 3050);
assert.equal(response.status, "delivered-waiting-for-reply");
assert.match(response.nextAction, /reply-to msg-status/);
handleAgentHubMessage({
  type: "agent-send",
  from: "slave-a",
  to: "master",
  taskId: "task-status",
  replyTo: "msg-status",
  messageId: "reply-status",
  body: "Status task complete."
}, 3060);
response = handleAgentHubMessage({
  type: "agent-task-status",
  agentId: "master",
  messageId: "msg-status"
}, 3070);
assert.equal(response.status, "replied-waiting-for-master");
assert.equal(response.replyMessage.messageId, "reply-status");
assert.match(response.nextAction, /Open the master page/);

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

const oversizedMailbox = [
  ...Array.from({ length: 12 }, (_unused, index) => ({
    messageId: `acked-${index}`,
    to: "slave-a",
    ackedAt: 2000 + index
  })),
  {
    messageId: "tmux-ai-long-task",
    from: "master",
    to: "slave-tmux",
    ackedAt: 3000,
    deliverySurface: "tmux-ai",
    replyMode: "cli",
    repliedAt: 0
  }
];
const prunedMailbox = pruneAgentMailboxItems(oversizedMailbox, 8);
assert.ok(prunedMailbox.some((item) => item.messageId === "tmux-ai-long-task"));
assert.ok(prunedMailbox.length > 0);

console.log("agent hub tests passed");
