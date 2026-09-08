#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeElement {
  constructor() { this.children = []; this.style = {}; this.isConnected = true; this.listeners = {}; }
  get childNodes() { return this.children; }
  get classList() { return { contains: (name) => this.className === name }; }
  attachShadow() { this.shadowRoot = new FakeElement(); return this.shadowRoot; }
  appendChild(child) { this.children.push(child); child.parentElement = this; return child; }
  insertBefore(child, before) {
    const index = this.children.indexOf(before);
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    child.parentElement = this;
  }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  remove() { this.isConnected = false; this.parentElement.children = this.parentElement.children.filter((c) => c !== this); }
}

class MockNode extends FakeElement {
  constructor(text = "", order = 1, role = "assistant") {
    super();
    this.innerText = text;
    this.textContent = text;
    this.order = order;
    this.role = role;
    this.parentElement = null;
  }

  closest(selector) { return selector === "pre" ? null : this; }
  contains() { return false; }
  querySelectorAll() { return []; }
  getAttribute(name) { return name === "data-message-author-role" ? this.role : ""; }
  getBoundingClientRect() { return { width: 640, height: 240 }; }
  compareDocumentPosition(other) { return this.order < other.order ? 4 : this.order > other.order ? 2 : 0; }
}

function drawioXml(name, body = '<mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>') {
  return `<mxfile><diagram name="${name}">${body}</diagram></mxfile>`;
}

function helper(xml, identity = "") {
  return [
    `ai-helper-drawio-start${identity ? `:${identity}` : ""}`,
    xml,
    "ai-helper-drawio-end"
  ].join("\n");
}

function loadContext() {
  const previewCalls = [];
  const invalidCalls = [];
  const preview = {
    validateDrawioXml(xml) {
      const text = String(xml || "");
      if (!/^<mxfile[\s>]/.test(text) || !/<diagram[\s>]/.test(text) || !/<\/mxfile>\s*$/.test(text)) {
        return { ok: false, error: "malformed draw.io XML" };
      }
      return { ok: true, title: /name="([^"]+)"/.exec(text)?.[1] || "Draw.io preview", pageCount: 1, byteLength: text.length };
    },
    isLikelyCompleteDrawioXml(xml) {
      return /^<mxfile[\s>]/.test(String(xml || "").trim()) && /<\/mxfile>\s*$/.test(String(xml || "").trim());
    },
    hashDrawioXml(xml) { return `hash-${String(xml || "").length}-${String(xml || "").slice(-12)}`; },
    consider(value) { previewCalls.push(value); return Promise.resolve({ ok: true }); },
    reportInvalid(value) {
      invalidCalls.push(value);
      return { ok: false, validationError: true, newError: true, artifactId: value.artifactId, error: value.error };
    },
    resetForPage() {},
    reopen() { return false; }
  };
  const context = {
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
      runtime: { id: "lkmeogidbglhedgekjgbpbfjkpapnhke", sendMessage: async () => ({ ok: true }) },
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
      createElement: () => new FakeElement(),
      documentElement: new MockNode("", 0),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {}
    },
    location: {
      href: "https://chatgpt.com/c/drawio",
      hostname: "chatgpt.com",
      origin: "https://chatgpt.com",
      pathname: "/c/drawio",
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
  return { context, previewCalls, invalidCalls };
}

