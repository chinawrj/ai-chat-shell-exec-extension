#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const NODE_POSITION_FOLLOWING = 4;
const NODE_POSITION_PRECEDING = 2;

class FakeElement {}

class MockNode extends FakeElement {
  constructor({ text = "", role = "", order = 0, visible = true, children = [] } = {}) {
    super();
    this.innerText = text;
    this.textContent = text;
    this.role = role;
    this.order = order;
    this.visible = visible;
    this.children = children;
    this.parentElement = null;
    for (const child of this.children) {
      child.parentElement = this;
    }
  }

  getAttribute(name) {
    if (name === "data-message-author-role") {
      return this.role || "";
    }
    return "";
  }

  closest(selector) {
    if (/\[data-message-author-role\]|\[role="article"\]|article/.test(selector)) {
      return this.role ? this : this.parentElement;
    }
    if (/\[data-testid\]|section|main > div/.test(selector)) {
      return this.parentElement || this;
    }
    return null;
  }

  compareDocumentPosition(other) {
    if (!(other instanceof MockNode)) {
      return 0;
    }
    if (this.order < other.order) {
      return NODE_POSITION_FOLLOWING;
    }
    if (this.order > other.order) {
      return NODE_POSITION_PRECEDING;
    }
    return 0;
  }

  querySelectorAll() {
    return this.children;
  }

  contains(node) {
    if (this.children.includes(node)) {
      return true;
    }
    return this.children.some((child) => child.contains?.(node));
  }

  getBoundingClientRect() {
    return this.visible ? { width: 600, height: 200 } : { width: 0, height: 0 };
  }
}

function createHelperBlock({ cmd }) {
  return [
    "ai-helper-shell-start",
    cmd,
    "ai-helper-shell-end"
  ].join("\n");
}

function createAgentRosterBlock() {
  return [
    "ai-helper-agent-roster-start",
    "role: slave",
    "ai-helper-agent-roster-end"
  ].join("\n");
}

function createAgentTaskStatusBlock() {
  return [
    "ai-helper-agent-task-status-start",
    "message-id: msg-repeat",
    "ai-helper-agent-task-status-end"
  ].join("\n");
}

function createAssistantMessage({ text, order }) {
  return new MockNode({ text, role: "assistant", order });
}

function createRoot(messages) {
  return new MockNode({
    text: messages.map((message) => message.innerText).join("\n"),
    order: 0,
    children: messages
  });
}

function loadContentContext() {
  const context = {
    CSS: { escape: (value) => String(value) },
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLButtonElement: class HTMLButtonElement extends FakeElement {},
    HTMLInputElement: class HTMLInputElement extends FakeElement {},
    HTMLTextAreaElement: class HTMLTextAreaElement extends FakeElement {},
    InputEvent: class InputEvent {},
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    Node: {
      DOCUMENT_POSITION_FOLLOWING: NODE_POSITION_FOLLOWING,
      DOCUMENT_POSITION_PRECEDING: NODE_POSITION_PRECEDING
    },
    chrome: {
      runtime: {
        id: "lkmeogidbglhedgekjgbpbfjkpapnhke",
        sendMessage: async () => ({ ok: true })
      },
      storage: {
        onChanged: { addListener() {} },
        sync: { get: async () => ({ enabled: false }) },
        local: { get: async () => ({}) }
      }
    },
    clearTimeout,
    console,
    document: {
      body: null,
      documentElement: new MockNode(),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {}
    },
    location: {
      href: "https://chatgpt.com/",
      hostname: "chatgpt.com",
      origin: "https://chatgpt.com",
      pathname: "/",
      port: "",
      protocol: "https:"
    },
    setTimeout: (fn) => {
      fn();
      return 1;
    },
    window: {
      confirm: () => true,
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      addEventListener() {},
      removeEventListener() {}
    }
  };

  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, "..", "extension", "src", "content.js"), "utf8");
  vm.runInContext(source, context, { filename: "content.js" });
  return context;
}

function installPersistentLocalStorage(context, backing = {}) {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  context.chrome.storage.local = {
    async get(keys) {
      const selected = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (Object.prototype.hasOwnProperty.call(backing, key)) {
          selected[key] = clone(backing[key]);
        }
      }
      return selected;
    },
    async set(values) {
      for (const [key, value] of Object.entries(values || {})) {
        backing[key] = clone(value);
      }
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete backing[key];
      }
    }
  };
  return backing;
}

const quotedShellOutput = [
  "Shell call result:",
  "```shell-output",
  "$ pwd",
  "target: %24",
  "exitCode: 0",
  "```"
].join("\n");

{
  const context = loadContentContext();
  const newBlock = createHelperBlock({ cmd: "echo NEW_MIXED" });
  const mixedMessage = createAssistantMessage({
    order: 1,
    text: `${quotedShellOutput}\n${newBlock}`
  });
  const root = createRoot([mixedMessage]);
  const candidate = context.getLastShellCallCandidate(root);
  assert.ok(candidate);
  assert.equal(candidate.call.target, undefined);
  assert.equal(candidate.call.cmd, "echo NEW_MIXED");
}

{
  const context = loadContentContext();
  const quotedOnly = createAssistantMessage({
    order: 1,
    text: quotedShellOutput
  });
  const root = createRoot([quotedOnly]);
  assert.equal(context.getLastShellCallCandidate(root), null);
}

{
  const context = loadContentContext();
  const oldMessage = createAssistantMessage({
    order: 1,
    text: createHelperBlock({ cmd: "echo OLD" })
  });
  const newMessage = createAssistantMessage({
    order: 2,
    text: `${quotedShellOutput}\n${createHelperBlock({ cmd: "echo NEWEST" })}`
  });
  const root = createRoot([oldMessage, newMessage]);
  const candidate = context.getLastShellCallCandidate(root);
  assert.ok(candidate);
  assert.equal(candidate.call.cmd, "echo NEWEST");
}

{
  // Regression: when the newest message has an ambiguous (empty) author role
  // attribute, the debug panel / executor must still pick its helper block
  // instead of falling back to an older message that is explicitly tagged as
  // assistant. Otherwise the first helper block in the conversation gets
  // surfaced even though the latest one is the real target.
  const context = loadContentContext();
  const oldMessage = createAssistantMessage({
    order: 1,
    text: createHelperBlock({ cmd: "echo OLD_AMBIG" })
  });
  const newMessage = new MockNode({
    order: 2,
    role: "",
    text: createHelperBlock({ cmd: "echo NEW_AMBIG" })
  });
  const root = createRoot([oldMessage, newMessage]);
  const candidate = context.getLastShellCallCandidate(root);
  assert.ok(candidate);
  assert.equal(candidate.call.cmd, "echo NEW_AMBIG");
}

async function verifyForceRunUsesLatestHelper() {
  const context = loadContentContext();
  const oldMessage = createAssistantMessage({
    order: 1,
    text: createHelperBlock({ cmd: "echo OLD_FORCE" })
  });
  const newMessage = createAssistantMessage({
    order: 2,
    text: `${quotedShellOutput}\n${createHelperBlock({ cmd: "echo NEW_FORCE" })}`
  });
  const root = createRoot([oldMessage, newMessage]);
  context.document.body = root;
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100
  });
  await Promise.resolve();
  const runCalls = [];
  context.getConversationRoot = () => root;
  context.updateSiteActionButton = () => {};
  context.setStatus = () => {};
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.runAndReply = async (callId, call, options) => {
    runCalls.push({ callId, call, options });
  };
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  vm.runInContext(`extensionActive = true; activeCallId = ''; initialThreadSettled = true; lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))}; lastThreadTextAt = Date.now() - 2000;`, context);

  await context.scanForShellCall({ force: true });
  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].options?.force, true);
  assert.equal(runCalls[0].call.cmd, "echo NEW_FORCE");
}

async function verifyDebugPanelUpdates() {
  const context = loadContentContext();
  const cmd = "echo DEBUG_TEST";
  const message = createAssistantMessage({
    order: 1,
    text: createHelperBlock({ cmd })
  });
  const root = createRoot([message]);
  context.document.body = root;
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100
  });

  // Mock the debug body element so updateDetectedHelperDebug can write to it
  const debugBody = { textContent: "" };
  const getElementByIdCalls = [];
  const origGetElementById = context.document.getElementById;
  context.document.getElementById = (id) => {
    getElementByIdCalls.push(id);
    if (id === "ai-chat-shell-exec-debug-body") {
      return debugBody;
    }
    return origGetElementById(id);
  };

  context.getConversationRoot = () => root;
  context.updateSiteActionButton = () => {};
  context.setStatus = () => {};
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.runAndReply = async () => {};
  vm.runInContext(`extensionActive = true; activeCallId = ''; initialThreadSettled = true; lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))}; lastThreadTextAt = Date.now() - 2000;`, context);

  await context.scanForShellCall({ force: true });

  assert.ok(getElementByIdCalls.includes("ai-chat-shell-exec-debug-body"), "getElementById should be called with DEBUG_BODY_ID");
  assert.ok(debugBody.textContent.includes("--- cmd / content (first 800 chars) ---"), `debug body should contain cmd/content header`);
  assert.ok(debugBody.textContent.includes(cmd), `debug body should contain the cmd '${cmd}'`);
}

async function verifyFrontendDoesNotDedupCommands() {
  const context = loadContentContext();
  const roster = context.parseCallPayload(createAgentRosterBlock());
  const rosterSemanticKey = context.buildSemanticCallKey(roster);
  assert.equal(
    context.getHandledHelperReason({ node: new context.Element() }, "new-roster-call", rosterSemanticKey, roster),
    ""
  );

  const status = context.parseCallPayload(createAgentTaskStatusBlock());
  const statusSemanticKey = context.buildSemanticCallKey(status);
  assert.equal(
    context.getHandledHelperReason({ node: new context.Element() }, "new-status-call", statusSemanticKey, status),
    ""
  );

  const shell = context.parseCallPayload(createHelperBlock({ cmd: "pwd" }));
  const shellSemanticKey = context.buildSemanticCallKey(shell);
  const firstShellCandidate = { node: new context.Element() };
  context.markCallProcessed(firstShellCandidate, "first-shell-call", shellSemanticKey);
  assert.equal(
    context.getHandledHelperReason({ node: new context.Element() }, "new-shell-call", shellSemanticKey, shell),
    "",
    "A new helper request with identical command text must reach the shell server."
  );
  assert.equal(
    context.getHandledHelperReason(firstShellCandidate, "first-shell-call", shellSemanticKey, shell),
    "processed rendered helper",
    "The exact same rendered helper request remains scan-debounced."
  );
}

async function verifyHiddenStopButtonDoesNotBlockHelperScan() {
  const context = loadContentContext();
  const hiddenStop = new MockNode({ text: "Stop generating", visible: false });
  const visibleStop = new MockNode({ text: "Stop", visible: true });

  context.document.querySelectorAll = () => [hiddenStop];
  assert.equal(context.isAssistantGenerating(), false, "A hidden stale Stop button must not block helper execution.");

  context.document.querySelectorAll = () => [visibleStop];
  assert.equal(context.isAssistantGenerating(), true, "A visible text-only Stop button must be recognized after trimming its label.");
}

async function verifyUnexpectedHelperCancelsSelfTestAndRuns() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const cmd = "echo REAL_HELPER_AFTER_SELF_TEST";
  const message = createAssistantMessage({
    order: 1,
    text: createHelperBlock({ cmd })
  });
  const root = createRoot([message]);
  const runCalls = [];
  const statuses = [];
  context.document.body = root;
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100
  });
  context.getConversationRoot = () => root;
  context.updateSiteActionButton = () => {};
  context.setStatus = (text, state) => statuses.push({ text, state });
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.runAndReply = async (callId, call, options) => {
    runCalls.push({ callId, call, options });
  };
  vm.runInContext(
    `extensionActive = true; initialThreadSettled = true; lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))}; lastThreadTextAt = Date.now() - 2000; pendingSelfTest = { command: 'printf EXPECTED_SELF_TEST', cwd: '', token: 'expected', startedAt: Date.now() };`,
    context
  );

  await context.scanForShellCall();

  assert.equal(runCalls.length, 1, "An unexpected real helper must continue to normal server dispatch.");
  assert.equal(runCalls[0].call.cmd, cmd);
  assert.equal(vm.runInContext("pendingSelfTest", context), null);
  assert.ok(statuses.some((status) => /Self-test cancelled/.test(status.text)));
}

