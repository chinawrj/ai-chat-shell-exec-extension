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
  context.agentDeliveryPromptStillPresent = () => true;
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
  assert.deepEqual(sentMessages.map((message) => message.type), ["agent-poll"]);
}

async function testAgentMessageStaysPendingUntilPageIsReady() {
  const context = loadContentContext();
  const sentMessages = [];
  const pendingPanel = {
    hidden: true,
    textContent: ""
  };
  let insertCount = 0;
  let clickCount = 0;
  let ackCount = 0;
  const message = {
    messageId: "reply-001",
    from: "slave-tmux",
    to: "master",
    taskId: "task-cli-001",
    body: "CLI reply body from tmux AI."
  };
  context.document.getElementById = (id) => id === "ai-chat-shell-exec-agent-pending" ? pendingPanel : null;
  context.getCurrentAgentProfile = async () => ({ role: "master", agentId: "master" });
  context.setStatus = () => {};
  context.agentDeliveryPromptStillPresent = () => insertCount > 1;
  context.insertReply = async (text) => {
    insertCount += 1;
    assert.match(text, /Message from slave-tmux for task task-cli-001:/);
    if (insertCount === 1) {
      throw new Error("composer unavailable");
    }
  };
  context.clickSendWhenReady = async () => {
    clickCount += 1;
    return clickCount === 2;
  };
  context.chrome.runtime.sendMessage = async (payload) => {
    sentMessages.push(payload);
    if (payload.type === "agent-poll") {
      return {
        ok: true,
        type: "agent-poll",
        registered: true,
        messages: [message]
      };
    }
    if (payload.type === "agent-ack") {
      ackCount += 1;
      assert.equal(payload.agentId, "master");
      assert.equal(payload.messageId, "reply-001");
      return { ok: true, type: "agent-ack" };
    }
    throw new Error(`Unexpected message type: ${payload.type}`);
  };

  await context.pollAndDeliverAgentMessage();
  assert.equal(insertCount, 1);
  assert.equal(clickCount, 0);
  assert.equal(ackCount, 0);
  assert.equal(pendingPanel.hidden, false);
  assert.match(pendingPanel.textContent, /waiting for chat composer/);
  assert.match(pendingPanel.textContent, /cached in this extension panel/);
  assert.match(pendingPanel.textContent, /Click\/focus the chat composer/);
  assert.match(pendingPanel.textContent, /CLI reply body from tmux AI/);

  await context.pollAndDeliverAgentMessage();
  assert.equal(insertCount, 2);
  assert.equal(clickCount, 1);
  assert.equal(ackCount, 0);
  assert.equal(pendingPanel.hidden, false);
  assert.match(pendingPanel.textContent, /waiting for AI page send readiness/);
  assert.match(pendingPanel.textContent, /Keep this tab open/);

  await context.pollAndDeliverAgentMessage();
  assert.equal(insertCount, 2);
  assert.equal(clickCount, 2);
  assert.equal(ackCount, 1);
  assert.equal(pendingPanel.hidden, true);
  assert.deepEqual(sentMessages.map((payload) => payload.type), ["agent-poll", "agent-ack"]);
}

async function testAgentMessageReinsertsWhenComposerLosesPrompt() {
  const context = loadContentContext();
  const sentMessages = [];
  let insertCount = 0;
  let clickCount = 0;
  let promptPresent = false;
  context.getCurrentAgentProfile = async () => ({ role: "master", agentId: "master" });
  context.setStatus = () => {};
  context.agentDeliveryPromptStillPresent = () => promptPresent;
  context.insertReply = async (text) => {
    insertCount += 1;
    promptPresent = true;
    assert.match(text, /Message from slave-a for task task-redraw:/);
  };
  context.clickSendWhenReady = async () => {
    clickCount += 1;
    if (clickCount === 1) {
      promptPresent = false;
      return false;
    }
    return true;
  };
  context.chrome.runtime.sendMessage = async (payload) => {
    sentMessages.push(payload);
    if (payload.type === "agent-poll") {
      return {
        ok: true,
        type: "agent-poll",
        registered: true,
        messages: [{
          messageId: "msg-redraw",
          from: "slave-a",
          to: "master",
          taskId: "task-redraw",
          body: "The composer was redrawn."
        }]
      };
    }
    if (payload.type === "agent-ack") {
      assert.equal(payload.messageId, "msg-redraw");
      return { ok: true, type: "agent-ack" };
    }
    throw new Error(`Unexpected message type: ${payload.type}`);
  };

  await context.pollAndDeliverAgentMessage();
  await context.pollAndDeliverAgentMessage();

  assert.equal(insertCount, 2);
  assert.equal(clickCount, 2);
  assert.deepEqual(sentMessages.map((payload) => payload.type), ["agent-poll", "agent-ack"]);
}

