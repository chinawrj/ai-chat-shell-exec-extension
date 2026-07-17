#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadContentContext(options = {}) {
  const localStore = options.localStore || {};
  const sessionStore = options.sessionStore || {};
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
        local: {
          get: async (keys) => {
            if (Array.isArray(keys)) {
              return Object.fromEntries(keys.map((key) => [key, localStore[key]]));
            }
            if (typeof keys === "string") {
              return { [keys]: localStore[keys] };
            }
            return { ...localStore };
          },
          set: async (values) => {
            Object.assign(localStore, values || {});
          },
          remove: async (keys) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              delete localStore[key];
            }
          }
        }
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
      removeEventListener() {},
      sessionStorage: {
        getItem: (key) => Object.prototype.hasOwnProperty.call(sessionStore, key) ? sessionStore[key] : null,
        setItem: (key, value) => {
          sessionStore[key] = String(value);
        },
        removeItem: (key) => {
          delete sessionStore[key];
        }
      }
    }
  };
  context.__localStore = localStore;
  context.__sessionStore = sessionStore;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, "..", "extension", "src", "content.js"), "utf8");
  vm.runInContext(source, context, { filename: "content.js" });
  return context;
}

function mockComposerWithText(text) {
  return {
    innerText: String(text || ""),
    textContent: String(text || ""),
    isConnected: true
  };
}

async function testSavedOriginProfileDoesNotAutoPollNewTab() {
  const context = loadContentContext({
    localStore: {
      "agentProfile:https://chatgpt.com": { role: "master", agentId: "master" }
    }
  });
  const sentMessages = [];
  context.setStatus = () => {};
  context.chrome.runtime.sendMessage = async (message) => {
    sentMessages.push(message);
    return { ok: true, messages: [] };
  };

  await context.pollAndDeliverAgentMessage();

  assert.deepEqual(sentMessages, []);
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
  let composerText = "";
  context.getCurrentAgentProfile = async () => ({ role: "slave", agentId: "slave-a" });
  context.setStatus = () => {};
  context.agentDeliveryPromptStillPresent = () => true;
  context.getComposerText = () => composerText;
  context.insertReply = async (text) => {
    insertCount += 1;
    composerText = text;
    assert.match(text, /Message from master for task task-001:/);
    return mockComposerWithText(text);
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
  let composerText = "";
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
  context.getComposerText = () => composerText;
  context.insertReply = async (text) => {
    insertCount += 1;
    assert.match(text, /Message from slave-tmux for task task-cli-001:/);
    if (insertCount === 1) {
      throw new Error("composer unavailable");
    }
    composerText = text;
    return mockComposerWithText(text);
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
  assert.match(pendingPanel.textContent, /Bind send/);

  await context.pollAndDeliverAgentMessage();
  assert.equal(insertCount, 2);
  assert.equal(clickCount, 2);
  assert.equal(ackCount, 1);
  assert.equal(pendingPanel.hidden, true);
  assert.deepEqual(sentMessages.map((payload) => payload.type), ["agent-poll", "agent-ack"]);
}

async function testDeletedAgentPromptIsCancelledInsteadOfReinserted() {
  const context = loadContentContext();
  const sentMessages = [];
  let insertCount = 0;
  let clickCount = 0;
  let ackCount = 0;
  let composer = null;
  context.getCurrentAgentProfile = async () => ({ role: "master", agentId: "master" });
  context.setStatus = () => {};
  context.insertReply = async (text) => {
    insertCount += 1;
    assert.match(text, /Message from slave-a for task task-redraw:/);
    composer = mockComposerWithText(text);
    return composer;
  };
  context.findReplyInput = async () => composer;
  context.clickSendWhenReady = async () => {
    clickCount += 1;
    if (clickCount === 1) {
      composer.innerText = "";
      composer.textContent = "";
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
          body: "The user intentionally deleted this prompt."
        }]
      };
    }
    if (payload.type === "agent-ack") {
      ackCount += 1;
      assert.equal(payload.messageId, "msg-redraw");
      return ackCount === 1
        ? { ok: false, error: "local hub temporarily unavailable" }
        : { ok: true, type: "agent-ack" };
    }
    throw new Error(`Unexpected message type: ${payload.type}`);
  };

  await context.pollAndDeliverAgentMessage();
  await context.pollAndDeliverAgentMessage();

  assert.equal(insertCount, 1, "A removed agent prompt must never be written into the composer again.");
  assert.equal(clickCount, 1, "A removed agent prompt must not receive another send attempt.");
  assert.equal(ackCount, 2, "Cancellation may retry only the local hub acknowledgement.");
  assert.deepEqual(sentMessages.map((payload) => payload.type), ["agent-poll", "agent-ack", "agent-ack"]);
}