async function verifyPendingAgentDeliveryDefersWithoutConsumingHelper() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const cmd = "echo RUN_AFTER_AGENT_COMPOSER_RELEASE";
  const message = createAssistantMessage({ order: 1, text: createHelperBlock({ cmd }) });
  const root = createRoot([message]);
  const runCalls = [];
  context.document.body = root;
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100
  });
  context.getConversationRoot = () => root;
  context.updateSiteActionButton = () => {};
  context.setStatus = () => {};
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.runAndReply = async (...args) => runCalls.push(args);
  vm.runInContext(
    `extensionActive = true; initialThreadSettled = true; lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))}; lastThreadTextAt = Date.now() - 2000; pendingAgentDelivery = { messageId: 'pending-agent' };`,
    context
  );

  await context.scanForShellCall();
  assert.equal(runCalls.length, 0, "A helper must remain unconsumed while an agent message owns the composer.");

  vm.runInContext("pendingAgentDelivery = { messageId: 'ack-only-agent', sent: true }; agentDeliveryInFlight = true; lastThreadTextAt = Date.now() - 2000;", context);
  await context.scanForShellCall();
  assert.equal(runCalls.length, 1, "A sent agent message waiting only for hub ack must not block a helper.");
  assert.equal(runCalls[0][1].cmd, cmd);
}

async function verifyRetryableAttemptDoesNotConsumeSameRenderedHelper() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const cmd = "echo RETRY_SAME_RENDERED_HELPER";
  const message = createAssistantMessage({ order: 1, text: createHelperBlock({ cmd }) });
  const root = createRoot([message]);
  const runCalls = [];
  context.document.body = root;
  context.chrome.storage.sync.get = async () => ({ enabled: true, enabledHosts: ["chatgpt.com"], maxChainCalls: 100 });
  context.getConversationRoot = () => root;
  context.updateSiteActionButton = () => {};
  context.setStatus = () => {};
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.runAndReply = async (...args) => {
    runCalls.push(args);
    return { retryable: true };
  };
  vm.runInContext(
    `extensionActive = true; initialThreadSettled = true; lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))}; lastThreadTextAt = Date.now() - 2000;`,
    context
  );

  await context.scanForShellCall();
  vm.runInContext("lastThreadTextAt = Date.now() - 2000;", context);
  await context.scanForShellCall();

  assert.equal(runCalls.length, 2, "A failed/unavailable attempt must leave the exact same rendered helper retryable.");
  assert.equal(runCalls[0][0], runCalls[1][0], "Retrying one rendered request must preserve its server call key for status/dedup adjudication.");
}

async function verifyStaleLongCallCannotAffectNewPageCall() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const pending = new Map();
  const inserted = [];
  const clicked = [];
  const statuses = [];
  context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: true });
  context.chrome.runtime.sendMessage = (payload) => {
    if (payload.type === "run-shell") {
      return new Promise((resolve) => pending.set(payload.id, resolve));
    }
    return Promise.resolve({ ok: true });
  };
  context.insertReply = async (text) => {
    inserted.push(text);
    return { innerText: text, textContent: text, isConnected: true };
  };
  context.clickSendWhenReady = async () => {
    clicked.push(context.location.href);
    return true;
  };
  context.setStatus = (text, state) => statuses.push({ text, state });
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);

  const oldCall = context.parseCallPayload(createHelperBlock({ cmd: "echo OLD_PAGE" }));
  const oldPromise = context.runAndReply("old-page-call", oldCall);
  await waitForTestCondition(() => pending.has("old-page-call"));
  assert.equal(vm.runInContext("activeCallId", context), "old-page-call");

  vm.runInContext("chainCallCount = 9; lastThreadText = 'old page'; pendingSelfTest = { command: 'old test' }; pendingForceRunRequested = true;", context);
  context.location.pathname = "/c/new-page";
  context.location.href = "https://chatgpt.com/c/new-page";
  context.refreshPageLifecycle();
  assert.equal(vm.runInContext("activeCallId", context), "", "SPA navigation must detach the old page call immediately.");
  assert.equal(vm.runInContext("initialThreadSettled", context), false);
  assert.equal(vm.runInContext("lastThreadText", context), "");
  assert.equal(vm.runInContext("chainCallCount", context), 0);
  assert.equal(vm.runInContext("pendingSelfTest", context), null);
  assert.equal(vm.runInContext("pendingForceRunRequested", context), false);

  const newCall = context.parseCallPayload(createHelperBlock({ cmd: "echo NEW_PAGE" }));
  const newPromise = context.runAndReply("new-page-call", newCall);
  await waitForTestCondition(() => pending.has("new-page-call"));
  assert.equal(vm.runInContext("activeCallId", context), "new-page-call");

  pending.get("old-page-call")({ ok: true, exitCode: 0, stdout: "OLD_PAGE" });
  await oldPromise;
  assert.equal(inserted.length, 0, "The old response must not be inserted into the new page composer.");
  assert.equal(vm.runInContext("activeCallId", context), "new-page-call", "The old finally block must not clear the new call lock.");

  pending.get("new-page-call")({ ok: true, exitCode: 0, stdout: "NEW_PAGE" });
  await newPromise;
  assert.equal(inserted.length, 1);
  assert.match(inserted[0], /NEW_PAGE/);
  assert.doesNotMatch(inserted[0], /OLD_PAGE/);
  assert.deepEqual(clicked, ["https://chatgpt.com/c/new-page"]);
  assert.equal(vm.runInContext("activeCallId", context), "");

  const disableOldCall = context.parseCallPayload(createHelperBlock({ cmd: "echo DISABLE_OLD" }));
  const disableOldPromise = context.runAndReply("disable-old-call", disableOldCall);
  await waitForTestCondition(() => pending.has("disable-old-call"));
  vm.runInContext("deactivateExtension(); extensionActive = true; beginPageLifecycle();", context);
  const afterEnableCall = context.parseCallPayload(createHelperBlock({ cmd: "echo AFTER_ENABLE" }));
  const afterEnablePromise = context.runAndReply("after-enable-call", afterEnableCall);
  await waitForTestCondition(() => pending.has("after-enable-call"));

  pending.get("disable-old-call")({ ok: true, exitCode: 0, stdout: "DISABLE_OLD" });
  await disableOldPromise;
  assert.equal(vm.runInContext("activeCallId", context), "after-enable-call");
  assert.equal(inserted.length, 1, "A disabled lifecycle's late response must not be inserted after re-enable.");

  pending.get("after-enable-call")({ ok: true, exitCode: 0, stdout: "AFTER_ENABLE" });
  await afterEnablePromise;
  assert.equal(inserted.length, 2);
  assert.match(inserted[1], /AFTER_ENABLE/);
}

async function verifyRuntimeChannelCloseRecoversByStatusOnly() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const sent = [];
  let statusAttempt = 0;
  context.sleep = async () => {};
  context.chrome.runtime.sendMessage = async (payload) => {
    sent.push(payload);
    if (payload.type === "run-shell") {
      throw new Error("The message port closed before a response was received.");
    }
    if (payload.type === "run-shell-status") {
      statusAttempt += 1;
      if (statusAttempt === 1) {
        return { ok: true, found: true, state: "running" };
      }
      return {
        ok: true,
        found: true,
        state: "completed",
        result: { ok: true, exitCode: 0, stdout: "RECOVERED_RESULT", durationMs: 360000 }
      };
    }
    return { ok: true };
  };

  const call = context.parseCallPayload(createHelperBlock({ cmd: "sleep 360; echo RECOVERED_RESULT" }));
  const response = await context.sendRunShellMessage("recover-call-key", call, false);
  assert.equal(response.stdout, "RECOVERED_RESULT");
  assert.deepEqual(sent.map((payload) => payload.type), ["run-shell", "run-shell-status", "run-shell-status"]);
  assert.equal(sent.filter((payload) => payload.type === "run-shell").length, 1, "Recovery must never resubmit the command.");
  assert.ok(sent.filter((payload) => payload.type === "run-shell-status").every((payload) => payload.callKey === "recover-call-key"));

  sent.length = 0;
  statusAttempt = 0;
  context.chrome.runtime.sendMessage = async (payload) => {
    sent.push(payload);
    if (payload.type === "run-shell") {
      throw new Error("A listener indicated an asynchronous response, but the message channel closed before a response was received.");
    }
    return { ok: true, found: false };
  };
  await assert.rejects(
    () => context.sendRunShellMessage("missing-recovery-key", call, false),
    /could not find the original server attempt/
  );
  assert.equal(sent.filter((payload) => payload.type === "run-shell").length, 1);
  assert.equal(sent.filter((payload) => payload.type === "run-shell-status").length, 5);

  sent.length = 0;
  context.chrome.runtime.sendMessage = async (payload) => {
    sent.push(payload);
    if (payload.type === "run-shell") {
      throw new Error("The message port closed before a response was received.");
    }
    throw new Error("Extension service worker is restarting.");
  };
  await assert.rejects(
    () => context.sendRunShellMessage("transport-recovery-key", call, false),
    /result recovery failed/
  );
  assert.equal(sent.filter((payload) => payload.type === "run-shell").length, 1);
  assert.equal(sent.filter((payload) => payload.type === "run-shell-status").length, 5);

  sent.length = 0;
  statusAttempt = 0;
  context.chrome.runtime.sendMessage = async (payload) => {
    sent.push(payload);
    if (payload.type === "run-shell") {
      return { ok: false, error: "Shell server closed the connection before returning a response." };
    }
    statusAttempt += 1;
    return statusAttempt === 1 ?
      { ok: true, found: true, state: "running" } :
      {
        ok: true,
        found: true,
        state: "completed",
        result: { ok: true, exitCode: 0, stdout: "RECOVERED_RESOLVED_TRANSPORT" }
      };
  };
  const resolvedTransportResponse = await context.sendRunShellMessage("resolved-transport-key", call, false);
  assert.equal(resolvedTransportResponse.stdout, "RECOVERED_RESOLVED_TRANSPORT");
  assert.deepEqual(sent.map((payload) => payload.type), ["run-shell", "run-shell-status", "run-shell-status"]);
  assert.equal(sent.filter((payload) => payload.type === "run-shell").length, 1, "A resolved transport failure must recover by status without resubmitting run.");

  sent.length = 0;
  const normalCommandFailure = { ok: false, error: "Command exited with status 42.", exitCode: 42 };
  context.chrome.runtime.sendMessage = async (payload) => {
    sent.push(payload);
    return normalCommandFailure;
  };
  const ordinaryFailureResponse = await context.sendRunShellMessage("normal-command-error-key", call, false);
  assert.equal(ordinaryFailureResponse, normalCommandFailure);
  assert.deepEqual(sent.map((payload) => payload.type), ["run-shell"], "Ordinary command errors must not enter status recovery.");
}