async function testAckFailureDoesNotResendAlreadySubmittedMessage() {
  const context = loadContentContext();
  const sentMessages = [];
  const pendingPanel = {
    hidden: true,
    textContent: ""
  };
  let insertCount = 0;
  let clickCount = 0;
  let ackCount = 0;
  context.document.getElementById = (id) => id === "ai-chat-shell-exec-agent-pending" ? pendingPanel : null;
  context.getCurrentAgentProfile = async () => ({ role: "master", agentId: "master" });
  context.setStatus = () => {};
  context.agentDeliveryPromptStillPresent = () => true;
  context.insertReply = async (text) => {
    insertCount += 1;
    assert.match(text, /Message from slave-a for task task-ack:/);
  };
  context.clickSendWhenReady = async () => {
    clickCount += 1;
    return true;
  };
  context.chrome.runtime.sendMessage = async (payload) => {
    sentMessages.push(payload);
    if (payload.type === "agent-poll") {
      return {
        ok: true,
        type: "agent-poll",
        registered: true,
        messages: [{
          messageId: "msg-ack",
          from: "slave-a",
          to: "master",
          taskId: "task-ack",
          body: "Ack should be retried without resending."
        }]
      };
    }
    if (payload.type === "agent-ack") {
      ackCount += 1;
      return ackCount === 1
        ? { ok: false, error: "server temporarily unavailable" }
        : { ok: true, type: "agent-ack" };
    }
    throw new Error(`Unexpected message type: ${payload.type}`);
  };

  await context.pollAndDeliverAgentMessage();
  assert.equal(insertCount, 1);
  assert.equal(clickCount, 1);
  assert.equal(ackCount, 1);
  assert.equal(pendingPanel.hidden, false);
  assert.match(pendingPanel.textContent, /sent to AI page; waiting to ack local hub/);
  assert.match(pendingPanel.textContent, /retry only the local ack/);
  assert.match(pendingPanel.textContent, /Last issue: server temporarily unavailable/);

  await context.pollAndDeliverAgentMessage();
  assert.equal(insertCount, 1);
  assert.equal(clickCount, 1);
  assert.equal(ackCount, 2);
  assert.equal(pendingPanel.hidden, true);
  assert.deepEqual(sentMessages.map((payload) => payload.type), ["agent-poll", "agent-ack", "agent-ack"]);
}

async function testProfileChangeClearsLocalPendingDelivery() {
  const context = loadContentContext();
  const sentMessages = [];
  let currentProfile = { role: "master", agentId: "master" };
  let insertCount = 0;
  let clickCount = 0;
  const statuses = [];
  context.getCurrentAgentProfile = async () => currentProfile;
  context.setStatus = (text, state) => statuses.push({ text, state });
  context.insertReply = async () => {
    insertCount += 1;
  };
  context.clickSendWhenReady = async () => {
    clickCount += 1;
    return false;
  };
  context.chrome.runtime.sendMessage = async (payload) => {
    sentMessages.push(payload);
    if (payload.type === "agent-poll" && payload.agentId === "master") {
      return {
        ok: true,
        type: "agent-poll",
        registered: true,
        messages: [{
          messageId: "msg-old-master",
          from: "slave-a",
          to: "master",
          taskId: "task-old",
          body: "Old master message."
        }]
      };
    }
    if (payload.type === "agent-poll" && payload.agentId === "master-2") {
      return {
        ok: true,
        type: "agent-poll",
        registered: true,
        messages: []
      };
    }
    throw new Error(`Unexpected message: ${JSON.stringify(payload)}`);
  };

  await context.pollAndDeliverAgentMessage();
  currentProfile = { role: "master", agentId: "master-2" };
  await context.pollAndDeliverAgentMessage();

  assert.equal(insertCount, 1);
  assert.equal(clickCount, 1);
  assert.deepEqual(sentMessages.map((payload) => `${payload.type}:${payload.agentId}`), ["agent-poll:master", "agent-poll:master-2"]);
  assert.match(statuses.at(-1).text, /Cleared pending agent delivery after profile changed to master-2/);
}