async function testRedrawnOwnedAgentComposerStillSends() {
  const context = loadContentContext();
  const sentMessages = [];
  let replacementComposer = null;
  let sendComposer = null;
  context.getCurrentAgentProfile = async () => ({ role: "master", agentId: "master" });
  context.setStatus = () => {};
  context.insertReply = async (text) => {
    replacementComposer = mockComposerWithText(text);
    return {
      ...mockComposerWithText(text),
      isConnected: false
    };
  };
  context.findReplyInput = async () => replacementComposer;
  context.clickSendWhenReady = async (composer) => {
    sendComposer = composer;
    return composer === replacementComposer;
  };
  context.chrome.runtime.sendMessage = async (payload) => {
    sentMessages.push(payload);
    if (payload.type === "agent-poll") {
      return {
        ok: true,
        registered: true,
        messages: [{
          messageId: "msg-redrawn-owned-composer",
          from: "slave-a",
          to: "master",
          taskId: "task-redrawn-owned-composer",
          body: "Send this after the page redraws its composer."
        }]
      };
    }
    if (payload.type === "agent-ack") {
      return { ok: true, type: "agent-ack" };
    }
    throw new Error(`Unexpected message type: ${payload.type}`);
  };

  await context.pollAndDeliverAgentMessage();

  assert.equal(sendComposer, replacementComposer, "Agent auto-send must follow exact owned text to the replacement composer node.");
  assert.deepEqual(sentMessages.map((payload) => payload.type), ["agent-poll", "agent-ack"]);
}

