#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../extension/src/drawio-preview.js"), "utf8");
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

class Element {
  constructor(tag = "div") {
    this.tag = tag; this.children = []; this.dataset = {}; this.listeners = new Map();
    this.isConnected = true; this.className = "";
    this.classList = {
      add: (name) => { this.className += ` ${name}`; },
      remove: (name) => { this.className = this.className.split(" ").filter((c) => c !== name).join(" "); }
    };
    if (tag === "iframe") this.contentWindow = { postMessage() {} };
  }
  appendChild(child) { this.children.push(child); child.parent = this; }
  remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  querySelector(selector) { return this.children.find((child) => child.className.split(" ").includes(selector.slice(1))) || null; }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type) { this.listeners.delete(type); }
}

function harness() {
  const listeners = new Set();
  const timers = new Map();
  let timer = 0;
  const host = new Element();
  const elements = Object.fromEntries(["viewport", "status", "title", "meta", "empty", "download", "copyPng", "downloadPng", "log", "logDetails"].map((name) => [name, new Element()]));
  const context = {
    Blob, TextEncoder, console: { error() {} },
    chrome: { runtime: { getURL: (url) => `chrome-extension://test/${url}` } },
    document: { visibilityState: "visible", createElement: (tag) => new Element(tag), addEventListener() {}, removeEventListener() {} },
    window: { addEventListener: (_type, listener) => listeners.add(listener), removeEventListener: (_type, listener) => listeners.delete(listener) },
    setTimeout: (callback) => { timers.set(++timer, callback); return timer; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (callback) => { timers.set(++timer, callback); return timer; },
    clearInterval: (id) => timers.delete(id)
  };
  vm.createContext(context);
  vm.runInContext(source.replace("  globalThis.AiChatDrawioPreview =", `
    globalThis.__test = {
      initialize(host, elements) {
        previewHost = host; previewElements = elements; previewShadow = {};
        viewerEmbedStrategyPromise = Promise.resolve({ nonce: "" });
      },
      active() { return activeStage; }
    };
    globalThis.AiChatDrawioPreview =`), context);
  context.__test.initialize(host, elements);
  const api = context.AiChatDrawioPreview;
  const candidate = (id, isCurrent) => ({ xml: `<mxfile>${id}</mxfile>`, artifactId: id, isCurrent,
    validation: { ok: true, title: id, byteLength: 30, pageCount: 1 } });
  return {
    api, host, elements, timers,
    consider: (id, guard) => api.consider(candidate(id, guard)),
    active: () => context.__test.active(),
    emit(type, extra = {}) {
      const frame = context.__test.active().layer.children[0];
      const channel = decodeURIComponent(frame.src.split("#channel=")[1]);
      for (const listener of [...listeners]) listener({ source: frame.contentWindow,
        data: { type: `ai-chat-drawio-${type}`, channel, artifactId: context.__test.active().artifactId, ...extra } });
    },
    begin() { this.emit("viewer-ready"); this.emit("render-started"); }
  };
}

async function main() {
  const same = harness();
  let ownsFirst = true;
  let ownsSecond = true;
  const first = same.consider("same-xml", () => ownsFirst);
  await tick();
  same.begin();
  const originalStage = same.active();
  ownsFirst = false;
  const second = same.consider("same-xml", () => ownsSecond);
  assert.equal(same.active(), originalStage, "Selecting identical XML in another helper must share its staging render.");
  same.emit("rendered", { title: "second owner" });
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true, "The second candidate must take ownership of the already pending renderer.");
  assert.equal(same.host.dataset.renderCount, "1");
  assert.equal(same.host.dataset.state, "ready");

  for (const outcome of ["rendered", "render-error"]) {
    for (const withExisting of [false, true]) {
      const h = harness();
      if (withExisting) {
        const initial = h.consider("existing", () => true);
        await tick(); h.begin(); h.emit("rendered"); await initial;
      }
      let current = true;
      const pending = h.consider("stale", () => current);
      await tick(); h.begin();
      current = false;
      h.emit(outcome, { error: "A stale renderer failure must stay invisible" });
      const result = await pending;
      assert.equal(result.cancelled, true, `Changed source must cancel ${outcome}.`);
      assert.equal(h.active(), null, "Cancellation must clear active-stage ownership.");
      assert.equal(h.host.dataset.pendingArtifactId, "", "Cancellation must clear pending diagnostics.");
      assert.equal(h.elements.viewport.querySelector(".drawio-frame-staging"), null, "No stale staging iframe may remain.");
      assert.equal(h.host.dataset.state, withExisting ? "ready" : "idle", "Cancellation must not leave a staging status.");
      assert.equal(h.host.dataset.currentArtifactId, withExisting ? "existing" : "", "Cancellation preserves any previously successful SVG.");
      assert.equal(h.host.dataset.errorCount, "0", "A stale source must not create a render error or AI error outcome.");
      assert.equal(h.timers.size, 0, "Cancelled ownership must release renderer timers.");
      const retry = h.consider("stale", () => true);
      await tick(); h.begin(); h.emit("rendered");
      assert.equal((await retry).ok, true, "A fresh click must recover after source cancellation.");
    }
  }
  const beforeMount = harness();
  let mountedOwner = true;
  const pending = beforeMount.consider("before-mount", () => mountedOwner);
  mountedOwner = false;
  await tick();
  assert.equal((await pending).cancelled, true, "Ownership is revalidated after asynchronous iframe preparation.");
  assert.equal(beforeMount.active(), null);
  assert.equal(beforeMount.host.dataset.state, "idle");
  assert.equal(beforeMount.elements.viewport.children.length, 0);
  console.log("drawio manual ownership tests passed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