async function verifyAmbiguousShellRecoveryFailureDoesNotResendSameRenderedHelper() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  const cmd = "printf AMBIGUOUS_RECOVERY_MUST_NOT_RESEND";
  const message = createAssistantMessage({ order: 1, text: createHelperBlock({ cmd }) });
  const root = createRoot([message]);
  let runCount = 0;
  let statusCount = 0;
  const inserted = [];
  const statuses = [];
  context.document.body = root;
  context.getConversationRoot = () => root;
  context.updateSiteActionButton = () => {};
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.setStatus = (text, state) => statuses.push({ text, state });
  context.sleep = async () => {};
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100,
    requireApproval: false,
    autoSend: false
  });
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "run-shell") {
      runCount += 1;
      throw new Error("The message port closed before a response was received.");
    }
    if (payload.type === "run-shell-status") {
      statusCount += 1;
      return { ok: true, found: false };
    }
    return { ok: true };
  };
  context.insertReply = async (text) => {
    inserted.push(text);
    return { innerText: text, textContent: text, isConnected: true };
  };
  vm.runInContext(
    `extensionActive = true; beginPageLifecycle(); initialThreadSettled = true; lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))}; lastThreadTextAt = Date.now() - 2000;`,
    context
  );

  await context.scanForShellCall();
  vm.runInContext("lastThreadTextAt = Date.now() - 2000;", context);
  await context.scanForShellCall();

  assert.equal(runCount, 1, "An ambiguous post-dispatch recovery failure must not resend run-shell for the same rendered helper.");
  assert.equal(statusCount, 5);
  assert.equal(inserted.length, 0, "Internal status-recovery failures must remain local and never enter the model composer.");
  assert.ok(statuses.some(({ text, state }) => state === "error" && text.includes("result recovery could not find")));
}

async function verifyBoardRuntimeChannelCloseRecoversByStatusOnly() {
  const context = loadContentContext();
  await Promise.resolve();
  const sent = [];
  let statusAttempt = 0;
  context.sleep = async () => {};
  context.chrome.runtime.sendMessage = async (payload) => {
    sent.push(payload);
    if (payload.type === "run-board") {
      throw new Error("The message port closed before a response was received.");
    }
    if (payload.type === "run-board-status") {
      statusAttempt += 1;
      return statusAttempt === 1 ?
        { ok: true, found: true, state: "running" } :
        {
          ok: true,
          found: true,
          state: "completed",
          result: {
            ok: true,
            exitCode: 0,
            stdout: "BOARD_RECOVERED\nBOARD> ",
            durationMs: 360000,
            executed: true,
            executionCompleted: false,
            completionObserved: true
          }
        };
    }
    return { ok: true };
  };

  const call = context.parseCallPayload("ai-helper-board-start\nstatus\nai-helper-board-end");
  assert.equal(call.kind, "board");
  const response = await context.sendRunBoardMessage("recover-board-key", call, false);
  assert.equal(response.stdout, "BOARD_RECOVERED\nBOARD> ");
  assert.deepEqual(sent.map((payload) => payload.type), ["run-board", "run-board-status", "run-board-status"]);
  assert.equal(sent.filter((payload) => payload.type === "run-board").length, 1, "Board recovery must never resubmit the command.");
  assert.ok(sent.filter((payload) => payload.type === "run-board-status").every((payload) => payload.callKey === "recover-board-key"));
  assert.equal(
    context.isRetryableHelperResponse(call, { ok: false, executed: false, error: "pre-dispatch board failure" }),
    false,
    "A dispatched board helper must not be automatically retried because board execution has no dedup authority."
  );

  sent.length = 0;
  context.chrome.runtime.sendMessage = async (payload) => {
    sent.push(payload);
    if (payload.type === "run-board") {
      throw new Error("The message channel closed before a response was received.");
    }
    return { ok: true, found: false };
  };
  await assert.rejects(
    () => context.sendRunBoardMessage("missing-board-recovery-key", call, false),
    (error) => error?.helperRetryable === false && /was not resubmitted/.test(error.message)
  );
  assert.equal(sent.filter((payload) => payload.type === "run-board").length, 1);
  assert.equal(sent.filter((payload) => payload.type === "run-board-status").length, 5);
}

async function verifyBoardRecoveryFailureStaysLocal() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  context.sleep = async () => {};
  context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: true });
  let runCount = 0;
  let statusCount = 0;
  let insertions = 0;
  const statuses = [];
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "run-board") {
      runCount += 1;
      throw new Error("The message channel closed before a response was received.");
    }
    if (payload.type === "run-board-status") {
      statusCount += 1;
      return { ok: true, found: false };
    }
    return { ok: true };
  };
  context.insertReply = async () => {
    insertions += 1;
    throw new Error("internal board recovery failure must not reach composer");
  };
  context.setStatus = (text, state) => statuses.push({ text, state });
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);
  const call = context.parseCallPayload("ai-helper-board-start\nstatus\nai-helper-board-end");

  const outcome = await context.runAndReply("board-recovery-local-only", call);

  assert.equal(runCount, 1);
  assert.equal(statusCount, 5);
  assert.equal(outcome.retryable, false);
  assert.equal(outcome.suppressedLocalFailure, true);
  assert.equal(outcome.deliveryFailed, false);
  assert.equal(insertions, 0, "Internal board status-recovery failures must remain local-only.");
  assert.ok(statuses.some(({ text, state }) => state === "error" && text.includes("Board helper failed")));
}

async function waitForTestCondition(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for test condition.");
}

async function verifyMixedShellOutputAndNewHelperRunsNormally() {
  const context = loadContentContext();
  const cmd = "echo MIXED_NORMAL_SCAN";
  const message = createAssistantMessage({
    order: 1,
    text: `${quotedShellOutput}\n${createHelperBlock({ cmd })}`
  });
  const root = createRoot([message]);
  const runCalls = [];
  context.document.body = root;
  context.chrome.storage.sync.get = async () => ({ enabled: true, enabledHosts: ["chatgpt.com"], maxChainCalls: 100 });
  context.getConversationRoot = () => root;
  context.updateSiteActionButton = () => {};
  context.setStatus = () => {};
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.runAndReply = async (callId, call) => runCalls.push({ callId, call });
  vm.runInContext(`extensionActive = true; activeCallId = ''; initialThreadSettled = true; lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))}; lastThreadTextAt = Date.now() - 2000;`, context);

  await context.scanForShellCall();
  assert.equal(runCalls.length, 1, "A closed historical shell-output must not suppress a later helper in the same message.");
  assert.equal(runCalls[0].call.cmd, cmd);
}

async function verifyVirtualizedReplacementAndSharedContainerRemainRunnable() {
  const context = loadContentContext();
  const cmd = "echo RENDER_IDENTITY";
  const firstMessage = createAssistantMessage({ order: 1, text: createHelperBlock({ cmd }) });
  let root = createRoot([firstMessage]);
  const runCalls = [];
  const statuses = [];
  context.document.body = root;
  context.chrome.storage.sync.get = async () => ({ enabled: true, enabledHosts: ["chatgpt.com"], maxChainCalls: 100 });
  context.getConversationRoot = () => root;
  context.updateSiteActionButton = () => {};
  context.setStatus = (text, state) => statuses.push({ text, state });
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.runAndReply = async (callId, call) => runCalls.push({ callId, call });
  vm.runInContext(`extensionActive = true; activeCallId = ''; initialThreadSettled = true; lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))}; lastThreadTextAt = Date.now() - 2000;`, context);
  await context.scanForShellCall();

  const replacementMessage = createAssistantMessage({ order: 1, text: createHelperBlock({ cmd }) });
  root = createRoot([replacementMessage]);
  context.document.body = root;
  vm.runInContext(`extensionActive = true; activeCallId = ''; lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))}; lastThreadTextAt = Date.now() - 2000;`, context);
  const replacementCandidate = context.getLastShellCallCandidate(root);
  const replacementSemantic = context.buildSemanticCallKey(replacementCandidate.call);
  const replacementCallKey = context.buildCandidateCallKey(replacementCandidate, replacementSemantic);
  assert.equal(context.getHandledHelperReason(replacementCandidate, replacementCallKey, replacementSemantic, replacementCandidate.call), "");
  await context.scanForShellCall();
  assert.equal(runCalls.length, 2, `A virtualized replacement helper at the same scan index is a new rendered request. Statuses: ${JSON.stringify(statuses)}`);

  const recycledCandidate = context.getLastShellCallCandidate(root);
  const recycledSemantic = context.buildSemanticCallKey(recycledCandidate.call);
  context.markCallProcessed(recycledCandidate, "recycled-first", recycledSemantic);
  const recycledCallKeyBefore = context.buildCandidateCallKey(recycledCandidate, recycledSemantic);
  context.invalidateRenderedHelperTracking([{
    type: "childList",
    target: replacementMessage,
    oldValue: replacementMessage.textContent,
    addedNodes: [{ textContent: replacementMessage.textContent }],
    removedNodes: [{ textContent: replacementMessage.textContent }]
  }]);
  const recycledCallKeyAfter = context.buildCandidateCallKey(recycledCandidate, recycledSemantic);
  assert.notEqual(recycledCallKeyAfter, recycledCallKeyBefore, "Recycling a helper DOM node must create a new request attempt identity.");
  assert.equal(
    context.getHandledHelperReason(recycledCandidate, recycledCallKeyAfter, recycledSemantic, recycledCandidate.call),
    "",
    "A recycled DOM Element containing a new identical helper must reach the server."
  );

  context.markCallProcessed(recycledCandidate, "recycled-again", recycledSemantic);
  const unrelatedCallKeyBefore = context.buildCandidateCallKey(recycledCandidate, recycledSemantic);
  context.invalidateRenderedHelperTracking([{
    type: "childList",
    target: replacementMessage,
    oldValue: null,
    addedNodes: [{ textContent: "copy button" }],
    removedNodes: []
  }]);
  const unrelatedCallKeyAfter = context.buildCandidateCallKey(recycledCandidate, recycledSemantic);
  assert.equal(unrelatedCallKeyAfter, unrelatedCallKeyBefore, "Unrelated UI decoration must not create a new helper attempt.");
  assert.equal(
    context.getHandledHelperReason(recycledCandidate, unrelatedCallKeyAfter, recycledSemantic, recycledCandidate.call),
    "processed rendered helper",
    "Unrelated DOM mutations must not resubmit an unchanged helper."
  );

  const shared = new MockNode({
    order: 2,
    role: "",
    text: `${createHelperBlock({ cmd })}\n${createHelperBlock({ cmd })}`
  });
  const sharedRoot = createRoot([shared]);
  const sharedCandidates = context.extractShellCallCandidates(sharedRoot);
  assert.equal(sharedCandidates.length, 2);
  const firstSemantic = context.buildSemanticCallKey(sharedCandidates[0].call);
  context.markCallProcessed(sharedCandidates[0], "shared-first", firstSemantic);
  const secondSemantic = context.buildSemanticCallKey(sharedCandidates[1].call);
  assert.equal(
    context.getHandledHelperReason(sharedCandidates[1], "shared-second", secondSemantic, sharedCandidates[1].call),
    "",
    "Two identical helpers in one shared container are distinct rendered requests."
  );

  context.location.pathname = "/c/new-conversation";
  context.location.href = "https://chatgpt.com/c/new-conversation?turn=2#latest";
  assert.equal(
    context.getHandledHelperReason(sharedCandidates[0], "spa-new", firstSemantic, sharedCandidates[0].call),
    "",
    "The same first helper in a new SPA conversation must not inherit old request tracking."
  );
}

async function verifyRenderedShellOutputStructureIsSuppressed() {
  const context = loadContentContext();
  const message = createAssistantMessage({
    order: 1,
    text: createHelperBlock({ cmd: "echo MUST_NOT_RUN_FROM_RENDERED_OUTPUT" })
  });
  message.className = "language-shell-output";
  const root = createRoot([message]);
  const candidate = context.getLastShellCallCandidate(root);
  assert.ok(candidate);
  assert.equal(candidate.insideShellOutput, true, "Rendered code DOM must preserve shell-output provenance even after Markdown fences disappear.");

  const runCalls = [];
  context.document.body = root;
  context.chrome.storage.sync.get = async () => ({ enabled: true, enabledHosts: ["chatgpt.com"], maxChainCalls: 100 });
  context.getConversationRoot = () => root;
  context.updateSiteActionButton = () => {};
  context.setStatus = () => {};
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.runAndReply = async (...args) => runCalls.push(args);
  vm.runInContext(`extensionActive = true; activeCallId = ''; initialThreadSettled = true; lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))}; lastThreadTextAt = Date.now() - 2000;`, context);
  await context.scanForShellCall();
  assert.equal(runCalls.length, 0, "A helper rendered inside language-shell-output code must never execute.");
}