async function testExternallySubmittedAgentPromptAcksWithoutReinsertion() {
  const context = loadContentContext();
  const sentMessages = [];
  let insertCount = 0;
  let clickCount = 0;
  let submitted = false;
  context.getCurrentAgentProfile = async () => ({ role: "slave", agentId: "slave-a" });
  context.setStatus = () => {};
  context.countSubmittedMessagesMatching = () => submitted ? 1 : 0;
  context.agentDeliveryPromptStillPresent = () => !submitted;
  context.insertReply = async (text) => {
    insertCount += 1;
    return mockComposerWithText(text);
  };
  context.clickSendWhenReady = async () => {
    clickCount += 1;
    submitted = true;
    return false;
  };
  context.chrome.runtime.sendMessage = async (payload) => {
    sentMessages.push(payload);
    if (payload.type === "agent-poll") {
      return {
        ok: true,
        registered: true,
        messages: [{
          messageId: "msg-external-submit",
          from: "master",
          to: "slave-a",
          taskId: "task-external-submit",
          body: "The page submitted this prompt outside the extension callback."
        }]
      };
    }
    if (payload.type === "agent-ack") {
      return { ok: true, type: "agent-ack" };
    }
    throw new Error(`Unexpected message type: ${payload.type}`);
  };

  await context.pollAndDeliverAgentMessage();
  assert.equal(insertCount, 1);
  assert.equal(clickCount, 1);
  assert.equal(insertCount, 1, "A prompt already present in submitted user messages must not be inserted again.");
  assert.equal(clickCount, 1, "Recovery should ack the externally submitted prompt without another send attempt.");
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
    return mockComposerWithText(text);
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

async function testMissingAckRecordIsIdempotentAfterMessageWasSent() {
  const localStore = {};
  const context = loadContentContext({ localStore });
  const sentMessages = [];
  const pendingPanel = { hidden: true, textContent: "" };
  let insertCount = 0;
  let clickCount = 0;
  context.document.getElementById = (id) => id === "ai-chat-shell-exec-agent-pending" ? pendingPanel : null;
  context.getCurrentAgentProfile = async () => ({ role: "master", agentId: "master" });
  context.setStatus = () => {};
  context.insertReply = async (text) => {
    insertCount += 1;
    return mockComposerWithText(text);
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
        registered: true,
        messages: [{
          messageId: "msg-lost-after-restart",
          from: "slave-a",
          to: "master",
          taskId: "task-restart",
          body: "This was submitted before the hub restarted."
        }]
      };
    }
    if (payload.type === "agent-ack") {
      return { ok: false, errorCode: "message-not-found", error: "mailbox restarted" };
    }
    throw new Error(`Unexpected message type: ${payload.type}`);
  };

  await context.pollAndDeliverAgentMessage();

  assert.equal(insertCount, 1);
  assert.equal(clickCount, 1);
  assert.equal(pendingPanel.hidden, true, "A sent message whose hub record vanished must leave no permanent local blocker.");
  assert.equal(localStore["agentPendingDelivery:https://chatgpt.com:/c/agent-test"], undefined);
  assert.deepEqual(sentMessages.map((payload) => payload.type), ["agent-poll", "agent-ack"]);
}

async function testModifiedAgentPromptIsNeverClickedOrOverwritten() {
  const context = loadContentContext();
  let insertCount = 0;
  let clickCount = 0;
  let ackCount = 0;
  let composerText = "";
  context.getCurrentAgentProfile = async () => ({ role: "master", agentId: "master" });
  context.setStatus = () => {};
  context.getComposerText = () => composerText;
  context.insertReply = async (text) => {
    insertCount += 1;
    composerText = text;
    return mockComposerWithText(text);
  };
  context.clickSendWhenReady = async () => {
    clickCount += 1;
    composerText = `${composerText.slice(0, 100)} USER MODIFIED THIS PROMPT`;
    return false;
  };
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "agent-poll") {
      return {
        ok: true,
        registered: true,
        messages: [{
          messageId: "msg-user-edit",
          from: "slave-a",
          to: "master",
          taskId: "task-user-edit",
          body: "Do not send this if the user edits it."
        }]
      };
    }
    if (payload.type === "agent-ack") {
      ackCount += 1;
      return { ok: true, type: "agent-ack" };
    }
    throw new Error(`Unexpected message type: ${payload.type}`);
  };

  await context.pollAndDeliverAgentMessage();

  assert.equal(insertCount, 1, "A modified pending agent prompt must not be reinserted over user text.");
  assert.equal(clickCount, 1, "A modified pending agent prompt must not trigger another click.");
  assert.equal(ackCount, 1, "Replacing an inserted agent prompt must immediately cancel and acknowledge its delivery.");
  assert.equal(vm.runInContext("pendingAgentDelivery", context), null, "A replaced prompt must not remain pending and block new helpers.");
  assert.match(composerText, /USER MODIFIED THIS PROMPT/);
}

