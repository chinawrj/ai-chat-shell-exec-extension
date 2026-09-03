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

function createSkillLoadBlock({ helperId, skillId, catalogSha }) {
  return [
    `ai-helper-skill-start:${helperId}`,
    "cmd: load",
    `skill-id: ${skillId}`,
    `catalog-sha: ${catalogSha}`,
    "ai-helper-skill-end"
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
    URL,
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
  const previousPageIdentity = context.getCurrentPageIdentity();
  context.location.pathname = "/c/same-rendered-helper-new-route";
  context.location.href = `${context.location.origin}${context.location.pathname}`;
  vm.runInContext(
    `routeHandoffPreviousPageIdentity = ${JSON.stringify(previousPageIdentity)};`,
    context
  );
  assert.equal(
    context.getHandledHelperReason(firstShellCandidate, "route-changed-shell-call", shellSemanticKey, shell),
    "processed rendered helper carried across pending route delivery",
    "A pending-delivery route handoff must not turn the exact same rendered helper into a new backend request."
  );
}

async function verifyHiddenStopButtonDoesNotBlockHelperScan() {
  const context = loadContentContext();
  const hiddenStop = new MockNode({ text: "Stop generating", visible: false });
  const visibleStop = new MockNode({ text: "Stop generating", visible: true });
  const composer = new MockNode({ visible: true });
  const composerForm = new MockNode({ children: [composer, visibleStop] });
  visibleStop.closest = (selector) => String(selector).trim() === "form" ? composerForm : null;
  const outsideStop = new MockNode({ text: "Stop generating", visible: true });
  const ambiguousStop = new MockNode({ text: "Stop", visible: true });

  context.document.querySelectorAll = () => [hiddenStop];
  assert.equal(context.isAssistantGenerating(), false, "A hidden stale Stop button must not block helper execution.");

  context.document.querySelectorAll = () => [visibleStop];
  assert.equal(context.isAssistantGenerating(), true,
    "A visible exact generation control in the ChatGPT composer form must be recognized.");

  context.document.querySelectorAll = () => [outsideStop];
  assert.equal(context.isAssistantGenerating(), false,
    "A visible exact Stop outside the ChatGPT composer form must not become generation evidence.");

  context.document.querySelectorAll = () => [ambiguousStop];
  assert.equal(context.isAssistantGenerating(), false,
    "A generic visible Stop button must not become executable-helper generation evidence.");
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
    `extensionActive = true;
     initialThreadSettled = true;
     lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))};
     lastThreadTextAt = Date.now() - 2000;
     pendingSelfTest = { command: 'printf EXPECTED_SELF_TEST', cwd: '', token: 'expected', startedAt: Date.now() };
     (() => {
       const candidate = extractShellCallCandidates(getConversationRoot()).at(-1);
       const semanticKey = buildSemanticCallKey(candidate.call);
       const renderRoot = getCandidateRenderRoot(candidate);
       liveGeneratedRenderedHelpers.set(renderRoot, new Set([buildRenderedHelperKey(candidate, semanticKey)]));
     })();`,
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
    `extensionActive = true;
     initialThreadSettled = true;
     lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))};
     lastThreadTextAt = Date.now() - 2000;
     pendingAgentDelivery = { messageId: 'pending-agent' };
     (() => {
       const candidate = extractShellCallCandidates(getConversationRoot()).at(-1);
       const semanticKey = buildSemanticCallKey(candidate.call);
       const renderRoot = getCandidateRenderRoot(candidate);
       liveGeneratedRenderedHelpers.set(renderRoot, new Set([buildRenderedHelperKey(candidate, semanticKey)]));
     })();`,
    context
  );

  await context.scanForShellCall();
  assert.equal(runCalls.length, 0, "A helper must remain unconsumed while an agent message owns the composer.");

  vm.runInContext("pendingAgentDelivery = { messageId: 'ack-only-agent', sent: true }; agentDeliveryInFlight = true; lastThreadTextAt = Date.now() - 2000;", context);
  await context.scanForShellCall();
  assert.equal(runCalls.length, 1, "A sent agent message waiting only for hub ack must not block a helper.");
  assert.equal(runCalls[0][1].cmd, cmd);
}

async function verifyPendingAgentDeliveryDefersSkillWithoutConsumingHelper() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const message = createAssistantMessage({
    order: 1,
    text: createSkillLoadBlock({
      helperId: "pending-agent-skill",
      skillId: "example",
      catalogSha: "a".repeat(64)
    })
  });
  const root = createRoot([message]);
  let backendCalls = 0;
  context.document.body = root;
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100
  });
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "skill-load") {
      backendCalls += 1;
      return { ok: false, error: "expected test rejection" };
    }
    return { ok: true };
  };
  context.getConversationRoot = () => root;
  context.updateSiteActionButton = () => {};
  context.setStatus = () => {};
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.queueSkillComposerReply = async () => true;
  vm.runInContext(
    `extensionActive = true;
     initialThreadSettled = true;
     lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))};
     lastThreadTextAt = Date.now() - 2000;
     pendingAgentDelivery = { messageId: 'pending-agent-skill' };
     (() => {
       const candidate = extractShellCallCandidates(getConversationRoot()).at(-1);
       const semanticKey = buildSemanticCallKey(candidate.call);
       const renderRoot = getCandidateRenderRoot(candidate);
       liveGeneratedRenderedHelpers.set(renderRoot, new Set([buildRenderedHelperKey(candidate, semanticKey)]));
     })();`,
    context
  );

  await context.scanForShellCall();
  assert.equal(backendCalls, 0, "A pending agent composer delivery must defer Skill backend dispatch.");

  vm.runInContext("pendingAgentDelivery = { messageId: 'sent-agent-skill', sent: true }; lastThreadTextAt = Date.now() - 2000;", context);
  await context.scanForShellCall();
  assert.equal(backendCalls, 1, "The unchanged Skill helper must remain eligible after the agent composer delivery is sent.");
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
    `extensionActive = true;
     initialThreadSettled = true;
     lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))};
     lastThreadTextAt = Date.now() - 2000;
     (() => {
       const candidate = extractShellCallCandidates(getConversationRoot()).at(-1);
       const semanticKey = buildSemanticCallKey(candidate.call);
       const renderRoot = getCandidateRenderRoot(candidate);
       liveGeneratedRenderedHelpers.set(renderRoot, new Set([buildRenderedHelperKey(candidate, semanticKey)]));
     })();`,
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

async function verifyFirstResponseRouteAssignmentCarriesInFlightShellResult() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  installPersistentLocalStorage(context);

  const command = "printf FIRST_RESPONSE_ROUTE_RESULT";
  const user = new MockNode({
    order: 1,
    role: "user",
    text: "Run the helper while this new chat receives its permanent URL."
  });
  const assistant = createAssistantMessage({
    order: 2,
    text: createHelperBlock({ cmd: command })
  });
  const root = createRoot([user, assistant]);
  for (const node of [root, user, assistant]) {
    node.isConnected = true;
  }
  context.document.body = root;
  context.__firstResponseRouteRoot = root;
  context.__firstResponseRouteAssistant = assistant;
  context.getConversationRoot = () => context.__firstResponseRouteRoot;

  const candidate = context.getLastShellCallCandidate(root);
  assert.ok(candidate, "The first response fixture must expose one complete shell helper.");
  context.__firstResponseRouteCandidate = candidate;

  let backendRuns = 0;
  let resolveBackend;
  let composerWrites = 0;
  let sendAttempts = 0;
  let receiptAttempts = 0;
  const submitted = [];
  const composer = { innerText: "", textContent: "", isConnected: true };
  context.document.querySelectorAll = (selector) =>
    selector.includes("data-message-author-role") ? submitted : [];
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100,
    requireApproval: false,
    autoSend: true
  });
  context.chrome.runtime.sendMessage = (payload) => {
    if (payload.type === "content-ui-delay") {
      return Promise.resolve({ ok: true });
    }
    if (payload.type === "run-result-presented") {
      receiptAttempts += 1;
      return Promise.resolve({ ok: true, found: true });
    }
    assert.equal(payload.type, "run-shell");
    backendRuns += 1;
    return new Promise((resolve) => {
      resolveBackend = resolve;
    });
  };
  context.insertReply = async (text) => {
    composerWrites += 1;
    composer.innerText = text;
    composer.textContent = text;
    return composer;
  };
  context.findReplyInput = async () => composer;
  context.clickSendWhenReady = async () => {
    sendAttempts += 1;
    const submittedRoot = new MockNode({
      order: 3,
      role: "user",
      text: composer.innerText
    });
    submittedRoot.isConnected = true;
    submitted.push(submittedRoot);
    composer.innerText = "";
    composer.textContent = "";
    return true;
  };
  context.setStatus = () => {};
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.updateSiteActionButton = () => {};
  vm.runInContext(`
    extensionActive = true;
    observedPageIdentity = location.href;
    initialThreadSettled = true;
    lastThreadText = normalizeText(globalThis.__firstResponseRouteRoot.innerText || globalThis.__firstResponseRouteRoot.textContent || "");
    lastThreadTextAt = Date.now() - 5000;
    const routeCandidate = globalThis.__firstResponseRouteCandidate;
    const routeSemanticKey = buildSemanticCallKey(routeCandidate.call);
    liveGeneratedRenderedHelpers.set(
      getCandidateRenderRoot(routeCandidate),
      new Set([buildRenderedHelperKey(routeCandidate, routeSemanticKey)])
    );
  `, context);

  const scan = context.scanForShellCall();
  await waitForTestCondition(() => typeof resolveBackend === "function");
  assert.equal(backendRuns, 1, "The helper must be dispatched exactly once on the provisional new-chat URL.");

  context.location.pathname = "/c/first-response-permanent";
  context.location.href = "https://chatgpt.com/c/first-response-permanent";
  assert.equal(context.refreshPageLifecycle(), true, "The test must cross a real content-script route lifecycle.");
  vm.runInContext("initialThreadSettled = true;", context);
  resolveBackend({
    ok: true,
    executed: true,
    executionCompleted: true,
    executionId: "1234567890abcdef",
    exitCode: 0,
    stdout: "FIRST_RESPONSE_ROUTE_RESULT"
  });
  await scan;
  await context.retryPendingHelperDeliveries();

  assert.equal(backendRuns, 1, "A permanent URL assignment must never replay the shell command.");
  assert.equal(composerWrites, 1,
    "The completed in-flight result must be written once when the exact first-response transcript survives the route assignment.");
  assert.equal(sendAttempts, 1, "The retained result must be submitted exactly once.");
  assert.equal(submitted.length, 1);
  assert.match(submitted[0].innerText, /FIRST_RESPONSE_ROUTE_RESULT/);
  assert.equal(receiptAttempts, 1, "The canonical execution must receive one presentation receipt.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
}

async function verifyInFlightShellResultCannotCrossRouteAfterTranscriptReplacement() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  installPersistentLocalStorage(context);

  const command = "printf OLD_CHAT_ROUTE_RESULT";
  const oldAssistant = createAssistantMessage({
    order: 1,
    text: createHelperBlock({ cmd: command })
  });
  const oldRoot = createRoot([oldAssistant]);
  oldRoot.isConnected = true;
  oldAssistant.isConnected = true;
  context.document.body = oldRoot;
  context.__routeReplacementRoot = oldRoot;
  context.getConversationRoot = () => context.__routeReplacementRoot;
  const candidate = context.getLastShellCallCandidate(oldRoot);
  context.__routeReplacementCandidate = candidate;

  let backendRuns = 0;
  let resolveBackend;
  let composerWrites = 0;
  let sendAttempts = 0;
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100,
    requireApproval: false,
    autoSend: true
  });
  context.chrome.runtime.sendMessage = (payload) => {
    if (payload.type === "content-ui-delay") {
      return Promise.resolve({ ok: true });
    }
    assert.equal(payload.type, "run-shell");
    backendRuns += 1;
    return new Promise((resolve) => {
      resolveBackend = resolve;
    });
  };
  context.insertReply = async () => {
    composerWrites += 1;
    return { innerText: "", textContent: "", isConnected: true };
  };
  context.clickSendWhenReady = async () => {
    sendAttempts += 1;
    return true;
  };
  context.setStatus = () => {};
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.updateSiteActionButton = () => {};
  vm.runInContext(`
    extensionActive = true;
    observedPageIdentity = location.href;
    initialThreadSettled = true;
    lastThreadText = normalizeText(globalThis.__routeReplacementRoot.innerText || globalThis.__routeReplacementRoot.textContent || "");
    lastThreadTextAt = Date.now() - 5000;
    const routeCandidate = globalThis.__routeReplacementCandidate;
    const routeSemanticKey = buildSemanticCallKey(routeCandidate.call);
    liveGeneratedRenderedHelpers.set(
      getCandidateRenderRoot(routeCandidate),
      new Set([buildRenderedHelperKey(routeCandidate, routeSemanticKey)])
    );
  `, context);

  const scan = context.scanForShellCall();
  await waitForTestCondition(() => typeof resolveBackend === "function");
  const replacement = createRoot([
    new MockNode({ order: 1, role: "user", text: "This is a different chat." })
  ]);
  replacement.isConnected = true;
  oldAssistant.isConnected = false;
  oldRoot.isConnected = false;
  context.__routeReplacementRoot = replacement;
  context.document.body = replacement;
  context.location.pathname = "/c/unrelated-existing-chat";
  context.location.href = "https://chatgpt.com/c/unrelated-existing-chat";
  assert.equal(context.refreshPageLifecycle(), true);
  vm.runInContext("initialThreadSettled = true;", context);
  resolveBackend({
    ok: true,
    executed: true,
    executionCompleted: true,
    executionId: "fedcba0987654321",
    exitCode: 0,
    stdout: "OLD_CHAT_ROUTE_RESULT"
  });
  await scan;
  await context.retryPendingHelperDeliveries();

  assert.equal(backendRuns, 1, "The old helper request must not be replayed after navigation.");
  assert.equal(composerWrites, 0, "An old-chat result must never be written into the replacement transcript.");
  assert.equal(sendAttempts, 0);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
}

async function verifySettingsAwaitRouteAdjudication() {
  const cases = [
    {
      name: "provisional route assignment with retained transcript",
      startPath: "/",
      nextPath: "/c/settings-retained",
      replaceTranscript: false,
      expectedBackendRuns: 1,
      expectedPending: 1
    },
    {
      name: "provisional route assignment with replacement transcript",
      startPath: "/",
      nextPath: "/c/settings-replaced",
      replaceTranscript: true,
      expectedBackendRuns: 0,
      expectedPending: 0
    },
    {
      name: "existing-chat to second route with retained transcript",
      startPath: "/c/settings-existing-a",
      nextPath: "/c/settings-existing-b",
      replaceTranscript: false,
      expectedBackendRuns: 0,
      expectedPending: 0
    }
  ];

  for (const testCase of cases) {
    const context = loadContentContext();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    installPersistentLocalStorage(context);
    context.location.pathname = testCase.startPath;
    context.location.href = `https://chatgpt.com${testCase.startPath}`;

    const command = `printf SETTINGS_ROUTE_${testCase.expectedBackendRuns}_${testCase.nextPath.replaceAll("/", "_")}`;
    const user = new MockNode({
      order: 1,
      role: "user",
      text: "Run only if this is still the same first-response chat."
    });
    const assistant = createAssistantMessage({
      order: 2,
      text: createHelperBlock({ cmd: command })
    });
    const root = createRoot([user, assistant]);
    for (const node of [root, user, assistant]) {
      node.isConnected = true;
    }
    context.document.body = root;
    context.__settingsRouteRoot = root;
    context.getConversationRoot = () => context.__settingsRouteRoot;
    const candidate = context.getLastShellCallCandidate(root);
    assert.ok(candidate, `${testCase.name} must expose the intended helper candidate.`);
    context.__settingsRouteCandidate = candidate;

    let releaseSettings;
    let markSettingsRequested;
    const settingsGate = new Promise((resolve) => {
      releaseSettings = resolve;
    });
    const settingsRequested = new Promise((resolve) => {
      markSettingsRequested = resolve;
    });
    let backendRuns = 0;
    context.chrome.storage.sync.get = async (keys) => {
      if (Array.isArray(keys) && keys.includes("requireApproval")) {
        markSettingsRequested();
        return settingsGate;
      }
      return {
        enabled: true,
        enabledHosts: ["chatgpt.com"],
        maxChainCalls: 100
      };
    };
    context.chrome.runtime.sendMessage = async (payload) => {
      assert.equal(payload.type, "run-shell");
      backendRuns += 1;
      return {
        ok: true,
        executed: true,
        executionCompleted: true,
        executionId: backendRuns === 1 ? "aaaabbbbccccdddd" : "1111222233334444",
        exitCode: 0,
        stdout: "SETTINGS_ROUTE_RESULT"
      };
    };
    context.setStatus = () => {};
    context.scheduleScan = () => {};
    context.resetChainForNewHumanPrompt = () => {};
    context.updateSiteActionButton = () => {};
    vm.runInContext(`
      extensionActive = true;
      observedPageIdentity = location.href;
      initialThreadSettled = true;
      lastThreadText = normalizeText(globalThis.__settingsRouteRoot.innerText || globalThis.__settingsRouteRoot.textContent || "");
      lastThreadTextAt = Date.now() - 5000;
      const settingsCandidate = globalThis.__settingsRouteCandidate;
      const settingsSemanticKey = buildSemanticCallKey(settingsCandidate.call);
      liveGeneratedRenderedHelpers.set(
        getCandidateRenderRoot(settingsCandidate),
        new Set([buildRenderedHelperKey(settingsCandidate, settingsSemanticKey)])
      );
      deliverHelperReply = async () => false;
    `, context);

    const scan = context.scanForShellCall();
    await settingsRequested;
    if (testCase.replaceTranscript) {
      const replacement = createRoot([
        new MockNode({ order: 1, role: "user", text: "Replacement transcript" })
      ]);
      replacement.isConnected = true;
      assistant.isConnected = false;
      root.isConnected = false;
      context.__settingsRouteRoot = replacement;
      context.document.body = replacement;
    }
    context.location.pathname = testCase.nextPath;
    context.location.href = `https://chatgpt.com${testCase.nextPath}`;
    assert.equal(context.refreshPageLifecycle(), true, `${testCase.name} must create a new lifecycle.`);
    vm.runInContext("initialThreadSettled = true;", context);
    releaseSettings({ requireApproval: false, autoSend: true });
    await scan;

    assert.equal(
      backendRuns,
      testCase.expectedBackendRuns,
      `${testCase.name} backend dispatch adjudication failed.`
    );
    assert.equal(
      vm.runInContext("pendingHelperDeliveries.size", context),
      testCase.expectedPending,
      `${testCase.name} must not create an unexpected result queue.`
    );
  }
}

function createStableChatGptRouteTurn(context, {
  userText,
  helperText,
  userId,
  assistantId
}) {
  const userCopy = new MockNode({ text: userText, order: 1 });
  const user = new MockNode({ text: userText, order: 1, children: [userCopy] });
  const assistantContent = new MockNode({ text: helperText, order: 2 });
  const assistant = new MockNode({ text: helperText, order: 2, children: [assistantContent] });
  const root = new MockNode({
    text: `${userText}\n${helperText}`,
    order: 0,
    children: [user, assistant]
  });

  const installMessageContract = (node, role, id) => {
    node.getAttribute = (name) => {
      if (name === "data-message-role" || name === "data-message-author-role") return role;
      if (name === "data-message-id") return id;
      return "";
    };
    node.matches = (selector) => String(selector).includes(`li[data-message-role="${role}"]`);
    node.closest = (selector) => node.matches(selector)
      ? node
      : node.parentElement?.closest?.(selector) || null;
  };
  installMessageContract(user, "user", userId);
  installMessageContract(assistant, "assistant", assistantId);

  userCopy.matches = (selector) => String(selector).includes("data-user-message-copy");
  userCopy.closest = (selector) => userCopy.matches(selector)
    ? userCopy
    : user.closest(selector);
  assistantContent.matches = (selector) => String(selector).includes("data-assistant-markdown");
  assistantContent.closest = (selector) => assistantContent.matches(selector)
    ? assistantContent
    : assistant.closest(selector);
  user.querySelectorAll = (selector) => String(selector).includes("data-user-message-copy")
    ? [userCopy]
    : [];
  assistant.querySelectorAll = (selector) => String(selector).includes("data-assistant-markdown")
    ? [assistantContent]
    : [];
  root.querySelectorAll = (selector) => {
    const value = String(selector);
    const matches = [];
    if (value.includes("data-message-role") || value.includes("data-message-author-role")) {
      matches.push(user, assistant);
    }
    if (value.includes("data-user-message-copy")) {
      matches.push(userCopy);
    }
    if (value.includes("data-assistant-markdown")) {
      matches.push(assistantContent);
    }
    return matches.length > 0
      ? Array.from(new Set(matches))
      : [user, userCopy, assistant, assistantContent];
  };

  for (const node of [root, user, userCopy, assistant, assistantContent]) {
    node.isConnected = true;
  }
  return {
    root,
    user,
    assistant,
    assistantContent,
    candidate: {
      call: context.parseCallPayload(helperText),
      node: assistant,
      textRoot: assistantContent,
      source: "text",
      blockIndex: 0
    }
  };
}

function setMockTreeConnected(node, connected) {
  if (!(node instanceof MockNode)) {
    return;
  }
  node.isConnected = connected;
  for (const child of node.children || []) {
    setMockTreeConnected(child, connected);
  }
}