async function verifyAgentHelperInsideShellOutputIsSuppressed() {
  const context = loadContentContext();
  const message = createAssistantMessage({
    order: 1,
    text: [
      "Agent message result:",
      "```shell-output",
      "statusQuery:",
      "````",
      "ai-helper-agent-task-status-start",
      "message-id: msg-embedded",
      "ai-helper-agent-task-status-end",
      "````",
      "```"
    ].join("\n")
  });
  const root = createRoot([message]);
  context.document.body = root;
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100
  });

  const runCalls = [];
  const statuses = [];
  context.getConversationRoot = () => root;
  context.updateSiteActionButton = () => {};
  context.setStatus = (text, state) => statuses.push({ text, state });
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.runAndReply = async (callId, call, options) => {
    runCalls.push({ callId, call, options });
  };
  vm.runInContext(`extensionActive = true; activeCallId = ''; initialThreadSettled = true; lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))}; lastThreadTextAt = Date.now() - 2000;`, context);

  await context.scanForShellCall();

  assert.equal(runCalls.length, 0);
  assert.match(statuses.at(-1).text, /Suppressed helper inside shell-output/);
  assert.equal(statuses.at(-1).state, "ok");
}

async function verifyNewIdenticalHelperAfterFailedAttemptRuns() {
  const context = loadContentContext();
  const cmd = "echo RETRY_AFTER_SERVER_FAILURE";
  const firstMessage = createAssistantMessage({
    order: 1,
    text: createHelperBlock({ cmd })
  });
  let root = createRoot([firstMessage]);
  const runCalls = [];
  const statuses = [];
  context.document.body = root;
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100
  });
  context.getConversationRoot = () => root;
  context.updateSiteActionButton = () => {};
  context.setStatus = (text, state) => statuses.push({ text, state });
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.runAndReply = async (callId, call, options) => {
    // The scanner must not infer command execution from this attempt. In the
    // real path runAndReply may receive a health/target/server failure.
    runCalls.push({ callId, call, options });
  };
  vm.runInContext(`extensionActive = true; activeCallId = ''; initialThreadSettled = true; lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))}; lastThreadTextAt = Date.now() - 2000;`, context);

  await context.scanForShellCall();
  assert.equal(runCalls.length, 1);

  const secondMessage = createAssistantMessage({
    order: 2,
    text: createHelperBlock({ cmd })
  });
  root = createRoot([firstMessage, secondMessage]);
  context.document.body = root;
  vm.runInContext(`extensionActive = true; activeCallId = ''; lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))}; lastThreadTextAt = Date.now() - 2000;`, context);

  const retryCandidates = context.extractShellCallCandidates(root);
  assert.equal(retryCandidates.length, 2);
  const retryCandidate = context.getLastShellCallCandidate(root);
  const retrySemanticKey = context.buildSemanticCallKey(retryCandidate.call);
  const retryCallKey = context.buildCandidateCallKey(retryCandidate, retrySemanticKey);
  assert.equal(context.getHandledHelperReason(retryCandidate, retryCallKey, retrySemanticKey, retryCandidate.call), "");

  await context.scanForShellCall();
  assert.equal(runCalls.length, 2, `A new identical helper after an unexecuted attempt must be submitted to the server. Statuses: ${JSON.stringify(statuses)}`);
  assert.notEqual(runCalls[0].callId, runCalls[1].callId);
}

async function verifyDebugPanelUpdatesDuringStreaming() {
  // Regression: while the AI is streaming a new helper block (or right after
  // it appears, before the thread text has been quiet for 1200ms), the
  // floating panel's debug body must already reflect the latest helper block
  // instead of the first one. Earlier the debug body was only refreshed
  // after the streaming/quiet early-returns, so the panel stayed stuck on
  // the first detected helper block.
  const context = loadContentContext();
  const oldCmd = "echo OLD_STREAM";
  const newCmd = "echo NEW_STREAM";
  const oldMessage = createAssistantMessage({
    order: 1,
    text: createHelperBlock({ cmd: oldCmd })
  });
  const newMessage = createAssistantMessage({
    order: 2,
    text: createHelperBlock({ cmd: newCmd })
  });
  const root = createRoot([oldMessage, newMessage]);
  context.document.body = root;
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100
  });

  const debugBody = { textContent: "" };
  const origGetElementById = context.document.getElementById;
  context.document.getElementById = (id) => {
    if (id === "ai-chat-shell-exec-debug-body") {
      return debugBody;
    }
    return origGetElementById(id);
  };

  context.getConversationRoot = () => root;
  context.updateSiteActionButton = () => {};
  context.setStatus = () => {};
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.runAndReply = async () => {};
  // Simulate a non-force scan where the thread text just changed (so we hit
  // the streaming early-return at "threadText !== lastThreadText"). The
  // debug body must still get updated to the newest helper block.
  vm.runInContext(
    "extensionActive = true; activeCallId = ''; initialThreadSettled = true; lastThreadText = ''; lastThreadTextAt = Date.now();",
    context
  );

  await context.scanForShellCall();

  assert.ok(
    debugBody.textContent.includes(newCmd),
    `streaming-phase debug body should contain newest cmd '${newCmd}' but got: ${debugBody.textContent}`
  );
  // The candidate-list section now intentionally enumerates every helper
  // block (so users can spot a wrong selection without DevTools), so the
  // old cmd may legitimately appear there. What must hold is that the
  // selected marker [*] is on the new cmd, and the detail / cmd-preview
  // section below the list reflects the new cmd, not the old one.
  const streamLines = debugBody.textContent.split("\n");
  const streamSelected = streamLines.find((line) => /^\[\*\] #\d+/.test(line));
  assert.ok(
    streamSelected && streamSelected.includes(newCmd),
    `streaming-phase debug body should mark the newest cmd as selected, got: ${streamSelected}`
  );
  const streamPreviewIdx = streamLines.findIndex((line) => line.startsWith("--- cmd / content"));
  assert.ok(streamPreviewIdx >= 0, "streaming-phase debug body should contain cmd preview header");
  const streamPreview = streamLines.slice(streamPreviewIdx + 1).join("\n");
  assert.ok(
    streamPreview.includes(newCmd),
    `streaming-phase cmd preview should contain newest cmd '${newCmd}' but got: ${streamPreview}`
  );
  assert.ok(
    !streamPreview.includes(oldCmd),
    `streaming-phase cmd preview should not contain old cmd '${oldCmd}' but got: ${streamPreview}`
  );
}

async function verifyDebugPanelUpdatesWhileActiveCallRunning() {
  // Regression: even while a previous helper call is still running
  // (`activeCallId` is set) or the AI is streaming a follow-up turn
  // (`isAssistantGenerating()` returns true), the floating panel's
  // detected-helper debug body must reflect the latest fully-terminated
  // helper block in the DOM. Otherwise the panel can stay stuck on the
  // first helper block while subsequent ones are visible in the chat.
  const context = loadContentContext();
  const oldCmd = "echo OLD_ACTIVE";
  const newCmd = "echo NEW_ACTIVE";
  const oldMessage = createAssistantMessage({
    order: 1,
    text: createHelperBlock({ cmd: oldCmd })
  });
  const newMessage = createAssistantMessage({
    order: 2,
    text: createHelperBlock({ cmd: newCmd })
  });
  const root = createRoot([oldMessage, newMessage]);
  context.document.body = root;

  const debugBody = { textContent: "" };
  const origGetElementById = context.document.getElementById;
  context.document.getElementById = (id) => {
    if (id === "ai-chat-shell-exec-debug-body") {
      return debugBody;
    }
    return origGetElementById(id);
  };

  context.getConversationRoot = () => root;
  context.updateSiteActionButton = () => {};
  context.setStatus = () => {};
  context.scheduleScan = () => {};
  // Pretend a previous helper call is still running: scanForShellCall takes
  // the `activeCallId` early-return branch before any of the host-check or
  // candidate-detection code runs. The debug body must still be refreshed.
  vm.runInContext(
    "extensionActive = true; activeCallId = 'pending-call-id'; initialThreadSettled = true;",
    context
  );

  await context.scanForShellCall();

  assert.ok(
    debugBody.textContent.includes(newCmd),
    `active-call debug body should contain newest cmd '${newCmd}' but got: ${debugBody.textContent}`
  );
  // See verifyDebugPanelUpdatesDuringStreaming: the candidate list now
  // enumerates every helper block by design, so old cmds are allowed to
  // appear there. The selected marker [*] and the cmd-preview section are
  // the authoritative checks for "the panel reflects the newest block".
  const activeLines = debugBody.textContent.split("\n");
  const activeSelected = activeLines.find((line) => /^\[\*\] #\d+/.test(line));
  assert.ok(
    activeSelected && activeSelected.includes(newCmd),
    `active-call debug body should mark the newest cmd as selected, got: ${activeSelected}`
  );
  const activePreviewIdx = activeLines.findIndex((line) => line.startsWith("--- cmd / content"));
  assert.ok(activePreviewIdx >= 0, "active-call debug body should contain cmd preview header");
  const activePreview = activeLines.slice(activePreviewIdx + 1).join("\n");
  assert.ok(
    activePreview.includes(newCmd),
    `active-call cmd preview should contain newest cmd '${newCmd}' but got: ${activePreview}`
  );
  assert.ok(
    !activePreview.includes(oldCmd),
    `active-call cmd preview should not contain old cmd '${oldCmd}' but got: ${activePreview}`
  );
}

async function verifyForceRunPersistsWhileActiveCallRunning() {
  // Regression: clicking Force run while a previous helper is still active
  // must not be a short-lived retry window. Long-running shell commands can
  // exceed that window, so the force request is kept pending until the active
  // call clears, then the latest helper is executed with force metadata.
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const timers = [];
  context.setTimeout = (fn, ms) => {
    timers.push({ fn, ms });
    return timers.length;
  };
  context.clearTimeout = () => {};

  const oldMessage = createAssistantMessage({
    order: 1,
    text: createHelperBlock({ cmd: "echo OLD_PENDING_FORCE" })
  });
  const newMessage = createAssistantMessage({
    order: 2,
    text: createHelperBlock({ cmd: "echo NEW_PENDING_FORCE" })
  });
  const root = createRoot([oldMessage, newMessage]);
  const runCalls = [];
  const statuses = [];
  context.document.body = root;
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100
  });

  context.getConversationRoot = () => root;
  context.updateSiteActionButton = () => {};
  context.setStatus = (text, state) => statuses.push({ text, state });
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.runAndReply = async (callId, call, options) => {
    runCalls.push({ callId, call, options });
  };
  vm.runInContext(
    `extensionActive = true; activeCallId = 'still-running'; initialThreadSettled = true; lastThreadText = ${JSON.stringify(root.innerText)}; lastThreadTextAt = Date.now() - 2000;`,
    context
  );

  await context.scanForShellCall({ force: true });
  assert.equal(runCalls.length, 0);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 500);
  assert.ok(
    statuses.some((status) => status.text === "Waiting for current helper call, then running latest"),
    `expected waiting status, got: ${JSON.stringify(statuses)}`
  );
  assert.equal(vm.runInContext("pendingForceRunRequested", context), true);

  vm.runInContext("activeCallId = '';", context);
  await context.scanForShellCall({ force: true });
  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].options?.force, true);
  assert.equal(runCalls[0].call.cmd, "echo NEW_PENDING_FORCE");
  assert.match(runCalls[0].callId, /:force:/);
  assert.equal(vm.runInContext("pendingForceRunRequested", context), false);
}