async function testMasterPanelRegistersTmuxAiSlave() {
  const context = loadContentContext();
  const sentMessages = [];
  const elements = {
    tmuxId: { value: "slave-tmux" },
    tmuxTarget: { value: "ClaudeSlave:0.0" }
  };
  context.document.querySelector = (selector) => {
    if (selector.includes("[data-shell-tmux-ai-id]")) {
      return elements.tmuxId;
    }
    if (selector.includes("[data-shell-tmux-ai-target]")) {
      return elements.tmuxTarget;
    }
    return null;
  };
  context.getCurrentAgentProfile = async () => ({ role: "master", agentId: "master" });
  context.setStatus = () => {};
  context.chrome.runtime.sendMessage = async (payload) => {
    sentMessages.push(payload);
    if (payload.type === "agent-register-tmux-ai") {
      return {
        ok: true,
        type: "agent-register-tmux-ai",
        agent: {
          agentId: payload.agentId,
          role: payload.role,
          surface: "tmux-ai"
        },
        agents: []
      };
    }
    throw new Error(`Unexpected message type: ${payload.type}`);
  };

  const response = await context.registerTmuxAiSlaveFromPanel();

  assert.equal(response.ok, true);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].type, "agent-register-tmux-ai");
  assert.equal(sentMessages[0].agentId, "slave-tmux");
  assert.equal(sentMessages[0].role, "slave");
  assert.equal(sentMessages[0].target, "ClaudeSlave:0.0");
}

async function testTmuxAiRegistrationExplainsMissingMaster() {
  const context = loadContentContext();
  context.document.querySelector = () => ({ value: "slave-tmux" });
  context.getCurrentAgentProfile = async () => ({ role: "none", agentId: "" });

  await assert.rejects(
    () => context.registerTmuxAiSlaveFromPanel(),
    /choose role master, enter an agent id, then click Save/
  );
}

async function testTmuxAiRegistrationExplainsInvalidSlaveId() {
  const context = loadContentContext();
  context.document.querySelector = (selector) => {
    if (selector.includes("[data-shell-tmux-ai-id]")) {
      return { value: "" };
    }
    if (selector.includes("[data-shell-tmux-ai-target]")) {
      return { value: "ClaudeSlave:0.0" };
    }
    return null;
  };
  context.getCurrentAgentProfile = async () => ({ role: "master", agentId: "master" });

  await assert.rejects(
    () => context.registerTmuxAiSlaveFromPanel(),
    /slave id is required/
  );
}

async function testTmuxAiRegistrationExplainsMissingTarget() {
  const context = loadContentContext();
  const target = { value: "" };
  context.document.querySelector = (selector) => {
    if (selector.includes("[data-shell-tmux-ai-id]")) {
      return { value: "slave-tmux" };
    }
    if (selector.includes("[data-shell-tmux-ai-target]")) {
      return target;
    }
    return null;
  };
  context.getCurrentAgentProfile = async () => ({ role: "master", agentId: "master" });
  context.refreshTmuxAiTargetOptions = async () => [];

  await assert.rejects(
    () => context.registerTmuxAiSlaveFromPanel(),
    /Click Refresh, then select the tmux window/
  );
}

async function testAgentMessageOutputExplainsTmuxAiDelivery() {
  const context = loadContentContext();
  const output = context.formatAgentMessageOutput({
    to: "slave-tmux",
    taskId: "task-001"
  }, {
    ok: true,
    durationMs: 12,
    message: {
      from: "master",
      to: "slave-tmux",
      taskId: "task-001",
      messageId: "msg-001"
    },
    delivery: {
      surface: "tmux-ai",
      replyBodyFile: "/tmp/agent-replies/msg-001-slave-tmux.md",
      replyScriptFile: "/tmp/agent-replies/msg-001-slave-tmux-reply.sh",
      replyCommand: "sh '/tmp/agent-replies/msg-001-slave-tmux-reply.sh'",
      nextStep: "Write final answer to the reply file, then run the short reply script command."
    }
  }, 1000);

  assert.match(output, /delivery: tmux-ai/);
  assert.match(output, /replyBodyFile: \/tmp\/agent-replies\/msg-001-slave-tmux\.md/);
  assert.match(output, /replyScriptFile: \/tmp\/agent-replies\/msg-001-slave-tmux-reply\.sh/);
  assert.match(output, /replyCommand: sh '\/tmp\/agent-replies\/msg-001-slave-tmux-reply\.sh'/);
  assert.match(output, /nextStep: Write final answer/);
  assert.match(output, /statusQuery:\n````\nai-helper-agent-task-status-start\nmessage-id: msg-001\nai-helper-agent-task-status-end\n````/);
}