async function verifyRouteRedrawDuringSettingsAwaitIsSingleFlight() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  installPersistentLocalStorage(context);

  const helperText = createHelperBlock({ cmd: "printf ROUTE_REDRAW_SETTINGS_RESULT" });
  const stableIds = {
    userId: "route-redraw-settings-user",
    assistantId: "route-redraw-settings-assistant"
  };
  const original = createStableChatGptRouteTurn(context, {
    userText: "Run once while this response receives its permanent route.",
    helperText,
    ...stableIds
  });
  context.__settingsRedrawRoot = original.root;
  context.__settingsRedrawCandidate = original.candidate;
  context.document.body = original.root;
  context.getConversationRoot = () => context.__settingsRedrawRoot;
  context.extractShellCallCandidates = () => [context.__settingsRedrawCandidate];

  let settingsRequests = 0;
  let releaseSettings;
  const settingsGate = new Promise((resolve) => {
    releaseSettings = resolve;
  });
  let backendRuns = 0;
  let composerWrites = 0;
  let sendAttempts = 0;
  let receiptAttempts = 0;
  const submitted = [];
  const composer = { innerText: "", textContent: "", isConnected: true };
  context.document.querySelectorAll = (selector) =>
    selector.includes("data-message-author-role") ? submitted : [];
  context.chrome.storage.sync.get = async (keys) => {
    if (Array.isArray(keys) && keys.includes("requireApproval")) {
      settingsRequests += 1;
      return settingsGate;
    }
    return {
      enabled: true,
      enabledHosts: ["chatgpt.com"],
      maxChainCalls: 100
    };
  };
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "content-ui-delay") {
      return { ok: true };
    }
    if (payload.type === "run-result-presented") {
      receiptAttempts += 1;
      return { ok: true, found: true };
    }
    assert.equal(payload.type, "run-shell");
    backendRuns += 1;
    return {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: backendRuns === 1 ? "abcddcba12344321" : "0123456789abcdef",
      exitCode: 0,
      stdout: "ROUTE_REDRAW_SETTINGS_RESULT"
    };
  };
  context.insertReply = async (text) => {
    composerWrites += 1;
    composer.innerText = text;
    composer.textContent = text;
    return composer;
  };
  context.findReplyInput = async () => composer;
  context.clickSendWhenReady = async () => {
    sendAttempts += 1;
    const submittedRoot = new MockNode({
      order: 3,
      role: "user",
      text: composer.innerText
    });
    submittedRoot.isConnected = true;
    submitted.push(submittedRoot);
    composer.innerText = "";
    composer.textContent = "";
    return true;
  };
  context.setStatus = () => {};
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.updateSiteActionButton = () => {};
  vm.runInContext(`
    extensionActive = true;
    observedPageIdentity = location.href;
    initialThreadSettled = true;
    lastThreadText = normalizeText(globalThis.__settingsRedrawRoot.innerText || globalThis.__settingsRedrawRoot.textContent || "");
    lastThreadTextAt = Date.now() - 5000;
    const firstCandidate = globalThis.__settingsRedrawCandidate;
    const firstSemanticKey = buildSemanticCallKey(firstCandidate.call);
    liveGeneratedRenderedHelpers.set(
      getCandidateRenderRoot(firstCandidate),
      new Set([buildRenderedHelperKey(firstCandidate, firstSemanticKey)])
    );
  `, context);

  const firstScan = context.scanForShellCall();
  await waitForTestCondition(() => settingsRequests === 1);

  const redraw = createStableChatGptRouteTurn(context, {
    userText: "Run once while this response receives its permanent route.",
    helperText,
    ...stableIds
  });
  setMockTreeConnected(original.root, false);
  context.__settingsRedrawRoot = redraw.root;
  context.__settingsRedrawCandidate = redraw.candidate;
  context.document.body = redraw.root;
  context.location.pathname = "/c/route-redraw-settings";
  context.location.href = "https://chatgpt.com/c/route-redraw-settings";
  assert.equal(context.refreshPageLifecycle(), true);
  vm.runInContext(`
    initialThreadSettled = true;
    lastThreadText = normalizeText(globalThis.__settingsRedrawRoot.innerText || globalThis.__settingsRedrawRoot.textContent || "");
    lastThreadTextAt = Date.now() - 5000;
    const secondCandidate = globalThis.__settingsRedrawCandidate;
    const secondSemanticKey = buildSemanticCallKey(secondCandidate.call);
    liveGeneratedRenderedHelpers.set(
      getCandidateRenderRoot(secondCandidate),
      new Set([buildRenderedHelperKey(secondCandidate, secondSemanticKey)])
    );
  `, context);

  let secondSettled = false;
  const secondScan = context.scanForShellCall().finally(() => {
    secondSettled = true;
  });
  await waitForTestCondition(() => settingsRequests >= 2 || secondSettled);
  releaseSettings({ requireApproval: false, autoSend: true });
  await Promise.all([firstScan, secondScan]);
  await context.retryPendingHelperDeliveries();

  assert.equal(backendRuns, 1,
    "A route redraw plus a second scan must retain one frontend backend dispatch claim.");
  assert.equal(composerWrites, 1, "The single result must be written exactly once.");
  assert.equal(sendAttempts, 1, "The single result must be submitted exactly once.");
  assert.equal(submitted.length, 1);
  assert.equal(receiptAttempts, 1, "The single canonical execution must receive one receipt.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
}

async function verifyRejectedHelperRouteSettingsGuard() {
  for (const testCase of [
    { name: "validation retained first-response turn", rejectionKind: "validation", replaceTranscript: false, expectedWrites: 1 },
    { name: "validation replacement transcript", rejectionKind: "validation", replaceTranscript: true, expectedWrites: 0 },
    { name: "chain-limit retained first-response turn", rejectionKind: "chain", replaceTranscript: false, expectedWrites: 1 },
    { name: "chain-limit replacement transcript", rejectionKind: "chain", replaceTranscript: true, expectedWrites: 0 }
  ]) {
    const context = loadContentContext();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    installPersistentLocalStorage(context);
    const helperText = testCase.rejectionKind === "validation"
      ? [
        "ai-helper-file-start:route-rejected-file",
        "../unsafe.txt",
        "must not cross chats",
        "ai-helper-file-end"
      ].join("\n")
      : createHelperBlock({ cmd: "printf CHAIN_LIMIT_REJECTION" });
    const stableIds = {
      userId: `rejected-route-user-${testCase.replaceTranscript ? "negative" : "positive"}`,
      assistantId: `rejected-route-assistant-${testCase.replaceTranscript ? "negative" : "positive"}`
    };
    const original = createStableChatGptRouteTurn(context, {
      userText: "Validate this helper in its originating response only.",
      helperText,
      ...stableIds
    });
    context.document.body = original.root;
    context.__rejectedRouteRoot = original.root;
    context.__rejectedRouteCandidate = original.candidate;
    context.getConversationRoot = () => context.__rejectedRouteRoot;
    context.extractShellCallCandidates = () => context.__rejectedRouteCandidate
      ? [context.__rejectedRouteCandidate]
      : [];

    let requestSettings;
    let releaseSettings;
    const settingsRequested = new Promise((resolve) => {
      requestSettings = resolve;
    });
    const settingsGate = new Promise((resolve) => {
      releaseSettings = resolve;
    });
    let composerWrites = 0;
    let sendAttempts = 0;
    const submitted = [];
    const composer = { innerText: "", textContent: "", isConnected: true };
    context.document.querySelectorAll = (selector) =>
      selector.includes("data-message-author-role") ? submitted : [];
    context.chrome.storage.sync.get = async (keys) => {
      if (Array.isArray(keys) && keys.length === 1 && keys[0] === "autoSend") {
        requestSettings();
        return settingsGate;
      }
      return {
        enabled: true,
        enabledHosts: ["chatgpt.com"],
        maxChainCalls: testCase.rejectionKind === "chain" ? 1 : 100
      };
    };
    context.chrome.runtime.sendMessage = async () => ({ ok: true, found: true });
    context.insertReply = async (text) => {
      composerWrites += 1;
      composer.innerText = text;
      composer.textContent = text;
      return composer;
    };
    context.findReplyInput = async () => composer;
    context.clickSendWhenReady = async () => {
      sendAttempts += 1;
      const submittedRoot = new MockNode({ order: 3, role: "user", text: composer.innerText });
      submittedRoot.isConnected = true;
      submitted.push(submittedRoot);
      composer.innerText = "";
      composer.textContent = "";
      return true;
    };
    context.setStatus = () => {};
    context.scheduleScan = () => {};
    context.resetChainForNewHumanPrompt = () => {};
    context.updateSiteActionButton = () => {};
    vm.runInContext(`
      extensionActive = true;
      observedPageIdentity = location.href;
      initialThreadSettled = true;
      chainCallCount = ${testCase.rejectionKind === "chain" ? 1 : 0};
      lastThreadText = normalizeText(globalThis.__rejectedRouteRoot.innerText || globalThis.__rejectedRouteRoot.textContent || "");
      lastThreadTextAt = Date.now() - 5000;
      const rejectedCandidate = globalThis.__rejectedRouteCandidate;
      const rejectedSemanticKey = buildSemanticCallKey(rejectedCandidate.call);
      liveGeneratedRenderedHelpers.set(
        getCandidateRenderRoot(rejectedCandidate),
        new Set([buildRenderedHelperKey(rejectedCandidate, rejectedSemanticKey)])
      );
    `, context);

    const scan = context.scanForShellCall();
    await settingsRequested;
    setMockTreeConnected(original.root, false);
    if (testCase.replaceTranscript) {
      const replacement = createRoot([
        new MockNode({ order: 1, role: "user", text: "A different chat owns this route." })
      ]);
      replacement.isConnected = true;
      context.__rejectedRouteRoot = replacement;
      context.__rejectedRouteCandidate = null;
      context.document.body = replacement;
    } else {
      const redraw = createStableChatGptRouteTurn(context, {
        userText: "Validate this helper in its originating response only.",
        helperText,
        ...stableIds
      });
      context.__rejectedRouteRoot = redraw.root;
      context.__rejectedRouteCandidate = redraw.candidate;
      context.document.body = redraw.root;
    }
    context.location.pathname = `/c/rejected-route-${testCase.replaceTranscript ? "negative" : "positive"}`;
    context.location.href = `https://chatgpt.com${context.location.pathname}`;
    assert.equal(context.refreshPageLifecycle(), true);
    vm.runInContext("initialThreadSettled = true;", context);
    releaseSettings({ autoSend: true });
    await scan;
    await context.retryPendingHelperDeliveries();

    assert.equal(composerWrites, testCase.expectedWrites,
      `${testCase.name}: rejected helper reply route ownership failed.`);
    assert.equal(sendAttempts, testCase.expectedWrites);
    assert.equal(submitted.length, testCase.expectedWrites);
    if (submitted.length > 0) {
      assert.match(
        submitted[0].innerText,
        testCase.rejectionKind === "validation" ? /File helper rejected:/ : /Chain limit reached/
      );
    }
    assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
    assert.equal(vm.runInContext("preparingRunnableDispatchToken", context), null);
  }
}

async function verifyPreparingDispatchStorageFailureReleasesForNewRootRetry() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  installPersistentLocalStorage(context);

  const helperText = createHelperBlock({ cmd: "printf STORAGE_REJECT_RETRY" });
  const stableIds = {
    userId: "storage-reject-user",
    assistantId: "storage-reject-assistant"
  };
  const firstTurn = createStableChatGptRouteTurn(context, {
    userText: "Retry this helper after a transient settings failure.",
    helperText,
    ...stableIds
  });
  context.__storageRejectRoot = firstTurn.root;
  context.__storageRejectCandidate = firstTurn.candidate;
  context.document.body = firstTurn.root;
  context.getConversationRoot = () => context.__storageRejectRoot;
  context.extractShellCallCandidates = () => [context.__storageRejectCandidate];

  let executionSettingsRequests = 0;
  let backendRuns = 0;
  let composerWrites = 0;
  let sendAttempts = 0;
  const submitted = [];
  const composer = { innerText: "", textContent: "", isConnected: true };
  context.document.querySelectorAll = (selector) =>
    selector.includes("data-message-author-role") ? submitted : [];
  context.chrome.storage.sync.get = async (keys) => {
    if (Array.isArray(keys) && keys.includes("requireApproval")) {
      executionSettingsRequests += 1;
      if (executionSettingsRequests === 1) {
        throw new Error("transient settings read failure");
      }
      return { requireApproval: false, autoSend: true };
    }
    return { enabled: true, enabledHosts: ["chatgpt.com"], maxChainCalls: 100 };
  };
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "content-ui-delay" || payload.type === "run-result-presented") {
      return { ok: true, found: true };
    }
    assert.equal(payload.type, "run-shell");
    backendRuns += 1;
    return {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: "feedfacecafebeef",
      exitCode: 0,
      stdout: "STORAGE_REJECT_RETRY"
    };
  };
  context.insertReply = async (text) => {
    composerWrites += 1;
    composer.innerText = text;
    composer.textContent = text;
    return composer;
  };
  context.findReplyInput = async () => composer;
  context.clickSendWhenReady = async () => {
    sendAttempts += 1;
    const submittedRoot = new MockNode({ order: 3, role: "user", text: composer.innerText });
    submittedRoot.isConnected = true;
    submitted.push(submittedRoot);
    composer.innerText = "";
    composer.textContent = "";
    return true;
  };
  context.setStatus = () => {};
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.updateSiteActionButton = () => {};
  vm.runInContext(`
    extensionActive = true;
    observedPageIdentity = location.href;
    initialThreadSettled = true;
    lastThreadText = normalizeText(globalThis.__storageRejectRoot.innerText || globalThis.__storageRejectRoot.textContent || "");
    lastThreadTextAt = Date.now() - 5000;
    const storageRejectCandidate = globalThis.__storageRejectCandidate;
    const storageRejectSemanticKey = buildSemanticCallKey(storageRejectCandidate.call);
    liveGeneratedRenderedHelpers.set(
      getCandidateRenderRoot(storageRejectCandidate),
      new Set([buildRenderedHelperKey(storageRejectCandidate, storageRejectSemanticKey)])
    );
  `, context);

  await assert.rejects(context.scanForShellCall(), /transient settings read failure/);
  assert.equal(vm.runInContext("preparingRunnableDispatchToken", context), null,
    "A rejected settings await must release exactly its pre-backend claim.");
  assert.equal(backendRuns, 0);

  const redraw = createStableChatGptRouteTurn(context, {
    userText: "Retry this helper after a transient settings failure.",
    helperText,
    ...stableIds
  });
  setMockTreeConnected(firstTurn.root, false);
  context.__storageRejectRoot = redraw.root;
  context.__storageRejectCandidate = redraw.candidate;
  context.document.body = redraw.root;
  vm.runInContext(`
    lastThreadText = normalizeText(globalThis.__storageRejectRoot.innerText || globalThis.__storageRejectRoot.textContent || "");
    lastThreadTextAt = Date.now() - 5000;
    const retryCandidate = globalThis.__storageRejectCandidate;
    const retrySemanticKey = buildSemanticCallKey(retryCandidate.call);
    liveGeneratedRenderedHelpers.set(
      getCandidateRenderRoot(retryCandidate),
      new Set([buildRenderedHelperKey(retryCandidate, retrySemanticKey)])
    );
  `, context);
  await context.scanForShellCall();
  await context.retryPendingHelperDeliveries();

  assert.equal(backendRuns, 1, "The same semantic helper in a fresh DOM root must retry exactly once.");
  assert.equal(composerWrites, 1);
  assert.equal(sendAttempts, 1);
  assert.equal(vm.runInContext("preparingRunnableDispatchToken", context), null);
}

async function verifyChangedRouteClaimUsesExactTokenRelease() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  installPersistentLocalStorage(context);

  const oldTurn = createStableChatGptRouteTurn(context, {
    userText: "Run the old helper only in its original chat.",
    helperText: createHelperBlock({ cmd: "printf OLD_PREPARING_CLAIM" }),
    userId: "old-preparing-user",
    assistantId: "old-preparing-assistant"
  });
  context.__claimRouteRoot = oldTurn.root;
  context.__claimRouteCandidate = oldTurn.candidate;
  context.document.body = oldTurn.root;
  context.getConversationRoot = () => context.__claimRouteRoot;
  context.extractShellCallCandidates = () => [context.__claimRouteCandidate];

  const settingsResolvers = [];
  let settingsRequests = 0;
  const backendCommands = [];
  context.chrome.storage.sync.get = async (keys) => {
    if (Array.isArray(keys) && keys.includes("requireApproval")) {
      settingsRequests += 1;
      return new Promise((resolve) => settingsResolvers.push(resolve));
    }
    return { enabled: true, enabledHosts: ["chatgpt.com"], maxChainCalls: 100 };
  };
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "content-ui-delay" || payload.type === "run-result-presented") {
      return { ok: true, found: true };
    }
    assert.equal(payload.type, "run-shell");
    backendCommands.push(payload.cmd);
    return {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: "0123abcdeffedcba",
      exitCode: 0,
      stdout: "NEW_PREPARING_CLAIM"
    };
  };
  context.insertReply = async (text) => ({ innerText: text, textContent: text, isConnected: true });
  context.findReplyInput = async () => ({ innerText: "", textContent: "", isConnected: true });
  context.clickSendWhenReady = async () => false;
  context.setStatus = () => {};
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.updateSiteActionButton = () => {};
  vm.runInContext(`
    extensionActive = true;
    observedPageIdentity = location.href;
    initialThreadSettled = true;
    lastThreadText = normalizeText(globalThis.__claimRouteRoot.innerText || globalThis.__claimRouteRoot.textContent || "");
    lastThreadTextAt = Date.now() - 5000;
    const oldClaimCandidate = globalThis.__claimRouteCandidate;
    const oldClaimSemanticKey = buildSemanticCallKey(oldClaimCandidate.call);
    liveGeneratedRenderedHelpers.set(
      getCandidateRenderRoot(oldClaimCandidate),
      new Set([buildRenderedHelperKey(oldClaimCandidate, oldClaimSemanticKey)])
    );
  `, context);

  const oldScan = context.scanForShellCall();
  await waitForTestCondition(() => settingsRequests === 1);

  const newTurn = createStableChatGptRouteTurn(context, {
    userText: "This replacement chat owns a different helper.",
    helperText: createHelperBlock({ cmd: "printf NEW_PREPARING_CLAIM" }),
    userId: "new-preparing-user",
    assistantId: "new-preparing-assistant"
  });
  setMockTreeConnected(oldTurn.root, false);
  context.__claimRouteRoot = newTurn.root;
  context.__claimRouteCandidate = newTurn.candidate;
  context.document.body = newTurn.root;
  context.location.pathname = "/c/new-preparing-owner";
  context.location.href = "https://chatgpt.com/c/new-preparing-owner";
  assert.equal(context.refreshPageLifecycle(), true);
  vm.runInContext(`
    initialThreadSettled = true;
    lastThreadText = normalizeText(globalThis.__claimRouteRoot.innerText || globalThis.__claimRouteRoot.textContent || "");
    lastThreadTextAt = Date.now() - 5000;
    const newClaimCandidate = globalThis.__claimRouteCandidate;
    const newClaimSemanticKey = buildSemanticCallKey(newClaimCandidate.call);
    liveGeneratedRenderedHelpers.set(
      getCandidateRenderRoot(newClaimCandidate),
      new Set([buildRenderedHelperKey(newClaimCandidate, newClaimSemanticKey)])
    );
  `, context);

  const newScan = context.scanForShellCall();
  await waitForTestCondition(() => settingsRequests === 2);
  settingsResolvers[0]({ requireApproval: false, autoSend: true });
  await oldScan;
  assert.equal(
    vm.runInContext("preparingRunnableDispatchToken?.call?.cmd", context),
    "printf NEW_PREPARING_CLAIM",
    "The stale continuation's finally must not clear the newer exact-token claim."
  );
  settingsResolvers[1]({ requireApproval: false, autoSend: true });
  await newScan;

  assert.deepEqual(backendCommands, ["printf NEW_PREPARING_CLAIM"]);
  assert.equal(vm.runInContext("preparingRunnableDispatchToken", context), null);
}

async function verifyTrustedForceCannotBypassPreparingDispatchClaim() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  installPersistentLocalStorage(context);
  const turn = createStableChatGptRouteTurn(context, {
    userText: "Do not let Force race the automatic preflight.",
    helperText: createHelperBlock({ cmd: "printf FORCE_PREPARING_GUARD" }),
    userId: "force-preparing-user",
    assistantId: "force-preparing-assistant"
  });
  context.__forceClaimRoot = turn.root;
  context.__forceClaimCandidate = turn.candidate;
  context.document.body = turn.root;
  context.getConversationRoot = () => context.__forceClaimRoot;
  context.extractShellCallCandidates = () => [context.__forceClaimCandidate];
  let releaseSettings;
  let settingsRequests = 0;
  const settingsGate = new Promise((resolve) => {
    releaseSettings = resolve;
  });
  let backendRuns = 0;
  context.chrome.storage.sync.get = async (keys) => {
    if (Array.isArray(keys) && keys.includes("requireApproval")) {
      settingsRequests += 1;
      return settingsGate;
    }
    return { enabled: true, enabledHosts: ["chatgpt.com"], maxChainCalls: 100 };
  };
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "content-ui-delay" || payload.type === "run-result-presented") {
      return { ok: true, found: true };
    }
    assert.equal(payload.type, "run-shell");
    backendRuns += 1;
    return {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: "abc12345def67890",
      exitCode: 0,
      stdout: "FORCE_PREPARING_GUARD"
    };
  };
  context.insertReply = async () => ({ innerText: "", textContent: "", isConnected: true });
  context.clickSendWhenReady = async () => false;
  context.setStatus = () => {};
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.updateSiteActionButton = () => {};
  vm.runInContext(`
    extensionActive = true;
    observedPageIdentity = location.href;
    initialThreadSettled = true;
    lastThreadText = normalizeText(globalThis.__forceClaimRoot.innerText || globalThis.__forceClaimRoot.textContent || "");
    lastThreadTextAt = Date.now() - 5000;
    const forceClaimCandidate = globalThis.__forceClaimCandidate;
    const forceClaimSemanticKey = buildSemanticCallKey(forceClaimCandidate.call);
    liveGeneratedRenderedHelpers.set(
      getCandidateRenderRoot(forceClaimCandidate),
      new Set([buildRenderedHelperKey(forceClaimCandidate, forceClaimSemanticKey)])
    );
  `, context);

  const automaticScan = context.scanForShellCall();
  await waitForTestCondition(() => settingsRequests === 1);
  assert.equal(await context.forceRunLatestDetectedHelper(), false,
    "The trusted Force path must refuse a live automatic pre-backend claim.");
  assert.equal(backendRuns, 0);
  releaseSettings({ requireApproval: false, autoSend: true });
  await automaticScan;
  assert.equal(backendRuns, 1, "Only the original automatic dispatch may reach the backend.");
}