async function main() {
  const { context: c, previewCalls } = loadContext();
  await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext('extensionActive = true', c);
  c.refreshPageLifecycle = () => false;
  c.chrome.storage.sync.get = async () => ({ enabled: true, enabledHosts: ['chatgpt.com'] });
  let backendCalls = 0;
  let composerCalls = 0;
  c.chrome.runtime.sendMessage = async () => { backendCalls++; throw Error('unexpected backend'); };
  c.queueDrawioErrorReply = async () => { composerCalls++; };
  c.updateDrawioContextAction = () => {};
  c.isVisibleElement = (node) => node?.isConnected !== false && !node?.hidden;
  let reopens = 0;
  c.AiChatDrawioPreview.reopen = () => { reopens++; return true; };
  const root = new MockNode();
  c.getConversationRoot = () => root;
  const create = (name, order, role = 'assistant') => {
    const node = new MockNode(helper(drawioXml(name), name), order, role);
    root.appendChild(node);
    return { call: c.parsePlainTextHelperBlocks(node.textContent)[0], node, textRoot: node, source: 'plain-text-block', blockIndex: 0 };
  };
  const skill = { call: { kind: 'skill', action: 'list' }, node: new MockNode('', 0), source: 'plain-text-block' };
  const first = create('first', 1);
  const second = create('second', 2);
  const user = create('user', 3, 'user');
  let candidates = [skill, first, second, user];
  c.extractShellCallCandidates = () => candidates;
  c.markBaselineIgnoredCandidates(candidates);
  c.processLatestDrawioCandidates(candidates);
  assert.equal(previewCalls.length, 0, 'Cold Skill then Draw.io history stays inert');
  c.syncDrawioPreviewButtons(candidates);
  assert.equal(vm.runInContext('drawioPreviewButtons.size', c), 2, 'User copies receive no Preview button');
  const hosts = vm.runInContext('Array.from(drawioPreviewButtons.values(), e => e.host)', c);
  c.syncDrawioPreviewButtons(candidates);
  assert.equal(vm.runInContext('Array.from(drawioPreviewButtons.values())[0].host', c), hosts[0], 'Rescans reuse controls');
  assert.equal(first.textRoot.textContent, helper(drawioXml('first'), 'first'), 'Control insertion preserves helper source');
  hosts[0].shadowRoot.children[0].listeners.click({ isTrusted: false });
  assert.equal(previewCalls.length, 0, 'Page script cannot synthesize Preview');
  const snapshot = c.createRenderedHelperCandidateSnapshot(first);
  assert.equal(await c.previewDrawioCandidate(snapshot, { isTrusted: false }), false);
  assert.equal(await c.previewDrawioCandidate(snapshot, { isTrusted: true }), true);
  assert.match(previewCalls.at(-1).xml, /name="first"/, 'Explicit selection renders the chosen older helper');
  assert.equal(c.isBaselineIgnoredHelperCandidate(first), true, 'Preview never unmarks historical helpers');
  c.processLatestDrawioCandidates(candidates);
  assert.equal(previewCalls.length, 1, 'Automatic scans do not override the manual selection');
  await c.previewDrawioCandidate(snapshot, { isTrusted: true });
  assert.equal(reopens, 2, 'The same button reopens a closed preview');
  assert.equal(previewCalls[0].isCurrent(), true, 'Repeated clicks retain in-flight ownership');

  await c.previewDrawioCandidate(c.createRenderedHelperCandidateSnapshot(second), { isTrusted: true });
  assert.match(previewCalls.at(-1).xml, /name="second"/);
  assert.equal(previewCalls[0].isCurrent(), false, 'A different selection invalidates earlier completion');
  const guard = previewCalls.at(-1).isCurrent;
  second.call.xml = drawioXml('changed');
  assert.equal(guard(), false, 'Semantic changes invalidate renderer completion');
  second.call.xml = drawioXml('second');
  second.node.hidden = true;
  assert.equal(await c.previewDrawioCandidate(c.createRenderedHelperCandidateSnapshot(second), { isTrusted: true }), false);
  second.node.hidden = false;
  second.node.isConnected = false;
  assert.equal(guard(), false, 'Detached helpers cannot finish rendering');
  second.node.isConnected = true;

  c.chrome.storage.sync.get = async () => ({ enabled: true });
  const originalConsider = c.AiChatDrawioPreview.consider;
  c.AiChatDrawioPreview.consider = () => Promise.resolve({ ok: false, newError: true, error: 'bad XML' });
  assert.equal(await c.previewDrawioCandidate(snapshot, { isTrusted: true }), false,
    'A malformed historical diagram reports failure locally');
  assert.equal(composerCalls, 0, 'Manual validation/render errors do not enter chat');
  c.AiChatDrawioPreview.consider = originalConsider;
  const originalM365User = c.isM365SubmittedUserMessageNode;
  c.isM365SubmittedUserMessageNode = (node) => node === first.node;
  assert.equal(await c.previewDrawioCandidate(snapshot, { isTrusted: true }), false,
    'Recognized M365 user messages reject Preview despite nested assistant metadata');
  c.isM365SubmittedUserMessageNode = originalM365User;

  const third = create('new-live', 4);
  candidates.push(third);
  c.processLatestDrawioCandidates(candidates);
  assert.match(previewCalls.at(-1).xml, /name="new-live"/, 'A genuinely new automatic candidate supersedes manual selection');
  assert.equal(guard(), false);

  let release;
  c.chrome.storage.sync.get = () => new Promise((resolve) => { release = resolve; });
  const pending = c.previewDrawioCandidate(snapshot, { isTrusted: true });
  const beforeRace = previewCalls.length;
  first.call.xml = drawioXml('mutated during settings');
  release({ enabled: true });
  assert.equal(await pending, false);
  assert.equal(previewCalls.length, beforeRace, 'Settings await revalidates exact helper content');
  first.call.xml = drawioXml('first');
  const routePending = c.previewDrawioCandidate(snapshot, { isTrusted: true });
  c.location.href = 'https://chatgpt.com/c/elsewhere';
  release({ enabled: true });
  assert.equal(await routePending, false, 'Manual previews never follow a route assignment');
  c.location.href = 'https://chatgpt.com/c/drawio';

  const releases = [];
  c.chrome.storage.sync.get = () => new Promise((resolve) => releases.push(resolve));
  const early = c.previewDrawioCandidate(snapshot, { isTrusted: true });
  const late = c.previewDrawioCandidate(c.createRenderedHelperCandidateSnapshot(second), { isTrusted: true });
  releases[1]({ enabled: true });
  await late;
  releases[0]({ enabled: true });
  assert.equal(await early, false, 'Out-of-order settings replies preserve latest click');
  assert.match(previewCalls.at(-1).xml, /name="second"/);
  c.chrome.storage.sync.get = async () => ({ enabled: false });
  assert.equal(await c.previewDrawioCandidate(snapshot, { isTrusted: true }), false, 'Disabled extension fails closed');

  // Multiple envelopes in one code root must retain a button per block.
  candidates = [first, { ...first, call: second.call, blockIndex: 1 }];
  c.syncDrawioPreviewButtons(candidates);
  assert.equal(vm.runInContext('drawioPreviewButtons.size', c), 2);
  const labels = vm.runInContext('Array.from(drawioPreviewButtons.values(), e => e.host.shadowRoot.children[0].textContent)', c);
  assert.deepEqual(Array.from(labels), ['Preview 1', 'Preview 2']);
  c.clearDrawioPreviewButtons();
  const pre = new FakeElement();
  const wrapper = new FakeElement();
  pre.appendChild(wrapper);
  wrapper.appendChild(first.textRoot);
  first.textRoot.closest = (selector) => selector === 'pre' ? pre : first.node;
  c.syncDrawioPreviewButtons(candidates);
  assert.deepEqual(pre.children.slice(0, 2).map((host) => host.shadowRoot.children[0].textContent),
    ['Preview 1', 'Preview 2'], 'Nested pre code keeps controls in reading order without moving source nodes');
  assert.equal(pre.children[2], wrapper);
  candidates = [];
  c.syncDrawioPreviewButtons(candidates);
  assert.equal(vm.runInContext('drawioPreviewButtons.size', c), 0, 'Removed candidates shed their controls');
  c.clearDrawioPreviewButtons();
  assert.equal(backendCalls, 0, 'No Skill, shell or other backend request');
  assert.equal(composerCalls, 0, 'Manual preview never queues a composer reply');
  console.log('content drawio inline preview tests passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