async function verifyDebugPanelListsAllCandidates() {
  // The debug body should list every detected helper-block candidate, mark
  // the selected one with [*], and surface the candidates:<idx>/<total>
  // header so the user can diagnose detection vs. execution issues without
  // opening DevTools.
  const context = loadContentContext();
  const oldCmd = "echo OLD_LIST";
  const newCmd = "echo NEW_LIST";
  const oldMessage = createAssistantMessage({
    order: 1,
    text: createHelperBlock({ cmd: oldCmd })
  });
  const newMessage = createAssistantMessage({
    order: 2,
    text: createHelperBlock({ cmd: newCmd })
  });
  const root = createRoot([oldMessage, newMessage]);
  context.document.body = root;
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100
  });

  const debugBody = { textContent: "" };
  const origGetElementById = context.document.getElementById;
  context.document.getElementById = (id) => {
    if (id === "ai-chat-shell-exec-debug-body") {
      return debugBody;
    }
    return origGetElementById(id);
  };

  context.getConversationRoot = () => root;
  context.updateSiteActionButton = () => {};
  context.setStatus = () => {};
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.runAndReply = async () => {};
  vm.runInContext("extensionActive = true; activeCallId = ''; initialThreadSettled = true;", context);

  await context.scanForShellCall({ force: true });

  const text = debugBody.textContent;
  assert.ok(
    text.includes("candidates: 2/2"),
    `debug body should contain 'candidates: 2/2' header but got: ${text}`
  );
  assert.ok(
    text.includes(oldCmd),
    `debug body should list the old candidate's cmd '${oldCmd}' but got: ${text}`
  );
  assert.ok(
    text.includes(newCmd),
    `debug body should list the new candidate's cmd '${newCmd}' but got: ${text}`
  );
  const lines = text.split("\n");
  const oldLine = lines.find((line) => line.includes(oldCmd) && /^\[[* ]\] #\d+/.test(line));
  const newLine = lines.find((line) => line.includes(newCmd) && /^\[[* ]\] #\d+/.test(line));
  assert.ok(oldLine, `expected a candidate row mentioning old cmd, got lines: ${lines.join(" | ")}`);
  assert.ok(newLine, `expected a candidate row mentioning new cmd, got lines: ${lines.join(" | ")}`);
  assert.ok(
    newLine.startsWith("[*]"),
    `selected marker [*] should be on the row with the newest cmd, got: ${newLine}`
  );
  assert.ok(
    oldLine.startsWith("[ ]"),
    `unselected marker [ ] should be on the row with the older cmd, got: ${oldLine}`
  );
}

async function verifySubmittedMessageReleasesStaleComposerWait() {
  const context = loadContentContext();
  const originalText = "Shell call result:\r\n\r\nstdout:\u00a0a b";
  const composer = { innerText: originalText, textContent: originalText };
  const submitted = [];
  context.document.querySelectorAll = (selector) =>
    selector.includes('data-message-author-role="user"') ? submitted : [];

  submitted.push(new MockNode({ text: `User\n${originalText}`, role: "user", order: 1 }));

  const result = await context.waitForSubmitted(composer, originalText, 0);
  assert.equal(result, true, "A newly rendered user message must release auto-send even when the old composer node still reports stale text.");

  submitted[0] = new MockNode({
    text: "User\nShell call result:\n\n\nstdout: a b",
    role: "user",
    order: 2
  });
  assert.equal(
    context.countSubmittedMessagesMatching(originalText),
    1,
    "CRLF, NBSP, and empty-paragraph count are the only tolerated whole-message DOM normalizations."
  );

  submitted[0] = {
    innerText: "User\nShell call result: stdout: a b",
    textContent: `User${originalText}`,
    querySelector: () => ({ textContent: "User" })
  };
  assert.equal(
    context.countSubmittedMessagesMatching(originalText),
    1,
    "When rendered innerText collapses semantic newlines, an explicit role node may be removed from exact raw textContent without weakening line matching."
  );

  submitted[0] = new MockNode({
    text: "User\nShell call result:\n\nstdout: a\nb",
    role: "user",
    order: 3
  });
  assert.equal(
    context.countSubmittedMessagesMatching(originalText),
    0,
    "A non-empty line boundary must not be collapsed into a space when proving submission."
  );

  submitted[0] = new MockNode({
    text: "User\nShell call result:\n\nstdout: a  b",
    role: "user",
    order: 4
  });
  assert.equal(
    context.countSubmittedMessagesMatching(originalText),
    0,
    "Whitespace inside a non-empty line remains semantic and must match exactly."
  );
}

async function verifyAutoSendDoesNotHoldExecutionLock() {
  const context = loadContentContext();
  await Promise.resolve();
  const composer = { innerText: "Shell call result", textContent: "Shell call result" };
  let autoSendStarted = false;
  let finishAutoSend;
  context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: true });
  context.chrome.runtime.sendMessage = async (payload) => payload.type === "run-shell" ? {
    ok: true,
    exitCode: 0,
    stdout: "ok"
  } : { ok: true };
  context.insertReply = async (text) => {
    composer.innerText = text;
    composer.textContent = text;
    return composer;
  };
  context.clickSendWhenReady = async () => {
    autoSendStarted = true;
    await new Promise((resolve) => {
      finishAutoSend = resolve;
    });
    return true;
  };
  context.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);

  const call = context.parseCallPayload(createHelperBlock({ cmd: "printf autosend" }));
  const runPromise = context.runAndReply("auto-send-lock", call);
  await waitForTestCondition(() => autoSendStarted);
  assert.equal(vm.runInContext("activeCallId", context), "", "UI auto-send must not keep the shell execution lock after the result is inserted.");
  finishAutoSend();
  await runPromise;
}

async function verifyBackendResponsesRetryOnlyLocalDelivery() {
  const context = loadContentContext();
  await Promise.resolve();
  context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: false });
  context.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);
  const call = context.parseCallPayload(createHelperBlock({ cmd: "printf retryable" }));

  context.chrome.runtime.sendMessage = async () => ({
    ok: false,
    executed: false,
    retryable: true,
    error: "tmux target unavailable before dispatch"
  });
  context.insertReply = async () => ({ innerText: "failure", textContent: "failure", isConnected: true });
  const unavailable = await context.runAndReply("retryable-unavailable", call);
  assert.equal(unavailable.retryable, false, "Once a backend response exists, composer delivery must not resend that same rendered helper.");

  context.chrome.runtime.sendMessage = async () => ({
    ok: true,
    executed: true,
    executionCompleted: true,
    exitCode: 0,
    stdout: "executed"
  });
  context.insertReply = async () => {
    throw new Error("composer disappeared before result insertion");
  };
  const insertionFailure = await context.runAndReply("retryable-insertion", call);
  assert.equal(insertionFailure.retryable, false, "An executed command whose output could not be inserted must retry only local reply delivery.");
  assert.equal(insertionFailure.deliveryFailed, true);
  assert.equal(insertionFailure.pendingDelivery, true);
}

async function verifyNonShellComposerWritesNeverReexecuteRenderedHelpers() {
  const context = loadContentContext();
  await Promise.resolve();
  context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: true });
  context.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);
  const call = context.parseCallPayload([
    "ai-helper-file-start",
    "write-once.txt",
    "write this file once",
    "ai-helper-file-end"
  ].join("\n"));
  let backendAttempts = 0;
  let composerWrites = 0;
  context.chrome.runtime.sendMessage = async () => {
    backendAttempts += 1;
    return {
      ok: true,
      filename: "write-once.txt",
      path: "/tmp/write-once.txt",
      bytes: 20
    };
  };
  context.insertReply = async (text) => {
    composerWrites += 1;
    return { innerText: text, textContent: text, isConnected: true };
  };
  context.clickSendWhenReady = async () => false;

  const completedResponse = await context.runAndReply("file-write-once-response", call);
  assert.equal(completedResponse.retryable, false, "A backend response must consume that rendered helper even when auto-send is not confirmed.");
  assert.equal(backendAttempts, 1);
  assert.equal(composerWrites, 1);

  context.chrome.runtime.sendMessage = async () => {
    backendAttempts += 1;
    throw new Error("file helper transport unavailable");
  };
  const failedResponse = await context.runAndReply("file-write-once-error", call);
  assert.equal(
    failedResponse.retryable,
    false,
    "Once an error reply was written into the composer, the same rendered side-effecting helper must not execute again."
  );
  assert.equal(backendAttempts, 2);
  assert.equal(composerWrites, 2);
}

async function verifySameRenderedPendingResultRetriesLocallyOnly() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  const backing = installPersistentLocalStorage(context);
  context.setTimeout = () => 1;
  context.clearTimeout = () => {};
  context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: true });
  const messages = [];
  context.chrome.runtime.sendMessage = async (payload) => {
    messages.push(payload);
    if (payload.type === "run-result-presented") {
      return { ok: true };
    }
    assert.equal(payload.type, "run-shell");
    return {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: "aabbccddeeff0011",
      exitCode: 0,
      stdout: "pending local output"
    };
  };
  const composer = { innerText: "", textContent: "", isConnected: true };
  let insertAttempts = 0;
  context.insertReply = async (text) => {
    insertAttempts += 1;
    composer.innerText = text;
    composer.textContent = text;
    return composer;
  };
  context.findReplyInput = async () => composer;
  let sendAttempts = 0;
  context.clickSendWhenReady = async () => {
    sendAttempts += 1;
    return sendAttempts > 1;
  };
  context.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);
  const call = context.parseCallPayload(createHelperBlock({ cmd: "printf pending-local" }));

  const first = await context.runAndReply("same-rendered-pending", call);
  assert.equal(first.retryable, false);
  assert.equal(first.pendingDelivery, true, "An unsuccessful auto-send must stay in the local pending queue.");
  assert.equal(messages.filter((payload) => payload.type === "run-shell").length, 1);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 1);
  assert.ok(Object.keys(backing).some((key) => key.startsWith("helperPendingDelivery:v1:")));

  const second = await context.runAndReply("same-rendered-pending", call);
  assert.equal(second.pendingDelivery, false);
  assert.equal(messages.filter((payload) => payload.type === "run-shell").length, 1, "Retrying the same rendered helper must retry only composer delivery.");
  assert.equal(insertAttempts, 1, "Once helper output is in the composer, send retries must not write it again.");
  assert.equal(sendAttempts, 2);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
  assert.ok(messages.some((payload) => payload.type === "run-result-presented" && payload.executionId === "aabbccddeeff0011"));
}

async function verifyDeletedPendingResultCancelsAutomaticComposerDelivery() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  installPersistentLocalStorage(context);
  context.setTimeout = () => 1;
  context.clearTimeout = () => {};
  context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: true });
  const messages = [];
  context.chrome.runtime.sendMessage = async (payload) => {
    messages.push(payload);
    if (payload.type === "run-result-presented") {
      throw new Error("A user-cancelled composer delivery must not be marked presented.");
    }
    assert.equal(payload.type, "run-shell");
    return {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: "decafbaddecafbad",
      exitCode: 0,
      stdout: "delete this pending output"
    };
  };
  const composer = {
    innerText: "",
    textContent: "",
    isConnected: true
  };
  let insertAttempts = 0;
  let sendAttempts = 0;
  context.insertReply = async (text) => {
    insertAttempts += 1;
    composer.innerText = text;
    composer.textContent = text;
    return composer;
  };
  context.findReplyInput = async () => composer;
  context.clickSendWhenReady = async () => {
    sendAttempts += 1;
    return false;
  };
  context.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);
  const call = context.parseCallPayload(createHelperBlock({ cmd: "printf delete-pending" }));

  const first = await context.runAndReply("deleted-pending-result", call);
  assert.equal(first.pendingDelivery, true);
  assert.equal(insertAttempts, 1);
  assert.equal(sendAttempts, 1);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 1);

  const secondCall = context.parseCallPayload(createHelperBlock({ cmd: "printf queued-after-delete" }));
  await context.rememberPendingHelperDelivery(
    "queued-after-deleted-result",
    secondCall,
    {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: "feedfacefeedface",
      exitCode: 0,
      stdout: "this queued result must not replace the deleted one"
    },
    "SECOND QUEUED REPLY",
    { autoSend: true }
  );
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 2);

  // This is an explicit user action, not a page-readiness failure. The
  // extension must yield ownership permanently instead of putting the output
  // back on its next local-delivery retry.
  composer.innerText = "";
  composer.textContent = "";
  const pendingEntry = vm.runInContext("Array.from(pendingHelperDeliveries.values())[0]", context);
  await context.attemptPendingHelperDelivery(pendingEntry, { autoSend: true });
  await context.retryPendingHelperDeliveries();

  assert.equal(insertAttempts, 1, "Deleting pending helper output must cancel every future automatic composer write.");
  assert.equal(sendAttempts, 1, "Deleted helper output must not trigger another send attempt.");
  assert.equal(messages.filter((payload) => payload.type === "run-shell").length, 1);
  assert.equal(messages.filter((payload) => payload.type === "run-result-presented").length, 0);
  assert.equal(
    vm.runInContext("pendingHelperDeliveries.size", context),
    0,
    "User cancellation should release the whole existing pending-delivery batch."
  );
}