async function verifyCachedPendingLoadAwaitCannotCrossRoute() {
  for (const testCase of [
    { name: "replacement transcript", startPath: "/", nextPath: "/c/cached-pending-replaced", replaceTranscript: true },
    { name: "second permanent route", startPath: "/c/cached-pending-a", nextPath: "/c/cached-pending-b", replaceTranscript: false }
  ]) {
    const context = loadContentContext();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    installPersistentLocalStorage(context);
    context.location.pathname = testCase.startPath;
    context.location.href = `https://chatgpt.com${testCase.startPath}`;
    const turn = createStableChatGptRouteTurn(context, {
      userText: "Deliver this cached result only to its original conversation.",
      helperText: createHelperBlock({ cmd: "printf CACHED_PENDING_ROUTE" }),
      userId: `cached-pending-user-${testCase.name}`,
      assistantId: `cached-pending-assistant-${testCase.name}`
    });
    context.__cachedPendingRoot = turn.root;
    context.__cachedPendingCandidate = turn.candidate;
    context.document.body = turn.root;
    context.getConversationRoot = () => context.__cachedPendingRoot;
    const call = turn.candidate.call;
    const semanticKey = context.buildSemanticCallKey(call);
    const callId = context.buildCandidateCallKey(turn.candidate, semanticKey);
    const dispatchContext = context.createRunnableHelperDispatchContext(turn.candidate);
    context.__cachedPendingCall = call;
    context.__cachedPendingCallId = callId;
    let loadStarted;
    let releaseLoad;
    const loadObserved = new Promise((resolve) => {
      loadStarted = resolve;
    });
    const loadGate = new Promise((resolve) => {
      releaseLoad = resolve;
    });
    let backendRuns = 0;
    let deliveryAttempts = 0;
    context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: true });
    context.chrome.runtime.sendMessage = async (payload) => {
      if (payload.type === "run-shell") backendRuns += 1;
      return { ok: true };
    };
    context.loadPendingHelperDeliveriesForCurrentPage = async () => {
      loadStarted();
      await loadGate;
    };
    context.attemptPendingHelperDelivery = async () => {
      deliveryAttempts += 1;
      return true;
    };
    context.schedulePendingHelperDeliveryRetry = () => {};
    context.updateContextualPanelActions = () => {};
    context.setStatus = () => {};
    vm.runInContext(`
      extensionActive = true;
      observedPageIdentity = location.href;
      initialThreadSettled = true;
      pendingHelperDeliveriesLoadedKey = pendingHelperDeliveryStorageKey();
      pendingHelperDeliveries.set(globalThis.__cachedPendingCallId, {
        callId: globalThis.__cachedPendingCallId,
        creationSequence: 1,
        executionId: "9999aaaabbbbcccc",
        kind: "shell",
        call: snapshotPendingHelperCall(globalThis.__cachedPendingCall),
        response: { ok: true, exitCode: 0, stdout: "CACHED_PENDING_ROUTE" },
        reply: "Shell call result: CACHED_PENDING_ROUTE",
        autoSend: true,
        pageIdentity: getCurrentPageIdentity(),
        phase: "queued",
        submittedMessageCountBefore: 0,
        submittedMessageRootIdsBefore: [],
        submittedMessageRootsBefore: new Set(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attempts: 0,
        lastError: "",
        restored: true
      });
    `, context);

    const run = context.runAndReply(callId, call, { dispatchContext });
    await loadObserved;
    if (testCase.replaceTranscript) {
      setMockTreeConnected(turn.root, false);
      const replacement = createRoot([
        new MockNode({ order: 1, role: "user", text: "A replacement chat is now mounted." })
      ]);
      replacement.isConnected = true;
      context.__cachedPendingRoot = replacement;
      context.document.body = replacement;
    }
    context.location.pathname = testCase.nextPath;
    context.location.href = `https://chatgpt.com${testCase.nextPath}`;
    assert.equal(context.refreshPageLifecycle(), true);
    releaseLoad();
    await run;
    await Promise.resolve();

    assert.equal(backendRuns, 0, `${testCase.name}: cached delivery must not fall through to backend.`);
    assert.equal(deliveryAttempts, 0, `${testCase.name}: stale cached output must not reach the composer.`);
    assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0,
      `${testCase.name}: stale cached pending state must be discarded.`);
    assert.equal(vm.runInContext("preparingRunnableDispatchToken", context), null);
  }
}

async function verifyDeferredProfileDispatchRouteGuards() {
  const helperCases = [
    {
      name: "shell",
      helperText: createHelperBlock({ cmd: "printf PROFILE_ROUTE_SHELL" }),
      runtimeType: "run-shell"
    },
    {
      name: "board",
      helperText: "ai-helper-board-start\nstatus\nai-helper-board-end",
      runtimeType: "run-board"
    },
    {
      name: "agent-message",
      helperText: [
        "ai-helper-agent-message-start",
        "to: slave-a",
        "task-id: profile-route-task",
        "",
        "Check profile-await route ownership.",
        "ai-helper-agent-message-end"
      ].join("\n"),
      runtimeType: "agent-send"
    },
    {
      name: "agent-roster",
      helperText: createAgentRosterBlock(),
      runtimeType: "agent-list"
    },
    {
      name: "agent-task-status",
      helperText: createAgentTaskStatusBlock(),
      runtimeType: "agent-task-status"
    }
  ];
  const routeCases = [
    {
      name: "retained provisional assignment",
      startPath: "/",
      routePath: (index) => `${index % 2 === 0 ? "/c" : "/uc"}/profile-retained-${index}`,
      replacement: false,
      expectedRuntimeCalls: 1
    },
    {
      name: "replacement transcript",
      startPath: "/",
      routePath: (index) => `/c/profile-replaced-${index}`,
      replacement: true,
      expectedRuntimeCalls: 0
    },
    {
      name: "second permanent route",
      startPath: "/c/profile-existing-a",
      routePath: () => "/c/profile-existing-b",
      replacement: false,
      expectedRuntimeCalls: 0
    }
  ];

  for (const [helperIndex, helperCase] of helperCases.entries()) {
    for (const routeCase of routeCases) {
      const context = loadContentContext();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      installPersistentLocalStorage(context);
      context.location.pathname = routeCase.startPath;
      context.location.href = `https://chatgpt.com${routeCase.startPath}`;
      const stableIds = {
        userId: `profile-route-user-${helperCase.name}`,
        assistantId: `profile-route-assistant-${helperCase.name}`
      };
      const turn = createStableChatGptRouteTurn(context, {
        userText: `Run the ${helperCase.name} helper in this exact conversation.`,
        helperText: helperCase.helperText,
        ...stableIds
      });
      context.__profileRouteRoot = turn.root;
      context.document.body = turn.root;
      context.getConversationRoot = () => context.__profileRouteRoot;
      const call = turn.candidate.call;
      const semanticKey = context.buildSemanticCallKey(call);
      const callId = context.buildCandidateCallKey(turn.candidate, semanticKey);
      const dispatchContext = context.createRunnableHelperDispatchContext(turn.candidate);

      let profileRequested;
      let releaseProfile;
      const profileObserved = new Promise((resolve) => {
        profileRequested = resolve;
      });
      const profileGate = new Promise((resolve) => {
        releaseProfile = resolve;
      });
      const runtimeCalls = [];
      context.getCurrentAgentProfile = async () => {
        profileRequested();
        return profileGate;
      };
      context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: true });
      context.chrome.runtime.sendMessage = async (payload) => {
        runtimeCalls.push(payload);
        if (payload.type === "run-shell" || payload.type === "run-board") {
          return {
            ok: true,
            executed: true,
            executionCompleted: true,
            executionId: "aa11bb22cc33dd44",
            exitCode: 0,
            stdout: "PROFILE_ROUTE_OK"
          };
        }
        if (payload.type === "agent-list") {
          return { ok: true, agents: [] };
        }
        return { ok: true, messageId: "profile-route-message" };
      };
      context.rememberPendingHelperDelivery = async (_callId, _call, response) => ({
        callId,
        response,
        phase: "queued"
      });
      context.attemptPendingHelperDelivery = async () => true;
      context.schedulePendingHelperDeliveryRetry = () => {};
      context.updateContextualPanelActions = () => {};
      context.updateStopHelperButton = () => {};
      context.setStatus = () => {};
      vm.runInContext(`
        extensionActive = true;
        observedPageIdentity = location.href;
        initialThreadSettled = true;
      `, context);

      const run = context.runAndReply(callId, call, { dispatchContext });
      await profileObserved;
      assert.equal(vm.runInContext("activeCallId", context), callId,
        `${helperCase.name}/${routeCase.name}: profile await must occur after active ownership starts.`);

      if (routeCase.replacement) {
        setMockTreeConnected(turn.root, false);
        const replacement = createRoot([
          new MockNode({ order: 1, role: "user", text: "A different conversation replaced this turn." })
        ]);
        replacement.isConnected = true;
        context.__profileRouteRoot = replacement;
        context.document.body = replacement;
      } else if (routeCase.startPath === "/") {
        const redraw = createStableChatGptRouteTurn(context, {
          userText: `Run the ${helperCase.name} helper in this exact conversation.`,
          helperText: helperCase.helperText,
          ...stableIds
        });
        setMockTreeConnected(turn.root, false);
        context.__profileRouteRoot = redraw.root;
        context.document.body = redraw.root;
      }
      const nextPath = routeCase.routePath(helperIndex);
      context.location.pathname = nextPath;
      context.location.href = `https://chatgpt.com${nextPath}`;
      assert.equal(context.refreshPageLifecycle(), true);
      releaseProfile({ role: "master", agentId: "master-profile-route" });
      await run;

      assert.equal(
        runtimeCalls.filter((payload) => payload.type === helperCase.runtimeType).length,
        routeCase.expectedRuntimeCalls,
        `${helperCase.name}/${routeCase.name}: runtime dispatch crossed an invalid profile await route.`
      );
      assert.equal(
        runtimeCalls.filter((payload) => payload.type !== helperCase.runtimeType).length,
        0,
        `${helperCase.name}/${routeCase.name}: no unrelated runtime message is expected.`
      );
    }
  }
}

async function verifyForceDeferredProfileDispatchRouteGuards() {
  const helperCases = [
    {
      name: "shell",
      helperText: createHelperBlock({ cmd: "printf FORCE_PROFILE_ROUTE_SHELL" }),
      runtimeType: "run-shell"
    },
    {
      name: "board",
      helperText: "ai-helper-board-start\nstatus\nai-helper-board-end",
      runtimeType: "run-board"
    },
    {
      name: "agent-message",
      helperText: [
        "ai-helper-agent-message-start",
        "to: slave-a",
        "task-id: force-profile-route-task",
        "",
        "Check Force profile-await ownership.",
        "ai-helper-agent-message-end"
      ].join("\n"),
      runtimeType: "agent-send"
    },
    {
      name: "agent-roster",
      helperText: createAgentRosterBlock(),
      runtimeType: "agent-list"
    },
    {
      name: "agent-task-status",
      helperText: createAgentTaskStatusBlock(),
      runtimeType: "agent-task-status"
    }
  ];
  const routeCases = [
    {
      name: "same lifecycle",
      nextPath: "",
      replacement: false,
      expectedRuntimeCalls: 1
    },
    {
      name: "second permanent route",
      nextPath: "/c/force-profile-b",
      replacement: false,
      expectedRuntimeCalls: 0
    },
    {
      name: "replacement transcript",
      nextPath: "/c/force-profile-replaced",
      replacement: true,
      expectedRuntimeCalls: 0
    }
  ];

  for (const [helperIndex, helperCase] of helperCases.entries()) {
    for (const routeCase of routeCases) {
      const context = loadContentContext();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      installPersistentLocalStorage(context);
      context.location.pathname = "/c/force-profile-a";
      context.location.href = "https://chatgpt.com/c/force-profile-a";
      const turn = createStableChatGptRouteTurn(context, {
        userText: `Force the ${helperCase.name} helper only in this exact chat.`,
        helperText: helperCase.helperText,
        userId: `force-profile-user-${helperCase.name}`,
        assistantId: `force-profile-assistant-${helperCase.name}`
      });
      context.__forceProfileRoot = turn.root;
      context.document.body = turn.root;
      context.getConversationRoot = () => context.__forceProfileRoot;
      context.extractShellCallCandidates = () => [turn.candidate];
      const call = turn.candidate.call;
      const semanticKey = context.buildSemanticCallKey(call);
      const callId = `force-profile:${helperIndex}:${routeCase.name}`;
      const forceCandidateSnapshot = context.createRenderedHelperCandidateSnapshot(turn.candidate);

      let profileRequested;
      let releaseProfile;
      const profileObserved = new Promise((resolve) => {
        profileRequested = resolve;
      });
      const profileGate = new Promise((resolve) => {
        releaseProfile = resolve;
      });
      const runtimeCalls = [];
      context.getCurrentAgentProfile = async () => {
        profileRequested();
        return profileGate;
      };
      context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: true });
      context.chrome.runtime.sendMessage = async (payload) => {
        runtimeCalls.push(payload);
        if (payload.type === "run-shell" || payload.type === "run-board") {
          return {
            ok: true,
            executed: true,
            executionCompleted: true,
            executionId: "ee11ff22aa33bb44",
            exitCode: 0,
            stdout: "FORCE_PROFILE_ROUTE_OK"
          };
        }
        if (payload.type === "agent-list") {
          return { ok: true, agents: [] };
        }
        return { ok: true, messageId: "force-profile-route-message" };
      };
      context.rememberPendingHelperDelivery = async (_callId, _call, response) => ({
        callId,
        response,
        phase: "queued"
      });
      context.attemptPendingHelperDelivery = async () => true;
      context.schedulePendingHelperDeliveryRetry = () => {};
      context.updateContextualPanelActions = () => {};
      context.updateStopHelperButton = () => {};
      context.setStatus = () => {};
      vm.runInContext(`
        extensionActive = true;
        observedPageIdentity = location.href;
        initialThreadSettled = true;
      `, context);

      const run = context.runAndReply(callId, call, {
        force: true,
        forceCandidateSnapshot
      });
      await profileObserved;
      assert.equal(vm.runInContext("activeCallId", context), callId,
        `${helperCase.name}/${routeCase.name}: Force profile await must own an active token.`);

      if (routeCase.nextPath) {
        if (routeCase.replacement) {
          setMockTreeConnected(turn.root, false);
          const replacement = createRoot([
            new MockNode({ order: 1, role: "user", text: "A replacement chat owns this route." })
          ]);
          replacement.isConnected = true;
          context.__forceProfileRoot = replacement;
          context.document.body = replacement;
        }
        context.location.pathname = routeCase.nextPath;
        context.location.href = `https://chatgpt.com${routeCase.nextPath}`;
        assert.equal(context.refreshPageLifecycle(), true);
      }
      releaseProfile({ role: "master", agentId: "master-force-profile" });
      await run;

      assert.equal(
        runtimeCalls.filter((payload) => payload.type === helperCase.runtimeType).length,
        routeCase.expectedRuntimeCalls,
        `${helperCase.name}/${routeCase.name}: Force runtime crossed its active-token lifecycle.`
      );
      assert.equal(
        runtimeCalls.filter((payload) => payload.type !== helperCase.runtimeType).length,
        0,
        `${helperCase.name}/${routeCase.name}: no unrelated Force runtime message is expected.`
      );
      assert.equal(vm.runInContext("activeCallId", context), "");
      assert.equal(vm.runInContext("activeForceRunCallId", context), "");
      assert.equal(semanticKey, context.buildSemanticCallKey(call));
    }
  }
}

async function verifyOuterSettingsAwaitRouteReconciliation() {
  const catalogSha = "a".repeat(64);
  const helperCases = [
    {
      name: "skill-load",
      helperText: createSkillLoadBlock({
        helperId: "outer-settings-skill",
        skillId: "example",
        catalogSha
      }),
      runtimeType: "skill-load"
    },
    {
      name: "shell",
      helperText: createHelperBlock({ cmd: "printf OUTER_SETTINGS_ROUTE" }),
      runtimeType: "run-shell"
    }
  ];
  const routeCases = [
    {
      name: "retained provisional assignment",
      startPath: "/",
      nextPath: "/c/outer-settings-retained",
      replacement: false,
      expectedRuntimeCalls: 1,
      expectedReplies: 1
    },
    {
      name: "replacement transcript",
      startPath: "/",
      nextPath: "/c/outer-settings-replaced",
      replacement: true,
      expectedRuntimeCalls: 0,
      expectedReplies: 0
    },
    {
      name: "second permanent route",
      startPath: "/c/outer-settings-a",
      nextPath: "/c/outer-settings-b",
      replacement: false,
      expectedRuntimeCalls: 0,
      expectedReplies: 0
    }
  ];

  for (const helperCase of helperCases) {
    for (const routeCase of routeCases) {
      const context = loadContentContext();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      installPersistentLocalStorage(context);
      context.location.pathname = routeCase.startPath;
      context.location.href = `https://chatgpt.com${routeCase.startPath}`;
      const stableIds = {
        userId: `outer-settings-user-${helperCase.name}`,
        assistantId: `outer-settings-assistant-${helperCase.name}`
      };
      const turn = createStableChatGptRouteTurn(context, {
        userText: `Run the ${helperCase.name} helper after assigning this chat URL.`,
        helperText: helperCase.helperText,
        ...stableIds
      });
      context.__outerSettingsRoot = turn.root;
      context.__outerSettingsCandidate = turn.candidate;
      context.document.body = turn.root;
      context.getConversationRoot = () => context.__outerSettingsRoot;
      context.extractShellCallCandidates = () => context.__outerSettingsCandidate
        ? [context.__outerSettingsCandidate]
        : [];

      let outerSettingsRequested;
      let releaseOuterSettings;
      const outerSettingsObserved = new Promise((resolve) => {
        outerSettingsRequested = resolve;
      });
      const outerSettingsGate = new Promise((resolve) => {
        releaseOuterSettings = resolve;
      });
      let outerSettingsCalls = 0;
      const runtimeCalls = [];
      let replies = 0;
      let scanScheduled = false;
      context.chrome.storage.sync.get = async (keys) => {
        if (Array.isArray(keys) && keys.includes("enabled")) {
          outerSettingsCalls += 1;
          if (outerSettingsCalls === 1) {
            outerSettingsRequested();
            return outerSettingsGate;
          }
          return { enabled: true, enabledHosts: ["chatgpt.com"], maxChainCalls: 100 };
        }
        return { requireApproval: false, autoSend: true };
      };
      context.chrome.runtime.sendMessage = async (payload) => {
        runtimeCalls.push(payload);
        if (payload.type === "skill-load") {
          return {
            ok: true,
            catalogSha,
            skill: { id: "example", sha: "b".repeat(64) },
            content: "# Example\nUse the loaded example Skill."
          };
        }
        if (payload.type === "run-shell") {
          return {
            ok: true,
            executed: true,
            executionCompleted: true,
            executionId: "bb22cc33dd44ee55",
            exitCode: 0,
            stdout: "OUTER_SETTINGS_ROUTE"
          };
        }
        return { ok: true };
      };
      context.getCurrentAgentProfile = async () => ({ role: "none", agentId: "" });
      context.queueSkillComposerReply = async () => {
        replies += 1;
        return true;
      };
      context.rememberPendingHelperDelivery = async (_callId, _call, response) => {
        replies += 1;
        return { callId: "outer-settings-shell", response, phase: "queued" };
      };
      context.setPendingHelperDeliveryStatus = () => {};
      context.attemptPendingHelperDelivery = async () => true;
      context.schedulePendingHelperDeliveryRetry = () => {};
      context.scheduleScan = () => {
        scanScheduled = true;
      };
      context.updateContextualPanelActions = () => {};
      context.updateSiteActionButton = () => {};
      context.updateStopHelperButton = () => {};
      context.resetChainForNewHumanPrompt = () => {};
      context.setStatus = () => {};
      vm.runInContext(`
        extensionActive = true;
        observedPageIdentity = location.href;
        initialThreadSettled = true;
        lastThreadText = normalizeText(globalThis.__outerSettingsRoot.innerText || globalThis.__outerSettingsRoot.textContent || "");
        lastThreadTextAt = Date.now() - 5000;
        const outerSettingsCandidate = globalThis.__outerSettingsCandidate;
        const outerSettingsSemanticKey = buildSemanticCallKey(outerSettingsCandidate.call);
        liveGeneratedRenderedHelpers.set(
          getCandidateRenderRoot(outerSettingsCandidate),
          new Set([buildRenderedHelperKey(outerSettingsCandidate, outerSettingsSemanticKey)])
        );
      `, context);

      const firstScan = context.scanForShellCall();
      await outerSettingsObserved;
      if (routeCase.replacement) {
        setMockTreeConnected(turn.root, false);
        const replacement = createRoot([
          new MockNode({ order: 1, role: "user", text: "This is an unrelated replacement chat." })
        ]);
        replacement.isConnected = true;
        context.__outerSettingsRoot = replacement;
        context.__outerSettingsCandidate = null;
        context.document.body = replacement;
      } else if (routeCase.startPath === "/") {
        const redraw = createStableChatGptRouteTurn(context, {
          userText: `Run the ${helperCase.name} helper after assigning this chat URL.`,
          helperText: helperCase.helperText,
          ...stableIds
        });
        setMockTreeConnected(turn.root, false);
        context.__outerSettingsRoot = redraw.root;
        context.__outerSettingsCandidate = redraw.candidate;
        context.document.body = redraw.root;
      }
      context.location.pathname = routeCase.nextPath;
      context.location.href = `https://chatgpt.com${routeCase.nextPath}`;
      if (!routeCase.replacement && routeCase.startPath === "/") {
        vm.runInContext(`
          const assignedCandidate = globalThis.__outerSettingsCandidate;
          const assignedSemanticKey = buildSemanticCallKey(assignedCandidate.call);
          liveGeneratedRenderedHelpers.set(
            getCandidateRenderRoot(assignedCandidate),
            new Set([buildRenderedHelperKey(assignedCandidate, assignedSemanticKey)])
          );
        `, context);
      }
      releaseOuterSettings({ enabled: true, enabledHosts: ["chatgpt.com"], maxChainCalls: 100 });
      await firstScan;
      for (let retry = 0; retry < 3 && scanScheduled; retry += 1) {
        scanScheduled = false;
        vm.runInContext("lastThreadTextAt = Date.now() - 5000;", context);
        await context.scanForShellCall();
      }

      assert.equal(
        runtimeCalls.filter((payload) => payload.type === helperCase.runtimeType).length,
        routeCase.expectedRuntimeCalls,
        `${helperCase.name}/${routeCase.name}: outer settings await used a stale route lifecycle.`
      );
      assert.equal(
        replies,
        routeCase.expectedReplies,
        `${helperCase.name}/${routeCase.name}: result delivery did not match the reconciled route.`
      );
    }
  }
}

