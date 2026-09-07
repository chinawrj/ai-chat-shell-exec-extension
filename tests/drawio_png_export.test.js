#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const viewerSource = fs.readFileSync(path.join(root, "extension/drawio/viewer.js"), "utf8");
const previewSource = fs.readFileSync(path.join(root, "extension/src/drawio-preview.js"), "utf8");
const tick = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const pngBlob = () => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: "image/png" });
function headerBlob(width = 320, height = 90) {
  const buffer = new ArrayBuffer(24);
  const header = new DataView(buffer);
  [0x89504e47, 0x0d0a1a0a, 13, 0x49484452, width, height].forEach((value, index) => header.setUint32(index * 4, value));
  return new Blob([buffer], { type: "image/png" });
}

function previewHarness(options = {}) {
  const listeners = new Map();
  const requests = [];
  const clipboardWrites = [];
  const downloads = [];
  const objectUrls = [];
  const revoked = [];
  const timers = new Map();
  let timerId = 0;
  let finishClipboard = null;
  const elements = {
    status: { textContent: "ready" }, title: { textContent: "First page" },
    copyPng: {}, downloadPng: {}, download: { disabled: false }
  };
  const host = { hidden: false, isConnected: true, dataset: {}, remove() { this.isConnected = false; } };
  const source = { postMessage: (request) => requests.push(request) };
  const artifact = { artifactId: "artifact-a", iframe: { contentWindow: source }, channel: "parent-channel", pageRevision: 0, pageCount: 2, title: "First page" };
  const context = {
    Blob, TextEncoder, DataView, Uint32Array,
    console: { error() {} },
    URL: {
      createObjectURL: (blob) => { objectUrls.push(blob); return "blob:png-test"; },
      revokeObjectURL: (url) => revoked.push(url)
    },
    document: { createElement: (name) => {
      assert.equal(name, "a");
      return { click() { downloads.push({ href: this.href, filename: this.download }); } };
    } },
    window: {
      addEventListener: (type, callback) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
      removeEventListener: (type, callback) => listeners.get(type)?.delete(callback)
    },
    navigator: { clipboard: { write: (items) => {
      clipboardWrites.push(items);
      if (options.clipboardReject) return Promise.reject(new Error("clipboard permission denied"));
      const ready = Promise.all(items.map((item) => item.types["image/png"]));
      return options.deferClipboard ? ready.then(() => new Promise((resolve) => { finishClipboard = resolve; })) : ready;
    } } },
    ClipboardItem: class { constructor(types) { this.types = types; } },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id)
  };
  vm.createContext(context);
  vm.runInContext(previewSource.replace("  globalThis.AiChatDrawioPreview =", `
    globalThis.__previewTest = {
      copyCurrentPng, downloadCurrentPng, requestPngExport, cancelPngExport,
      initialize(artifact, elements, host) { currentArtifact = artifact; previewElements = elements; previewHost = host; previewShadow = {}; },
      supersede() { cancelPngExport(); renderGeneration += 1; currentArtifact = { ...currentArtifact, artifactId: "artifact-b" }; },
      pending() { return pendingPngExport; }
    };
    globalThis.AiChatDrawioPreview =
  `), context);
  const api = context.__previewTest;
  api.initialize(artifact, elements, host);
  return {
    api, publicApi: context.AiChatDrawioPreview, context, artifact, source, requests, clipboardWrites, downloads, objectUrls, revoked, timers, elements, host,
    finishClipboard: () => { assert.equal(typeof finishClipboard, "function"); finishClipboard(); },
    emit(patch = {}, eventSource = source) {
      const request = requests.at(-1) || {};
      const event = { source: eventSource, data: {
        ...request, type: "ai-chat-drawio-exported-png", pageRevision: 0,
        blob: headerBlob(), width: 320, height: 90, ...patch
      } };
      for (const callback of [...(listeners.get("message") || [])]) callback(event);
    },
    fireTimeout() { for (const [id, timer] of [...timers]) if (timer.delay === 15000) { timers.delete(id); timer.callback(); } }
  };
}