async function testUnrelatedPostInsertionDraftCancelsAgentPrompt() {
  const context = loadContentContext();
  let insertCount = 0;
  let clickCount = 0;
  let ackCount = 0;
  context.getCurrentAgentProfile = async () => ({ role: "master", agentId: "master" });
  context.setStatus = () => {};
  context.insertReply = async () => {
    insertCount += 1;
    return mockComposerWithText("The user's unrelated draft survived the attempted insertion.");
  };
  context.clickSendWhenReady = async () => {
    clickCount += 1;
    return true;
  };
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "agent-poll") {
      return {
        ok: true,
        registered: true,
        messages: [{
          messageId: "msg-rejected-insertion",
          from: "slave-a",
          to: "master",
          taskId: "task-rejected-insertion",
          body: "The intended inbound prompt."
        }]
      };
    }
    if (payload.type === "agent-ack") {
      ackCount += 1;
      return { ok: true, type: "agent-ack" };
    }
    throw new Error(`Unexpected message type: ${payload.type}`);
  };

  await context.pollAndDeliverAgentMessage();

  assert.equal(insertCount, 1);
  assert.equal(clickCount, 0, "A post-insertion value unrelated to the intended prompt must never reach auto-send.");
  assert.equal(ackCount, 1);
  assert.equal(vm.runInContext("pendingAgentDelivery", context), null, "A failed post-write ownership check must cancel instead of blocking future helpers.");
}

async function testPreexistingUserDraftBlocksAgentInsertionAtomically() {
  const context = loadContentContext();
  const composer = {
    value: "User is actively writing this draft",
    innerText: "",
    textContent: "",
    focus() {
      throw new Error("occupied composer must not be focused");
    }
  };
  let clickCount = 0;
  context.getCurrentAgentProfile = async () => ({ role: "master", agentId: "master" });
  context.findReplyInput = async () => composer;
  context.clickSendWhenReady = async () => {
    clickCount += 1;
    return true;
  };
  context.setStatus = () => {};
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "agent-poll") {
      return {
        ok: true,
        registered: true,
        messages: [{
          messageId: "msg-user-draft-guard",
          from: "slave-a",
          to: "master",
          taskId: "task-user-draft-guard",
          body: "Do not overwrite the user's composer."
        }]
      };
    }
    throw new Error(`Unexpected message type: ${payload.type}`);
  };

  await context.pollAndDeliverAgentMessage();

  assert.equal(composer.value, "User is actively writing this draft");
  assert.equal(clickCount, 0);
  const pending = vm.runInContext("pendingAgentDelivery", context);
  assert.equal(pending.sent, false);
  assert.equal(pending.inserted, false);
  assert.equal(pending.composerConflict, true);
  assert.match(pending.lastError, /already contains unsent text/);
}

async function testAgentAckDoesNotHoldComposerLease() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  let resolveAck;
  let ackStarted = false;
  let laterWriterStarted = false;
  context.setStatus = () => {};
  context.insertReply = async (text) => mockComposerWithText(text);
  context.clickSendWhenReady = async () => true;
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "agent-ack") {
      ackStarted = true;
      return new Promise((resolve) => {
        resolveAck = resolve;
      });
    }
    throw new Error(`Unexpected message type: ${payload.type}`);
  };
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);
  const profile = { role: "master", agentId: "master" };
  const message = {
    messageId: "msg-ack-outside-lease",
    from: "slave-a",
    to: "master",
    taskId: "task-ack-outside-lease",
    body: "Release the composer before waiting for ack."
  };

  const delivery = context.deliverAgentMessageToPage(profile, message);
  await waitFor(() => ackStarted && resolveAck, "agent ack to start after composer submission");
  const laterWriter = context.withComposerDeliveryLease({
    kind: "helper-output",
    pageIdentity: context.getCurrentPageIdentity(),
    generation: vm.runInContext("pageLifecycleGeneration", context)
  }, async () => {
    laterWriterStarted = true;
  });
  await waitFor(() => laterWriterStarted, "later composer writer while ack is pending");

  resolveAck({ ok: true, type: "agent-ack" });
  await Promise.all([delivery, laterWriter]);
  assert.equal(laterWriterStarted, true);
}

