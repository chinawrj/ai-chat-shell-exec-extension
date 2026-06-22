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
  vm.runInContext(`extensionActive = true; activeCallId = ''; initialThreadSettled = true; lastThreadText = ${JSON.stringify(root.innerText)}; lastThreadTextAt = Date.now() - 2000;`, context);

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
  vm.runInContext(`extensionActive = true; activeCallId = ''; initialThreadSettled = true; lastThreadText = ${JSON.stringify(root.innerText)}; lastThreadTextAt = Date.now() - 2000;`, context);

  await context.scanForShellCall({ force: true });

  assert.ok(getElementByIdCalls.includes("ai-chat-shell-exec-debug-body"), "getElementById should be called with DEBUG_BODY_ID");
  assert.ok(debugBody.textContent.includes("--- cmd / content (first 800 chars) ---"), `debug body should contain cmd/content header`);
  assert.ok(debugBody.textContent.includes(cmd), `debug body should contain the cmd '${cmd}'`);
}

async function verifyRepeatableAgentQueriesBypassSemanticDedup() {
  const context = loadContentContext();
  const roster = context.parseCallPayload(createAgentRosterBlock());
  const rosterSemanticKey = context.buildSemanticCallKey(roster);
  vm.runInContext(`processedSemanticCalls.add(${JSON.stringify(rosterSemanticKey)});`, context);
  assert.equal(
    context.getDuplicateHelperDedupReason({ node: new context.Element() }, "new-roster-call", rosterSemanticKey, roster),
    ""
  );

  const status = context.parseCallPayload(createAgentTaskStatusBlock());
  const statusSemanticKey = context.buildSemanticCallKey(status);
  vm.runInContext(`processedSemanticCalls.add(${JSON.stringify(statusSemanticKey)});`, context);
  assert.equal(
    context.getDuplicateHelperDedupReason({ node: new context.Element() }, "new-status-call", statusSemanticKey, status),
    ""
  );

  const shell = context.parseCallPayload(createHelperBlock({ cmd: "pwd" }));
  const shellSemanticKey = context.buildSemanticCallKey(shell);
  vm.runInContext(`processedSemanticCalls.add(${JSON.stringify(shellSemanticKey)});`, context);
  assert.equal(
    context.getDuplicateHelperDedupReason({ node: new context.Element() }, "new-shell-call", shellSemanticKey, shell),
    "processed semantic key"
  );

  assert.equal(
    context.getDuplicateHelperDedupReason({ node: new context.Element() }, "same-roster-call", rosterSemanticKey, roster),
    ""
  );
  vm.runInContext("processedCalls.add('same-roster-call');", context);
  assert.equal(
    context.getDuplicateHelperDedupReason({ node: new context.Element() }, "same-roster-call", rosterSemanticKey, roster),
    "processed callKey"
  );
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

verifyForceRunUsesLatestHelper()
  .then(() => verifyDebugPanelUpdates())
  .then(() => verifyRepeatableAgentQueriesBypassSemanticDedup())
  .then(() => verifyDebugPanelUpdatesDuringStreaming())
  .then(() => verifyDebugPanelUpdatesWhileActiveCallRunning())
  .then(() => verifyForceRunPersistsWhileActiveCallRunning())
  .then(() => verifyDebugPanelListsAllCandidates())
  .then(() => {
    console.log("content last-shell-call candidate tests passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