async function testParentExport() {
  const synthetic = previewHarness();
  for (const [width, height] of [[1, 1], [8192, 1], [4096, 4096]]) {
    assert.equal(synthetic.publicApi.validatePngDimensions(width, height).width, width);
  }
  for (const [width, height] of [[0, 1], [-1, 10], [NaN, 1], [Infinity, 1], [1.5, 1], [8193, 1], [4096, 4097]]) {
    assert.throws(() => synthetic.publicApi.validatePngDimensions(width, height), /bounds|pixels|megapixels/);
  }
  assert.equal(await synthetic.api.copyCurrentPng({ isTrusted: false }), false);
  assert.equal(await synthetic.api.downloadCurrentPng({ isTrusted: false }), false);
  assert.equal(synthetic.requests.length, 0);
  assert.equal(synthetic.clipboardWrites.length, 0, "Page synthetic clicks must not modify the clipboard.");

  const copy = previewHarness();
  const copied = copy.api.copyCurrentPng({ isTrusted: true });
  assert.equal(copy.clipboardWrites.length, 1, "clipboard.write must start synchronously inside the trusted click.");
  assert.equal(typeof copy.clipboardWrites[0][0].types["image/png"].then, "function");
  assert.equal(copy.elements.copyPng.disabled, true);
  assert.equal(copy.requests[0].type, "ai-chat-drawio-export-png");
  copy.emit({}, {});
  for (const patch of [{ channel: "wrong" }, { artifactId: "wrong" }, { requestId: "wrong" }]) copy.emit(patch);
  await tick();
  assert.ok(copy.api.pending(), "Mismatched replies must not consume the pending request.");
  copy.emit();
  assert.equal(await copied, true);
  assert.match(copy.elements.status.textContent, /copied/);
  assert.equal(copy.api.pending(), null);
  assert.equal(copy.elements.downloadPng.disabled, false);
  assert.equal(copy.timers.size, 0);

  const slowClipboard = previewHarness({ deferClipboard: true });
  const slowCopy = slowClipboard.api.copyCurrentPng({ isTrusted: true });
  slowClipboard.emit();
  await tick();
  assert.equal(slowClipboard.api.pending(), null, "The PNG response has finished before the OS clipboard promise settles.");
  assert.equal(slowClipboard.elements.copyPng.disabled, true,
    "Copy must remain busy until clipboard.write settles, preventing out-of-order clipboard writes.");
  assert.equal(await slowClipboard.api.copyCurrentPng({ isTrusted: true }), false);
  assert.equal(slowClipboard.clipboardWrites.length, 1);
  assert.equal(slowClipboard.requests.length, 1);
  slowClipboard.finishClipboard();
  assert.equal(await slowCopy, true);
  assert.equal(slowClipboard.elements.copyPng.disabled, false);

  const rejected = previewHarness({ clipboardReject: true });
  assert.equal(await rejected.api.copyCurrentPng({ isTrusted: true }), false);
  assert.match(rejected.elements.status.textContent, /permission denied/);
  assert.equal(rejected.api.pending(), null);
  assert.equal(rejected.elements.download.disabled, false, "Clipboard failure must leave the native .drawio download available.");
  const downloaded = rejected.api.downloadCurrentPng({ isTrusted: true });
  rejected.emit();
  assert.equal(await downloaded, true, "Download PNG must remain usable after clipboard rejection.");
  assert.equal(rejected.downloads[0].filename, "First page.png");
  for (const timer of rejected.timers.values()) timer.callback();
  assert.deepEqual(rejected.revoked, ["blob:png-test"]);

  const errors = [
    { blob: pngBlob() },
    { blob: new Blob([new Uint8Array(24)], { type: "image/png" }) },
    { blob: new Blob([new Uint8Array(24)], { type: "image/jpeg" }) },
    { blob: new Blob([headerBlob(), new Uint8Array(32 * 1024 * 1024)], { type: "image/png" }) },
    { blob: { type: "image/png", size: 24 } },
    { width: 0 }, { width: 8193 }, { width: 320, height: 91 }, { pageRevision: 1 },
    { type: "ai-chat-drawio-export-error", error: "SVG rasterization failed" }
  ];
  for (const patch of errors) {
    const invalid = previewHarness();
    const operation = invalid.api.downloadCurrentPng({ isTrusted: true });
    invalid.emit(patch);
    assert.equal(await operation, false, `Invalid PNG response must fail: ${Object.keys(patch)}`);
    assert.equal(invalid.downloads.length, 0);
    assert.equal(invalid.publicApi.getDiagnostics().currentArtifactId, "artifact-a", "Export failure must preserve the SVG artifact.");
    assert.equal(invalid.publicApi.getDiagnostics().renderErrorCount, 0, "PNG errors must not become render errors or composer replies.");
  }

  for (const action of ["supersede", "close", "resetForPage"]) {
    const stale = previewHarness();
    const operation = stale.api.downloadCurrentPng({ isTrusted: true });
    const oldRequest = stale.requests[0];
    if (action === "supersede") stale.api.supersede(); else stale.publicApi[action]();
    stale.emit(oldRequest);
    assert.equal(await operation, false);
    assert.equal(stale.downloads.length, 0, `${action} must cancel an asynchronous old-artifact export.`);
    assert.equal(stale.api.pending(), null);
  }

  const delayed = previewHarness();
  let readHeader;
  const blob = headerBlob();
  blob.slice = () => ({ arrayBuffer: () => new Promise((resolve) => { readHeader = resolve; }) });
  const operation = delayed.api.downloadCurrentPng({ isTrusted: true });
  delayed.emit({ blob });
  assert.equal(typeof readHeader, "function");
  delayed.api.supersede();
  readHeader(await headerBlob().arrayBuffer());
  assert.equal(await operation, false, "Ownership must be revalidated after PNG header reading awaits.");
  assert.equal(delayed.objectUrls.length, 0);

  const timeout = previewHarness();
  const timed = timeout.api.downloadCurrentPng({ isTrusted: true });
  timeout.fireTimeout();
  assert.equal(await timed, false);
  assert.match(timeout.elements.status.textContent, /timed out/);
  assert.equal(timeout.api.pending(), null);

  const multipage = previewHarness();
  const oldPage = multipage.api.downloadCurrentPng({ isTrusted: true });
  const pageUpdate = { type: "ai-chat-drawio-page-changed", title: "Second page", pageIndex: 1, pageRevision: 1 };
  multipage.emit({ ...pageUpdate, pageIndex: 2 });
  multipage.emit({ ...pageUpdate, pageRevision: 0 });
  assert.equal(multipage.artifact.pageRevision, 0, "Out-of-range pages and stale revisions must be rejected.");
  multipage.emit(pageUpdate);
  assert.equal(await oldPage, false, "Selecting another page must cancel the previous page's export.");
  assert.equal(multipage.elements.title.textContent, "Second page");
  const newPage = multipage.api.downloadCurrentPng({ isTrusted: true });
  multipage.emit({ pageRevision: 1 });
  assert.equal(await newPage, true);
  assert.equal(multipage.downloads[0].filename, "Second page.png");
}