async function testMasterPromptIdentityPreventsHistoricalFalseAck() {
  const context = loadContentContext();
  const profile = { role: "master", agentId: "master" };
  const base = {
    from: "slave-a",
    to: "master",
    taskId: "same-task",
    body: "Same visible payload."
  };
  const first = context.formatInboundAgentPrompt(profile, { ...base, messageId: "msg-first" });
  const second = context.formatInboundAgentPrompt(profile, { ...base, messageId: "msg-second" });

  assert.notEqual(first, second);
  assert.match(first, /Message id: msg-first/);
  assert.match(second, /Message id: msg-second/);
}

async function testSpaNavigationTransfersExactAgentPromptToSendOnlyRetry() {
  const localStore = {};
  const context = loadContentContext({ localStore });
  let releaseClick;
  let composer = null;
  let insertCount = 0;
  let clickCount = 0;
  let ackCount = 0;
  context.getCurrentAgentProfile = async () => ({ role: "master", agentId: "master" });
  context.setStatus = () => {};
  context.insertReply = async (text) => {
    insertCount += 1;
    composer = mockComposerWithText(text);
    return composer;
  };
  context.findReplyInput = async () => composer;
  context.clickSendWhenReady = async (currentComposer, _shouldContinue, expectedText) => {
    clickCount += 1;
    assert.equal(currentComposer, composer);
    assert.equal(context.getValidatedComposerOwnershipText(currentComposer, expectedText), expectedText);
    if (clickCount === 1) {
      return new Promise((resolve) => {
        releaseClick = resolve;
      });
    }
    return true;
  };
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "agent-poll") {
      return {
        ok: true,
        registered: true,
        messages: [{
          messageId: "msg-spa-cancel",
          from: "slave-a",
          to: "master",
          taskId: "task-spa",
          body: "Do not let the old page click after navigation."
        }]
      };
    }
    if (payload.type === "agent-ack") {
      ackCount += 1;
      return { ok: true };
    }
    throw new Error(`Unexpected message type: ${payload.type}`);
  };

  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);
  const delivery = context.pollAndDeliverAgentMessage();
  await waitFor(() => releaseClick, "agent click attempt before SPA navigation");
  assert.ok(localStore["agentPendingDelivery:https://chatgpt.com:/c/agent-test"]);

  const insertedText = composer.innerText;
  composer.isConnected = false;
  composer = mockComposerWithText(insertedText);
  context.location.pathname = "/c/agent-new";
  context.location.href = "https://chatgpt.com/c/agent-new";
  context.refreshPageLifecycle();
  releaseClick(false);
  await delivery;
  await Promise.resolve();

  assert.equal(ackCount, 0, "The stale pre-route token must not ack.");
  assert.equal(localStore["agentPendingDelivery:https://chatgpt.com:/c/agent-test"], undefined);
  assert.ok(localStore["agentPendingDelivery:https://chatgpt.com:/c/agent-new"], "The pending envelope must migrate under the new page storage key.");
  assert.equal(localStore["agentPendingDelivery:https://chatgpt.com:/c/agent-new"].inserted, true);

  await context.pollAndDeliverAgentMessage();

  assert.equal(insertCount, 1, "SPA route continuity must never rewrite the prompt.");
  assert.equal(clickCount, 2, "The replacement composer should receive send-only retry.");
  assert.equal(ackCount, 1, "Only the successfully submitted prompt may be acknowledged.");
  assert.equal(vm.runInContext("pendingAgentDelivery", context), null);
}

