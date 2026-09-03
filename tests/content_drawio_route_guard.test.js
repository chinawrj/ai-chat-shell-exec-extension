#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeElement {}

class MockNode extends FakeElement {
  constructor({ text = "", role = "", order = 0, children = [] } = {}) {
    super();
    this.innerText = text;
    this.textContent = text;
    this.role = role;
    this.order = order;
    this.children = children;
    this.parentElement = null;
    this.isConnected = true;
    for (const child of children) {
      child.parentElement = this;
    }
  }

  getAttribute(name) {
    return name === "data-message-author-role" ? this.role : "";
  }

  matches() { return false; }

  closest(selector) {
    if (/\[data-message-author-role\]|\[data-message-role\]|article/.test(String(selector))) {
      return this.role ? this : this.parentElement?.closest?.(selector) || null;
    }
    return this.parentElement?.closest?.(selector) || null;
  }

  contains(node) {
    return this.children.includes(node) || this.children.some((child) => child.contains?.(node));
  }

  querySelectorAll() { return this.children; }

  compareDocumentPosition(other) {
    return this.order < other.order ? 4 : this.order > other.order ? 2 : 0;
  }

  getBoundingClientRect() { return { width: 640, height: 240 }; }
}

function drawioXml(name) {
  return `<mxfile><diagram name="${name}"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>`;
}

function drawioHelper(name, identity = "route-drawio") {
  return [
    `ai-helper-drawio-start:${identity}`,
    drawioXml(name),
    "ai-helper-drawio-end"
  ].join("\n");
}

function loadContext() {
  const backing = {};
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const preview = {
    validateDrawioXml: () => ({ ok: true }),
    hashDrawioXml: (xml) => `artifact-${String(xml).length}`,
    consider: () => Promise.resolve({ ok: true }),
    reportInvalid: ({ artifactId, error }) => ({
      ok: false,
      newError: true,
      artifactId,
      error
    }),
    getDiagnostics: () => ({ state: "idle", errors: [] }),
    resetForPage() {},
    reopen: () => false
  };
  const context = {
    URL,
    AiChatDrawioPreview: preview,
    CSS: { escape: String },
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLButtonElement: class extends FakeElement {},
    HTMLInputElement: class extends FakeElement {},
    HTMLTextAreaElement: class extends FakeElement {},
    InputEvent: class {},
    MutationObserver: class { observe() {} disconnect() {} },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
    chrome: {
      runtime: {
        id: "lkmeogidbglhedgekjgbpbfjkpapnhke",
        sendMessage: async () => ({ ok: true, found: true })
      },
      storage: {
        onChanged: { addListener() {} },
        sync: { get: async () => ({ enabled: false }) },
        local: {
          async get(keys) {
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              if (Object.prototype.hasOwnProperty.call(backing, key)) {
                result[key] = clone(backing[key]);
              }
            }
            return result;
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
        }
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
    setTimeout: () => 1,
    window: {
      confirm: () => true,
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      addEventListener() {},
      removeEventListener() {}
    }
  };
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "extension", "src", "content.js"), "utf8"),
    context,
    { filename: "content.js" }
  );
  return { context, preview, backing };
}

function createStableChatGptTurn(context, name = "Route guard") {
  const helperText = drawioHelper(name);
  const userText = `Render ${name}`;
  const userCopy = new MockNode({ text: userText, order: 1 });
  const user = new MockNode({ text: userText, role: "user", order: 1, children: [userCopy] });
  const assistantContent = new MockNode({ text: helperText, order: 2 });
  const assistant = new MockNode({ text: helperText, role: "assistant", order: 2, children: [assistantContent] });
  const root = new MockNode({ text: `${userText}\n${helperText}`, children: [user, assistant] });

  function installMessageContract(node, role, id) {
    node.getAttribute = (attribute) => {
      if (attribute === "data-message-role" || attribute === "data-message-author-role") return role;
      if (attribute === "data-message-id") return id;
      return "";
    };
    node.matches = (selector) => String(selector).includes(`li[data-message-role="${role}"]`);
    node.closest = (selector) => node.matches(selector)
      ? node
      : node.parentElement?.closest?.(selector) || null;
  }
  installMessageContract(user, "user", `${name}-user`);
  installMessageContract(assistant, "assistant", `${name}-assistant`);
  userCopy.matches = (selector) => String(selector).includes("data-user-message-copy");
  userCopy.closest = (selector) => userCopy.matches(selector) ? userCopy : user.closest(selector);
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
    if (value.includes("data-user-message-copy")) matches.push(userCopy);
    if (value.includes("data-assistant-markdown")) matches.push(assistantContent);
    return matches.length > 0 ? Array.from(new Set(matches)) : [user, userCopy, assistant, assistantContent];
  };
  const candidate = {
    call: context.parseCallPayload(helperText),
    node: assistant,
    textRoot: assistantContent,
    source: "plain-text-block",
    blockIndex: 0
  };
  return { root, user, assistant, assistantContent, candidate };
}