async function verifySkillBackendRouteHandoffRejectsSecondPermanentRoute() {
  const catalogSha = "a".repeat(64);
  for (const routeCase of [
    { name: "provisional c", startPath: "/", nextPath: "/c/skill-backend-c", expectedReplies: 1 },
    { name: "provisional uc", startPath: "/", nextPath: "/uc/skill-backend-uc", expectedReplies: 1 },
    { name: "second permanent route", startPath: "/c/skill-backend-a", nextPath: "/c/skill-backend-b", expectedReplies: 0 }
  ]) {
    const context = loadContentContext();
    context.location.pathname = routeCase.startPath;
    context.location.href = `https://chatgpt.com${routeCase.startPath}`;
    const helperText = createSkillLoadBlock({
      helperId: `skill-backend-${routeCase.name.replaceAll(" ", "-")}`,
      skillId: "example",
      catalogSha
    });
    const turn = createStableChatGptRouteTurn(context, {
      userText: "Load the exact Skill for this stable assistant turn.",
      helperText,
      userId: "skill-backend-route-user",
      assistantId: "skill-backend-route-assistant"
    });
    context.__skillBackendRouteRoot = turn.root;
    context.document.body = turn.root;
    context.getConversationRoot = () => context.__skillBackendRouteRoot;
    context.extractShellCallCandidates = () => [turn.candidate];
    let runtimeStarted;
    let releaseRuntime;
    const runtimeObserved = new Promise((resolve) => {
      runtimeStarted = resolve;
    });
    const runtimeGate = new Promise((resolve) => {
      releaseRuntime = resolve;
    });
    let runtimeCalls = 0;
    let replies = 0;
    context.chrome.runtime.sendMessage = async (payload) => {
      if (payload.type !== "skill-load") {
        return { ok: true };
      }
      runtimeCalls += 1;
      runtimeStarted();
      await runtimeGate;
      return {
        ok: true,
        catalogSha,
        skill: { id: "example", sha: "b".repeat(64) },
        content: "# Example\nUse this Skill."
      };
    };
    context.queueSkillComposerReply = async () => {
      replies += 1;
      return true;
    };
    context.updateContextualPanelActions = () => {};
    context.scheduleScan = () => {};
    context.setStatus = () => {};
    vm.runInContext("extensionActive = true; observedPageIdentity = location.href;", context);

    const processing = context.processLatestSkillCandidate(
      [turn.candidate],
      { maxChainCalls: 100 }
    );
    await runtimeObserved;
    context.location.pathname = routeCase.nextPath;
    context.location.href = `https://chatgpt.com${routeCase.nextPath}`;
    assert.equal(context.refreshPageLifecycle(), true);
    releaseRuntime();
    await processing;

    assert.equal(runtimeCalls, 1);
    assert.equal(replies, routeCase.expectedReplies,
      `${routeCase.name}: Skill backend response crossed an invalid route boundary.`);
  }
}

async function verifyManualForceDispatchWinsOuterScanRace() {
  for (const manualStartsFirst of [false, true]) {
    const context = loadContentContext();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    installPersistentLocalStorage(context);
    const helperText = createHelperBlock({ cmd: "printf MANUAL_FORCE_WINS" });
    const turn = createStableChatGptRouteTurn(context, {
      userText: "Run this helper once even if Force overlaps automatic scanning.",
      helperText,
      userId: `force-race-user-${manualStartsFirst}`,
      assistantId: `force-race-assistant-${manualStartsFirst}`
    });
    context.__forceRaceRoot = turn.root;
    context.document.body = turn.root;
    context.getConversationRoot = () => context.__forceRaceRoot;
    context.extractShellCallCandidates = () => [turn.candidate];
    const forceSnapshot = context.createRenderedHelperCandidateSnapshot(turn.candidate);
    let firstOuterStarted;
    let releaseFirstOuter;
    const firstOuterObserved = new Promise((resolve) => {
      firstOuterStarted = resolve;
    });
    const firstOuterGate = new Promise((resolve) => {
      releaseFirstOuter = resolve;
    });
    let outerCalls = 0;
    const runtimeCalls = [];
    context.chrome.storage.sync.get = async (keys) => {
      if (Array.isArray(keys) && keys.includes("enabled")) {
        outerCalls += 1;
        if (outerCalls === 1) {
          firstOuterStarted();
          return firstOuterGate;
        }
        return { enabled: true, enabledHosts: ["chatgpt.com"], maxChainCalls: 100 };
      }
      return { requireApproval: false, autoSend: true };
    };
    context.chrome.runtime.sendMessage = async (payload) => {
      if (payload.type === "run-shell") {
        runtimeCalls.push(payload);
        return {
          ok: true,
          executed: true,
          executionCompleted: true,
          executionId: `force-race-${manualStartsFirst ? "first" : "second"}`,
          exitCode: 0,
          stdout: "MANUAL_FORCE_WINS"
        };
      }
      return { ok: true };
    };
    context.getCurrentAgentProfile = async () => ({ role: "none", agentId: "" });
    context.rememberPendingHelperDelivery = async (callId, call, response) => ({
      callId,
      call,
      response,
      phase: "queued"
    });
    context.attemptPendingHelperDelivery = async () => true;
    context.setPendingHelperDeliveryStatus = () => {};
    context.schedulePendingHelperDeliveryRetry = () => {};
    context.scheduleScan = () => {};
    context.updateContextualPanelActions = () => {};
    context.updateSiteActionButton = () => {};
    context.updateStopHelperButton = () => {};
    context.resetChainForNewHumanPrompt = () => {};
    context.setStatus = () => {};
    vm.runInContext(`
      extensionActive = true;
      observedPageIdentity = location.href;
      initialThreadSettled = true;
      lastThreadText = normalizeText(globalThis.__forceRaceRoot.innerText || globalThis.__forceRaceRoot.textContent || "");
      lastThreadTextAt = Date.now() - 5000;
      const forceRaceCandidate = globalThis.__forceRaceRoot && extractShellCallCandidates(globalThis.__forceRaceRoot)[0];
      const forceRaceSemanticKey = buildSemanticCallKey(forceRaceCandidate.call);
      liveGeneratedRenderedHelpers.set(
        getCandidateRenderRoot(forceRaceCandidate),
        new Set([buildRenderedHelperKey(forceRaceCandidate, forceRaceSemanticKey)])
      );
    `, context);

    let autoScan;
    let forceScan;
    if (manualStartsFirst) {
      vm.runInContext("forceRunInFlight = true;", context);
      forceScan = context.scanForShellCall({ force: true, forceCandidateSnapshot: forceSnapshot });
      await firstOuterObserved;
      autoScan = context.scanForShellCall();
      releaseFirstOuter({ enabled: true, enabledHosts: ["chatgpt.com"], maxChainCalls: 100 });
    } else {
      autoScan = context.scanForShellCall();
      await firstOuterObserved;
      vm.runInContext("forceRunInFlight = true;", context);
      forceScan = context.scanForShellCall({ force: true, forceCandidateSnapshot: forceSnapshot });
      await waitForTestCondition(() => runtimeCalls.length === 1);
      releaseFirstOuter({ enabled: true, enabledHosts: ["chatgpt.com"], maxChainCalls: 100 });
    }
    await Promise.all([autoScan, forceScan]);
    vm.runInContext("forceRunInFlight = false;", context);

    assert.equal(runtimeCalls.length, 1,
      `${manualStartsFirst ? "Force-first" : "auto-first"}: overlapping scans must execute once.`);
    assert.equal(runtimeCalls[0].callMeta?.force, true,
      "The trusted manual Force dispatch must win over an automatic pre-claim scan.");
  }
}

async function verifyManualSkillRecoveryWinsOuterScanRace() {
  const catalogSha = "c".repeat(64);
  for (const manualStartsFirst of [false, true]) {
    const context = loadContentContext();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    installPersistentLocalStorage(context);
    const helperText = createSkillLoadBlock({
      helperId: `skill-recovery-race-${manualStartsFirst}`,
      skillId: "example",
      catalogSha
    });
    const turn = createStableChatGptRouteTurn(context, {
      userText: "Process this Skill exactly once.",
      helperText,
      userId: `skill-recovery-race-user-${manualStartsFirst}`,
      assistantId: `skill-recovery-race-assistant-${manualStartsFirst}`
    });
    context.__skillRecoveryRaceRoot = turn.root;
    context.document.body = turn.root;
    context.getConversationRoot = () => context.__skillRecoveryRaceRoot;
    context.extractShellCallCandidates = () => [turn.candidate];
    let firstOuterStarted;
    let releaseFirstOuter;
    const firstOuterObserved = new Promise((resolve) => {
      firstOuterStarted = resolve;
    });
    const firstOuterGate = new Promise((resolve) => {
      releaseFirstOuter = resolve;
    });
    let outerCalls = 0;
    let runtimeStarted;
    let releaseRuntime;
    const runtimeObserved = new Promise((resolve) => {
      runtimeStarted = resolve;
    });
    const runtimeGate = new Promise((resolve) => {
      releaseRuntime = resolve;
    });
    let runtimeCalls = 0;
    let replies = 0;
    context.chrome.storage.sync.get = async (keys) => {
      if (Array.isArray(keys) && keys.includes("enabled")) {
        outerCalls += 1;
        if (outerCalls === 1) {
          firstOuterStarted();
          return firstOuterGate;
        }
        return { enabled: true, enabledHosts: ["chatgpt.com"], maxChainCalls: 100 };
      }
      return { autoSend: true };
    };
    context.chrome.runtime.sendMessage = async (payload) => {
      if (payload.type !== "skill-load") {
        return { ok: true };
      }
      runtimeCalls += 1;
      runtimeStarted();
      await runtimeGate;
      return {
        ok: true,
        catalogSha,
        skill: { id: "example", sha: "d".repeat(64) },
        content: "# Example\nUse this Skill."
      };
    };
    context.queueSkillComposerReply = async () => {
      replies += 1;
      return true;
    };
    context.scheduleScan = () => {};
    context.schedulePendingHelperDeliveryRetry = () => {};
    context.updateContextualPanelActions = () => {};
    context.updateSiteActionButton = () => {};
    context.resetChainForNewHumanPrompt = () => {};
    context.setStatus = () => {};
    vm.runInContext(`
      extensionActive = true;
      observedPageIdentity = location.href;
      initialThreadSettled = true;
      lastThreadText = normalizeText(globalThis.__skillRecoveryRaceRoot.innerText || globalThis.__skillRecoveryRaceRoot.textContent || "");
      lastThreadTextAt = Date.now() - 5000;
      const skillRecoveryRaceCandidate = extractShellCallCandidates(globalThis.__skillRecoveryRaceRoot)[0];
      const skillRecoveryRaceSemanticKey = buildSemanticCallKey(skillRecoveryRaceCandidate.call);
      liveGeneratedRenderedHelpers.set(
        getCandidateRenderRoot(skillRecoveryRaceCandidate),
        new Set([buildRenderedHelperKey(skillRecoveryRaceCandidate, skillRecoveryRaceSemanticKey)])
      );
    `, context);

    let autoScan;
    let recovery;
    if (manualStartsFirst) {
      recovery = context.processLatestSkillRecovery({ forceDetected: true });
      await firstOuterObserved;
      autoScan = context.scanForShellCall();
      releaseFirstOuter({ enabled: true, enabledHosts: ["chatgpt.com"], maxChainCalls: 100 });
      await runtimeObserved;
    } else {
      autoScan = context.scanForShellCall();
      await firstOuterObserved;
      recovery = context.processLatestSkillRecovery({ forceDetected: true });
      await runtimeObserved;
      releaseFirstOuter({ enabled: true, enabledHosts: ["chatgpt.com"], maxChainCalls: 100 });
    }
    await autoScan;
    releaseRuntime();
    await recovery;

    assert.equal(runtimeCalls, 1,
      `${manualStartsFirst ? "Process-Skill-first" : "auto-first"}: overlapping Skill scans must execute once.`);
    assert.equal(replies, 1, "Only the manual Process Skill dispatch may queue one reply.");
  }
}

async function verifyStaleShellCompletionCannotClearNewActiveUi() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  installPersistentLocalStorage(context);
  context.location.pathname = "/c/old-shell-ui";
  context.location.href = "https://chatgpt.com/c/old-shell-ui";
  const oldTurn = createStableChatGptRouteTurn(context, {
    userText: "Start the old shell helper.",
    helperText: createHelperBlock({ cmd: "printf OLD_SHELL_UI" }),
    userId: "old-shell-ui-user",
    assistantId: "old-shell-ui-assistant"
  });
  context.__shellUiRoot = oldTurn.root;
  context.document.body = oldTurn.root;
  context.getConversationRoot = () => context.__shellUiRoot;

  const pendingRuntime = new Map();
  const statuses = [];
  const stopStates = [];
  const clearedNotices = [];
  context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: true });
  context.chrome.runtime.sendMessage = (payload) => {
    if (payload.type === "run-shell") {
      return new Promise((resolve) => pendingRuntime.set(payload.cmd, resolve));
    }
    return Promise.resolve({ ok: true, found: true });
  };
  context.getCurrentAgentProfile = async () => ({ role: "none", agentId: "" });
  context.setStatus = (text, state) => statuses.push({ text, state });
  context.updateStopHelperButton = (active) => {
    stopStates.push(active === true);
    vm.runInContext(`panelShellHelperActive = ${active === true ? "true" : "false"};`, context);
  };
  context.clearShellRunNotice = (executionId = "") => clearedNotices.push(executionId);
  context.rememberPendingHelperDelivery = async (callId, _call, response) => ({
    callId,
    response,
    phase: "queued"
  });
  context.setPendingHelperDeliveryStatus = () => {};
  context.attemptPendingHelperDelivery = async () => true;
  context.schedulePendingHelperDeliveryRetry = () => {};
  context.updateContextualPanelActions = () => {};
  vm.runInContext("extensionActive = true; observedPageIdentity = location.href; initialThreadSettled = true;", context);

  const oldCall = oldTurn.candidate.call;
  const oldContext = context.createRunnableHelperDispatchContext(oldTurn.candidate);
  const oldRun = context.runAndReply("old-shell-ui-call", oldCall, { dispatchContext: oldContext });
  await waitForTestCondition(() => pendingRuntime.has("printf OLD_SHELL_UI"));

  const newTurn = createStableChatGptRouteTurn(context, {
    userText: "This new chat owns its own shell helper.",
    helperText: createHelperBlock({ cmd: "printf NEW_SHELL_UI" }),
    userId: "new-shell-ui-user",
    assistantId: "new-shell-ui-assistant"
  });
  setMockTreeConnected(oldTurn.root, false);
  context.__shellUiRoot = newTurn.root;
  context.document.body = newTurn.root;
  context.location.pathname = "/c/new-shell-ui";
  context.location.href = "https://chatgpt.com/c/new-shell-ui";
  assert.equal(context.refreshPageLifecycle(), true);

  const newCall = newTurn.candidate.call;
  const newContext = context.createRunnableHelperDispatchContext(newTurn.candidate);
  const newRun = context.runAndReply("new-shell-ui-call", newCall, { dispatchContext: newContext });
  await waitForTestCondition(() => pendingRuntime.has("printf NEW_SHELL_UI"));
  assert.equal(vm.runInContext("activeCallId", context), "new-shell-ui-call");
  assert.equal(stopStates.at(-1), true);
  assert.match(statuses.at(-1).text, /NEW_SHELL_UI/);
  const statusCountBeforeOldCompletion = statuses.length;
  const noticeClearCountBeforeOldCompletion = clearedNotices.length;

  pendingRuntime.get("printf OLD_SHELL_UI")({
    ok: true,
    executed: true,
    executionCompleted: true,
    executionId: "1111aaaabbbb2222",
    exitCode: 0,
    stdout: "OLD_SHELL_UI"
  });
  await oldRun;

  assert.equal(vm.runInContext("activeCallId", context), "new-shell-ui-call",
    "A stale completion must not release the new exact active token.");
  assert.equal(stopStates.at(-1), true,
    "A stale completion and its finally must leave Stop visible for the new shell.");
  assert.equal(statuses.length, statusCountBeforeOldCompletion,
    "A stale reporter must not replace the new shell's running status.");
  assert.equal(clearedNotices.length, noticeClearCountBeforeOldCompletion,
    "A stale completion must not clear the new shell's output-idle notice state.");

  pendingRuntime.get("printf NEW_SHELL_UI")({
    ok: true,
    executed: true,
    executionCompleted: true,
    executionId: "3333ccccdddd4444",
    exitCode: 0,
    stdout: "NEW_SHELL_UI"
  });
  await newRun;
  assert.equal(vm.runInContext("activeCallId", context), "");
  assert.equal(stopStates.at(-1), false, "The current shell's own completion must hide Stop normally.");
  assert.deepEqual(clearedNotices, ["3333ccccdddd4444"]);
}

function verifyStaleSkillReporterCannotOverwriteNewRunnableStatus() {
  const context = loadContentContext();
  const statuses = [];
  context.setStatus = (text, state) => statuses.push({ text, state });
  vm.runInContext(`
    activeCallId = "new-runnable-after-skill";
    activeCallToken = {
      callId: activeCallId,
      pageIdentity: getCurrentPageIdentity(),
      generation: pageLifecycleGeneration,
      call: parseCallPayload(${JSON.stringify(createHelperBlock({ cmd: "printf NEW_AFTER_SKILL" }))})
    };
  `, context);
  context.reportStaleSkillDispatch(null);
  assert.equal(statuses.length, 0,
    "A stale Skill response must not overwrite a newer runnable helper's status.");
  assert.equal(vm.runInContext("activeCallId", context), "new-runnable-after-skill");
}

async function verifyShellProgressUsesExactActiveCallAfterProfileAwait() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const statuses = [];
  context.setStatus = (text, state) => statuses.push({ text, state });
  context.updateShellRunControlPanel = () => {};
  context.startShellRunMonitor = () => {};
  vm.runInContext("extensionActive = true;", context);

  let profileRequested;
  let releaseProfile;
  const profileObserved = new Promise((resolve) => {
    profileRequested = resolve;
  });
  const profileGate = new Promise((resolve) => {
    releaseProfile = resolve;
  });
  context.getCurrentAgentProfile = async () => {
    profileRequested();
    return profileGate;
  };
  const staleProgress = context.handleShellRunProgress({
    state: "awaiting-user",
    callKey: "old-progress-call",
    executionId: "old-progress-execution",
    agentId: "",
    idleForMs: 180000
  });
  await profileObserved;
  vm.runInContext(`
    activeCallId = "new-progress-call";
    activeCallToken = {
      callId: activeCallId,
      pageIdentity: getCurrentPageIdentity(),
      generation: pageLifecycleGeneration,
      call: parseCallPayload(${JSON.stringify(createHelperBlock({ cmd: "printf NEW_PROGRESS" }))})
    };
    activeShellRunNotice = {
      callKey: activeCallId,
      executionId: "new-progress-execution",
      agentId: "",
      idleForMs: 1000,
      idleTimeoutMs: 180000
    };
  `, context);
  statuses.push({ text: "Running: printf NEW_PROGRESS", state: "running" });
  releaseProfile({ role: "none", agentId: "" });
  await staleProgress;

  assert.equal(vm.runInContext("activeShellRunNotice.callKey", context), "new-progress-call");
  assert.deepEqual(statuses, [{ text: "Running: printf NEW_PROGRESS", state: "running" }],
    "Old progress resolving after profile lookup must not overwrite the new call UI.");

  context.getCurrentAgentProfile = async () => ({ role: "none", agentId: "" });
  await context.handleShellRunProgress({
    state: "awaiting-user",
    callKey: "new-progress-call",
    executionId: "new-progress-execution",
    agentId: "",
    idleForMs: 200000
  });
  assert.equal(vm.runInContext("activeShellRunNotice.callKey", context), "new-progress-call");
  assert.match(statuses.at(-1).text, /produced no output/,
    "Progress for the exact active call must remain accepted.");
}