async function verifyPendingResultRestoresAcrossSamePageReload() {
  const backing = {};
  const firstContext = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  installPersistentLocalStorage(firstContext, backing);
  firstContext.setTimeout = () => 1;
  firstContext.clearTimeout = () => {};
  firstContext.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: false });
  let firstBackendRuns = 0;
  firstContext.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "run-shell") {
      firstBackendRuns += 1;
      return {
        ok: true,
        executed: true,
        executionCompleted: true,
        executionId: "1122334455667788",
        exitCode: 0,
        stdout: "restore me after reload"
      };
    }
    return { ok: true };
  };
  firstContext.insertReply = async () => {
    throw new Error("composer missing before reload");
  };
  firstContext.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle(); initialThreadSettled = true;", firstContext);
  const call = firstContext.parseCallPayload(createHelperBlock({ cmd: "printf reload-pending" }));
  const firstOutcome = await firstContext.runAndReply("reload-pending-call", call);
  assert.equal(firstOutcome.pendingDelivery, true);
  assert.equal(firstBackendRuns, 1);
  assert.ok(Object.keys(backing).some((key) => key.startsWith("helperPendingDelivery:v1:")));

  const restoredContext = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  installPersistentLocalStorage(restoredContext, backing);
  restoredContext.setTimeout = () => 1;
  restoredContext.clearTimeout = () => {};
  restoredContext.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: false });
  const restoredMessages = [];
  restoredContext.chrome.runtime.sendMessage = async (payload) => {
    restoredMessages.push(payload);
    if (payload.type === "run-shell") {
      throw new Error("Reload recovery must not resend run-shell");
    }
    return { ok: true };
  };
  const inserted = [];
  restoredContext.insertReply = async (text) => {
    inserted.push(text);
    return { innerText: text, textContent: text, isConnected: true };
  };
  restoredContext.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle(); initialThreadSettled = true;", restoredContext);
  await restoredContext.loadPendingHelperDeliveriesForCurrentPage();
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", restoredContext), 1, `Expected one restored pending result; storage keys: ${Object.keys(backing).join(", ")}`);
  vm.runInContext("extensionActive = true; initialThreadSettled = true;", restoredContext);
  assert.equal(vm.runInContext("pendingHelperDeliveryRetryInFlight", restoredContext), false);
  await restoredContext.retryPendingHelperDeliveries();

  assert.equal(inserted.length, 1);
  assert.match(inserted[0], /restore me after reload/);
  assert.equal(restoredMessages.filter((payload) => payload.type === "run-shell").length, 0);
  assert.ok(restoredMessages.some((payload) => payload.type === "run-result-presented" && payload.executionId === "1122334455667788"));
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", restoredContext), 0);
  const retainedKey = Object.keys(backing).find((key) => key.startsWith("helperPendingDelivery:v1:"));
  assert.ok(retainedKey, "A bounded local presentation tombstone remains for stale duplicate responses.");
  assert.equal(backing[retainedKey].entries.length, 0);
  assert.ok(backing[retainedKey].presentedExecutions.some((entry) => entry.executionId === "1122334455667788"));
}

async function verifyPresentationReceiptRetriesWithoutDuplicateInsertion() {
  const backing = {};
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  installPersistentLocalStorage(context, backing);
  context.setTimeout = () => 1;
  context.clearTimeout = () => {};
  context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: false });
  const executionId = "8899aabbccddeeff";
  let runCount = 0;
  let receiptCount = 0;
  let receiptReady = false;
  const inserted = [];
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "run-result-presented") {
      receiptCount += 1;
      return receiptReady
        ? { ok: true, found: true, matched: 1 }
        : { ok: false, error: "service worker/server restart" };
    }
    assert.equal(payload.type, "run-shell");
    runCount += 1;
    if (runCount === 1) {
      return {
        ok: true,
        executed: true,
        executionCompleted: true,
        executionId,
        exitCode: 0,
        stdout: "present exactly once"
      };
    }
    return {
      ok: true,
      duplicate: true,
      skipped: true,
      replayedOutput: true,
      previousResultPresented: false,
      reason: "already-executed-on-target",
      executionId,
      executed: true,
      executionCompleted: true,
      exitCode: 0,
      stdout: "present exactly once"
    };
  };
  context.insertReply = async (text) => {
    inserted.push(text);
    return { innerText: text, textContent: text, isConnected: true };
  };
  context.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);
  const call = context.parseCallPayload(createHelperBlock({ cmd: "printf present-once" }));

  const first = await context.runAndReply("presentation-first", call);
  assert.equal(first.pendingDelivery, false);
  assert.equal(inserted.length, 1);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 1, "A failed receipt must remain durably pending after local presentation.");
  assert.equal(receiptCount, 1);

  const staleDuplicate = await context.runAndReply("presentation-stale-duplicate", call);
  assert.equal(staleDuplicate.suppressedDuplicate, true, "A locally presented execution suppresses a stale backend unpresented duplicate response.");
  assert.equal(inserted.length, 1, "The stale duplicate replay must not re-enter the composer.");

  receiptReady = true;
  vm.runInContext("extensionActive = true;", context);
  await context.retryPendingHelperDeliveries();
  assert.equal(
    receiptCount,
    2,
    `The durable presentation receipt must retry until acknowledged. state=${vm.runInContext("JSON.stringify(Array.from(pendingHelperDeliveries.values()).map(({ callId, phase, deliveryInFlight, pageIdentity }) => ({ callId, phase, deliveryInFlight, pageIdentity })))", context)}`
  );
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
  assert.equal(inserted.length, 1);

  const restored = loadContentContext();
  await Promise.resolve();
  installPersistentLocalStorage(restored, backing);
  restored.setTimeout = () => 1;
  restored.clearTimeout = () => {};
  restored.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: false });
  let restoredInsertions = 0;
  restored.chrome.runtime.sendMessage = async (payload) => payload.type === "run-shell"
    ? {
        ok: true,
        duplicate: true,
        skipped: true,
        replayedOutput: true,
        previousResultPresented: false,
        executionId,
        executed: true,
        executionCompleted: true,
        stdout: "present exactly once"
      }
    : { ok: true, found: true };
  restored.insertReply = async () => {
    restoredInsertions += 1;
    throw new Error("locally presented stale replay must stay out of composer");
  };
  restored.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle();", restored);
  await restored.loadPendingHelperDeliveriesForCurrentPage();
  const restoredOutcome = await restored.runAndReply("presentation-restored-duplicate", call);
  assert.equal(restoredOutcome.suppressedDuplicate, true);
  assert.equal(restoredInsertions, 0);
}

async function verifyCanonicalExecutionCoalescesPendingDeliveries() {
  const context = loadContentContext();
  await Promise.resolve();
  installPersistentLocalStorage(context);
  context.setTimeout = () => 1;
  context.clearTimeout = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);
  const call = context.parseCallPayload(createHelperBlock({ cmd: "printf coalesce" }));
  const response = {
    ok: true,
    executionId: "1029384756abcdef",
    executed: true,
    executionCompleted: true,
    exitCode: 0,
    stdout: "coalesced output"
  };
  const first = await context.rememberPendingHelperDelivery("coalesce-first", call, response, "FIRST REPLY", { autoSend: false });
  const second = await context.rememberPendingHelperDelivery("coalesce-second", call, response, "SECOND REPLY", { autoSend: false });

  assert.equal(first, second, "Concurrent local responses with one canonical executionId must share one pending delivery entry.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 1);
  assert.equal(second.reply, "FIRST REPLY", "Coalescing must retain the already-queued canonical result instead of replacing composer ownership text.");
}

async function verifyNewRenderRootCanRunWhileOldReplyIsPending() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  installPersistentLocalStorage(context);
  context.setTimeout = () => 1;
  context.clearTimeout = () => {};
  const cmd = "printf identical-new-root";
  const firstMessage = createAssistantMessage({ order: 1, text: createHelperBlock({ cmd }) });
  let root = createRoot([firstMessage]);
  let backendRuns = 0;
  context.document.body = root;
  context.getConversationRoot = () => root;
  context.updateSiteActionButton = () => {};
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.setStatus = () => {};
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100,
    requireApproval: false,
    autoSend: false
  });
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type !== "run-shell") {
      return { ok: true };
    }
    backendRuns += 1;
    return {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: `new-root-${backendRuns}`,
      exitCode: 0,
      stdout: `result-${backendRuns}`
    };
  };
  context.insertReply = async () => {
    throw new Error("keep each result pending");
  };
  vm.runInContext(
    `extensionActive = true; beginPageLifecycle(); initialThreadSettled = true; lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))}; lastThreadTextAt = Date.now() - 2000;`,
    context
  );
  await context.scanForShellCall();
  assert.equal(backendRuns, 1);

  const secondMessage = createAssistantMessage({ order: 2, text: createHelperBlock({ cmd }) });
  root = createRoot([firstMessage, secondMessage]);
  context.document.body = root;
  vm.runInContext(`extensionActive = true; initialThreadSettled = true; lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))}; lastThreadTextAt = Date.now() - 2000;`, context);
  await context.scanForShellCall();

  assert.equal(backendRuns, 2, "An identical helper in a new render root must receive its own backend adjudication.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 2);
}

async function verifyAuthoritativeDuplicateStaysLocal() {
  const context = loadContentContext();
  await Promise.resolve();
  const inserted = [];
  let sendAttempts = 0;
  const statuses = [];
  context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: true });
  context.chrome.runtime.sendMessage = async (payload) => {
    assert.equal(payload.type, "run-shell");
    return {
      ok: true,
      duplicate: true,
      skipped: true,
      executed: true,
      executionCompleted: true,
      reason: "already-executed-on-target",
      target: "%1",
      targetName: "ForAI:host",
      stdout: "previous output",
      replayedOutput: true,
      previousResultPresented: true,
      executionId: "0123456789abcdef"
    };
  };
  context.insertReply = async (text) => {
    inserted.push(text);
    return { innerText: text, textContent: text, isConnected: true };
  };
  context.clickSendWhenReady = async () => {
    sendAttempts += 1;
    return true;
  };
  context.setStatus = (text, state) => statuses.push({ text, state });
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);

  const call = context.parseCallPayload(createHelperBlock({ cmd: "printf duplicate" }));
  const outcome = await context.runAndReply("authoritative-duplicate", call);

  assert.equal(outcome.retryable, false, "An authoritative duplicate consumes only that rendered helper request.");
  assert.equal(outcome.suppressedDuplicate, true);
  assert.equal(outcome.deliveryFailed, false);
  assert.deepEqual(inserted, [], "Duplicate metadata and replayed output must never enter the chat composer.");
  assert.equal(sendAttempts, 0, "A duplicate verdict must never trigger model-facing auto-send.");
  assert.ok(
    statuses.some(({ text, state }) => state === "ok" && text.includes("Server confirmed duplicate shell command")),
    "The local extension panel must still explain the backend duplicate verdict."
  );
}