async function testAgentMessageFailureOutputShowsNextAction() {
  const context = loadContentContext();
  const output = context.formatAgentMessageOutput({
    to: "slave-missing",
    taskId: "task-404"
  }, {
    ok: false,
    errorCode: "recipient-not-registered",
    error: "Agent recipient is not registered: slave-missing",
    hint: "The target agent is not online in the local agent hub.",
    nextAction: "Open the target web page or register the tmux-ai pane, then run Agent Check."
  }, 2000);

  assert.match(output, /Agent message failed/);
  assert.match(output, /hint: The target agent is not online/);
  assert.match(output, /nextAction: Open the target web page/);
  assert.match(output, /aiNextAction: Run ai-helper-agent-roster-start with role: slave/);
}

async function testAgentRosterHelperDispatchesAndFormatsSlaveCapabilities() {
  const context = loadContentContext();
  const sentMessages = [];
  let replyText = "";
  let clickCount = 0;
  context.getCurrentAgentProfile = async () => ({ role: "master", agentId: "master" });
  context.setStatus = () => {};
  context.insertReply = async (text) => {
    replyText = text;
  };
  context.clickSendWhenReady = async () => {
    clickCount += 1;
    return true;
  };
  context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: true });
  context.chrome.runtime.sendMessage = async (payload) => {
    sentMessages.push(payload);
    if (payload.type === "agent-list") {
      return {
        ok: true,
        agents: [
          { agentId: "master", role: "master", surface: "web", replyMode: "poll", pendingCount: 0, canReceiveTask: false, capabilities: ["agent-message"], lastSeenAgeMs: 12 },
          { agentId: "slave-a", role: "slave", surface: "web", replyMode: "poll", pendingCount: 1, canReceiveTask: true, capabilities: ["receive-task", "per-agent-shell-workspace"], lastSeenAgeMs: 20 },
          { agentId: "slave-tmux", role: "slave", surface: "tmux-ai", replyMode: "cli", pendingCount: 0, canReceiveTask: true, capabilities: ["receive-task", "short-reply-script"], lastSeenAgeMs: 0, tmuxTargetName: "Claude:0.0" }
        ]
      };
    }
    throw new Error(`Unexpected message type: ${payload.type}`);
  };

  const call = context.parseCallPayload([
    "ai-helper-agent-roster-start",
    "role: slave",
    "ai-helper-agent-roster-end"
  ].join("\n"));
  await context.runAndReply("call-roster", call);

  assert.deepEqual(sentMessages.map((payload) => payload.type), ["agent-list"]);
  assert.equal(clickCount, 1);
  assert.match(replyText, /Agent roster result/);
  assert.match(replyText, /requester: master/);
  assert.match(replyText, /filterRole: slave/);
  assert.match(replyText, /count: 2/);
  assert.match(replyText, /- slave-a role=slave surface=web replyMode=poll pending=1 canReceiveTask=true lastSeenAgeMs=20 capabilities=receive-task,per-agent-shell-workspace/);
  assert.match(replyText, /- slave-tmux role=slave surface=tmux-ai replyMode=cli pending=0 canReceiveTask=true lastSeenAgeMs=0 capabilities=receive-task,short-reply-script tmux=Claude:0\.0/);
  assert.match(replyText, /nextAction: Send agent-message helpers to exact slave ids/);
}

async function testAgentRosterHelperRequiresRegisteredPage() {
  const context = loadContentContext();
  let replyText = "";
  context.getCurrentAgentProfile = async () => ({ role: "none", agentId: "" });
  context.setStatus = () => {};
  context.insertReply = async (text) => {
    replyText = text;
  };
  context.clickSendWhenReady = async () => true;
  context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: true });
  const call = context.parseCallPayload([
    "ai-helper-agent-roster-start",
    "ai-helper-agent-roster-end"
  ].join("\n"));

  await context.runAndReply("call-roster-missing-agent", call);

  assert.match(replyText, /Agent roster query failed/);
  assert.match(replyText, /Current page is not configured as an agent/);
}

