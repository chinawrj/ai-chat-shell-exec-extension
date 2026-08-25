#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeElement {}

class MockNode extends FakeElement {
  constructor(text = "", order = 1, role = "assistant") {
    super();
    this.innerText = text;
    this.textContent = text;
    this.order = order;
    this.role = role;
    this.parentElement = null;
  }

  closest() { return this; }
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

{
  const { context } = loadContext();
  const xml = drawioXml("Architecture");
  const calls = context.parsePlainTextHelperBlocks(helper(xml, "diagram-v1"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "drawio");
  assert.equal(calls[0].helperId, "diagram-v1");
  assert.equal(calls[0].helperIdSource, "marker");
  assert.equal(calls[0].xml, xml, "The helper body is the draw.io file itself.");
  assert.equal(context.isRunnableHelperCall(calls[0]), false, "Draw.io helpers must never enter the backend runner.");
}

{
  const { context } = loadContext();
  const xmlWithMarkerText = [
    '<mxfile><diagram name="Marker collision"><![CDATA[',
    "ai-helper-drawio-end",
    "]]></diagram></mxfile>"
  ].join("\n");
  const calls = context.parsePlainTextHelperBlocks(helper(xmlWithMarkerText));
  assert.equal(calls.length, 1, "An end-marker-looking CDATA line must not truncate an incomplete mxfile.");
  assert.equal(calls[0].xml, xmlWithMarkerText);
}

{
  const { context } = loadContext();
  assert.equal(
    context.parsePlainTextHelperBlocks("ai-helper-drawio-start\n<mxfile><diagram name=\"streaming\">").length,
    0,
    "An incomplete streaming helper must not become a preview candidate."
  );
}

{
  const { context, previewCalls, invalidCalls } = loadContext();
  const older = { call: context.parsePlainTextHelperBlocks(helper(drawioXml("Older")))[0], node: new MockNode("older", 1), textRoot: new MockNode("older", 1), source: "plain-text-block", blockIndex: 0 };
  const newest = { call: context.parsePlainTextHelperBlocks(helper(drawioXml("Newest")))[0], node: new MockNode("newest", 2), textRoot: new MockNode("newest", 2), source: "plain-text-block", blockIndex: 0 };
  context.processLatestDrawioCandidates([older, newest]);
  assert.equal(previewCalls.length, 1);
  assert.match(previewCalls[0].xml, /name="Newest"/, "A quiet scan renders only the last valid helper.");
  assert.equal(invalidCalls.length, 0);
}

{
  const { context, previewCalls } = loadContext();
  const assistant = { call: context.parsePlainTextHelperBlocks(helper(drawioXml("Assistant")))[0], node: new MockNode("assistant", 1, "assistant"), textRoot: new MockNode("assistant", 1, "assistant"), source: "plain-text-block", blockIndex: 0 };
  const explicitUser = { call: context.parsePlainTextHelperBlocks(helper(drawioXml("User copy")))[0], node: new MockNode("user", 2, "user"), textRoot: new MockNode("user", 2, "user"), source: "plain-text-block", blockIndex: 0 };
  context.processLatestDrawioCandidates([assistant, explicitUser]);
  assert.equal(previewCalls.length, 1);
  assert.match(previewCalls[0].xml, /name="Assistant"/, "An explicitly identified user helper must not become the Draw.io outcome.");

  const unknown = { call: context.parsePlainTextHelperBlocks(helper(drawioXml("Unknown host container")))[0], node: new MockNode("unknown", 3, ""), textRoot: new MockNode("unknown", 3, ""), source: "plain-text-block", blockIndex: 0 };
  context.processLatestDrawioCandidates([assistant, unknown]);
  assert.equal(previewCalls.length, 2);
  assert.match(previewCalls[1].xml, /name="Unknown host container"/, "Draw.io must not depend on the optional role filter recognizing a host container.");
}

{
  const { context, previewCalls, invalidCalls } = loadContext();
  const valid = { call: context.parsePlainTextHelperBlocks(helper(drawioXml("Keep me")))[0], node: new MockNode("valid", 1), textRoot: new MockNode("valid", 1), source: "plain-text-block", blockIndex: 0 };
  const malformed = { call: context.parsePlainTextHelperBlocks(helper("<mxfile><diagram></diagram></mxfile>"))[0], node: new MockNode("bad", 2), textRoot: new MockNode("bad", 2), source: "plain-text-block", blockIndex: 0 };
  malformed.call.xml = "<not-mxfile><diagram/></not-mxfile>";
  context.processLatestDrawioCandidates([valid, malformed]);
  assert.equal(previewCalls.length, 0, "A newer complete failure must not fall back to an older valid render.");
  assert.equal(invalidCalls.length, 1);
  assert.match(invalidCalls[0].error, /malformed/);
  setImmediate(() => {
    assert.equal(invalidCalls.length, 1, "Only the newest complete helper outcome is reported.");
    console.log("content drawio helper tests passed");
  });
}
