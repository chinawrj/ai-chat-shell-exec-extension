#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeElement {
  constructor() {
    this.children = [];
    this.style = {};
    this.isConnected = true;
    this.listeners = {};
    this.domInsertions = 0;
  }
  get childNodes() { return this.children; }
  get nextSibling() {
    const index = this.parentElement?.children.indexOf(this) ?? -1;
    return index < 0 ? null : this.parentElement.children[index + 1] || null;
  }
  get classList() { return { contains: (name) => this.className === name }; }
  attachShadow() { this.shadowRoot = new FakeElement(); return this.shadowRoot; }
  appendChild(child) {
    this.domInsertions += 1;
    if (child.parentElement) {
      child.parentElement.children = child.parentElement.children.filter((entry) => entry !== child);
    }
    this.children.push(child);
    child.parentElement = this;
    child.isConnected = true;
    return child;
  }
  insertBefore(child, before) {
    this.domInsertions += 1;
    if (child.parentElement) {
      child.parentElement.children = child.parentElement.children.filter((entry) => entry !== child);
    }
    const index = this.children.indexOf(before);
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    child.parentElement = this;
    child.isConnected = true;
  }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  remove() {
    this.isConnected = false;
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    }
  }
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
  let controls = vm.runInContext('Array.from(drawioPreviewButtons.values())', c);
  assert.equal(controls.flatMap((entry) => [entry.before.host, entry.after.host]).length, 4,
    'Each eligible Draw.io helper receives start and end Preview controls');
  assert.deepEqual(Array.from(controls, (entry) => [
    entry.before.host['data-drawio-preview-position'],
    entry.after.host['data-drawio-preview-position']
  ]), [['start', 'end'], ['start', 'end']]);
  assert.deepEqual(Array.from(controls[0].before.button.title.matchAll(/\(first\)/g)).length, 1);
  assert.deepEqual(Array.from(controls[0].after.button.title.matchAll(/\(first\)/g)).length, 1);
  assert.equal(controls[0].before.button['aria-label'], controls[0].before.button.title);
  assert.equal(controls[0].after.button['aria-label'], controls[0].after.button.title);
  root.domInsertions = 0;
  c.syncDrawioPreviewButtons(candidates);
  assert.equal(root.domInsertions, 0, 'An unchanged rescan performs no control DOM writes');
  assert.equal(vm.runInContext('Array.from(drawioPreviewButtons.values())[0].before.host', c), controls[0].before.host,
    'Rescans reuse the start control');
  assert.equal(vm.runInContext('Array.from(drawioPreviewButtons.values())[0].after.host', c), controls[0].after.host,
    'Rescans reuse the end control');
  assert.equal(first.textRoot.textContent, helper(drawioXml('first'), 'first'), 'Control insertion preserves helper source');
  controls[0].before.button.listeners.click({ isTrusted: false });
  controls[0].after.button.listeners.click({ isTrusted: false });
  assert.equal(previewCalls.length, 0, 'Page script cannot synthesize either Preview control');
  const trustedEvent = { isTrusted: true, preventDefault() {}, stopPropagation() {} };
  controls[0].after.button.listeners.click(trustedEvent);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(previewCalls.at(-1).xml, /name="first"/, 'The end control previews its exact helper');
  controls[0].before.button.listeners.click(trustedEvent);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(previewCalls.at(-1).xml, /name="first"/, 'The start control previews the same exact helper');
  previewCalls.length = 0;
  reopens = 0;

  const oldBeforeHost = controls[0].before.host;
  const oldAfterHost = controls[0].after.host;
  oldAfterHost.isConnected = false;
  c.syncDrawioPreviewButtons(candidates);
  controls = vm.runInContext('Array.from(drawioPreviewButtons.values())', c);
  assert.notEqual(controls[0].before.host, oldBeforeHost, 'A missing end control rebuilds the pair');
  assert.notEqual(controls[0].after.host, oldAfterHost, 'A missing end control is replaced');
  assert.equal(oldBeforeHost.isConnected, false, 'Pair rebuild removes the surviving stale control');

  const secondPair = controls[1];
  second.node.hidden = true;
  c.syncDrawioPreviewButtons(candidates);
  assert.equal(vm.runInContext('drawioPreviewButtons.size', c), 1, 'A hidden helper exposes no controls');
  assert.equal(secondPair.before.host.isConnected, false);
  assert.equal(secondPair.after.host.isConnected, false);
  second.node.hidden = false;
  c.syncDrawioPreviewButtons(candidates);
  assert.equal(vm.runInContext('drawioPreviewButtons.size', c), 2, 'A visible helper restores both controls');
  assert.equal(c.parsePlainTextHelperBlocks('ai-helper-drawio-start\n<mxfile>').length, 0,
    'An incomplete helper cannot create either control');

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
  const labels = vm.runInContext('Array.from(drawioPreviewButtons.values(), e => [e.before.button.textContent, e.after.button.textContent])', c);
  assert.deepEqual(Array.from(labels, (pair) => Array.from(pair)), [
    ['Preview 1', 'Preview 1'], ['Preview 2', 'Preview 2']
  ]);
  c.clearDrawioPreviewButtons();
  const pre = new FakeElement();
  const wrapper = new FakeElement();
  pre.appendChild(wrapper);
  wrapper.appendChild(first.textRoot);
  first.textRoot.closest = (selector) => selector === 'pre' ? pre : first.node;
  c.syncDrawioPreviewButtons(candidates);
  assert.deepEqual(pre.children.slice(0, 2).map((host) => host.shadowRoot.children[0].textContent),
    ['Preview 1', 'Preview 2'], 'Nested pre code keeps start controls in reading order without moving source nodes');
  assert.equal(pre.children[2], wrapper);
  assert.deepEqual(pre.children.slice(3).map((host) => host.shadowRoot.children[0].textContent),
    ['Preview 1', 'Preview 2'], 'Nested pre code keeps end controls in reading order after the helper');
  const sharedEntries = vm.runInContext('Array.from(drawioPreviewButtons.values())', c);
  sharedEntries[0].after.host.isConnected = false;
  c.syncDrawioPreviewButtons(candidates);
  const rebuiltSharedEntries = vm.runInContext('Array.from(drawioPreviewButtons.values())', c);
  assert.notEqual(rebuiltSharedEntries[0].before.host, sharedEntries[0].before.host);
  assert.equal(rebuiltSharedEntries[1].before.host, sharedEntries[1].before.host,
    'Partial rebuild reuses the unaffected helper pair');
  assert.deepEqual(pre.children.slice(0, 2).map((host) => host.shadowRoot.children[0].textContent),
    ['Preview 1', 'Preview 2'], 'Partial rebuild preserves shared-root start order');
  assert.equal(pre.children[2], wrapper, 'Partial rebuild never moves the source node');
  assert.deepEqual(pre.children.slice(3).map((host) => host.shadowRoot.children[0].textContent),
    ['Preview 1', 'Preview 2'], 'Partial rebuild preserves shared-root end order');
  candidates = [];
  c.syncDrawioPreviewButtons(candidates);
  assert.equal(vm.runInContext('drawioPreviewButtons.size', c), 0, 'Removed candidates shed their controls');
  c.clearDrawioPreviewButtons();
  assert.equal(backendCalls, 0, 'No Skill, shell or other backend request');
  assert.equal(composerCalls, 0, 'Manual preview never queues a composer reply');
  console.log('content drawio inline preview tests passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