function viewerHarness(options = {}) {
  const messages = [];
  const listeners = new Map();
  const timers = new Map();
  const images = [];
  const canvases = [];
  const pageBars = [];
  const calls = [];
  let blobCallback = null;
  let nextTimer = 0;
  const parent = { postMessage: (message) => messages.push(message) };
  const graph = {
    view: { scale: options.scale || 2 },
    getGraphBounds: () => options.bounds || { x: -900, y: 4000, width: 640, height: 180 },
    getSvg: (...args) => {
      calls.push(args);
      return { getAttribute: (name) => String(name === "width" ? options.width ?? 320 : options.height ?? 90) };
    }
  };
  const context = {
    Blob, TextEncoder, URLSearchParams,
    console: { error() {} },
    parent,
    location: { hash: "#channel=png-channel" },
    window: { addEventListener: (type, callback) => listeners.set(type, callback) },
    document: {
      querySelector: () => options.embeddedChannel ? { getAttribute: () => options.embeddedChannel } : null,
      getElementById: () => ({ before: (bar) => pageBars.push(bar) }),
      addEventListener() {},
      createElement: (tag) => {
        if (tag !== "canvas") return {
          tag, children: [], attributes: {}, events: {},
          appendChild(child) { this.children.push(child); },
          setAttribute(name, value) { this.attributes[name] = value; },
          addEventListener(type, callback) { this.events[type] = callback; }
        };
        const canvas = {
          width: 0, height: 0,
          getContext: () => options.noContext ? null : { drawImage: (...args) => calls.push(["drawImage", ...args]) },
          toBlob(callback, type) {
            assert.equal(type, "image/png");
            if (options.deferBlob) blobCallback = callback;
            else callback(options.blob === undefined ? pngBlob() : options.blob);
          }
        };
        canvases.push(canvas);
        return canvas;
      }
    },
    XMLSerializer: class { serializeToString() { return options.serialized || '<svg width="320" height="90"><foreignObject>label</foreignObject></svg>'; } },
    Image: class {
      constructor() { images.push(this); }
      set src(value) {
        this.source = value;
        if (!value || options.deferImage) return;
        queueMicrotask(() => options.imageError ? this.onerror?.() : this.onload?.());
      }
    },
    setTimeout: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id)
  };
  if (options.canvasClass) context.mxSvgCanvas2D = options.canvasClass;
  if (options.textClass) context.mxText = options.textClass;
  vm.createContext(context);
  vm.runInContext(viewerSource.replace('  post("ai-chat-drawio-viewer-ready");', `
    globalThis.__viewerTest = {
      exportPng, validatePngDimensions, installPageSelector, installCspLabelStyles,
      setGraph(instance) { graphViewer = instance; renderedArtifactId = "artifact-a"; },
      changePage() { pageRevision += 1; }
    };
    post("ai-chat-drawio-viewer-ready");
  `), context);
  const api = context.__viewerTest;
  api.setGraph({ graph, currentPage: 0, diagrams: [{ getAttribute: () => "Page A" }] });
  const request = { type: "ai-chat-drawio-export-png", channel: "png-channel", artifactId: "artifact-a", requestId: "request-a" };
  return {
    api, request, messages, calls, images, canvases, timers, pageBars, context,
    send: (patch = {}, source = parent) => listeners.get("message")({ source, data: { ...request, ...patch } }),
    finishBlob: () => blobCallback(pngBlob())
  };
}

