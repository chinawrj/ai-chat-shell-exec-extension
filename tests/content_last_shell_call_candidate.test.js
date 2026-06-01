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

function createHelperBlock({ target = "%24", cmd }) {
  return [
    "ai-helper-shell-start",
    target,
    cmd,
    "ai-helper-shell-end"
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
  assert.equal(candidate.call.target, "%24");
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
  const runCalls = [];
  context.getConversationRoot = () => root;
  context.updateSiteActionButton = () => {};
  context.setStatus = () => {};
  context.scheduleScan = () => {};
  context.resetChainForNewHumanPrompt = () => {};
  context.runAndReply = async (callId, call, options) => {
    runCalls.push({ callId, call, options });
  };
  vm.runInContext("extensionActive = true; activeCallId = ''; initialThreadSettled = true;", context);

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
    text: createHelperBlock({ target: "%24", cmd })
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
  vm.runInContext("extensionActive = true; activeCallId = ''; initialThreadSettled = true;", context);

  await context.scanForShellCall({ force: true });

  assert.ok(getElementByIdCalls.includes("ai-chat-shell-exec-debug-body"), "getElementById should be called with DEBUG_BODY_ID");
  assert.ok(debugBody.textContent.includes("target:"), `debug body should contain 'target:' but got: ${debugBody.textContent}`);
  assert.ok(debugBody.textContent.includes("--- cmd / content (first 800 chars) ---"), `debug body should contain cmd/content header`);
  assert.ok(debugBody.textContent.includes(cmd), `debug body should contain the cmd '${cmd}'`);
}

verifyForceRunUsesLatestHelper()
  .then(() => verifyDebugPanelUpdates())
  .then(() => {
    console.log("content last-shell-call candidate tests passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