async function testProfileSwitchCancelsOldAgentDeliveryToken() {
  const sessionStore = {
    aiChatShellExecAgentProfile: JSON.stringify({ role: "master", agentId: "master" })
  };
  const localStore = {};
  const context = loadContentContext({ localStore, sessionStore });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  let releaseClick;
  let ackCount = 0;
  context.setStatus = () => {};
  context.insertReply = async (text) => mockComposerWithText(text);
  context.clickSendWhenReady = async () => new Promise((resolve) => {
    releaseClick = resolve;
  });
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "agent-ack") {
      ackCount += 1;
      return { ok: true };
    }
    throw new Error(`Unexpected message type: ${payload.type}`);
  };
  const message = {
    messageId: "msg-profile-cancel",
    from: "slave-a",
    to: "master",
    taskId: "task-profile",
    body: "Old profile must not finish this delivery."
  };

  const delivery = context.deliverAgentMessageToPage({ role: "master", agentId: "master" }, message);
  await waitFor(() => releaseClick, "agent click attempt before profile switch");
  await context.setCurrentAgentProfile("slave", "slave-new");
  releaseClick(true);
  await delivery;
  await Promise.resolve();

  assert.equal(ackCount, 0);
  assert.equal(vm.runInContext("pendingAgentDelivery", context), null);
  assert.equal(localStore["agentPendingDelivery:https://chatgpt.com:/c/agent-test"], undefined);
  assert.deepEqual(JSON.parse(sessionStore.aiChatShellExecAgentProfile), { role: "slave", agentId: "slave-new" });
}

async function testSentPendingAgentDeliverySurvivesReloadWithoutResend() {
  const localStore = {};
  const firstContext = loadContentContext({ localStore });
  let firstInsertCount = 0;
  let firstClickCount = 0;
  let firstAckCount = 0;
  firstContext.getCurrentAgentProfile = async () => ({ role: "master", agentId: "master" });
  firstContext.setStatus = () => {};
  firstContext.agentDeliveryPromptStillPresent = () => true;
  firstContext.insertReply = async (text) => {
    firstInsertCount += 1;
    return mockComposerWithText(text);
  };
  firstContext.clickSendWhenReady = async () => {
    firstClickCount += 1;
    return true;
  };
  firstContext.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "agent-poll") {
      return {
        ok: true,
        type: "agent-poll",
        registered: true,
        messages: [{
          messageId: "msg-reload",
          from: "slave-a",
          to: "master",
          taskId: "task-reload",
          body: "Ack should survive reload."
        }]
      };
    }
    if (payload.type === "agent-ack") {
      firstAckCount += 1;
      return { ok: false, error: "server temporarily unavailable" };
    }
    throw new Error(`Unexpected first payload: ${JSON.stringify(payload)}`);
  };

  await firstContext.pollAndDeliverAgentMessage();

  assert.equal(firstInsertCount, 1);
  assert.equal(firstClickCount, 1);
  assert.equal(firstAckCount, 1);
  assert.ok(localStore["agentPendingDelivery:https://chatgpt.com:/c/agent-test"]);
  assert.equal(localStore["agentPendingDelivery:https://chatgpt.com:/c/agent-test"].sent, true);

  const secondContext = loadContentContext({ localStore });
  const secondMessages = [];
  let secondInsertCount = 0;
  let secondClickCount = 0;
  secondContext.getCurrentAgentProfile = async () => ({ role: "master", agentId: "master" });
  secondContext.setStatus = () => {};
  secondContext.insertReply = async (text) => {
    secondInsertCount += 1;
    return mockComposerWithText(text);
  };
  secondContext.clickSendWhenReady = async () => {
    secondClickCount += 1;
    return true;
  };
  secondContext.chrome.runtime.sendMessage = async (payload) => {
    secondMessages.push(payload);
    if (payload.type === "agent-ack") {
      return { ok: true, type: "agent-ack" };
    }
    throw new Error(`Reload should only retry ack, got: ${JSON.stringify(payload)}`);
  };

  await secondContext.pollAndDeliverAgentMessage();

  assert.equal(secondInsertCount, 0);
  assert.equal(secondClickCount, 0);
  assert.deepEqual(secondMessages.map((payload) => payload.type), ["agent-ack"]);
  assert.equal(localStore["agentPendingDelivery:https://chatgpt.com:/c/agent-test"], undefined);
}