function testCspLabelStyles() {
  const canvasCalls = [];
  const measurements = [];
  const styleWrites = [];
  const originalReturn = { original: true };
  function Canvas() {}
  function Text() {}
  Canvas.prototype.setCssText = function(...args) {
    canvasCalls.push({ receiver: this, args });
    return originalReturn;
  };
  Text.prototype.updateBoundingBox = function(...args) {
    measurements.push({ receiver: this, args, width: this.node?.offsetWidth, writes: styleWrites.length });
    return originalReturn;
  };
  const originalCanvasMethod = Canvas.prototype.setCssText;
  const originalTextMethod = Text.prototype.updateBoundingBox;
  const ordinary = viewerHarness({ canvasClass: Canvas, textClass: Text });
  ordinary.api.installCspLabelStyles();
  assert.equal(Canvas.prototype.setCssText, originalCanvasMethod, "Packaged extension-page viewing must not install host-CSP hooks.");
  assert.equal(Text.prototype.updateBoundingBox, originalTextMethod);

  const csp = viewerHarness({ embeddedChannel: "nonce-srcdoc-channel", canvasClass: Canvas, textClass: Text });
  csp.api.installCspLabelStyles();
  const canvasMethod = Canvas.prototype.setCssText;
  const textMethod = Text.prototype.updateBoundingBox;
  assert.notEqual(canvasMethod, originalCanvasMethod);
  assert.notEqual(textMethod, originalTextMethod);
  csp.api.installCspLabelStyles();
  assert.equal(Canvas.prototype.setCssText, canvasMethod, "The CSP hook must install only once.");
  assert.equal(Text.prototype.updateBoundingBox, textMethod);

  function nodeWithBlockedStyle(label, cssText, ownerDocument = csp.context.document) {
    let applied = false;
    let declared = cssText;
    return {
      ownerDocument,
      style: {
        get cssText() { return declared; },
        set cssText(value) { declared = value; applied = true; styleWrites.push(label); }
      },
      getAttribute(name) { assert.equal(name, "style"); return declared; },
      // CSP-blocked inline declarations still exist as attributes, but only
      // an authorized CSSOM application supplies the intended layout width.
      get offsetWidth() { return applied ? 222 : 760; }
    };
  }
  const liveNode = nodeWithBlockedStyle("canvas", "width: 222px;");
  const canvas = new Canvas();
  canvas.setCssText(liveNode, "display: flex; width: 222px;");
  assert.equal(liveNode.offsetWidth, 222);
  assert.equal(canvasCalls.length, 0, "Live label CSS must use CSSOM instead of CSP-blocked setAttribute.");
  canvas.setCssText(liveNode, "");
  assert.equal(liveNode.style.cssText, "", "Explicit empty style updates must clear prior live styles.");
  const exportNode = nodeWithBlockedStyle("export", "width: 222px;", {});
  assert.equal(canvas.setCssText(exportNode, "export-css", "extra"), originalReturn,
    "Detached export-document calls must preserve the original method return value.");
  assert.equal(canvasCalls.at(-1).receiver, canvas);
  assert.deepEqual(canvasCalls.at(-1).args, [exportNode, "export-css", "extra"]);
  assert.equal(exportNode.offsetWidth, 760, "Foreign export documents must not be rewritten as live label nodes.");
  const noCssom = { ownerDocument: csp.context.document };
  assert.equal(canvas.setCssText(noCssom, "fallback"), originalReturn);
  assert.equal(canvasCalls.at(-1).args[0], noCssom);

  const rootNode = nodeWithBlockedStyle("root", "width: 222px;");
  const childNode = nodeWithBlockedStyle("child", "display: inline-block;");
  const noStyleNode = { getAttribute: () => null, style: { set cssText(_) { throw new Error("Unstyled nodes must not be changed"); } } };
  rootNode.querySelectorAll = (selector) => { assert.equal(selector, "[style]"); return [childNode, noStyleNode]; };
  const text = new Text();
  text.node = rootNode;
  const writesBefore = styleWrites.length;
  assert.equal(text.updateBoundingBox("bounds-argument", 5), originalReturn);
  assert.deepEqual(styleWrites.slice(writesBefore), ["root", "child"]);
  assert.equal(measurements.at(-1).width, 222, "Root and rich-label styles must apply before the original synchronous measurement.");
  assert.equal(measurements.at(-1).writes, styleWrites.length);
  assert.equal(measurements.at(-1).receiver, text);
  assert.deepEqual(measurements.at(-1).args, ["bounds-argument", 5]);
  const isolatedRoot = nodeWithBlockedStyle("outside", "width: 222px;", {});
  isolatedRoot.querySelectorAll = () => { throw new Error("Do not traverse nodes outside the viewer document"); };
  text.node = isolatedRoot;
  assert.equal(text.updateBoundingBox(), originalReturn);
  assert.equal(measurements.at(-1).width, 760);
  text.node = null;
  assert.equal(text.updateBoundingBox("empty-node"), originalReturn);
}