function setTreeConnected(node, connected) {
  node.isConnected = connected;
  for (const child of node.children || []) setTreeConnected(child, connected);
}

async function settleContext(context) {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  vm.runInContext("extensionActive = true; observedPageIdentity = location.href; initialThreadSettled = true;", context);
}

function installTurn(context, turn) {
  context.document.body = turn.root;
  context.__drawioRoot = turn.root;
  context.__drawioCandidate = turn.candidate;
  context.getConversationRoot = () => context.__drawioRoot;
  context.extractShellCallCandidates = () => [context.__drawioCandidate];
}

function navigate(context, pathname) {
  context.location.pathname = pathname;
  context.location.href = `https://chatgpt.com${pathname}`;
  assert.equal(context.refreshPageLifecycle(), true);
  vm.runInContext("initialThreadSettled = true;", context);
}

function replaceTranscript(context, turn, pathname) {
  setTreeConnected(turn.root, false);
  const replacement = new MockNode({
    text: "A different conversation owns this page",
    children: [new MockNode({ text: "different", role: "user", order: 1 })]
  });
  context.__drawioRoot = replacement;
  context.document.body = replacement;
  context.extractShellCallCandidates = () => [];
  navigate(context, pathname);
}

function createDeferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function deferFirstStorageSet(context) {
  const original = context.chrome.storage.local.set.bind(context.chrome.storage.local);
  const gate = createDeferred();
  const started = createDeferred();
  let count = 0;
  context.chrome.storage.local.set = async (values) => {
    count += 1;
    if (count === 1) {
      started.resolve();
      await gate.promise;
    }
    return original(values);
  };
  return { started: started.promise, release: gate.resolve, count: () => count };
}

function installSuccessfulDelivery(context) {
  const composer = { innerText: "", textContent: "", isConnected: true };
  const submitted = [];
  let writes = 0;
  let sends = 0;
  context.document.querySelectorAll = (selector) =>
    String(selector).includes("data-message-author-role") ? submitted : [];
  context.insertReply = async (text) => {
    writes += 1;
    composer.innerText = text;
    composer.textContent = text;
    return composer;
  };
  context.findReplyInput = async () => composer;
  context.clickSendWhenReady = async () => {
    sends += 1;
    submitted.push(new MockNode({ text: composer.innerText, role: "user", order: 10 + sends }));
    composer.innerText = "";
    composer.textContent = "";
    return true;
  };
  context.setStatus = () => {};
  return { writes: () => writes, sends: () => sends };
}

function errorResult(context, candidate) {
  return {
    ok: false,
    newError: true,
    artifactId: context.AiChatDrawioPreview.hashDrawioXml(candidate.call.xml),
    error: "renderer timed out"
  };
}

async function verifySettingsAwaitGuardsSamePageAndReplacement() {
  for (const replace of [false, true]) {
    const { context } = loadContext();
    await settleContext(context);
    const turn = createStableChatGptTurn(context, replace ? "settings-stale" : "settings-current");
    installTurn(context, turn);
    const delivery = installSuccessfulDelivery(context);
    const settings = createDeferred();
    const requested = createDeferred();
    context.chrome.storage.sync.get = async () => {
      requested.resolve();
      return settings.promise;
    };
    const dispatchContext = context.createDrawioDispatchContext(turn.candidate);
    const queued = context.queueDrawioErrorReply(turn.candidate, errorResult(context, turn.candidate), dispatchContext);
    await requested.promise;
    if (replace) replaceTranscript(context, turn, "/c/settings-replacement");
    settings.resolve({ autoSend: true, maxChainCalls: 100 });
    assert.equal(await queued, !replace);
    assert.equal(delivery.writes(), replace ? 0 : 1);
    assert.equal(delivery.sends(), replace ? 0 : 1);
    assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
  }
}