async function testProfileChangeClearsLocalPendingDelivery() {
  const context = loadContentContext();
  const sentMessages = [];
  let currentProfile = { role: "master", agentId: "master" };
  let insertCount = 0;
  let clickCount = 0;
  let composerText = "";
  const statuses = [];
  context.getCurrentAgentProfile = async () => currentProfile;
  context.setStatus = (text, state) => statuses.push({ text, state });
  context.getComposerText = () => composerText;
  context.insertReply = async (text) => {
    insertCount += 1;
    composerText = text;
    return mockComposerWithText(text);
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
  assert.match(output, /statusMessageId: msg-001/);
  assert.match(output, /statusAction: Ask for an agent task-status query/);
  assert.doesNotMatch(output, /^ai-helper-agent-task-status-start$/m);
  assert.doesNotMatch(output, /^ai-helper-agent-task-status-end$/m);
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
    return mockComposerWithText(text);
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
    return mockComposerWithText(text);
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
    return mockComposerWithText(text);
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

async function testAgentSetupCheckExplainsMissingSlave() {
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
  assert.deepEqual(Array.from(result.readySlaves), []);
  assert.match(statuses.at(-1).text, /web slaves: none/);
  assert.match(statuses.at(-1).text, /tmux-ai slaves: none/);
  assert.match(statuses.at(-1).text, /open\/register at least one slave tab/);
  assert.equal(statuses.at(-1).state, "error");
}

async function testAgentSetupCheckAcceptsWebSlave() {
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
          { agentId: "slave-a", role: "slave", surface: "web", canReceiveTask: true }
        ]
      };
    }
    if (payload.type === "tmux-list") {
      return {
        ok: true,
        panes: []
      };
    }
    throw new Error(`Unexpected message type: ${payload.type}`);
  };

  const result = await context.runAgentSetupCheck();

  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.readySlaves, (agent) => agent.agentId), ["slave-a"]);
  assert.match(statuses.at(-1).text, /web slaves: slave-a/);
  assert.match(statuses.at(-1).text, /tmux-ai slaves: none/);
  assert.match(statuses.at(-1).text, /Ready: delegate to slave-a\. Tmux AI is optional/);
  assert.equal(statuses.at(-1).state, "ok");
}

async function testAgentSetupCheckExplainsTmuxAiReadyState() {
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
  assert.deepEqual(Array.from(result.readySlaves, (agent) => agent.agentId), ["slave-tmux"]);
  assert.deepEqual(Array.from(result.tmuxAiStaleAgents), []);
  assert.match(statuses.at(-1).text, /tmux-ai slaves: slave-tmux@Claude:0\.0/);
  assert.match(statuses.at(-1).text, /Ready: delegate to slave-tmux\. Tmux AI is optional/);
  assert.equal(statuses.at(-1).state, "ok");
}

async function testAgentSetupCheckMarksMissingTmuxPaneStale() {
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
          { agentId: "slave-tmux", role: "slave", surface: "tmux-ai", canReceiveTask: true, tmuxTargetName: "Claude:0.0" }
        ]
      };
    }
    if (payload.type === "tmux-list") {
      return {
        ok: true,
        panes: [{ address: "Other:0.0", windowName: "Other" }]
      };
    }
    throw new Error(`Unexpected message type: ${payload.type}`);
  };

  const result = await context.runAgentSetupCheck();

  assert.equal(result.ok, false);
  assert.deepEqual(Array.from(result.readySlaves), []);
  assert.deepEqual(Array.from(result.tmuxAiStaleAgents, (agent) => agent.agentId), ["slave-tmux"]);
  assert.match(statuses.at(-1).text, /tmux-ai slaves: slave-tmux@Claude:0\.0 \(stale\)/);
  assert.match(statuses.at(-1).text, /stale tmux-ai slave-tmux needs a live pane/);
  assert.match(statuses.at(-1).text, /Click Refresh, select the new tmux pane, then Register/);
  assert.equal(statuses.at(-1).state, "error");
}