async function verifyOldFinalizationCannotOverwriteNewRunnableStatus() {
  for (const receiptAcknowledged of [true, false]) {
    for (const newerOwner of ["shell", "skill", "force"]) {
    const context = loadContentContext();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    installPersistentLocalStorage(context);
    const statuses = [];
    context.setStatus = (text, state) => statuses.push({ text, state });
    context.schedulePendingHelperDeliveryRetry = () => {};
    let receiptRequested;
    let releaseReceipt;
    const receiptObserved = new Promise((resolve) => {
      receiptRequested = resolve;
    });
    const receiptGate = new Promise((resolve) => {
      releaseReceipt = resolve;
    });
    context.acknowledgePendingHelperResultPresented = async () => {
      receiptRequested();
      return receiptGate;
    };
    const oldCall = context.parseCallPayload(createHelperBlock({ cmd: "printf OLD_FINALIZATION" }));
    context.__oldFinalizationCall = oldCall;
    vm.runInContext(`
      const oldFinalizationEntry = {
        callId: "old-finalization-call",
        executionId: "5555aaaabbbb6666",
        kind: "shell",
        call: snapshotPendingHelperCall(globalThis.__oldFinalizationCall),
        response: { ok: true, exitCode: 0, stdout: "OLD_FINALIZATION" },
        reply: "Shell call result: OLD_FINALIZATION",
        pageIdentity: getCurrentPageIdentity(),
        phase: "submitted",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attempts: 1,
        lastError: ""
      };
      pendingHelperDeliveriesLoadedKey = pendingHelperDeliveryStorageKey();
      pendingHelperDeliveries.set(oldFinalizationEntry.callId, oldFinalizationEntry);
      globalThis.__oldFinalizationEntry = oldFinalizationEntry;
    `, context);

    const finalization = context.performPendingHelperDeliveryFinalization(
      context.__oldFinalizationEntry,
      "submitted"
    );
    await receiptObserved;
    if (newerOwner === "shell") {
      vm.runInContext(`
        activeCallId = "new-call-during-finalization";
        activeCallToken = {
          callId: activeCallId,
          pageIdentity: getCurrentPageIdentity(),
          generation: pageLifecycleGeneration,
          call: parseCallPayload(${JSON.stringify(createHelperBlock({ cmd: "printf NEW_DURING_FINALIZATION" }))})
        };
        panelShellHelperActive = true;
      `, context);
    } else if (newerOwner === "skill") {
      vm.runInContext(`
        skillHelperInFlight = true;
        activeSkillHelperCallKey = "new-skill-during-finalization";
      `, context);
    } else {
      vm.runInContext(`
        forceRunInFlight = true;
        activeForceRunCallId = "new-force-during-finalization";
      `, context);
    }
    statuses.push({ text: `Running: new ${newerOwner} during finalization`, state: "running" });
    const statusCountBeforeReceipt = statuses.length;
    releaseReceipt(receiptAcknowledged);
    await finalization;

    assert.equal(statuses.length, statusCountBeforeReceipt,
      `Receipt ${receiptAcknowledged ? "ack" : "retry"} must not overwrite a newer running status.`);
    assert.deepEqual(statuses.at(-1), {
      text: `Running: new ${newerOwner} during finalization`,
      state: "running"
    });
    assert.equal(
      vm.runInContext("locallyPresentedHelperExecutions.has('5555aaaabbbb6666')", context),
      true,
      "The local presentation tombstone must still be recorded while UI ownership is protected."
    );
    assert.equal(
      vm.runInContext("pendingHelperDeliveries.has('old-finalization-call')", context),
      !receiptAcknowledged,
      "Receipt state must still clear or retain the pending entry normally."
    );
    }
  }
}

async function verifyStaleDiscardCannotOverwriteNewRunnableStatus() {
  for (const kind of ["runnable", "skill"]) {
    for (const newerOwner of ["shell", "skill", "force"]) {
    const context = loadContentContext();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const statuses = [];
    context.setStatus = (text, state) => statuses.push({ text, state });
    let releasePersist;
    let persistStarted;
    const persistObserved = new Promise((resolve) => {
      persistStarted = resolve;
    });
    const persistGate = new Promise((resolve) => {
      releasePersist = resolve;
    });
    context.persistPendingHelperDeliveries = async () => {
      persistStarted();
      await persistGate;
    };
    vm.runInContext(`
      const staleDiscardEntry = {
        callId: "stale-${kind}-discard",
        pageIdentity: getCurrentPageIdentity(),
        phase: "queued"
      };
      pendingHelperDeliveries.set(staleDiscardEntry.callId, staleDiscardEntry);
      globalThis.__staleDiscardEntry = staleDiscardEntry;
    `, context);
    const discard = kind === "skill"
      ? context.discardStaleSkillPendingDelivery(context.__staleDiscardEntry)
      : context.discardStaleRunnablePendingDelivery(context.__staleDiscardEntry);
    await persistObserved;
    if (newerOwner === "shell") {
      vm.runInContext(`
        activeCallId = "new-call-during-${kind}-discard";
        activeCallToken = {
          callId: activeCallId,
          pageIdentity: getCurrentPageIdentity(),
          generation: pageLifecycleGeneration,
          call: parseCallPayload(${JSON.stringify(createHelperBlock({ cmd: "printf NEW_DURING_DISCARD" }))})
        };
        panelShellHelperActive = true;
      `, context);
    } else if (newerOwner === "skill") {
      vm.runInContext(`
        skillHelperInFlight = true;
        activeSkillHelperCallKey = "new-skill-during-${kind}-discard";
      `, context);
    } else {
      vm.runInContext(`
        forceRunInFlight = true;
        activeForceRunCallId = "new-force-during-${kind}-discard";
      `, context);
    }
    statuses.push({ text: `Running: new ${newerOwner} during ${kind} discard`, state: "running" });
    releasePersist();
    await discard;
    assert.deepEqual(statuses, [{ text: `Running: new ${newerOwner} during ${kind} discard`, state: "running" }],
      `${kind} discard must not overwrite a newer ${newerOwner} operation after persistence.`);
    }
  }
}

async function verifyCurrentPanelOperationMayPublishItsOwnCompletion() {
  for (const owner of ["shell", "skill", "force"]) {
    const context = loadContentContext();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    installPersistentLocalStorage(context);
    const statuses = [];
    context.setStatus = (text, state) => statuses.push({ text, state });
    context.acknowledgePendingHelperResultPresented = async () => true;
    const callId = owner === "skill"
      ? "skill-load:own-skill-operation"
      : `own-${owner}-operation`;
    const call = owner === "skill"
      ? { kind: "skill-load", cmd: "load", skillId: "own-skill" }
      : context.parseCallPayload(createHelperBlock({ cmd: `printf OWN_${owner.toUpperCase()}` }));
    context.__ownPanelEntry = {
      callId,
      executionId: "",
      kind: owner === "skill" ? "skill-load" : "shell",
      call,
      response: { ok: true, exitCode: 0, stdout: "OWN" },
      reply: "own operation result",
      pageIdentity: context.getCurrentPageIdentity(),
      phase: "submitted",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempts: 1,
      lastError: ""
    };
    vm.runInContext(`
      pendingHelperDeliveries.set(globalThis.__ownPanelEntry.callId, globalThis.__ownPanelEntry);
    `, context);
    if (owner === "shell") {
      vm.runInContext(`
        activeCallId = globalThis.__ownPanelEntry.callId;
        activeCallToken = { callId: activeCallId, call: globalThis.__ownPanelEntry.call };
        panelShellHelperActive = true;
      `, context);
    } else if (owner === "skill") {
      vm.runInContext(`
        skillHelperInFlight = true;
        activeSkillHelperCallKey = "own-skill-operation";
      `, context);
    } else {
      vm.runInContext(`
        forceRunInFlight = true;
        activeForceRunCallId = globalThis.__ownPanelEntry.callId;
      `, context);
    }

    await context.performPendingHelperDeliveryFinalization(context.__ownPanelEntry, "submitted");
    assert.ok(statuses.length >= 1, `${owner} operation must be allowed to publish its own completion.`);
    assert.match(statuses.at(-1).text, owner === "skill" ? /Skill own-skill sent/ : /Shell helper completed/);
  }

  for (const kind of ["runnable", "skill"]) {
    const context = loadContentContext();
    const statuses = [];
    context.setStatus = (text, state) => statuses.push({ text, state });
    context.persistPendingHelperDeliveries = async () => {};
    context.__ownDiscardEntry = {
      callId: `own-${kind}-discard`,
      pageIdentity: context.getCurrentPageIdentity(),
      phase: "queued"
    };
    vm.runInContext(`
      pendingHelperDeliveries.set(globalThis.__ownDiscardEntry.callId, globalThis.__ownDiscardEntry);
    `, context);
    if (kind === "skill") {
      await context.discardStaleSkillPendingDelivery(context.__ownDiscardEntry);
    } else {
      await context.discardStaleRunnablePendingDelivery(context.__ownDiscardEntry);
    }
    assert.equal(statuses.length, 1, `${kind} discard must remain visible without a newer operation.`);
    assert.match(statuses[0].text, /Discarded a cached/);
  }
}

async function verifyManualSkillRejectionPublishesItsOwnCompletion() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  installPersistentLocalStorage(context);
  const helperText = [
    "ai-helper-skill-start:manual-invalid-skill",
    "cmd: load",
    "skill-id: example",
    "ai-helper-skill-end"
  ].join("\n");
  const turn = createStableChatGptRouteTurn(context, {
    userText: "Process this invalid Skill helper once.",
    helperText,
    userId: "manual-invalid-skill-user",
    assistantId: "manual-invalid-skill-assistant"
  });
  context.__manualInvalidSkillRoot = turn.root;
  context.document.body = turn.root;
  context.getConversationRoot = () => context.__manualInvalidSkillRoot;
  context.extractShellCallCandidates = () => [turn.candidate];
  const statuses = [];
  context.setStatus = (text, state) => statuses.push({ text, state });
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100,
    autoSend: true
  });
  context.acknowledgePendingHelperResultPresented = async () => true;
  context.attemptPendingHelperDelivery = async (entry) =>
    context.performPendingHelperDeliveryFinalization(entry, "submitted");
  context.schedulePendingHelperDeliveryRetry = () => {};
  context.scheduleScan = () => {};
  context.updateContextualPanelActions = () => {};
  vm.runInContext("extensionActive = true; observedPageIdentity = location.href;", context);

  assert.equal(await context.processLatestSkillRecovery({ forceDetected: true }), false);
  assert.equal(vm.runInContext("skillRecoveryInFlight", context), false);
  assert.equal(vm.runInContext("activeSkillHelperCallKey", context), "");
  assert.ok(statuses.length > 0);
  assert.equal(statuses.at(-1).state, "error",
    "A manual Skill rejection must publish its own terminal status instead of staying blue/running.");
  assert.match(statuses.at(-1).text, /Skill protocol error sent/);
}

async function verifyCancelledBatchCannotOverwriteNewPanelOperation() {
  for (const newerOwner of ["skill", "force"]) {
    const context = loadContentContext();
    const statuses = [];
    context.setStatus = (text, state) => statuses.push({ text, state });
    context.markPendingHelperCancellationBoundary = () => {};
    context.waitForPendingHelperSubmissionProof = async () => false;
    let persistStarted;
    let releasePersist;
    const persistObserved = new Promise((resolve) => {
      persistStarted = resolve;
    });
    const persistGate = new Promise((resolve) => {
      releasePersist = resolve;
    });
    context.persistPendingHelperDeliveries = async () => {
      persistStarted();
      await persistGate;
    };
    context.__cancelledOldEntry = {
      callId: "cancelled-old-entry",
      creationSequence: 1,
      cancellationBatchSequence: 1,
      pageIdentity: context.getCurrentPageIdentity(),
      phase: "inserted",
      kind: "shell",
      call: context.parseCallPayload(createHelperBlock({ cmd: "printf CANCEL_OLD" }))
    };
    vm.runInContext(`
      pendingHelperDeliveryCreationSequence = 1;
      pendingHelperDeliveries.set(globalThis.__cancelledOldEntry.callId, globalThis.__cancelledOldEntry);
    `, context);
    const cancellation = context.cancelPendingHelperDeliveryAfterComposerRemoval(
      context.__cancelledOldEntry
    );
    await persistObserved;
    if (newerOwner === "skill") {
      vm.runInContext(`
        skillHelperInFlight = true;
        activeSkillHelperCallKey = "new-skill-during-cancel";
      `, context);
    } else {
      vm.runInContext(`
        forceRunInFlight = true;
        activeForceRunCallId = "new-force-during-cancel";
      `, context);
    }
    statuses.push({ text: `Running: new ${newerOwner} during cancellation`, state: "running" });
    releasePersist();
    assert.equal(await cancellation, true);
    assert.deepEqual(statuses, [{
      text: `Running: new ${newerOwner} during cancellation`,
      state: "running"
    }]);
  }

  const context = loadContentContext();
  const statuses = [];
  context.setStatus = (text, state) => statuses.push({ text, state });
  context.markPendingHelperCancellationBoundary = () => {};
  context.waitForPendingHelperSubmissionProof = async () => false;
  context.persistPendingHelperDeliveries = async () => {};
  context.__visibleCancellationEntry = {
    callId: "visible-cancellation-entry",
    creationSequence: 1,
    cancellationBatchSequence: 1,
    pageIdentity: context.getCurrentPageIdentity(),
    phase: "inserted",
    kind: "shell",
    call: context.parseCallPayload(createHelperBlock({ cmd: "printf CANCEL_VISIBLE" }))
  };
  vm.runInContext(`
    pendingHelperDeliveryCreationSequence = 1;
    pendingHelperDeliveries.set(globalThis.__visibleCancellationEntry.callId, globalThis.__visibleCancellationEntry);
  `, context);
  assert.equal(await context.cancelPendingHelperDeliveryAfterComposerRemoval(
    context.__visibleCancellationEntry
  ), true);
  assert.equal(statuses.length, 1);
  assert.match(statuses[0].text, /were cancelled/);
}

async function verifyForceRejectedReplyKeepsStrictRouteBoundary() {
  for (const testCase of [
    { name: "same lifecycle", gate: "none", expectedReplies: 1 },
    { name: "route during auto-send settings", gate: "settings", expectedReplies: 0 },
    { name: "route during persistence", gate: "persist", expectedReplies: 0 }
  ]) {
    const context = loadContentContext();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    installPersistentLocalStorage(context);
    const helperText = [
      "ai-helper-file-start:force-rejected-route",
      "../unsafe-force.txt",
      "must stay in the force origin",
      "ai-helper-file-end"
    ].join("\n");
    const turn = createStableChatGptRouteTurn(context, {
      userText: "Force-check this invalid helper only in this chat.",
      helperText,
      userId: `force-rejected-user-${testCase.gate}`,
      assistantId: `force-rejected-assistant-${testCase.gate}`
    });
    context.__forceRejectedRoot = turn.root;
    context.__forceRejectedCandidate = turn.candidate;
    context.document.body = turn.root;
    context.getConversationRoot = () => context.__forceRejectedRoot;
    context.extractShellCallCandidates = () => context.__forceRejectedCandidate
      ? [context.__forceRejectedCandidate]
      : [];
    const forceSnapshot = context.createRenderedHelperCandidateSnapshot(turn.candidate);

    let settingsRequested;
    let releaseSettings;
    const settingsObserved = new Promise((resolve) => {
      settingsRequested = resolve;
    });
    const settingsGate = new Promise((resolve) => {
      releaseSettings = resolve;
    });
    let persistenceGate = null;
    if (testCase.gate === "persist") {
      persistenceGate = deferFirstLocalStorageSet(context);
    }
    let replies = 0;
    let runtimeCalls = 0;
    context.chrome.storage.sync.get = async (keys) => {
      if (Array.isArray(keys) && keys.includes("autoSend") && testCase.gate === "settings") {
        settingsRequested();
        return settingsGate;
      }
      return {
        enabled: true,
        enabledHosts: ["chatgpt.com"],
        maxChainCalls: 100,
        autoSend: true
      };
    };
    context.chrome.runtime.sendMessage = async () => {
      runtimeCalls += 1;
      return { ok: true };
    };
    context.attemptPendingHelperDelivery = async () => {
      replies += 1;
      return true;
    };
    context.schedulePendingHelperDeliveryRetry = () => {};
    context.scheduleScan = () => {};
    context.updateSiteActionButton = () => {};
    context.updateContextualPanelActions = () => {};
    context.setStatus = () => {};
    vm.runInContext(`
      extensionActive = true;
      observedPageIdentity = location.href;
      initialThreadSettled = true;
      lastThreadText = normalizeText(globalThis.__forceRejectedRoot.innerText || globalThis.__forceRejectedRoot.textContent || "");
      lastThreadTextAt = Date.now() - 5000;
    `, context);

    const scan = context.scanForShellCall({
      force: true,
      forceCandidateSnapshot: forceSnapshot
    });
    if (testCase.gate === "settings") {
      await settingsObserved;
    } else if (testCase.gate === "persist") {
      await persistenceGate.firstSetStarted;
    }
    if (testCase.gate !== "none") {
      setMockTreeConnected(turn.root, false);
      const replacement = createRoot([
        new MockNode({ order: 1, role: "user", text: "A replacement chat must not receive Force rejection output." })
      ]);
      replacement.isConnected = true;
      context.__forceRejectedRoot = replacement;
      context.__forceRejectedCandidate = null;
      context.document.body = replacement;
      context.location.pathname = `/c/force-rejected-${testCase.gate}`;
      context.location.href = `https://chatgpt.com${context.location.pathname}`;
      assert.equal(context.refreshPageLifecycle(), true);
      if (testCase.gate === "settings") {
        releaseSettings({ autoSend: true });
      } else {
        persistenceGate.releaseFirstSet();
      }
    }
    await scan;
    await vm.runInContext("pendingHelperDeliveryStorageTail", context);

    assert.equal(replies, testCase.expectedReplies,
      `${testCase.name}: Force rejection crossed its strict origin boundary.`);
    assert.equal(runtimeCalls, 0, "Rejected Force helpers must never reach a runtime backend.");
    if (testCase.expectedReplies === 0) {
      assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
    }
  }
}

async function verifyFirstResponseRouteAssignmentCarriesRuntimeStatusRecovery() {
  const cases = [
    {
      name: "shell",
      helperText: createHelperBlock({ cmd: "printf ROUTE_STATUS_SHELL_RESULT" }),
      runType: "run-shell",
      statusType: "run-shell-status",
      output: "ROUTE_STATUS_SHELL_RESULT",
      assignedPath: "/c/route-status-shell"
    },
    {
      name: "board",
      helperText: "ai-helper-board-start\nstatus\nai-helper-board-end",
      runType: "run-board",
      statusType: "run-board-status",
      output: "ROUTE_STATUS_BOARD_RESULT\nBOARD> ",
      assignedPath: "/uc/route-status-board"
    }
  ];

  for (const testCase of cases) {
    const context = loadContentContext();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    installPersistentLocalStorage(context);
    context.sleep = async () => {};

    const turn = createStableChatGptRouteTurn(context, {
      userText: `Recover the ${testCase.name} result after this new chat receives its permanent URL.`,
      helperText: testCase.helperText,
      userId: `route-status-${testCase.name}-user`,
      assistantId: `route-status-${testCase.name}-assistant`
    });
    context.document.body = turn.root;
    context.__routeStatusRoot = turn.root;
    context.__routeStatusCandidate = turn.candidate;
    context.getConversationRoot = () => context.__routeStatusRoot;
    context.extractShellCallCandidates = () => [context.__routeStatusCandidate];

    let runCount = 0;
    let statusCount = 0;
    let composerWrites = 0;
    let sendAttempts = 0;
    let receiptAttempts = 0;
    const submitted = [];
    const messageTypes = [];
    const composer = { innerText: "", textContent: "", isConnected: true };
    context.document.querySelectorAll = (selector) =>
      selector.includes("data-message-author-role") ? submitted : [];
    context.chrome.storage.sync.get = async () => ({
      enabled: true,
      enabledHosts: ["chatgpt.com"],
      maxChainCalls: 100,
      requireApproval: false,
      autoSend: true
    });
    context.chrome.runtime.sendMessage = async (payload) => {
      if (payload.type === "content-ui-delay") {
        return { ok: true };
      }
      if (payload.type === "run-result-presented") {
        receiptAttempts += 1;
        return { ok: true, found: true };
      }
      messageTypes.push(payload.type);
      if (payload.type === testCase.runType) {
        runCount += 1;
        context.location.pathname = testCase.assignedPath;
        context.location.href = `https://chatgpt.com${testCase.assignedPath}`;
        assert.equal(context.refreshPageLifecycle(), true);
        vm.runInContext("initialThreadSettled = true;", context);
        throw new Error("The message port closed before a response was received.");
      }
      assert.equal(payload.type, testCase.statusType);
      statusCount += 1;
      return {
        ok: true,
        found: true,
        state: "completed",
        result: {
          ok: true,
          executed: true,
          executionCompleted: true,
          executionId: testCase.name === "shell" ? "aaaabbbb00001111" : "ccccdddd22223333",
          exitCode: 0,
          stdout: testCase.output
        }
      };
    };
    context.insertReply = async (text) => {
      composerWrites += 1;
      composer.innerText = text;
      composer.textContent = text;
      return composer;
    };
    context.findReplyInput = async () => composer;
    context.clickSendWhenReady = async () => {
      sendAttempts += 1;
      const submittedRoot = new MockNode({ order: 3, role: "user", text: composer.innerText });
      submittedRoot.isConnected = true;
      submitted.push(submittedRoot);
      composer.innerText = "";
      composer.textContent = "";
      return true;
    };
    context.setStatus = () => {};
    context.scheduleScan = () => {};
    context.resetChainForNewHumanPrompt = () => {};
    context.updateSiteActionButton = () => {};
    vm.runInContext(`
      extensionActive = true;
      observedPageIdentity = location.href;
      initialThreadSettled = true;
      lastThreadText = normalizeText(globalThis.__routeStatusRoot.innerText || globalThis.__routeStatusRoot.textContent || "");
      lastThreadTextAt = Date.now() - 5000;
      const routeCandidate = globalThis.__routeStatusCandidate;
      const routeSemanticKey = buildSemanticCallKey(routeCandidate.call);
      liveGeneratedRenderedHelpers.set(
        getCandidateRenderRoot(routeCandidate),
        new Set([buildRenderedHelperKey(routeCandidate, routeSemanticKey)])
      );
    `, context);

    assert.ok(
      context.getLastShellCallCandidate(turn.root),
      `${testCase.name}: the route-status fixture must expose its helper through the production scanner.`
    );

    await context.scanForShellCall();
    await context.retryPendingHelperDeliveries();

    assert.equal(runCount, 1, `${testCase.name}: runtime recovery must never resubmit the helper.`);
    assert.equal(statusCount, 1, `${testCase.name}: the executed attempt must recover through status only.`);
    assert.deepEqual(messageTypes, [testCase.runType, testCase.statusType]);
    assert.equal(composerWrites, 1, `${testCase.name}: the recovered result must be written once.`);
    assert.equal(sendAttempts, 1, `${testCase.name}: the recovered result must be sent once.`);
    assert.equal(submitted.length, 1);
    assert.match(submitted[0].innerText, new RegExp(testCase.output.split("\n")[0]));
    assert.equal(receiptAttempts, 1, `${testCase.name}: presentation must be acknowledged once.`);
    assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
  }
}