async function verifyDuplicateConsumesOnlySameRenderedHelper() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  const message = createAssistantMessage({
    order: 1,
    text: createHelperBlock({ cmd: "printf duplicate-scan" })
  });
  const root = createRoot([message]);
  let backendRuns = 0;
  let insertions = 0;
  context.document.body = root;
  context.getConversationRoot = () => root;
  context.updateSiteActionButton = () => {};
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.setStatus = () => {};
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100,
    requireApproval: false,
    autoSend: true
  });
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type !== "run-shell") {
      return { ok: true };
    }
    backendRuns += 1;
    return {
      ok: true,
      duplicate: true,
      skipped: true,
      replayedOutput: true,
      previousResultPresented: true,
      executionId: "fedcba9876543210",
      executed: true,
      executionCompleted: true,
      reason: "already-executed-on-target"
    };
  };
  context.insertReply = async () => {
    insertions += 1;
    throw new Error("duplicate must never reach the composer");
  };
  vm.runInContext(
    `extensionActive = true; initialThreadSettled = true; lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))}; lastThreadTextAt = Date.now() - 2000; beginPageLifecycle(); initialThreadSettled = true; lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))}; lastThreadTextAt = Date.now() - 2000;`,
    context
  );

  await context.scanForShellCall();
  vm.runInContext("lastThreadTextAt = Date.now() - 2000;", context);
  await context.scanForShellCall();

  assert.equal(backendRuns, 1, "The same rendered helper must stay handled after an authoritative duplicate verdict.");
  assert.equal(insertions, 0);
}

async function verifyUnpresentedDuplicateRecoversCleanResult() {
  const context = loadContentContext();
  await Promise.resolve();
  const inserted = [];
  const messages = [];
  context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: false });
  context.chrome.runtime.sendMessage = async (payload) => {
    messages.push(payload);
    if (payload.type === "run-result-presented") {
      return { ok: true, found: true, matched: 1 };
    }
    assert.equal(payload.type, "run-shell");
    return {
      ok: true,
      duplicate: true,
      skipped: true,
      replayedOutput: true,
      previousResultPresented: false,
      reason: "already-executed-on-target",
      previousCallKey: "original-call",
      executionId: "0011223344556677",
      executed: true,
      executionCompleted: true,
      exitCode: 130,
      interrupted: true,
      interruptSignal: "INT",
      stdout: "original stdout",
      stderr: "Command interrupted by Ctrl+C (SIGINT).",
      target: "%1",
      targetName: "ForAI:host",
      cwd: "/tmp",
      durationMs: 0
    };
  };
  context.insertReply = async (text) => {
    inserted.push(text);
    return { innerText: text, textContent: text, isConnected: true };
  };
  context.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);

  const call = context.parseCallPayload(createHelperBlock({ cmd: "sleep 60" }));
  const outcome = await context.runAndReply("recover-unpresented-duplicate", call);

  assert.equal(outcome.retryable, false);
  assert.equal(outcome.recoveredUnpresentedResult, true);
  assert.equal(inserted.length, 1);
  assert.match(inserted[0], /^recovered: true$/m);
  assert.match(inserted[0], /^executionId: 0011223344556677$/m);
  assert.match(inserted[0], /stdout:\noriginal stdout/);
  assert.match(inserted[0], /^interrupted: true$/m);
  assert.doesNotMatch(inserted[0], /^duplicate: true$/m);
  assert.doesNotMatch(inserted[0], /^skipped: true$/m);
  assert.doesNotMatch(inserted[0], /^replayedOutput: true$/m);
  assert.doesNotMatch(inserted[0], /^reason:/m);
  assert.ok(messages.some((payload) => payload.type === "run-result-presented" && payload.executionId === "0011223344556677"));
}

async function verifyRejectedHelperUsesComposerLeaseAndPreservesDraft() {
  const context = loadContentContext();
  await Promise.resolve();
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);
  const metadata = {
    pageIdentity: context.getCurrentPageIdentity(),
    generation: vm.runInContext("pageLifecycleGeneration", context)
  };
  let releaseFirstWriter;
  const firstWriter = context.withComposerDeliveryLease({ ...metadata, kind: "test-writer" }, async () => {
    await new Promise((resolve) => {
      releaseFirstWriter = resolve;
    });
  });
  await waitForTestCondition(() => releaseFirstWriter);

  const composer = new context.HTMLTextAreaElement();
  composer.value = "User draft that must remain untouched";
  let focusCount = 0;
  let sendAttempts = 0;
  let insertAttempts = 0;
  let insertOptions = null;
  composer.focus = () => {
    focusCount += 1;
  };
  context.findReplyInput = async () => composer;
  const originalInsertReply = context.insertReply;
  context.insertReply = async (text, options) => {
    insertAttempts += 1;
    insertOptions = options;
    return originalInsertReply(text, options);
  };
  context.clickSendWhenReady = async () => {
    sendAttempts += 1;
    return true;
  };
  context.setStatus = () => {};

  const rejected = context.replyWithRejectedCall(
    context.parseCallPayload(createHelperBlock({ cmd: "printf rejected" })),
    "test rejection"
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(insertAttempts, 0, "Rejected-helper feedback must wait behind the existing composer writer.");

  releaseFirstWriter();
  await firstWriter;
  assert.equal(await rejected, false);
  assert.equal(insertAttempts, 1);
  assert.equal(insertOptions?.preserveExisting, true);
  assert.equal(composer.value, "User draft that must remain untouched");
  assert.equal(focusCount, 0, "The occupied-composer check must run before focus or mutation.");
  assert.equal(sendAttempts, 0, "Rejected feedback that could not acquire the composer must never auto-send.");
}

async function verifyComposerDeliveryLeaseSerializesWriters() {
  const context = loadContentContext();
  const events = [];
  let releaseFirst;
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);
  const metadata = {
    pageIdentity: context.getCurrentPageIdentity(),
    generation: vm.runInContext("pageLifecycleGeneration", context)
  };
  const first = context.withComposerDeliveryLease({ ...metadata, kind: "helper-output" }, async () => {
    events.push("helper-start");
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    events.push("helper-end");
  });
  await waitForTestCondition(() => releaseFirst);
  const second = context.withComposerDeliveryLease({ ...metadata, kind: "agent-message" }, async () => {
    events.push("agent-start");
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ["helper-start"], "A second composer writer must wait without overwriting the first delivery.");
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["helper-start", "helper-end", "agent-start"]);
}

async function verifyAutoSendAbortsWhenComposerOwnershipChanges() {
  const context = loadContentContext();
  let clicks = 0;
  let formSubmits = 0;
  let focuses = 0;
  let keyboardEvents = 0;
  const form = {
    requestSubmit() {
      formSubmits += 1;
    }
  };
  const makeComposer = (text) => ({
    innerText: text,
    textContent: text,
    isConnected: true,
    closest: () => form,
    focus() {
      focuses += 1;
    },
    dispatchEvent() {
      keyboardEvents += 1;
    }
  });
  const button = {
    disabled: false,
    getAttribute: () => "false",
    click() {
      clicks += 1;
    }
  };
  context.sleep = async () => {};

  const overwritten = makeComposer("Shell call result: original");
  context.findSendButton = () => {
    overwritten.innerText = "A newly typed user or agent prompt";
    overwritten.textContent = overwritten.innerText;
    return button;
  };
  assert.equal(await context.clickSendWhenReady(overwritten), false);
  assert.deepEqual(
    { clicks, formSubmits, focuses, keyboardEvents },
    { clicks: 0, formSubmits: 0, focuses: 0, keyboardEvents: 0 },
    "Auto-send must recheck exact composer ownership after button lookup and before every send side effect."
  );

  const disconnected = makeComposer("Shell call result: disconnected");
  disconnected.isConnected = false;
  context.findSendButton = () => button;
  assert.equal(await context.clickSendWhenReady(disconnected), false);

  const emptied = makeComposer("");
  assert.equal(await context.clickSendWhenReady(emptied), false, "An empty composer without a newly rendered submitted message is not proof of submission.");
  assert.deepEqual(
    { clicks, formSubmits, focuses, keyboardEvents },
    { clicks: 0, formSubmits: 0, focuses: 0, keyboardEvents: 0 },
    "Disconnected, overwritten, and empty composers must never trigger click, form, focus, or keyboard side effects."
  );
}

async function verifyUnboundSendButtonIsTriedImmediately() {
  const context = loadContentContext();
  const text = "Shell call result: heartbeat completed";
  const composer = {
    innerText: text,
    textContent: text,
    isConnected: true,
    closest: () => null,
    focus() {},
    dispatchEvent() {}
  };
  const submitted = [];
  const preferBoundOnlyValues = [];
  let clicks = 0;
  context.document.querySelectorAll = (selector) =>
    selector.includes("data-message-author-role") ? submitted : [];
  context.findSendButton = (_composer, preferBoundOnly) => {
    preferBoundOnlyValues.push(preferBoundOnly);
    return {
      disabled: false,
      getAttribute: () => "false",
      click() {
        clicks += 1;
        submitted.push({ innerText: text, textContent: text });
        composer.innerText = "";
        composer.textContent = "";
      }
    };
  };
  context.sleep = async () => {};

  assert.equal(await context.clickSendWhenReady(composer), true);
  assert.equal(clicks, 1);
  assert.equal(
    preferBoundOnlyValues[0],
    false,
    "A visible unbound page send button must be eligible on the first attempt so one queued composer delivery cannot delay every later helper."
  );
}

async function verifyUnrelatedPostInsertionDraftIsNeverAdopted() {
  const context = loadContentContext();
  let sendLookupCount = 0;
  const intended = "Shell call result:\n\nstdout:\nbackend output";
  const userDraft = {
    innerText: "This is the user's unrelated draft",
    textContent: "This is the user's unrelated draft",
    isConnected: true
  };
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);
  context.insertReply = async () => userDraft;
  context.findSendButton = () => {
    sendLookupCount += 1;
    return null;
  };

  const delivered = await context.deliverHelperReply({
    pageIdentity: context.getCurrentPageIdentity(),
    generation: vm.runInContext("pageLifecycleGeneration", context),
    phase: "response-received"
  }, intended, { autoSend: true });

  assert.equal(delivered, false);
  assert.equal(sendLookupCount, 0, "An unrelated post-insertion draft must fail ownership validation before send-button discovery.");
  assert.equal(context.getValidatedComposerOwnershipText(userDraft, intended), "");
  assert.equal(
    context.getValidatedComposerOwnershipText(
      { innerText: "Shell call result:\r\n\r\n\r\nstdout:\r\nbackend\u00a0output", textContent: "" },
      intended
    ),
    "Shell call result:\n\n\nstdout:\nbackend\u00a0output",
    "Only CRLF, NBSP, and empty-paragraph count may vary when adopting an existing composer."
  );
  assert.equal(
    context.getValidatedComposerOwnershipText(
      { innerText: "Shell call result:\n\nstdout: backend\noutput", textContent: "" },
      intended
    ),
    "",
    "Composer ownership must distinguish an internal space from a non-empty line break."
  );
}

async function verifyHelperSendReacquiresRedrawnOwnedComposer() {
  const context = loadContentContext();
  const intended = "Shell call result:\n\nstdout:\nredrawn composer output";
  const oldComposer = {
    innerText: intended,
    textContent: intended,
    isConnected: false
  };
  const replacementComposer = {
    innerText: intended,
    textContent: intended,
    isConnected: true
  };
  let sendComposer = null;
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);
  context.insertReply = async () => oldComposer;
  context.findReplyInput = async () => replacementComposer;
  context.clickSendWhenReady = async (composer, _shouldContinue, expectedText) => {
    sendComposer = composer;
    return composer === replacementComposer && expectedText === intended;
  };

  const delivered = await context.deliverHelperReply({
    pageIdentity: context.getCurrentPageIdentity(),
    generation: vm.runInContext("pageLifecycleGeneration", context),
    phase: "response-received"
  }, intended, { autoSend: true });

  assert.equal(delivered, true, "A page redraw that preserves exact plugin-owned text must still auto-send.");
  assert.equal(sendComposer, replacementComposer, "Auto-send must reacquire the connected composer instead of using the detached writer node.");
}