async function testViewerExport() {
  const normal = viewerHarness({ width: "320px", height: "90px" });
  await normal.api.exportPng(normal.request);
  const result = normal.messages.at(-1);
  assert.equal(result.type, "ai-chat-drawio-exported-png");
  assert.equal(result.channel, "png-channel");
  assert.equal(result.artifactId, "artifact-a");
  assert.equal(result.requestId, "request-a");
  assert.equal(result.width, 320);
  assert.equal(result.height, 90);
  assert.equal(result.blob.type, "image/png");
  assert.deepEqual(Array.from(normal.calls[0]), ["#ffffff", 1, 0],
    "Export must ask the graph for natural-scale cropped content rather than the displayed viewport.");
  assert.equal(normal.timers.size, 0);
  assert.equal(normal.canvases[0].width, 0, "The raster canvas allocation must be released.");
  assert.equal(normal.images[0].source, "", "Temporary SVG image data must be released.");

  for (const [width, height] of [[1, 1], [8192, 1], [4096, 4096]]) normal.api.validatePngDimensions(width, height);
  for (const [width, height] of [[0, 1], [-1, 10], [NaN, 1], [Infinity, 1], [1.5, 1], [8193, 1], [4096, 4097]]) {
    assert.throws(() => normal.api.validatePngDimensions(width, height), /bounds|pixels|megapixels/);
  }
  const wrong = viewerHarness();
  wrong.send({}, {});
  wrong.send({ channel: "wrong" });
  wrong.send({ artifactId: "stale" });
  wrong.send({ requestId: "" });
  wrong.send({ requestId: "x".repeat(257) });
  await tick();
  assert.equal(wrong.calls.length, 0, "Foreign, stale, and malformed export requests must not reach the graph.");

  for (const [options, expectedError] of [
    [{ imageError: true }, /rasterize/],
    [{ noContext: true }, /allocate/],
    [{ blob: null }, /encoding/],
    [{ blob: new Blob(["bad"], { type: "image/jpeg" }) }, /encoding/],
    [{ blob: { type: "image/png", size: 32 * 1024 * 1024 + 1 } }, /32 MiB/],
    [{ bounds: { x: 0, y: 0, width: 0, height: 10 } }, /non-empty/],
    [{ width: 9000 }, /8192/],
    [{ serialized: "x".repeat(8 * 1024 * 1024 + 1) }, /8 MiB/]
  ]) {
    const harness = viewerHarness(options);
    await harness.api.exportPng(harness.request);
    assert.equal(harness.messages.at(-1).type, "ai-chat-drawio-export-error");
    assert.match(harness.messages.at(-1).error, expectedError);
    assert.equal(harness.messages.some((message) => message.type === "ai-chat-drawio-render-error"), false,
      "PNG failure must not replace a successfully rendered diagram with a render failure.");
    assert.equal(harness.timers.size, 0);
  }

  const pending = viewerHarness({ deferBlob: true });
  const first = pending.api.exportPng(pending.request);
  await tick();
  await pending.api.exportPng({ ...pending.request, requestId: "request-b" });
  assert.equal(pending.canvases.length, 1, "A second request cannot allocate another export while one is pending.");
  pending.api.changePage();
  pending.finishBlob();
  await first;
  assert.equal(pending.messages.at(-1).type, "ai-chat-drawio-export-error");
  assert.match(pending.messages.at(-1).error, /page changed/);
  assert.equal(pending.messages.some((message) => message.type === "ai-chat-drawio-exported-png"), false,
    "An asynchronous export from a previously selected page must never be delivered.");

  const timed = viewerHarness({ deferImage: true });
  const timedExport = timed.api.exportPng(timed.request);
  for (const callback of timed.timers.values()) callback();
  await timedExport;
  assert.match(timed.messages.at(-1).error, /timed out/);
  assert.equal(timed.timers.size, 0);

  const encodingOptions = { deferBlob: true };
  const encoding = viewerHarness(encodingOptions);
  const stuckEncoding = encoding.api.exportPng(encoding.request);
  await tick();
  for (const callback of [...encoding.timers.values()]) callback();
  await stuckEncoding;
  assert.match(encoding.messages.at(-1).error, /encoding timed out/);
  assert.equal(encoding.canvases[0].width, 0);
  const countBeforeLateBlob = encoding.messages.length;
  encoding.finishBlob();
  await tick();
  assert.equal(encoding.messages.length, countBeforeLateBlob, "A timed-out encoder's late callback must not emit success.");
  encodingOptions.deferBlob = false;
  await encoding.api.exportPng({ ...encoding.request, requestId: "retry-after-encoding-timeout" });
  assert.equal(encoding.messages.at(-1).type, "ai-chat-drawio-exported-png",
    "An encoding timeout must release the viewer's export lock so the user can retry.");

  const pages = viewerHarness();
  const selections = [];
  let graphChanged;
  const instance = {
    currentPage: 0,
    diagrams: [{ getAttribute: () => "Alpha" }, { getAttribute: () => "Beta" }],
    addListener(name, callback) { assert.equal(name, "graphChanged"); graphChanged = callback; },
    selectPage(index) { selections.push(index); this.currentPage = index; graphChanged(); }
  };
  pages.api.installPageSelector(instance);
  const select = pages.pageBars[0].children[0];
  const previous = pages.pageBars[0].children[1];
  const next = pages.pageBars[0].children[2];
  assert.equal(select.attributes["aria-label"], "Draw.io page");
  assert.equal(select.children.length, 2, "Every page must appear in the selector.");
  assert.equal(previous.attributes["aria-label"], "Previous page");
  assert.equal(next.attributes["aria-label"], "Next page");
  assert.equal(previous.disabled, true, "Previous must be disabled on the first page.");
  assert.equal(next.disabled, false);
  previous.events.click({ isTrusted: true });
  next.events.click({ isTrusted: false });
  previous.events.click({ isTrusted: false });
  assert.equal(selections.length, 0, "Out-of-range and synthetic navigation must not select a page.");
  select.value = "1";
  select.events.change({ isTrusted: false });
  assert.equal(selections.length, 0, "Synthetic page-selection events must not switch the diagram.");
  select.events.change({ isTrusted: true });
  assert.deepEqual(selections, [1]);
  assert.equal(pages.messages.at(-1).type, "ai-chat-drawio-page-changed");
  assert.equal(pages.messages.at(-1).pageIndex, 1);
  assert.equal(pages.messages.at(-1).pageRevision, 1);
  assert.equal(pages.messages.at(-1).title, "Beta");
  assert.equal(previous.disabled, false);
  assert.equal(next.disabled, true, "Next must be disabled on the last page.");
  next.events.click({ isTrusted: true });
  assert.deepEqual(selections, [1], "Even a direct disabled-last-page callback must reject the out-of-range page.");
  previous.events.click({ isTrusted: true });
  assert.deepEqual(selections, [1, 0]);
  assert.equal(select.value, "0", "Previous navigation must synchronize the page selector.");
  assert.equal(previous.disabled, true);
  assert.equal(next.disabled, false);
  next.events.click({ isTrusted: true });
  assert.deepEqual(selections, [1, 0, 1]);
  assert.equal(select.value, "1");
  assert.equal(pages.messages.at(-1).pageRevision, 3, "Each actual graph change must advance the export ownership revision.");
  for (const value of ["-1", "2", "1.5", "NaN"]) {
    select.value = value;
    select.events.change({ isTrusted: true });
  }
  assert.deepEqual(selections, [1, 0, 1], "Invalid, fractional, and out-of-range selected indexes must be ignored.");
  select.value = "0";
  instance.selectPage = () => { throw new Error("page unavailable"); };
  select.events.change({ isTrusted: true });
  assert.equal(pages.messages.at(-1).type, "ai-chat-drawio-page-error");
  assert.match(pages.messages.at(-1).error, /page unavailable/);
  const singlePage = viewerHarness();
  singlePage.api.installPageSelector({ diagrams: [{ getAttribute: () => "Only page" }] });
  assert.equal(singlePage.pageBars.length, 0, "Single-page diagrams do not need a page selector.");
}

Promise.resolve().then(testCspLabelStyles).then(testViewerExport).then(testParentExport).then(() => console.log("drawio PNG export tests passed")).catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