async function verifyRuntimeStatusRecoveryCannotCrossInvalidRoute() {
  const cases = [
    {
      name: "shell transcript replacement",
      helperText: createHelperBlock({ cmd: "printf STALE_ROUTE_STATUS_SHELL" }),
      runType: "run-shell",
      statusType: "run-shell-status",
      replaceTranscript: true,
      expectedStatusCount: 0
    },
    {
      name: "board second route",
      helperText: "ai-helper-board-start\nstatus\nai-helper-board-end",
      runType: "run-board",
      statusType: "run-board-status",
      secondRoute: true,
      expectedStatusCount: 1
    }
  ];

  for (const testCase of cases) {
    const context = loadContentContext();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    installPersistentLocalStorage(context);
    context.sleep = async () => {};

    const turn = createStableChatGptRouteTurn(context, {
      userText: `Do not leak this ${testCase.name} result into another chat.`,
      helperText: testCase.helperText,
      userId: `invalid-route-status-${testCase.runType}-user`,
      assistantId: `invalid-route-status-${testCase.runType}-assistant`
    });
    context.document.body = turn.root;
    context.__invalidRouteStatusRoot = turn.root;
    context.__invalidRouteStatusCandidate = turn.candidate;
    context.getConversationRoot = () => context.__invalidRouteStatusRoot;
    context.extractShellCallCandidates = (root) =>
      root === context.__invalidRouteStatusRoot && root === turn.root
        ? [context.__invalidRouteStatusCandidate]
        : [];

    let runCount = 0;
    let statusCount = 0;
    let composerWrites = 0;
    let sendAttempts = 0;
    context.chrome.storage.sync.get = async () => ({
      enabled: true,
      enabledHosts: ["chatgpt.com"],
      maxChainCalls: 100,
      requireApproval: false,
      autoSend: true
    });
    context.chrome.runtime.sendMessage = async (payload) => {
      if (payload.type === "content-ui-delay") {
        return { ok: true };
      }
      if (payload.type === testCase.runType) {
        runCount += 1;
        if (testCase.replaceTranscript) {
          const replacement = createRoot([
            new MockNode({ order: 1, role: "user", text: "A different conversation now owns this page." })
          ]);
          replacement.isConnected = true;
          setMockTreeConnected(turn.root, false);
          context.__invalidRouteStatusRoot = replacement;
          context.document.body = replacement;
        }
        context.location.pathname = `/c/invalid-route-status-${testCase.runType}`;
        context.location.href = `https://chatgpt.com/c/invalid-route-status-${testCase.runType}`;
        assert.equal(context.refreshPageLifecycle(), true);
        vm.runInContext("initialThreadSettled = true;", context);
        throw new Error("The message channel closed before a response was received.");
      }
      if (payload.type === testCase.statusType) {
        statusCount += 1;
        if (testCase.secondRoute) {
          context.location.pathname = `/c/invalid-route-status-${testCase.runType}-second`;
          context.location.href = `https://chatgpt.com/c/invalid-route-status-${testCase.runType}-second`;
          assert.equal(context.refreshPageLifecycle(), true);
          vm.runInContext("initialThreadSettled = true;", context);
        }
        return {
          ok: true,
          found: true,
          state: "completed",
          result: { ok: true, exitCode: 0, stdout: "MUST_NOT_BE_DELIVERED" }
        };
      }
      return { ok: true };
    };
    context.insertReply = async () => {
      composerWrites += 1;
      return { innerText: "", textContent: "", isConnected: true };
    };
    context.clickSendWhenReady = async () => {
      sendAttempts += 1;
      return true;
    };
    context.setStatus = () => {};
    context.scheduleScan = () => {};
    context.resetChainForNewHumanPrompt = () => {};
    context.updateSiteActionButton = () => {};
    vm.runInContext(`
      extensionActive = true;
      observedPageIdentity = location.href;
      initialThreadSettled = true;
      lastThreadText = normalizeText(globalThis.__invalidRouteStatusRoot.innerText || globalThis.__invalidRouteStatusRoot.textContent || "");
      lastThreadTextAt = Date.now() - 5000;
      const routeCandidate = globalThis.__invalidRouteStatusCandidate;
      const routeSemanticKey = buildSemanticCallKey(routeCandidate.call);
      liveGeneratedRenderedHelpers.set(
        getCandidateRenderRoot(routeCandidate),
        new Set([buildRenderedHelperKey(routeCandidate, routeSemanticKey)])
      );
    `, context);

    await context.scanForShellCall();
    await context.retryPendingHelperDeliveries();

    assert.equal(runCount, 1, `${testCase.name}: an ambiguous completed attempt must never be resubmitted.`);
    assert.equal(statusCount, testCase.expectedStatusCount,
      `${testCase.name}: recovery must stop at the first lifecycle boundary around its status await.`);
    assert.equal(composerWrites, 0, `${testCase.name}: stale output must not enter the replacement composer.`);
    assert.equal(sendAttempts, 0, `${testCase.name}: stale output must not be submitted.`);
    assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
  }
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

async function verifyForceRuntimeRecoveryKeepsStrictRouteBoundary() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  context.sleep = async () => {};
  let runCount = 0;
  let statusCount = 0;
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "run-shell") {
      runCount += 1;
      context.location.pathname = "/c/force-must-not-follow-route";
      context.location.href = "https://chatgpt.com/c/force-must-not-follow-route";
      assert.equal(context.refreshPageLifecycle(), true);
      throw new Error("The message port closed before a response was received.");
    }
    if (payload.type === "run-shell-status") {
      statusCount += 1;
      return {
        ok: true,
        found: true,
        state: "completed",
        result: { ok: true, exitCode: 0, stdout: "FORCE_STALE_RESULT" }
      };
    }
    return { ok: true };
  };
  vm.runInContext(`
    extensionActive = true;
    observedPageIdentity = location.href;
    initialThreadSettled = true;
  `, context);

  const call = context.parseCallPayload(createHelperBlock({ cmd: "printf FORCE_STALE_RESULT" }));
  await assert.rejects(
    () => context.sendRunShellMessage("force-route-recovery", call, true, null),
    (error) => error?.helperRetryable === false && /page lifecycle changed/.test(error.message)
  );
  assert.equal(runCount, 1, "Force recovery must never resend the original helper.");
  assert.equal(statusCount, 0,
    "Force has no automatic candidate-bound route handoff and must retain the strict lifecycle snapshot.");
}

function deferFirstLocalStorageSet(context) {
  const originalSet = context.chrome.storage.local.set.bind(context.chrome.storage.local);
  let releaseFirstSet;
  let markFirstSetStarted;
  let setCount = 0;
  const firstSetStarted = new Promise((resolve) => {
    markFirstSetStarted = resolve;
  });
  const firstSetGate = new Promise((resolve) => {
    releaseFirstSet = resolve;
  });
  context.chrome.storage.local.set = async (values) => {
    setCount += 1;
    if (setCount === 1) {
      markFirstSetStarted();
      await firstSetGate;
    }
    return originalSet(values);
  };
  return {
    firstSetStarted,
    releaseFirstSet,
    getSetCount: () => setCount
  };
}

async function verifyRetainedRouteDuringPendingPersistenceQueuesOnce() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const backing = installPersistentLocalStorage(context);
  const storageGate = deferFirstLocalStorageSet(context);
  const helperText = createHelperBlock({ cmd: "printf PERSIST_ROUTE_RETAINED" });
  const turn = createStableChatGptRouteTurn(context, {
    userText: "Keep this result while persistence crosses the permanent route assignment.",
    helperText,
    userId: "persist-route-user",
    assistantId: "persist-route-assistant"
  });
  context.document.body = turn.root;
  context.__persistRouteRoot = turn.root;
  context.__persistRouteCandidate = turn.candidate;
  context.getConversationRoot = () => context.__persistRouteRoot;
  context.extractShellCallCandidates = () => [context.__persistRouteCandidate];

  let backendRuns = 0;
  let composerWrites = 0;
  let sendAttempts = 0;
  let receiptAttempts = 0;
  const submitted = [];
  const composer = { innerText: "", textContent: "", isConnected: true };
  context.document.querySelectorAll = (selector) =>
    selector.includes("data-message-author-role") ? submitted : [];
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100,
    requireApproval: false,
    autoSend: true
  });
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "content-ui-delay") return { ok: true };
    if (payload.type === "run-result-presented") {
      receiptAttempts += 1;
      return { ok: true, found: true };
    }
    assert.equal(payload.type, "run-shell");
    backendRuns += 1;
    return {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: "1111aaaa2222bbbb",
      exitCode: 0,
      stdout: "PERSIST_ROUTE_RETAINED"
    };
  };
  context.insertReply = async (text) => {
    composerWrites += 1;
    composer.innerText = text;
    composer.textContent = text;
    return composer;
  };
  context.findReplyInput = async () => composer;
  context.clickSendWhenReady = async () => {
    sendAttempts += 1;
    const submittedRoot = new MockNode({ order: 3, role: "user", text: composer.innerText });
    submittedRoot.isConnected = true;
    submitted.push(submittedRoot);
    composer.innerText = "";
    composer.textContent = "";
    return true;
  };
  context.setStatus = () => {};
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.updateSiteActionButton = () => {};
  vm.runInContext(`
    extensionActive = true;
    observedPageIdentity = location.href;
    initialThreadSettled = true;
    lastThreadText = normalizeText(globalThis.__persistRouteRoot.innerText || globalThis.__persistRouteRoot.textContent || "");
    lastThreadTextAt = Date.now() - 5000;
    const candidate = globalThis.__persistRouteCandidate;
    const semanticKey = buildSemanticCallKey(candidate.call);
    liveGeneratedRenderedHelpers.set(
      getCandidateRenderRoot(candidate),
      new Set([buildRenderedHelperKey(candidate, semanticKey)])
    );
  `, context);

  const scan = context.scanForShellCall();
  await storageGate.firstSetStarted;
  assert.equal(backendRuns, 1);
  assert.equal(vm.runInContext("Array.from(pendingHelperDeliveries.values())[0]?.attempts", context), 0,
    "The queued result must not begin composer work before its first durable write completes.");
  context.location.pathname = "/uc/persist-route-retained";
  context.location.href = "https://chatgpt.com/uc/persist-route-retained";
  assert.equal(context.refreshPageLifecycle(), true);
  vm.runInContext("initialThreadSettled = true;", context);
  storageGate.releaseFirstSet();
  await scan;
  await context.retryPendingHelperDeliveries();
  await waitForTestCondition(() => composerWrites === 1 && sendAttempts === 1 && receiptAttempts === 1 &&
    vm.runInContext("pendingHelperDeliveries.size", context) === 0);
  await vm.runInContext("pendingHelperDeliveryStorageTail", context);

  assert.equal(backendRuns, 1);
  assert.equal(composerWrites, 1, "A retained persisted result must be written exactly once.");
  assert.equal(sendAttempts, 1, "A retained persisted result must be sent exactly once.");
  assert.equal(receiptAttempts, 1);
  assert.equal(submitted.length, 1);
  assert.match(submitted[0].innerText, /PERSIST_ROUTE_RETAINED/);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
  assert.ok(storageGate.getSetCount() >= 1);
  assert.doesNotMatch(JSON.stringify(backing), /PERSIST_ROUTE_RETAINED/,
    "Finalization must remove the delivered result from persistent pending state.");
}

async function verifyInvalidRouteDuringPendingPersistenceCannotReviveOldEntry() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const backing = installPersistentLocalStorage(context);
  const storageGate = deferFirstLocalStorageSet(context);
  const helperText = createHelperBlock({ cmd: "printf STALE_PERSISTED_ROUTE_RESULT" });
  const turn = createStableChatGptRouteTurn(context, {
    userText: "Do not carry this result into a replacement transcript.",
    helperText,
    userId: "stale-persist-user",
    assistantId: "stale-persist-assistant"
  });
  context.document.body = turn.root;
  context.__stalePersistRoot = turn.root;
  context.__stalePersistCandidate = turn.candidate;
  context.getConversationRoot = () => context.__stalePersistRoot;
  context.extractShellCallCandidates = (root) => root === turn.root
    ? [context.__stalePersistCandidate]
    : [];

  let oldBackendRuns = 0;
  let newBackendRuns = 0;
  let resolveNewBackend;
  let composerWrites = 0;
  let sendAttempts = 0;
  const statuses = [];
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100,
    requireApproval: false,
    autoSend: true
  });
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type !== "run-shell") return { ok: true };
    if (payload.cmd.includes("STALE_PERSISTED_ROUTE_RESULT")) {
      oldBackendRuns += 1;
      return {
        ok: true,
        executed: true,
        executionCompleted: true,
        executionId: "3333cccc4444dddd",
        exitCode: 0,
        stdout: "STALE_PERSISTED_ROUTE_RESULT"
      };
    }
    newBackendRuns += 1;
    return new Promise((resolve) => {
      resolveNewBackend = resolve;
    });
  };
  context.insertReply = async () => {
    composerWrites += 1;
    return { innerText: "", textContent: "", isConnected: true };
  };
  context.clickSendWhenReady = async () => {
    sendAttempts += 1;
    return true;
  };
  context.setStatus = (text, state) => statuses.push({ text, state });
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.updateSiteActionButton = () => {};
  vm.runInContext(`
    extensionActive = true;
    observedPageIdentity = location.href;
    initialThreadSettled = true;
    lastThreadText = normalizeText(globalThis.__stalePersistRoot.innerText || globalThis.__stalePersistRoot.textContent || "");
    lastThreadTextAt = Date.now() - 5000;
    const candidate = globalThis.__stalePersistCandidate;
    const semanticKey = buildSemanticCallKey(candidate.call);
    liveGeneratedRenderedHelpers.set(
      getCandidateRenderRoot(candidate),
      new Set([buildRenderedHelperKey(candidate, semanticKey)])
    );
  `, context);

  const oldScan = context.scanForShellCall();
  await storageGate.firstSetStarted;
  const oldEntry = vm.runInContext("Array.from(pendingHelperDeliveries.values())[0]", context);
  assert.equal(oldEntry.attempts, 0);

  const replacement = createRoot([
    new MockNode({ order: 1, role: "user", text: "Replacement transcript owns this route." })
  ]);
  replacement.isConnected = true;
  setMockTreeConnected(turn.root, false);
  context.__stalePersistRoot = replacement;
  context.document.body = replacement;
  context.location.pathname = "/c/stale-persist-replacement";
  context.location.href = "https://chatgpt.com/c/stale-persist-replacement";
  assert.equal(context.refreshPageLifecycle(), true);
  vm.runInContext("initialThreadSettled = true;", context);

  const newCall = context.parseCallPayload(createHelperBlock({ cmd: "printf NEW_ACTIVE_ROUTE_CALL" }));
  const newRun = context.runAndReply("new-active-route-call", newCall);
  await waitForTestCondition(() => typeof resolveNewBackend === "function");
  assert.equal(vm.runInContext("activeCallId", context), "new-active-route-call");
  storageGate.releaseFirstSet();
  await oldScan;
  await vm.runInContext("pendingHelperDeliveryStorageTail", context);

  assert.equal(oldBackendRuns, 1);
  assert.equal(newBackendRuns, 1);
  assert.equal(oldEntry.attempts, 0, "The stale continuation must never start a delivery attempt.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0,
    "The stale entry must be removed precisely after its blocked persistence returns.");
  assert.doesNotMatch(JSON.stringify(backing), /STALE_PERSISTED_ROUTE_RESULT/,
    "The stale entry must be removed from persistent state as well as memory.");
  assert.equal(composerWrites, 0);
  assert.equal(sendAttempts, 0);
  assert.equal(vm.runInContext("activeCallId", context), "new-active-route-call",
    "Cleanup from the old continuation must not release the new active call.");
  assert.match(statuses.at(-1)?.text || "", /NEW_ACTIVE_ROUTE_CALL/,
    "Cleanup from the old continuation must not overwrite the new active status.");
  void newRun;
}

async function verifyForcePendingPersistenceKeepsStrictRouteBoundary() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  const backing = installPersistentLocalStorage(context);
  const storageGate = deferFirstLocalStorageSet(context);
  const helperText = createHelperBlock({ cmd: "printf FORCE_STALE_PERSISTED_RESULT" });
  const assistant = createAssistantMessage({ order: 1, text: helperText });
  const root = createRoot([assistant]);
  root.isConnected = true;
  assistant.isConnected = true;
  context.document.body = root;
  context.getConversationRoot = () => root;
  const candidate = context.getLastShellCallCandidate(root);
  const forceSnapshot = context.createRenderedHelperCandidateSnapshot(candidate);
  let backendRuns = 0;
  let composerWrites = 0;
  context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: true });
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type !== "run-shell") return { ok: true };
    backendRuns += 1;
    return {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: "5555eeee6666ffff",
      exitCode: 0,
      stdout: "FORCE_STALE_PERSISTED_RESULT"
    };
  };
  context.insertReply = async () => {
    composerWrites += 1;
    return { innerText: "", textContent: "", isConnected: true };
  };
  context.setStatus = () => {};
  context.updateSiteActionButton = () => {};
  vm.runInContext("extensionActive = true; observedPageIdentity = location.href; initialThreadSettled = true;", context);

  const forceRun = context.runAndReply("force-stale-persist", candidate.call, {
    force: true,
    forceCandidateSnapshot: forceSnapshot
  });
  await storageGate.firstSetStarted;
  const forceEntry = vm.runInContext("pendingHelperDeliveries.get('force-stale-persist')", context);
  assert.equal(forceEntry.attempts, 0);
  context.location.pathname = "/c/force-stale-persist";
  context.location.href = "https://chatgpt.com/c/force-stale-persist";
  assert.equal(context.refreshPageLifecycle(), true);
  storageGate.releaseFirstSet();
  await forceRun;
  await vm.runInContext("pendingHelperDeliveryStorageTail", context);

  assert.equal(backendRuns, 1);
  assert.equal(forceEntry.attempts, 0);
  assert.equal(composerWrites, 0);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
  assert.doesNotMatch(JSON.stringify(backing), /FORCE_STALE_PERSISTED_RESULT/);
}

async function verifyForceRejectedPersistenceKeepsStrictRouteBoundary() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  const backing = installPersistentLocalStorage(context);
  const storageGate = deferFirstLocalStorageSet(context);
  const helperText = [
    "ai-helper-file-start:force-rejected-persist",
    "../unsafe.txt",
    "must remain on the original route",
    "ai-helper-file-end"
  ].join("\n");
  const assistant = createAssistantMessage({ order: 1, text: helperText });
  const root = createRoot([assistant]);
  root.isConnected = true;
  assistant.isConnected = true;
  context.document.body = root;
  context.getConversationRoot = () => root;
  const candidate = context.getLastShellCallCandidate(root);
  assert.ok(candidate);
  const forceSnapshot = context.createRenderedHelperCandidateSnapshot(candidate);
  let composerWrites = 0;
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100,
    autoSend: true
  });
  context.chrome.runtime.sendMessage = async () => ({ ok: true });
  context.insertReply = async () => {
    composerWrites += 1;
    return { innerText: "", textContent: "", isConnected: true };
  };
  context.setStatus = () => {};
  context.scheduleScan = () => {};
  context.updateSiteActionButton = () => {};
  vm.runInContext("extensionActive = true; observedPageIdentity = location.href; initialThreadSettled = true;", context);

  const forceScan = context.scanForShellCall({
    force: true,
    forceCandidateSnapshot: forceSnapshot
  });
  await storageGate.firstSetStarted;
  const rejectedEntry = vm.runInContext("Array.from(pendingHelperDeliveries.values())[0]", context);
  assert.equal(rejectedEntry.attempts, 0);
  context.location.pathname = "/c/force-rejected-persist";
  context.location.href = "https://chatgpt.com/c/force-rejected-persist";
  assert.equal(context.refreshPageLifecycle(), true);
  storageGate.releaseFirstSet();
  await forceScan;
  await vm.runInContext("pendingHelperDeliveryStorageTail", context);

  assert.equal(rejectedEntry.attempts, 0,
    "A Force validation reply must not begin delivery after its strict route boundary changes.");
  assert.equal(composerWrites, 0);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
  assert.doesNotMatch(JSON.stringify(backing), /must remain on the original route/);
}