async function testSlavePollHeartbeatsWhileShellCallIsRunning() {
  const context = loadContentContext();
  const sentMessages = [];
  let releaseAgentList;
  context.getCurrentAgentProfile = async () => ({ role: "slave", agentId: "slave-a" });
  context.setStatus = () => {};
  context.insertReply = async () => {};
  context.clickSendWhenReady = async () => true;
  context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: true });
  context.chrome.runtime.sendMessage = async (payload) => {
    sentMessages.push(payload);
    if (payload.type === "agent-list") {
      return new Promise((resolve) => {
        releaseAgentList = () => resolve({ ok: true, agents: [] });
      });
    }
    if (payload.type === "agent-register") {
      return { ok: true, agents: [{ agentId: "slave-a", role: "slave" }] };
    }
    throw new Error(`Unexpected message type: ${payload.type}`);
  };
  const call = context.parseCallPayload([
    "ai-helper-agent-roster-start",
    "ai-helper-agent-roster-end"
  ].join("\n"));
  const runningCall = context.runAndReply("running-agent-roster", call);
  await waitFor(() => releaseAgentList, "agent-list request to start");

  await context.pollAndDeliverAgentMessage();
  releaseAgentList();
  await runningCall;

  assert.deepEqual(sentMessages.map((payload) => payload.type), ["agent-list", "agent-register"]);
  assert.equal(sentMessages[1].agentId, "slave-a");
  assert.equal(sentMessages[1].role, "slave");
}

async function testAgentPollFailureShowsStatusAfterRetries() {
  const context = loadContentContext();
  const statuses = [];
  context.getCurrentAgentProfile = async () => ({ role: "slave", agentId: "slave-a" });
  context.setStatus = (text, state) => statuses.push({ text, state });
  context.chrome.runtime.sendMessage = async () => {
    throw new Error("local server offline");
  };
  vm.runInContext("extensionActive = false;", context);

  await context.runAgentPollLoop();
  await context.runAgentPollLoop();
  await context.runAgentPollLoop();

  assert.match(statuses.at(-1).text, /Agent polling failing: local server offline/);
  assert.match(statuses.at(-1).text, /Click Agent Check for details/);
  assert.equal(statuses.at(-1).state, "error");
}

async function waitFor(predicate, label) {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

(async () => {
  await testSavedOriginProfileDoesNotAutoPollNewTab();
  await testAutoReregisterWhenRosterIsLost();
  await testUnsentAgentMessageIsNotInsertedTwice();
  await testAgentMessageStaysPendingUntilPageIsReady();
  await testDeletedAgentPromptIsCancelledInsteadOfReinserted();
  await testRedrawnOwnedAgentComposerStillSends();
  await testExternallySubmittedAgentPromptAcksWithoutReinsertion();
  await testAckFailureDoesNotResendAlreadySubmittedMessage();
  await testMissingAckRecordIsIdempotentAfterMessageWasSent();
  await testModifiedAgentPromptIsNeverClickedOrOverwritten();
  await testUnrelatedPostInsertionDraftCancelsAgentPrompt();
  await testPreexistingUserDraftBlocksAgentInsertionAtomically();
  await testAgentAckDoesNotHoldComposerLease();
  await testMasterPromptIdentityPreventsHistoricalFalseAck();
  await testSpaNavigationTransfersExactAgentPromptToSendOnlyRetry();
  await testProfileSwitchCancelsOldAgentDeliveryToken();
  await testSentPendingAgentDeliverySurvivesReloadWithoutResend();
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
  await testAgentSetupCheckExplainsMissingSlave();
  await testAgentSetupCheckAcceptsWebSlave();
  await testAgentSetupCheckExplainsTmuxAiReadyState();
  await testAgentSetupCheckMarksMissingTmuxPaneStale();
  await testSlavePollHeartbeatsWhileShellCallIsRunning();
  await testAgentPollFailureShowsStatusAfterRetries();
  console.log("content agent delivery tests passed");
})();