async function testAgentTaskStatusHelperDispatchesAndFormatsNextAction() {
  const context = loadContentContext();
  const sentMessages = [];
  let replyText = "";
  context.getCurrentAgentProfile = async () => ({ role: "master", agentId: "master" });
  context.setStatus = () => {};
  context.insertReply = async (text) => {
    replyText = text;
  };
  context.clickSendWhenReady = async () => true;
  context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: true });
  context.chrome.runtime.sendMessage = async (payload) => {
    sentMessages.push(payload);
    if (payload.type === "agent-task-status") {
      return {
        ok: true,
        agentId: "master",
        status: "waiting-for-tmux-ai-reply",
        ageMs: 5000,
        nextAction: "Keep the tmux-ai pane running.",
        message: {
          messageId: "msg-001",
          taskId: "task-001",
          from: "master",
          to: "slave-tmux",
          deliverySurface: "tmux-ai",
          replyMode: "cli"
        }
      };
    }
    throw new Error(`Unexpected message type: ${payload.type}`);
  };

  const call = context.parseCallPayload([
    "ai-helper-agent-task-status-start",
    "message-id: msg-001",
    "ai-helper-agent-task-status-end"
  ].join("\n"));
  await context.runAndReply("call-status", call);

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].type, "agent-task-status");
  assert.equal(sentMessages[0].agentId, "master");
  assert.equal(sentMessages[0].messageId, "msg-001");
  assert.equal(sentMessages[0].taskId, "");
  assert.match(replyText, /Agent task status result/);
  assert.match(replyText, /status: waiting-for-tmux-ai-reply/);
  assert.match(replyText, /delivery: tmux-ai/);
  assert.match(replyText, /replyMode: cli/);
  assert.match(replyText, /nextAction: Keep the tmux-ai pane running/);
}

async function testAgentSetupCheckExplainsMissingTmuxAiSlave() {
  const context = loadContentContext();
  const statuses = [];
  context.getCurrentAgentProfile = async () => ({ role: "master", agentId: "master" });
  context.setStatus = (text, state) => statuses.push({ text, state });
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "agent-list") {
      return {
        ok: true,
        agents: [{ agentId: "master", role: "master", surface: "web" }]
      };
    }
    if (payload.type === "tmux-list") {
      return {
        ok: true,
        panes: [{ address: "Claude:0.0", windowName: "Claude" }]
      };
    }
    throw new Error(`Unexpected message type: ${payload.type}`);
  };

  const result = await context.runAgentSetupCheck();

  assert.equal(result.ok, false);
  assert.match(statuses.at(-1).text, /tmux-ai slaves: none/);
  assert.match(statuses.at(-1).text, /select the AI tmux pane, then click Register/);
  assert.equal(statuses.at(-1).state, "error");
}

async function testAgentSetupCheckExplainsReadyState() {
  const context = loadContentContext();
  const statuses = [];
  context.getCurrentAgentProfile = async () => ({ role: "master", agentId: "master" });
  context.setStatus = (text, state) => statuses.push({ text, state });
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "agent-list") {
      return {
        ok: true,
        agents: [
          { agentId: "master", role: "master", surface: "web" },
          { agentId: "slave-tmux", role: "slave", surface: "tmux-ai", tmuxTargetName: "Claude:0.0" }
        ]
      };
    }
    if (payload.type === "tmux-list") {
      return {
        ok: true,
        panes: [{ address: "Claude:0.0", windowName: "Claude" }]
      };
    }
    throw new Error(`Unexpected message type: ${payload.type}`);
  };

  const result = await context.runAgentSetupCheck();

  assert.equal(result.ok, true);
  assert.match(statuses.at(-1).text, /Ready: ask the master AI/);
  assert.match(statuses.at(-1).text, /slave-tmux@Claude:0\.0/);
  assert.equal(statuses.at(-1).state, "ok");
}

(async () => {
  await testAutoReregisterWhenRosterIsLost();
  await testUnsentAgentMessageIsNotInsertedTwice();
  await testAgentMessageStaysPendingUntilPageIsReady();
  await testAgentMessageReinsertsWhenComposerLosesPrompt();
  await testAckFailureDoesNotResendAlreadySubmittedMessage();
  await testProfileChangeClearsLocalPendingDelivery();
  await testMasterPanelRegistersTmuxAiSlave();
  await testTmuxAiRegistrationExplainsMissingMaster();
  await testTmuxAiRegistrationExplainsInvalidSlaveId();
  await testTmuxAiRegistrationExplainsMissingTarget();
  await testAgentMessageOutputExplainsTmuxAiDelivery();
  await testAgentMessageFailureOutputShowsNextAction();
  await testAgentRosterHelperDispatchesAndFormatsSlaveCapabilities();
  await testAgentRosterHelperRequiresRegisteredPage();
  await testAgentTaskStatusHelperDispatchesAndFormatsNextAction();
  await testAgentSetupCheckExplainsMissingTmuxAiSlave();
  await testAgentSetupCheckExplainsReadyState();
  console.log("content agent delivery tests passed");
})();