async function verifyStalePersistenceCleanupCannotDeleteReplacementIdentity() {
  const context = loadContentContext();
  await Promise.resolve();
  const backing = installPersistentLocalStorage(context);
  const storageGate = deferFirstLocalStorageSet(context);
  let lifecycleCurrent = true;
  const call = context.parseCallPayload(createHelperBlock({ cmd: "printf OLD_IDENTITY" }));
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);
  const remember = context.rememberPendingHelperDelivery(
    "shared-call-id",
    call,
    { ok: true, executionId: "7777aaaa8888bbbb", stdout: "OLD_IDENTITY" },
    "Shell call result:\n\nstdout:\nOLD_IDENTITY",
    { autoSend: true },
    { lifecycleGuard: () => lifecycleCurrent }
  );
  await storageGate.firstSetStarted;
  const oldEntry = vm.runInContext("pendingHelperDeliveries.get('shared-call-id')", context);
  const replacement = { ...oldEntry, reply: "Shell call result:\n\nstdout:\nNEW_IDENTITY" };
  context.__replacementPendingIdentity = replacement;
  vm.runInContext("pendingHelperDeliveries.set('shared-call-id', globalThis.__replacementPendingIdentity);", context);
  const replacementPersist = context.persistPendingHelperDeliveries();
  lifecycleCurrent = false;
  storageGate.releaseFirstSet();
  assert.equal(await remember, null);
  await replacementPersist;
  assert.equal(vm.runInContext("pendingHelperDeliveries.get('shared-call-id')", context), replacement,
    "A stale continuation may delete only the exact entry object it created.");
  const storedReplacement = Object.values(backing)
    .flatMap((snapshot) => Array.isArray(snapshot?.entries) ? snapshot.entries : [])
    .find((entry) => entry?.callId === "shared-call-id");
  assert.equal(storedReplacement?.reply, replacement.reply,
    "A stale cleanup must not overwrite the newer same-call identity's durable snapshot.");
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
    `extensionActive = true;
     beginPageLifecycle();
     initialThreadSettled = true;
     lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))};
     lastThreadTextAt = Date.now() - 2000;
     (() => {
       const candidate = extractShellCallCandidates(getConversationRoot()).at(-1);
       const semanticKey = buildSemanticCallKey(candidate.call);
       const renderRoot = getCandidateRenderRoot(candidate);
       liveGeneratedRenderedHelpers.set(renderRoot, new Set([buildRenderedHelperKey(candidate, semanticKey)]));
     })();`,
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

function markLatestHelperLive(context) {
  vm.runInContext(`(() => {
    const candidate = extractShellCallCandidates(getConversationRoot()).at(-1);
    const semanticKey = buildSemanticCallKey(candidate.call);
    const renderRoot = getCandidateRenderRoot(candidate);
    liveGeneratedRenderedHelpers.set(renderRoot, new Set([buildRenderedHelperKey(candidate, semanticKey)]));
  })();`, context);
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
  markLatestHelperLive(context);

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
  markLatestHelperLive(context);
  await context.scanForShellCall();

  const replacementMessage = createAssistantMessage({ order: 1, text: createHelperBlock({ cmd }) });
  root = createRoot([replacementMessage]);
  context.document.body = root;
  vm.runInContext(`extensionActive = true; activeCallId = ''; lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))}; lastThreadTextAt = Date.now() - 2000;`, context);
  markLatestHelperLive(context);
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
  markLatestHelperLive(context);

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
  markLatestHelperLive(context);

  await context.scanForShellCall();
  assert.equal(runCalls.length, 1);

  const secondMessage = createAssistantMessage({
    order: 2,
    text: createHelperBlock({ cmd })
  });
  root = createRoot([firstMessage, secondMessage]);
  context.document.body = root;
  vm.runInContext(`extensionActive = true; activeCallId = ''; lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))}; lastThreadTextAt = Date.now() - 2000;`, context);
  markLatestHelperLive(context);

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

async function verifySubmittedMessageMatchingPreservesLineBoundaries() {
  const context = loadContentContext();
  const originalText = "Shell call result:\r\n\r\nstdout:\u00a0a b";
  const submitted = [];
  context.document.querySelectorAll = (selector) =>
    selector.includes('data-message-author-role="user"') ? submitted : [];

  submitted.push(new MockNode({
    text: "User\nShell call result:\n\n\nstdout: a b",
    role: "user",
    order: 2
  }));
  assert.equal(
    context.countSubmittedMessagesMatching(originalText),
    1,
    "CRLF, NBSP, and empty-paragraph count are the only tolerated whole-message DOM normalizations."
  );

  submitted[0] = {
    innerText: "User\nShell call result: stdout: a b",
    textContent: `User${originalText}`,
    getAttribute: (name) => name === "data-message-author-role" ? "user" : "",
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

  const fencedText = [
    "Shell call result:",
    "",
    "```shell-output",
    "$ printf rendered-proof",
    "executionId: 0011223344556677",
    "",
    "stdout:",
    "rendered proof",
    "```"
  ].join("\n");
  const renderedCode = [
    "$ printf rendered-proof",
    "executionId: 0011223344556677",
    "",
    "stdout:",
    "rendered proof"
  ].join("\n");
  submitted[0] = {
    innerText: `You\nShell call result:\nshell-output\n${renderedCode}\nShow more`,
    textContent: `You\nShell call result:\nshell-output\n${renderedCode}\nShow more`,
    getAttribute: (name) => name === "data-message-author-role" ? "user" : "",
    querySelector: () => ({ textContent: "You" }),
    querySelectorAll: (selector) => selector.includes("code") ? [{ textContent: renderedCode }] : []
  };
  assert.equal(
    context.countSubmittedMessagesMatching(fencedText),
    1,
    "A chat-rendered fenced shell-output block must prove exact submission even when the host exposes its language label and Show more UI text."
  );
  submitted[0].querySelectorAll = () => [{ textContent: renderedCode.replace("rendered proof", "different output") }];
  assert.equal(
    context.countSubmittedMessagesMatching(fencedText),
    0,
    "Rendered code-block submission proof still requires the complete exact fenced payload."
  );

  context.location.hostname = "m365.cloud.microsoft";
  const m365Flattened = fencedText.replace(/\n/g, "");
  const m365UserMessage = {
    className: "fai-UserMessage",
    innerText: `You said:\n${m365Flattened}\n`,
    textContent: `You said:\n${m365Flattened}\n`,
    getAttribute: () => "",
    matches: (selector) => selector === '.fai-UserMessage[role="article"]',
    querySelector: () => ({ textContent: "You said:" }),
    querySelectorAll: () => []
  };
  context.document.querySelectorAll = () => [m365UserMessage];
  assert.equal(
    context.countSubmittedMessagesMatching(fencedText),
    1,
    "M365 may flatten a structured plugin delivery after submission; the exact fresh root and complete flattened payload still prove presentation."
  );
  const m365EquivalentStructuredLayout = fencedText.replace(
    "stdout:\nrendered proof",
    "stdout:rendered\n proof"
  );
  assert.equal(m365EquivalentStructuredLayout.replace(/\n/g, ""), m365Flattened);
  assert.equal(
    context.countSubmittedMessagesMatching(m365EquivalentStructuredLayout),
    1,
    "M365 irreversibly erases structured line boundaries, so this host equivalence is safe only as a fresh before/after count inside the plugin-owned delivery lifecycle."
  );
  m365UserMessage.innerText = `You said:\n${m365Flattened.replace("rendered proof", "changed proof")}\n`;
  m365UserMessage.textContent = m365UserMessage.innerText;
  assert.equal(
    context.countSubmittedMessagesMatching(fencedText),
    0,
    "M365 submission proof must still reject any non-formatting payload change."
  );
  for (const changed of [
    `prefix${m365Flattened}`,
    `${m365Flattened}suffix`,
    m365Flattened.replace("stdout:", "stdout: "),
    ` ${m365Flattened}`,
    `${m365Flattened} `,
    `\t${m365Flattened}`,
    `${m365Flattened}\t`
  ]) {
    m365UserMessage.innerText = `You said:\n${changed}`;
    m365UserMessage.textContent = m365UserMessage.innerText;
    assert.equal(
      context.countSubmittedMessagesMatching(fencedText),
      0,
      "M365 submission proof requires complete whole-message equality without extra prefix, suffix, or whitespace."
    );
  }
  const m365CopilotMessage = {
    ...m365UserMessage,
    className: "fai-CopilotMessage",
    innerText: `Copilot said:\n${m365Flattened}\n`,
    textContent: `Copilot said:\n${m365Flattened}\n`,
    matches: () => false,
    querySelector: () => ({ textContent: "Copilot said:" })
  };
  context.document.querySelectorAll = () => [m365CopilotMessage];
  assert.equal(
    context.countSubmittedMessagesMatching(fencedText),
    0,
    "An M365 Copilot response must never be accepted as a submitted user message."
  );
  for (const ordinaryNode of [
    { ...m365UserMessage, matches: () => false },
    { ...m365UserMessage, matches: (selector) => selector === ".fai-UserMessage" }
  ]) {
    ordinaryNode.innerText = `You said:\n${m365Flattened}\n`;
    ordinaryNode.textContent = ordinaryNode.innerText;
    context.document.querySelectorAll = () => [ordinaryNode];
    assert.equal(
      context.countSubmittedMessagesMatching(fencedText),
      0,
      "A generic article or M365-looking node without both the exact class and article role is not submission proof."
    );
  }
  m365UserMessage.innerText = "You said:\na\nbc\n";
  m365UserMessage.textContent = m365UserMessage.innerText;
  context.document.querySelectorAll = () => [m365UserMessage];
  assert.equal(
    context.countSubmittedMessagesMatching("ab\nc"),
    0,
    "M365 submission proof must not collapse distinct newline layouts into the same flattened string."
  );
}

async function verifyCompletionStatusSurvivesHandledRescan() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  const panelChild = new FakeElement();
  panelChild.closest = (selector) => selector === "#ai-chat-shell-exec-status" ? panelChild : null;
  assert.equal(
    context.isShellToolPanelMutation({ target: panelChild }),
    true,
    "Mutations produced by the extension panel must be filtered before they can schedule a helper rescan."
  );
  const pageElement = new FakeElement();
  pageElement.closest = () => null;
  assert.equal(
    context.isShellToolPanelMutation({ target: pageElement }),
    false,
    "Ordinary page mutations must remain observable."
  );
  const command = "printf terminal-panel-status";
  const message = createAssistantMessage({
    order: 1,
    text: createHelperBlock({ cmd: command })
  });
  const root = createRoot([message]);
  context.document.body = root;
  context.getConversationRoot = () => root;
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100
  });
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.updateSiteActionButton = () => {};

  const panel = {
    dataset: {},
    querySelector: () => null
  };
  const statusText = {
    textContent: "",
    ariaLabel: "",
    setAttribute(name, value) {
      if (name === "aria-label") {
        this.ariaLabel = value;
      }
    }
  };
  const statusDetail = { textContent: "" };
  const indicator = { style: {} };
  const elements = new Map([
    ["ai-chat-shell-exec-status", panel],
    ["ai-chat-shell-exec-status-text", statusText],
    ["ai-chat-shell-exec-status-detail", statusDetail],
    ["ai-chat-shell-exec-status-indicator", indicator]
  ]);
  context.document.getElementById = (id) => elements.get(id) || null;

  const [candidate] = context.extractShellCallCandidates(root);
  assert.ok(candidate, "The terminal-status fixture must expose one shell helper.");
  const semanticCallKey = context.buildSemanticCallKey(candidate.call);
  const callKey = context.buildCandidateCallKey(candidate, semanticCallKey);
  context.markCallProcessed(candidate, callKey, semanticCallKey);

  vm.runInContext(
    `extensionActive = true; activeCallId = ''; initialThreadSettled = true; lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))}; lastThreadTextAt = Date.now() - 2000;`,
    context
  );
  context.setHelperCompletionStatus(candidate.call, {
    ok: true,
    executed: true,
    executionCompleted: true,
    executionId: "1010101010101010",
    exitCode: 0,
    stdout: "terminal-panel-status"
  });
  assert.match(statusText.textContent, /Shell helper completed/);

  await context.scanForShellCall();

  assert.match(
    statusText.textContent,
    /Shell helper completed/,
    "A benign observer rescan of the already-handled source helper must preserve terminal completion."
  );
  assert.doesNotMatch(statusText.textContent, /Already handled this helper block/);
  assert.equal(panel.dataset.state, "ok");
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

async function verifyNonPersistentResultRetriesSendOnly() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  installPersistentLocalStorage(context);
  context.setTimeout = () => 1;
  context.clearTimeout = () => {};
  context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: true });
  context.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);
  const call = context.parseCallPayload([
    "ai-helper-file-start",
    "send-only-retry.txt",
    "write once and retry only sending",
    "ai-helper-file-end"
  ].join("\n"));
  let backendAttempts = 0;
  let insertAttempts = 0;
  let sendAttempts = 0;
  const submitted = [];
  const composer = { innerText: "", textContent: "", isConnected: true };
  context.document.querySelectorAll = (selector) =>
    selector.includes('data-message-author-role="user"') ? submitted : [];
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "content-ui-delay") {
      return { ok: true };
    }
    assert.equal(payload.type, "write-file");
    backendAttempts += 1;
    return {
      ok: true,
      filename: "send-only-retry.txt",
      path: "/tmp/send-only-retry.txt",
      bytes: 33
    };
  };
  context.insertReply = async (text) => {
    insertAttempts += 1;
    composer.innerText = text;
    composer.textContent = text;
    return composer;
  };
  context.findReplyInput = async () => composer;
  context.clickSendWhenReady = async () => {
    sendAttempts += 1;
    if (sendAttempts >= 2) {
      submitted.push(new MockNode({
        text: context.getComposerText(composer),
        role: "user",
        order: 2
      }));
      composer.innerText = "";
      composer.textContent = "";
    }
    return sendAttempts >= 2;
  };

  const first = await context.runAndReply("file-send-only-retry", call);
  assert.equal(first.pendingDelivery, true, "A file result whose first send attempt fails must remain in local delivery.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 1);
  assert.equal(vm.runInContext("Array.from(pendingHelperDeliveries.values())[0].phase", context), "inserted");
  vm.runInContext("extensionActive = true;", context);
  await context.retryPendingHelperDeliveries();

  assert.equal(backendAttempts, 1, "Send retry must never execute the file helper again.");
  assert.equal(insertAttempts, 1, "Send retry must never write the file result again.");
  assert.equal(sendAttempts, 2, "The queue retries only sending while exact ownership remains.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
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
  const submitted = [];
  context.document.querySelectorAll = (selector) =>
    selector.includes('data-message-author-role="user"') ? submitted : [];
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "content-ui-delay") {
      return { ok: true };
    }
    if (payload.type === "run-result-presented") {
      messages.push(payload);
      return { ok: true };
    }
    assert.equal(payload.type, "run-shell");
    messages.push(payload);
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
    if (sendAttempts > 1) {
      submitted.push(new MockNode({
        text: context.getComposerText(composer),
        role: "user",
        order: 2
      }));
      composer.innerText = "";
      composer.textContent = "";
    }
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
  assert.equal(messages.filter((payload) => payload.type === "run-shell").length, 1, "Retrying the same rendered helper must remain local.");
  assert.equal(insertAttempts, 1, "Once helper output is in the composer, send retries must not write it again.");
  assert.equal(sendAttempts, 2, "The same page lifecycle may make a bounded send-only retry.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
  assert.ok(messages.some((payload) => payload.type === "run-result-presented"));
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
    if (payload.type === "content-ui-delay") {
      return { ok: true };
    }
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
  pendingEntry.userCancellationObserved = true;
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

async function verifyHostClearedComposerFinalizesDelayedSubmissionBeforeCancellation() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  installPersistentLocalStorage(context);
  context.setTimeout = () => 1;
  context.clearTimeout = () => {};
  context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: true });
  const submitted = [];
  let receiptCount = 0;
  context.document.querySelectorAll = (selector) =>
    selector.includes('data-message-author-role="user"') ? submitted : [];
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "content-ui-delay") {
      return { ok: true };
    }
    if (payload.type === "run-result-presented") {
      receiptCount += 1;
      return { ok: true, found: true, matched: 1 };
    }
    assert.equal(payload.type, "run-shell");
    return {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: "c001d00dc001d00d",
      exitCode: 0,
      stdout: "host-cleared submitted output"
    };
  };
  const composer = { innerText: "", textContent: "", isConnected: true };
  let insertedReply = "";
  context.insertReply = async (text) => {
    insertedReply = text;
    composer.innerText = text;
    composer.textContent = text;
    return composer;
  };
  context.findReplyInput = async () => composer;
  context.clickSendWhenReady = async () => false;
  context.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);
  const call = context.parseCallPayload(createHelperBlock({ cmd: "printf host-cleared-submitted" }));

  const first = await context.runAndReply("host-cleared-submitted", call);
  assert.equal(first.pendingDelivery, true);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 1);

  // Chat hosts may clear the owned composer before their submitted-message
  // DOM is visible. The exact new user message is proof of submission, not a
  // user cancellation, so the pending entry must finalize and send a receipt.
  composer.innerText = "";
  composer.textContent = "";
  const pendingEntry = vm.runInContext("Array.from(pendingHelperDeliveries.values())[0]", context);
  const stillWaiting = await context.attemptPendingHelperDelivery(pendingEntry, { autoSend: true });
  assert.equal(stillWaiting, false);
  assert.equal(pendingEntry.phase, "submitted-unconfirmed");
  submitted.push(new MockNode({
    text: insertedReply,
    role: "user",
    order: 2
  }));
  const finalized = await context.attemptPendingHelperDelivery(pendingEntry, { autoSend: true });

  assert.equal(finalized, true);
  assert.equal(receiptCount, 1, "A delayed exact submission must produce the canonical presentation receipt.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
}

async function verifyM365SubmittedResultProducesOnePresentationReceipt() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  installPersistentLocalStorage(context);
  context.setTimeout = () => 1;
  context.clearTimeout = () => {};
  context.location.href = "https://m365.cloud.microsoft/chat/conversation/receipt-test";
  context.location.hostname = "m365.cloud.microsoft";
  context.location.origin = "https://m365.cloud.microsoft";
  context.location.pathname = "/chat/conversation/receipt-test";

  const reply = [
    "Shell call result:",
    "",
    "```shell-output",
    "$ printf m365-receipt",
    "executionId: abcdefabcdefabcd",
    "stdout:",
    "m365-receipt",
    "```"
  ].join("\n");
  const makeUserMessage = () => ({
    innerText: `You said:\n${reply.replace(/\n/g, "")}\n`,
    textContent: `You said:\n${reply.replace(/\n/g, "")}\n`,
    getAttribute: () => "",
    matches: (selector) => selector === '.fai-UserMessage[role="article"]',
    querySelector: () => ({ textContent: "You said:" }),
    querySelectorAll: () => []
  });
  const submittedRoots = [makeUserMessage()];
  context.document.querySelectorAll = (selector) =>
    selector.includes(".fai-UserMessage") ? submittedRoots : [];

  const composer = new context.Element();
  composer.innerText = "";
  composer.textContent = "";
  composer.isConnected = true;
  composer.isContentEditable = true;
  composer.getAttribute = (name) => ({
    role: "textbox",
    contenteditable: "true",
    "aria-label": "Message Copilot"
  })[name] || "";
  composer.querySelector = (selector) => selector === '[aria-hidden="true"][data-lexical-text="true"]'
    ? { textContent: "\u200b\u200c" }
    : null;
  composer.getBoundingClientRect = () => ({ width: 700, height: 100 });
  composer.closest = () => null;
  context.insertReply = async (text) => {
    assert.equal(text, reply);
    composer.innerText = `${text.replace(/\n/g, "")}\u200b\u200c`;
    composer.textContent = composer.innerText;
    return composer;
  };
  context.findReplyInput = async () => composer;
  context.clickSendWhenReady = async () => {
    submittedRoots.push(makeUserMessage());
    composer.innerText = "";
    composer.textContent = "";
    return true;
  };
  let receiptCount = 0;
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "run-result-presented") {
      receiptCount += 1;
      assert.equal(payload.executionId, "abcdefabcdefabcd");
      return { ok: true, found: true, matched: 1 };
    }
    if (payload.type === "content-ui-delay") {
      return { ok: true };
    }
    throw new Error(`Unexpected runtime message: ${payload.type}`);
  };
  context.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);
  assert.equal(context.countSubmittedMessagesMatching(reply), 1);

  const call = context.parseCallPayload(createHelperBlock({ cmd: "printf m365-receipt" }));
  const entry = await context.rememberPendingHelperDelivery(
    "m365-receipt-call",
    call,
    {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: "abcdefabcdefabcd",
      exitCode: 0,
      stdout: "m365-receipt"
    },
    reply,
    { autoSend: true }
  );
  assert.equal(entry.submittedMessageCountBefore, 1, "Existing identical history is only a baseline, not fresh submission proof.");

  const delivered = await context.attemptPendingHelperDelivery(entry, { autoSend: true });
  assert.equal(delivered, true);
  assert.equal(context.countSubmittedMessagesMatching(reply), 2);
  assert.equal(receiptCount, 1, "Only the newly added M365 user message produces one presentation receipt.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
  await context.retryPendingHelperDeliveries();
  assert.equal(receiptCount, 1, "A completed M365 delivery must not send the receipt twice.");
}

