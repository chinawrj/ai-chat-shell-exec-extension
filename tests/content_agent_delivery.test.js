#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadContentContext() {
  const context = {
    CSS: { escape: (value) => String(value) },
    Element: class Element {},
    InputEvent: class InputEvent {},
    MutationObserver: class MutationObserver {},
    Node: {
      DOCUMENT_POSITION_FOLLOWING: 4,
      DOCUMENT_POSITION_PRECEDING: 2
    },
    chrome: {
      runtime: { id: "lkmeogidbglhedgekjgbpbfjkpapnhke" },
      storage: {
        onChanged: { addListener() {} },
        sync: { get: async () => ({ enabled: false }) },
        local: { get: async () => ({}) }
      }
    },
    clearTimeout,
    console,
    document: {
      activeElement: null,
      getElementById: () => null,
      removeEventListener() {}
    },
    location: {
      hostname: "chatgpt.com",
      href: "https://chatgpt.com/c/agent-test",
      origin: "https://chatgpt.com",
      pathname: "/c/agent-test",
      protocol: "https:"
    },
    setTimeout,
    window: {
      confirm: () => true,
      removeEventListener() {}
    }
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, "..", "extension", "src", "content.js"), "utf8");
  vm.runInContext(source, context, { filename: "content.js" });
  return context;
}

async function testAutoReregisterWhenRosterIsLost() {
  const context = loadContentContext();
  const messages = [];
  const statuses = [];
  context.getCurrentAgentProfile = async () => ({ role: "slave", agentId: "slave-a" });
  context.setStatus = (text, state) => statuses.push({ text, state });
  context.chrome.runtime.sendMessage = async (message) => {
    messages.push(message);
    if (message.type === "agent-poll") {
      return { ok: true, type: "agent-poll", registered: false, messages: [] };
    }
    if (message.type === "agent-register") {
      return { ok: true, type: "agent-register", agent: { agentId: message.agentId, role: message.role } };
    }
    throw new Error(`Unexpected message type: ${message.type}`);
  };

  await context.pollAndDeliverAgentMessage();

  assert.deepEqual(messages.map((message) => message.type), ["agent-poll", "agent-register"]);
  assert.equal(messages[1].type, "agent-register");
  assert.equal(messages[1].agentId, "slave-a");
  assert.equal(messages[1].role, "slave");
  assert.equal(messages[1].origin, "https://chatgpt.com");
  assert.equal(messages[1].pathname, "/c/agent-test");
  assert.equal(statuses.at(-1).text, "Re-registered slave slave-a");
  assert.equal(statuses.at(-1).state, "ok");
}

async function testUnsentAgentMessageIsNotInsertedTwice() {
  const context = loadContentContext();
  const sentMessages = [];
  let insertCount = 0;
  let clickCount = 0;
  context.getCurrentAgentProfile = async () => ({ role: "slave", agentId: "slave-a" });
  context.setStatus = () => {};
  context.insertReply = async (text) => {
    insertCount += 1;
    assert.match(text, /Message from master for task task-001:/);
  };
  context.clickSendWhenReady = async () => {
    clickCount += 1;
    return false;
  };
  context.chrome.runtime.sendMessage = async (message) => {
    sentMessages.push(message);
    if (message.type === "agent-poll") {
      return {
        ok: true,
        type: "agent-poll",
        registered: true,
        messages: [{
          messageId: "msg-001",
          from: "master",
          to: "slave-a",
          taskId: "task-001",
          body: "Do the work."
        }]
      };
    }
    throw new Error(`Unexpected message type: ${message.type}`);
  };

  await context.pollAndDeliverAgentMessage();
  await context.pollAndDeliverAgentMessage();

  assert.equal(insertCount, 1);
  assert.equal(clickCount, 2);
  assert.deepEqual(sentMessages.map((message) => message.type), ["agent-poll", "agent-poll"]);
}

(async () => {
  await testAutoReregisterWhenRosterIsLost();
  await testUnsentAgentMessageIsNotInsertedTwice();
  console.log("content agent delivery tests passed");
})();