async function verifyInsertReplyPreservesExistingComposerAtomically() {
  const context = loadContentContext();
  const composer = new context.HTMLTextAreaElement();
  composer.value = "User draft that must remain untouched";
  composer.innerText = "";
  composer.textContent = "";
  let focusCount = 0;
  let mutationCount = 0;
  composer.focus = () => {
    focusCount += 1;
  };
  composer.dispatchEvent = () => {
    mutationCount += 1;
  };
  context.findReplyInput = async () => composer;

  await assert.rejects(
    () => context.insertReply("Shell call result:\nstdout:\nnew output", { preserveExisting: true }),
    (error) => error?.code === "composer-occupied"
  );
  assert.equal(composer.value, "User draft that must remain untouched");
  assert.equal(focusCount, 0, "The occupied-composer guard must run before focus.");
  assert.equal(mutationCount, 0, "The occupied-composer guard must run before input/DOM mutation.");

  composer.value = "Shell call result:\r\n\r\n\r\nstdout:\r\nreplayed\u00a0output";
  const reused = await context.insertReply(
    "Shell call result:\n\nstdout:\nreplayed output",
    { preserveExisting: true }
  );
  assert.equal(reused, composer, "An equivalent retry may reuse the existing composer without rewriting it.");
  assert.equal(composer.value, "Shell call result:\r\n\r\n\r\nstdout:\r\nreplayed\u00a0output");
  assert.equal(focusCount, 0);
  assert.equal(mutationCount, 0);
}

async function verifyLaterHelperCannotOverwriteUnsentEarlierOutput() {
  const context = loadContentContext();
  const composer = {
    innerText: "",
    textContent: "",
    isConnected: true
  };
  let clickCount = 0;
  context.insertReply = async (text, options) => {
    assert.equal(options?.preserveExisting, true);
    if (context.getComposerText(composer)) {
      if (context.getValidatedComposerOwnershipText(composer, text)) {
        return composer;
      }
      const error = new Error("composer occupied");
      error.code = "composer-occupied";
      throw error;
    }
    composer.innerText = text;
    composer.textContent = text;
    return composer;
  };
  context.clickSendWhenReady = async () => {
    clickCount += 1;
    return false;
  };
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);
  const metadata = () => ({
    pageIdentity: context.getCurrentPageIdentity(),
    generation: vm.runInContext("pageLifecycleGeneration", context),
    phase: "response-received"
  });
  const first = "Shell call result:\n\nstdout:\nFIRST UNSENT OUTPUT";
  const second = "Shell call result:\n\nstdout:\nSECOND OUTPUT";

  assert.equal(await context.deliverHelperReply(metadata(), first, { autoSend: true }), false, "An unsent result remains pending even when its text is still intact.");
  assert.equal(context.getComposerText(composer), context.normalizeCommand(first));
  assert.equal(await context.deliverHelperReply(metadata(), second, { autoSend: true }), false);
  assert.equal(context.getComposerText(composer), context.normalizeCommand(first), "A later helper must leave the earlier unsent output byte-for-byte intact after normalization.");
  assert.equal(clickCount, 1, "The occupied second delivery must fail before send calibration.");

  assert.equal(await context.deliverHelperReply(metadata(), first, { autoSend: true }), false);
  assert.equal(clickCount, 2, "A replay of the exact first output may reuse the composer and retry sending.");
}

async function verifyUnboundSendAssociationRejectsFeedbackAndArbitrarySubmit() {
  const context = loadContentContext();
  const region = { contains: () => true };
  const composer = {
    id: "composer-id",
    closest: (selector) => selector === "form" ? null : region,
    parentElement: region,
    getBoundingClientRect: () => ({ left: 0, right: 400, top: 0, bottom: 100 })
  };
  const button = ({ ariaLabel = "", text = "", type = "button", testId = "", controls = "" }) => ({
    textContent: text,
    getAttribute(name) {
      if (name === "aria-label") return ariaLabel;
      if (name === "type") return type;
      if (name === "data-testid") return testId;
      if (name === "aria-controls") return controls;
      return "";
    },
    matches(selector) {
      return Boolean(testId && selector.includes(`[data-testid="${testId}"]`));
    },
    closest: () => null,
    getBoundingClientRect: () => ({ left: 360, right: 400, top: 30, bottom: 70 })
  });

  assert.equal(
    context.isSendButtonAssociatedWithComposer(button({ ariaLabel: "Send feedback", text: "Send feedback" }), composer, region),
    false
  );
  assert.equal(
    context.isSendButtonAssociatedWithComposer(button({ ariaLabel: "Continue", type: "submit" }), composer, region),
    false,
    "A submit type outside an actual composer form is not sufficient association."
  );
  assert.equal(
    context.isSendButtonAssociatedWithComposer(button({ ariaLabel: "Send message", text: "Send" }), composer, region),
    true
  );
  assert.equal(
    context.isSendButtonAssociatedWithComposer(button({ testId: "send-button", ariaLabel: "Send message" }), composer, region),
    true
  );
}

async function verifyBoundSendButtonMustBelongToCurrentComposer() {
  const context = loadContentContext();
  const currentForm = {
    contains: (node) => node?.form === currentForm,
    querySelectorAll: () => [heuristicButton]
  };
  const staleForm = { contains: () => false };
  const composer = {
    id: "current-composer",
    closest: (selector) => selector === "form" ? currentForm : null,
    parentElement: currentForm,
    getBoundingClientRect: () => ({ left: 0, right: 400, top: 0, bottom: 100 })
  };
  const makeButton = ({ form, label = "Send message", type = "button", testId = "" }) => {
    const node = new context.HTMLButtonElement();
    node.form = form;
    node.textContent = label;
    node.getAttribute = (name) => {
      if (name === "aria-label") return label;
      if (name === "type") return type;
      if (name === "data-testid") return testId;
      if (name === "aria-controls") return "";
      if (name === "title") return "";
      return "";
    };
    node.matches = (selector) => Boolean(testId && selector.includes(`[data-testid="${testId}"]`));
    node.closest = (selector) => selector === "form" ? form : null;
    node.getBoundingClientRect = () => ({ width: 40, height: 40, left: 350, right: 390, top: 30, bottom: 70 });
    return node;
  };
  const validBound = makeButton({ form: currentForm, type: "submit" });
  const staleBound = makeButton({ form: staleForm, type: "submit" });
  const unrelatedBound = makeButton({ form: currentForm, label: "Attach file" });
  const heuristicButton = makeButton({ form: currentForm, testId: "send-button" });

  assert.equal(context.isBoundSendButtonAssociatedWithComposer(validBound, composer), true);
  assert.equal(
    context.isBoundSendButtonAssociatedWithComposer(staleBound, composer),
    false,
    "A saved selector that now resolves inside a stale SPA form must not be clicked."
  );
  assert.equal(
    context.isBoundSendButtonAssociatedWithComposer(unrelatedBound, composer),
    false,
    "A saved node still in the form must retain send semantics; structural proximity alone is insufficient."
  );

  context.findBoundSendButton = () => validBound;
  assert.equal(context.findSendButton(composer, false), validBound, "A valid saved send control remains preferred.");

  context.findBoundSendButton = () => staleBound;
  assert.equal(
    context.findSendButton(composer, false),
    heuristicButton,
    "A stale saved binding falls back to current-page heuristics without deleting the saved selector."
  );
}

async function verifyNoOpSendButtonHasBoundedRetries() {
  const context = loadContentContext();
  const text = "Shell call result: bounded calibration";
  const composer = {
    innerText: text,
    textContent: text,
    isConnected: true,
    closest: () => null,
    focus() {},
    dispatchEvent() {}
  };
  let clicks = 0;
  context.document.querySelectorAll = () => [];
  context.findSendButton = () => ({
    disabled: false,
    getAttribute: () => "false",
    click() {
      clicks += 1;
    }
  });
  context.trySubmitForm = () => false;
  context.tryKeyboardSubmit = () => false;
  context.sleep = async () => {};

  assert.equal(await context.clickSendWhenReady(composer), false);
  assert.equal(clicks, 2, "A no-op heuristic candidate must not be clicked on every calibration attempt.");
}

verifyForceRunUsesLatestHelper()
  .then(() => verifyDebugPanelUpdates())
  .then(() => verifyFrontendDoesNotDedupCommands())
  .then(() => verifyHiddenStopButtonDoesNotBlockHelperScan())
  .then(() => verifyUnexpectedHelperCancelsSelfTestAndRuns())
  .then(() => verifyPendingAgentDeliveryDefersWithoutConsumingHelper())
  .then(() => verifyRetryableAttemptDoesNotConsumeSameRenderedHelper())
  .then(() => verifyStaleLongCallCannotAffectNewPageCall())
  .then(() => verifyRuntimeChannelCloseRecoversByStatusOnly())
  .then(() => verifyAmbiguousShellRecoveryFailureDoesNotResendSameRenderedHelper())
  .then(() => verifyBoardRuntimeChannelCloseRecoversByStatusOnly())
  .then(() => verifyBoardRecoveryFailureStaysLocal())
  .then(() => verifyMixedShellOutputAndNewHelperRunsNormally())
  .then(() => verifyVirtualizedReplacementAndSharedContainerRemainRunnable())
  .then(() => verifyRenderedShellOutputStructureIsSuppressed())
  .then(() => verifyAgentHelperInsideShellOutputIsSuppressed())
  .then(() => verifyNewIdenticalHelperAfterFailedAttemptRuns())
  .then(() => verifyDebugPanelUpdatesDuringStreaming())
  .then(() => verifyDebugPanelUpdatesWhileActiveCallRunning())
  .then(() => verifyForceRunPersistsWhileActiveCallRunning())
  .then(() => verifyDebugPanelListsAllCandidates())
  .then(() => verifySubmittedMessageReleasesStaleComposerWait())
  .then(() => verifyAutoSendDoesNotHoldExecutionLock())
  .then(() => verifyBackendResponsesRetryOnlyLocalDelivery())
  .then(() => verifyNonShellComposerWritesNeverReexecuteRenderedHelpers())
  .then(() => verifySameRenderedPendingResultRetriesLocallyOnly())
  .then(() => verifyDeletedPendingResultCancelsAutomaticComposerDelivery())
  .then(() => verifyPendingResultRestoresAcrossSamePageReload())
  .then(() => verifyPresentationReceiptRetriesWithoutDuplicateInsertion())
  .then(() => verifyCanonicalExecutionCoalescesPendingDeliveries())
  .then(() => verifyNewRenderRootCanRunWhileOldReplyIsPending())
  .then(() => verifyAuthoritativeDuplicateStaysLocal())
  .then(() => verifyDuplicateConsumesOnlySameRenderedHelper())
  .then(() => verifyUnpresentedDuplicateRecoversCleanResult())
  .then(() => verifyRejectedHelperUsesComposerLeaseAndPreservesDraft())
  .then(() => verifyComposerDeliveryLeaseSerializesWriters())
  .then(() => verifyAutoSendAbortsWhenComposerOwnershipChanges())
  .then(() => verifyUnboundSendButtonIsTriedImmediately())
  .then(() => verifyUnrelatedPostInsertionDraftIsNeverAdopted())
  .then(() => verifyHelperSendReacquiresRedrawnOwnedComposer())
  .then(() => verifyInsertReplyPreservesExistingComposerAtomically())
  .then(() => verifyLaterHelperCannotOverwriteUnsentEarlierOutput())
  .then(() => verifyUnboundSendAssociationRejectsFeedbackAndArbitrarySubmit())
  .then(() => verifyBoundSendButtonMustBelongToCurrentComposer())
  .then(() => verifyNoOpSendButtonHasBoundedRetries())
  .then(() => {
    console.log("content last-shell-call candidate tests passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