async function verifyM365ClearedComposerWithoutSubmittedRootStaysUnpresented() {
  const context = loadContentContext();
  await Promise.resolve();
  await Promise.resolve();
  installPersistentLocalStorage(context);
  context.setTimeout = () => 1;
  context.clearTimeout = () => {};
  context.location.href = "https://m365.cloud.microsoft/chat/conversation/no-submit-proof";
  context.location.hostname = "m365.cloud.microsoft";
  context.location.origin = "https://m365.cloud.microsoft";
  context.location.pathname = "/chat/conversation/no-submit-proof";
  context.document.querySelectorAll = () => [];
  context.chrome.storage.sync.get = async () => ({ requireApproval: false, autoSend: true });

  const composer = new context.Element();
  composer.innerText = "";
  composer.textContent = "";
  composer.isConnected = true;
  composer.isContentEditable = true;
  composer.getAttribute = (name) => ({
    role: "textbox",
    contenteditable: "true",
    "aria-label": "Message Copilot"
  })[name] || "";
  composer.querySelector = (selector) => selector === '[aria-hidden="true"][data-lexical-text="true"]'
    ? { textContent: "\u200b\u200c" }
    : null;
  composer.getBoundingClientRect = () => ({ width: 700, height: 100 });
  composer.closest = () => null;
  let insertedReply = "";
  context.insertReply = async (text) => {
    insertedReply = text;
    composer.innerText = `${text.replace(/\n/g, "")}\u200b\u200c`;
    composer.textContent = composer.innerText;
    return composer;
  };
  context.findReplyInput = async () => composer;
  context.clickSendWhenReady = async () => {
    composer.innerText = "";
    composer.textContent = "";
    return true;
  };

  let receiptCount = 0;
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "content-ui-delay") {
      return { ok: true };
    }
    if (payload.type === "run-result-presented") {
      receiptCount += 1;
      return { ok: true, found: true, matched: 1 };
    }
    assert.equal(payload.type, "run-shell");
    return {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: "0123456789abcdef",
      exitCode: 0,
      stdout: "no-submit-proof"
    };
  };
  context.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);
  const call = context.parseCallPayload(createHelperBlock({ cmd: "printf no-submit-proof" }));

  const outcome = await context.runAndReply("m365-no-submit-proof", call);
  assert.equal(outcome.pendingDelivery, true);
  assert.match(insertedReply, /no-submit-proof/);
  assert.equal(receiptCount, 0, "A cleared M365 composer without a new exact user-message root must never emit a presentation receipt.");
  assert.equal(vm.runInContext("locallyPresentedHelperExecutions.size", context), 0);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 1);
  assert.equal(
    vm.runInContext("Array.from(pendingHelperDeliveries.values())[0].phase", context),
    "submitted-unconfirmed",
    "The canonical result remains pending without rewriting or regaining send authority."
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
  const restoredSubmitted = [];
  restoredContext.document.querySelectorAll = (selector) =>
    selector.includes('data-message-author-role="user"') ? restoredSubmitted : [];
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
  assert.ok(!restoredMessages.some((payload) => payload.type === "run-result-presented"));
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", restoredContext), 1);

  restoredSubmitted.push(new MockNode({
    text: inserted[0],
    role: "user",
    order: 2
  }));
  await restoredContext.retryPendingHelperDeliveries();
  assert.ok(
    restoredMessages.some((payload) => payload.type === "run-result-presented" && payload.executionId === "1122334455667788"),
    vm.runInContext(`JSON.stringify({
      matching: getSubmittedMessageRootsMatching(Array.from(pendingHelperDeliveries.values())[0]?.reply || "").length,
      pending: Array.from(pendingHelperDeliveries.values()).map((entry) => ({
        phase: entry.phase,
        countBefore: entry.submittedMessageCountBefore,
        rootIdsBefore: entry.submittedMessageRootIdsBefore,
        hasProof: hasPendingHelperSubmissionProof(entry)
      }))
    })`, restoredContext)
  );
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
  let submittedCount = 0;
  const inserted = [];
  context.countSubmittedMessagesMatching = () => submittedCount;
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
  assert.equal(first.pendingDelivery, true);
  assert.equal(inserted.length, 1);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 1);
  assert.equal(receiptCount, 0, "Insertion with auto-send disabled is not presentation proof.");

  submittedCount = 1;
  const manuallySubmittedEntry = vm.runInContext("Array.from(pendingHelperDeliveries.values())[0]", context);
  await context.attemptPendingHelperDelivery(manuallySubmittedEntry, { autoSend: false });
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 1, "A failed receipt must remain durably pending after exact manual submission.");
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
  markLatestHelperLive(context);
  await context.scanForShellCall();
  assert.equal(backendRuns, 1);

  const secondMessage = createAssistantMessage({ order: 2, text: createHelperBlock({ cmd }) });
  root = createRoot([firstMessage, secondMessage]);
  context.document.body = root;
  vm.runInContext(`extensionActive = true; initialThreadSettled = true; lastThreadText = ${JSON.stringify(context.normalizeText(root.innerText))}; lastThreadTextAt = Date.now() - 2000;`, context);
  markLatestHelperLive(context);
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
  markLatestHelperLive(context);

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
  let submittedCount = 0;
  context.countSubmittedMessagesMatching = () => submittedCount;
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
  assert.ok(!messages.some((payload) => payload.type === "run-result-presented"));
  submittedCount = 1;
  const recoveredEntry = vm.runInContext("Array.from(pendingHelperDeliveries.values())[0]", context);
  await context.attemptPendingHelperDelivery(recoveredEntry, { autoSend: false });
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

async function verifyM365LexicalFlatteningKeepsOriginalSendActuator() {
  const context = loadContentContext();
  const intended = [
    "Shell call result:",
    "",
    "```shell-output",
    "$ printf m365-owned",
    "stdout:",
    "m365-owned",
    "```"
  ].join("\n");
  const composer = new context.Element();
  composer.innerText = `${intended.replace(/\n/g, "")}\u200b\u200c`;
  composer.textContent = composer.innerText;
  composer.isConnected = true;
  composer.isContentEditable = true;
  composer.getAttribute = (name) => ({
    role: "textbox",
    contenteditable: "true",
    "aria-label": "Message Copilot"
  })[name] || "";
  composer.querySelector = (selector) => selector === '[aria-hidden="true"][data-lexical-text="true"]'
    ? { textContent: "\u200b\u200c" }
    : null;
  composer.getBoundingClientRect = () => ({ width: 700, height: 100 });
  composer.closest = () => null;

  context.location.href = "https://m365.cloud.microsoft/chat/conversation/test";
  context.location.hostname = "m365.cloud.microsoft";
  context.location.origin = "https://m365.cloud.microsoft";
  context.location.pathname = "/chat/conversation/test";
  context.findReplyInput = async () => composer;
  composer.innerText = "\n";
  composer.textContent = "";
  composer.querySelector = () => null;
  assert.equal(
    context.hasPreexistingComposerContent(composer),
    false,
    "M365's real empty Lexical shape (<p><br></p>, innerText newline, empty textContent, no sentinel) remains writable."
  );
  composer.querySelector = (selector) => selector === '[aria-hidden="true"][data-lexical-text="true"]'
    ? { textContent: "\u200b\u200c" }
    : null;
  composer.innerText = `${intended.replace(/\n/g, "")}\u200b\u200c`;
  composer.textContent = composer.innerText;
  await assert.rejects(
    () => context.insertReply(intended, { preserveExisting: true }),
    (error) => error?.code === "composer-occupied"
  );
  composer.innerText = " \t\u00a0\u200b\u200c";
  composer.textContent = composer.innerText;
  await assert.rejects(
    () => context.insertReply(intended, { preserveExisting: true }),
    (error) => error?.code === "composer-occupied"
  );
  composer.innerText = `${intended.replace(/\n/g, "")}\u200b\u200c`;
  composer.textContent = composer.innerText;
  assert.equal(
    context.getValidatedComposerOwnershipText(composer, intended),
    "",
    "A pre-existing flattened M365 user draft is never reusable without post-write ownership proof."
  );
  assert.equal(
    context.getValidatedComposerOwnershipText(composer, intended, { allowM365HostNormalization: true }),
    composer.innerText,
    "Post-write delivery may explicitly accept M365's exact host normalization."
  );

  const originalHostname = context.location.hostname;
  context.location.hostname = "example.com";
  assert.equal(
    context.getValidatedComposerOwnershipText(composer, intended, { allowM365HostNormalization: true }),
    ""
  );
  context.location.hostname = originalHostname;
  const originalGetAttribute = composer.getAttribute;
  composer.getAttribute = (name) => name === "aria-label" ? "Nachricht an Copilot" : originalGetAttribute(name);
  assert.equal(
    context.getValidatedComposerOwnershipText(composer, intended, { allowM365HostNormalization: true }),
    composer.innerText,
    "M365 may localize its composer label; exact node shape, sentinel, and full payload remain the ownership proof."
  );
  composer.getAttribute = (name) => name === "aria-label" ? "Search chats" : originalGetAttribute(name);
  assert.equal(
    context.getValidatedComposerOwnershipText(composer, intended, { allowM365HostNormalization: true }),
    "",
    "A generic M365 textbox label without Copilot must not acquire flattened composer ownership."
  );
  composer.getAttribute = originalGetAttribute;
  const originalQuerySelector = composer.querySelector;
  composer.querySelector = () => null;
  assert.equal(
    context.getValidatedComposerOwnershipText(composer, intended, { allowM365HostNormalization: true }),
    ""
  );
  composer.querySelector = originalQuerySelector;
  composer.innerText = `${intended.replace(/\n/g, "")}\u200d`;
  composer.textContent = composer.innerText;
  assert.equal(
    context.getValidatedComposerOwnershipText(composer, intended, { allowM365HostNormalization: true }),
    "",
    "A semantic ZWJ must not be swallowed as the M365 caret sentinel."
  );
  composer.innerText = `${intended.replace(/\n/g, "")}\u200b\u200c`;
  composer.textContent = composer.innerText;

  context.insertReply = async () => composer;
  let submittedCount = 0;
  context.countSubmittedMessagesMatching = () => submittedCount;
  let sendCalls = 0;
  context.clickSendWhenReady = async (ownedComposer) => {
    sendCalls += 1;
    assert.equal(ownedComposer, composer);
    submittedCount = 1;
    return true;
  };
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);

  assert.equal(
    context.getValidatedComposerOwnershipText(composer, intended, { allowM365HostNormalization: true }),
    composer.innerText,
    "M365's exact Lexical newline flattening remains the plugin-owned text."
  );
  assert.equal(
    context.contentEditableHasText(composer, intended),
    true,
    "M365's exact newline-only Lexical projection remains a complete insertion."
  );
  const intendedCatalog = [
    "Local SKILLS catalog synchronization response:",
    "",
    "````skill-output",
    "{",
    '  "catalogSha": "abc",',
    '  "skills": []',
    "}",
    "````"
  ].join("\n");
  assert.equal(
    context.getHostCompatibleComposerInsertionText(intendedCatalog),
    intendedCatalog.replace(/\n/g, ""),
    "M365 must write a known structured catalog in the exact newline-free form the host will submit."
  );
  assert.match(context.getHostCompatibleComposerInsertionText(intendedCatalog), /skill-output\{/,
    "Pre-flattening must preserve every JSON brace instead of accepting host corruption.");
  assert.equal(
    context.getHostCompatibleComposerInsertionText("ordinary\nuser text"),
    "ordinary\nuser text",
    "M365 host projection must never flatten arbitrary text."
  );
  composer.innerText = `${intendedCatalog.replace(/\n/g, "").replace("{", "").replace("}", "")}\u200b\u200c`;
  composer.textContent = composer.innerText;
  assert.equal(
    context.contentEditableHasText(composer, intendedCatalog),
    false,
    "A prefix-matching M365 insertion with stripped JSON braces must fall through to the exact DOM replacement path."
  );
  composer.innerText = `${intended.replace(/\n/g, "")}\u200b\u200c`;
  composer.textContent = composer.innerText;
  context.location.hostname = "example.com";
  assert.equal(
    context.getHostCompatibleComposerInsertionText(intendedCatalog),
    intendedCatalog,
    "Other hosts must retain the original multiline composer payload."
  );
  context.location.hostname = "m365.cloud.microsoft";
  const delivered = await context.deliverHelperReply({
    pageIdentity: context.getCurrentPageIdentity(),
    generation: vm.runInContext("pageLifecycleGeneration", context),
    phase: "response-received"
  }, intended, { autoSend: true });
  assert.equal(delivered, true, "The unchanged v0.8.9 actuator must still run on M365's host-normalized composer text.");
  assert.equal(sendCalls, 1);

  for (const changed of [
    ` ${intended.replace(/\n/g, "")}\u200b\u200c`,
    `\t${intended.replace(/\n/g, "")}\u200b\u200c`,
    `${intended.replace(/\n/g, "")} \u200b\u200c`,
    `${intended.replace(/\n/g, "")}\t\u200b\u200c`
  ]) {
    composer.innerText = changed;
    composer.textContent = changed;
    assert.equal(
      context.getValidatedComposerOwnershipText(composer, intended, { allowM365HostNormalization: true }),
      "",
      "M365 composer ownership must preserve every non-newline character, including leading and trailing spaces or tabs."
    );
  }

  composer.innerText = `${intended.replace(/\n/g, "")}\u200b\u200c`;
  composer.textContent = composer.innerText;
  composer.innerText = composer.innerText.replace("m365-owned", "user-changed");
  composer.textContent = composer.innerText;
  assert.equal(
    context.getValidatedComposerOwnershipText(composer, intended, { allowM365HostNormalization: true }),
    "",
    "Any non-formatting user change must revoke M365 composer ownership."
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
  let submittedCount = 0;
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);
  context.countSubmittedMessagesMatching = () => submittedCount;
  context.insertReply = async () => oldComposer;
  context.findReplyInput = async () => replacementComposer;
  context.clickSendWhenReady = async (composer) => {
    sendComposer = composer;
    const sent = composer === replacementComposer &&
      context.getValidatedComposerOwnershipText(composer, intended) === intended;
    if (sent) {
      submittedCount = 1;
    }
    return sent;
  };

  const delivered = await context.deliverHelperReply({
    pageIdentity: context.getCurrentPageIdentity(),
    generation: vm.runInContext("pageLifecycleGeneration", context),
    phase: "response-received"
  }, intended, { autoSend: true });

  assert.equal(delivered, true, "A page redraw that preserves exact plugin-owned text must still auto-send.");
  assert.equal(sendComposer, replacementComposer, "Auto-send must reacquire the connected composer instead of using the detached writer node.");
}

async function verifyTrackedTextareaUpdatesHostState() {
  const context = loadContentContext();
  context.Event = class Event {};
  context.chrome.storage.local.set = async () => {};
  Object.defineProperty(context.HTMLTextAreaElement.prototype, "value", {
    configurable: true,
    get() {
      return this._value || "";
    },
    set(value) {
      this._value = String(value);
    }
  });

  const composer = new context.HTMLTextAreaElement();
  composer.id = "tracked-composer";
  composer.isConnected = true;
  composer.getBoundingClientRect = () => ({ width: 600, height: 48 });
  let trackedValue = "";
  let hostEditorState = "";
  Object.defineProperty(composer, "value", {
    configurable: true,
    get() {
      return this._value || "";
    },
    set(value) {
      this._value = String(value);
      trackedValue = this._value;
    }
  });
  composer.focus = () => {};
  composer.dispatchEvent = () => {
    if (trackedValue !== composer._value) {
      hostEditorState = composer._value;
      trackedValue = composer._value;
    }
    return true;
  };
  context.findReplyInput = async () => composer;

  const intended = "Shell call result:\n\nstdout:\ntracked textarea";
  const returned = await context.insertReply(intended, { preserveExisting: true });

  assert.equal(returned, composer);
  assert.equal(composer.value, intended);
  assert.equal(
    hostEditorState,
    intended,
    "The native textarea setter must bypass a framework value tracker so the input event updates host editor state."
  );
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

  composer.value = " \t\u00a0";
  await assert.rejects(
    () => context.insertReply("Shell call result:\nstdout:\nwhitespace draft", { preserveExisting: true }),
    (error) => error?.code === "composer-occupied"
  );
  assert.equal(composer.value, " \t\u00a0", "Whitespace-only textarea content remains user-owned and untouched.");
  assert.equal(focusCount, 0);
  assert.equal(mutationCount, 0);

  composer.value = "Shell call result:\r\n\r\n\r\nstdout:\r\nreplayed\u00a0output";
  await assert.rejects(
    () => context.insertReply(
      "Shell call result:\n\nstdout:\nreplayed output",
      { preserveExisting: true }
    ),
    (error) => error?.code === "composer-occupied"
  );
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
  assert.equal(clickCount, 1, "A pre-existing exact-text draft is never adopted or sent by a new queued delivery.");
}

verifyForceRunUsesLatestHelper()
  .then(() => verifyDebugPanelUpdates())
  .then(() => verifyFrontendDoesNotDedupCommands())
  .then(() => verifyHiddenStopButtonDoesNotBlockHelperScan())
  .then(() => verifyUnexpectedHelperCancelsSelfTestAndRuns())
  .then(() => verifyPendingAgentDeliveryDefersWithoutConsumingHelper())
  .then(() => verifyPendingAgentDeliveryDefersSkillWithoutConsumingHelper())
  .then(() => verifyRetryableAttemptDoesNotConsumeSameRenderedHelper())
  .then(() => verifyStaleLongCallCannotAffectNewPageCall())
  .then(() => verifyFirstResponseRouteAssignmentCarriesInFlightShellResult())
  .then(() => verifyInFlightShellResultCannotCrossRouteAfterTranscriptReplacement())
  .then(() => verifySettingsAwaitRouteAdjudication())
  .then(() => verifyRouteRedrawDuringSettingsAwaitIsSingleFlight())
  .then(() => verifyRejectedHelperRouteSettingsGuard())
  .then(() => verifyPreparingDispatchStorageFailureReleasesForNewRootRetry())
  .then(() => verifyChangedRouteClaimUsesExactTokenRelease())
  .then(() => verifyTrustedForceCannotBypassPreparingDispatchClaim())
  .then(() => verifyCachedPendingLoadAwaitCannotCrossRoute())
  .then(() => verifyDeferredProfileDispatchRouteGuards())
  .then(() => verifyForceDeferredProfileDispatchRouteGuards())
  .then(() => verifyOuterSettingsAwaitRouteReconciliation())
  .then(() => verifySkillBackendRouteHandoffRejectsSecondPermanentRoute())
  .then(() => verifyManualForceDispatchWinsOuterScanRace())
  .then(() => verifyManualSkillRecoveryWinsOuterScanRace())
  .then(() => verifyStaleShellCompletionCannotClearNewActiveUi())
  .then(() => verifyStaleSkillReporterCannotOverwriteNewRunnableStatus())
  .then(() => verifyShellProgressUsesExactActiveCallAfterProfileAwait())
  .then(() => verifyOldFinalizationCannotOverwriteNewRunnableStatus())
  .then(() => verifyStaleDiscardCannotOverwriteNewRunnableStatus())
  .then(() => verifyCurrentPanelOperationMayPublishItsOwnCompletion())
  .then(() => verifyManualSkillRejectionPublishesItsOwnCompletion())
  .then(() => verifyCancelledBatchCannotOverwriteNewPanelOperation())
  .then(() => verifyForceRejectedReplyKeepsStrictRouteBoundary())
  .then(() => verifyFirstResponseRouteAssignmentCarriesRuntimeStatusRecovery())
  .then(() => verifyRuntimeStatusRecoveryCannotCrossInvalidRoute())
  .then(() => verifyRuntimeChannelCloseRecoversByStatusOnly())
  .then(() => verifyForceRuntimeRecoveryKeepsStrictRouteBoundary())
  .then(() => verifyRetainedRouteDuringPendingPersistenceQueuesOnce())
  .then(() => verifyInvalidRouteDuringPendingPersistenceCannotReviveOldEntry())
  .then(() => verifyForcePendingPersistenceKeepsStrictRouteBoundary())
  .then(() => verifyForceRejectedPersistenceKeepsStrictRouteBoundary())
  .then(() => verifyStalePersistenceCleanupCannotDeleteReplacementIdentity())
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
  .then(() => verifySubmittedMessageMatchingPreservesLineBoundaries())
  .then(() => verifyCompletionStatusSurvivesHandledRescan())
  .then(() => verifyAutoSendDoesNotHoldExecutionLock())
  .then(() => verifyBackendResponsesRetryOnlyLocalDelivery())
  .then(() => verifyNonShellComposerWritesNeverReexecuteRenderedHelpers())
  .then(() => verifyNonPersistentResultRetriesSendOnly())
  .then(() => verifySameRenderedPendingResultRetriesLocallyOnly())
  .then(() => verifyDeletedPendingResultCancelsAutomaticComposerDelivery())
  .then(() => verifyHostClearedComposerFinalizesDelayedSubmissionBeforeCancellation())
  .then(() => verifyM365SubmittedResultProducesOnePresentationReceipt())
  .then(() => verifyM365ClearedComposerWithoutSubmittedRootStaysUnpresented())
  .then(() => verifyPendingResultRestoresAcrossSamePageReload())
  .then(() => verifyPresentationReceiptRetriesWithoutDuplicateInsertion())
  .then(() => verifyCanonicalExecutionCoalescesPendingDeliveries())
  .then(() => verifyNewRenderRootCanRunWhileOldReplyIsPending())
  .then(() => verifyAuthoritativeDuplicateStaysLocal())
  .then(() => verifyDuplicateConsumesOnlySameRenderedHelper())
  .then(() => verifyUnpresentedDuplicateRecoversCleanResult())
  .then(() => verifyRejectedHelperUsesComposerLeaseAndPreservesDraft())
  .then(() => verifyComposerDeliveryLeaseSerializesWriters())
  .then(() => verifyUnrelatedPostInsertionDraftIsNeverAdopted())
  .then(() => verifyM365LexicalFlatteningKeepsOriginalSendActuator())
  .then(() => verifyHelperSendReacquiresRedrawnOwnedComposer())
  .then(() => verifyTrackedTextareaUpdatesHostState())
  .then(() => verifyInsertReplyPreservesExistingComposerAtomically())
  .then(() => verifyLaterHelperCannotOverwriteUnsentEarlierOutput())
  .then(() => {
    console.log("content last-shell-call candidate tests passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