async function verifyPersistenceAwaitGuardsSamePageAndSecondRoute() {
  for (const secondRoute of [false, true]) {
    const { context } = loadContext();
    await settleContext(context);
    const startPath = secondRoute ? "/c/origin" : "/c/current";
    context.location.pathname = startPath;
    context.location.href = `https://chatgpt.com${startPath}`;
    vm.runInContext("observedPageIdentity = location.href;", context);
    const turn = createStableChatGptTurn(context, secondRoute ? "persist-stale" : "persist-current");
    installTurn(context, turn);
    const delivery = installSuccessfulDelivery(context);
    context.chrome.storage.sync.get = async () => ({ autoSend: true, maxChainCalls: 100 });
    const storage = deferFirstStorageSet(context);
    const dispatchContext = context.createDrawioDispatchContext(turn.candidate);
    const queued = context.queueDrawioErrorReply(turn.candidate, errorResult(context, turn.candidate), dispatchContext);
    await storage.started;
    if (secondRoute) navigate(context, "/c/other-conversation");
    storage.release();
    assert.equal(await queued, !secondRoute);
    await Promise.resolve();
    assert.equal(delivery.writes(), secondRoute ? 0 : 1);
    assert.equal(delivery.sends(), secondRoute ? 0 : 1);
    assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
  }
}

async function verifyProvisionalRoutePersistenceHandoffDeliversOnce() {
  const { context } = loadContext();
  await settleContext(context);
  const turn = createStableChatGptTurn(context, "provisional-retained");
  installTurn(context, turn);
  const delivery = installSuccessfulDelivery(context);
  context.chrome.storage.sync.get = async () => ({ autoSend: true, maxChainCalls: 100 });
  const storage = deferFirstStorageSet(context);
  const dispatchContext = context.createDrawioDispatchContext(turn.candidate);
  const queued = context.queueDrawioErrorReply(turn.candidate, errorResult(context, turn.candidate), dispatchContext);
  await storage.started;
  navigate(context, "/uc/assigned-drawio-chat");
  storage.release();
  assert.equal(await queued, true);
  await Promise.resolve();
  assert.equal(delivery.writes(), 1);
  assert.equal(delivery.sends(), 1);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
  assert.equal(dispatchContext.routeHandoffCount, 1);
}

async function verifyRenderCompletionCannotCrossRoute() {
  for (const testCase of [
    { name: "same-page", nextPath: "", expect: 1 },
    { name: "retained-provisional", nextPath: "/c/render-assigned", expect: 1 },
    { name: "second-permanent", startPath: "/c/render-origin", nextPath: "/c/render-other", expect: 0 },
    { name: "replacement", nextPath: "/c/render-replacement", replace: true, expect: 0 }
  ]) {
    const { context, preview } = loadContext();
    await settleContext(context);
    const startPath = testCase.startPath || "/";
    context.location.pathname = startPath;
    context.location.href = `https://chatgpt.com${startPath}`;
    vm.runInContext("observedPageIdentity = location.href;", context);
    const turn = createStableChatGptTurn(context, `render-${testCase.name}`);
    installTurn(context, turn);
    const render = createDeferred();
    preview.consider = () => render.promise;
    let panelUpdates = 0;
    let queues = 0;
    context.updateDrawioPanelStatus = () => { panelUpdates += 1; };
    context.queueDrawioErrorReply = async () => { queues += 1; return true; };
    context.processLatestDrawioCandidates([turn.candidate]);
    if (testCase.replace) {
      replaceTranscript(context, turn, testCase.nextPath);
    } else if (testCase.nextPath) {
      navigate(context, testCase.nextPath);
    }
    render.resolve({
      ok: false,
      newError: true,
      artifactId: preview.hashDrawioXml(turn.candidate.call.xml),
      error: "late renderer failure"
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(panelUpdates, testCase.expect, `${testCase.name}: stale render completion panel ownership mismatch`);
    assert.equal(queues, testCase.expect, `${testCase.name}: stale render error queue ownership mismatch`);
  }
}

verifySettingsAwaitGuardsSamePageAndReplacement()
  .then(() => verifyPersistenceAwaitGuardsSamePageAndSecondRoute())
  .then(() => verifyProvisionalRoutePersistenceHandoffDeliversOnce())
  .then(() => verifyRenderCompletionCannotCrossRoute())
  .then(() => console.log("content drawio route guard tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
