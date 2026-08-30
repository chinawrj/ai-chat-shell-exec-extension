#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const previewSource = fs.readFileSync(path.join(ROOT, "extension", "src", "drawio-preview.js"), "utf8");
const viewerSource = fs.readFileSync(path.join(ROOT, "extension", "drawio", "viewer.js"), "utf8");

let fakeNow = 1000;
let nextTimerId = 1;
const fakeTimers = new Map();
class FakeDate extends Date {
  constructor(...args) {
    super(...(args.length > 0 ? args : [fakeNow]));
  }
  static now() {
    return fakeNow;
  }
}
class FakeVisibilityDocument {
  constructor() {
    this.hidden = false;
    this.visibilityState = "visible";
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  setHidden(hidden) {
    this.hidden = hidden;
    this.visibilityState = hidden ? "hidden" : "visible";
    for (const listener of this.listeners.get("visibilitychange") || []) listener();
  }
}
const fakeDocument = new FakeVisibilityDocument();

function fakeSetTimeout(callback, delay) {
  const id = nextTimerId++;
  fakeTimers.set(id, { callback, dueAt: fakeNow + Number(delay || 0) });
  return id;
}

function fakeClearTimeout(id) {
  fakeTimers.delete(id);
}

function advanceFakeTime(ms) {
  const target = fakeNow + ms;
  while (true) {
    const next = Array.from(fakeTimers.entries())
      .filter(([, timer]) => timer.dueAt <= target)
      .sort((a, b) => a[1].dueAt - b[1].dueAt)[0];
    if (!next) break;
    fakeNow = next[1].dueAt;
    fakeTimers.delete(next[0]);
    next[1].callback();
  }
  fakeNow = target;
}

class MockDOMParser {
  parseFromString(text) {
    const source = String(text || "");
    const rootMatch = source.match(/^\s*(?:<\?xml[^>]*>\s*)?<([A-Za-z0-9:_-]+)/);
    const diagramMatches = Array.from(source.matchAll(/<diagram\b([^>]*)>/g));
    const malformed = !rootMatch || !source.includes(`</${rootMatch[1]}>`);
    return {
      documentElement: { localName: rootMatch?.[1]?.split(":").at(-1) || "" },
      querySelector(selector) {
        return selector === "parsererror" && malformed ? { textContent: "mock XML parse error" } : null;
      },
      getElementsByTagName(name) {
        if (name !== "diagram") return [];
        return diagramMatches.map((match) => ({
          getAttribute(attribute) {
            if (attribute !== "name") return null;
            return /\bname="([^"]*)"/.exec(match[1])?.[1] || null;
          }
        }));
      }
    };
  }
}

const context = {
  Blob,
  Date: FakeDate,
  DOMParser: MockDOMParser,
  TextEncoder,
  URL,
  clearTimeout: fakeClearTimeout,
  console,
  document: fakeDocument,
  setTimeout: fakeSetTimeout
};
vm.createContext(context);
vm.runInContext(previewSource, context, { filename: "drawio-preview.js" });
const preview = context.AiChatDrawioPreview;

const valid = '<mxfile><diagram name="System"><mxGraphModel/></diagram></mxfile>';
assert.deepEqual(
  JSON.parse(JSON.stringify(preview.validateDrawioXml(valid))),
  { ok: true, byteLength: valid.length, pageCount: 1, title: "System" }
);
assert.equal(preview.validateDrawioXml("<svg></svg>").ok, false);
assert.match(preview.validateDrawioXml("<svg></svg>").error, /root must be <mxfile>/);
assert.equal(preview.validateDrawioXml("<mxfile></mxfile>").ok, false);
assert.match(preview.validateDrawioXml("<mxfile>").error, /malformed/);
assert.equal(preview.validateDrawioXml(`<!--${"x".repeat(preview.DRAWIO_XML_MAX_BYTES)}-->`).ok, false);
assert.match(preview.validateDrawioXml(`<!--${"x".repeat(preview.DRAWIO_XML_MAX_BYTES)}-->`).error, /limit/);
assert.equal(preview.isLikelyCompleteDrawioXml(valid), true);
assert.equal(preview.isLikelyCompleteDrawioXml("<mxfile><diagram>"), false);
assert.equal(preview.hashDrawioXml(valid), preview.hashDrawioXml(valid));
assert.notEqual(preview.hashDrawioXml(valid), preview.hashDrawioXml(valid.replace("System", "Other")));

fakeDocument.setHidden(true);
let watchdogFirings = 0;
const hiddenWatchdog = preview.createVisibleTimeWatchdog(7000, () => { watchdogFirings += 1; });
advanceFakeTime(60000);
assert.equal(watchdogFirings, 0, "A backgrounded page must not consume Draw.io startup/render budget.");
fakeDocument.setHidden(false);
advanceFakeTime(6999);
assert.equal(watchdogFirings, 0);
advanceFakeTime(1);
assert.equal(watchdogFirings, 1, "The watchdog must fire after the full visible-page budget.");
hiddenWatchdog.cancel();

const cancelledWatchdog = preview.createVisibleTimeWatchdog(7000, () => { watchdogFirings += 1; });
advanceFakeTime(2500);
cancelledWatchdog.cancel();
advanceFakeTime(10000);
assert.equal(watchdogFirings, 1, "A ready/rendered phase transition must be able to cancel its prior watchdog.");

const retryEvents = [];
const retryFailures = [];
let retryPolicy;
retryPolicy = preview.createRenderAttemptWatchdog({
  maxAttempts: 2,
  startupTimeoutMs: 7000,
  acceptTimeoutMs: 7000,
  createWatchdog: preview.createVisibleTimeWatchdog,
  onRetry(event) {
    retryEvents.push({ ...event });
    retryPolicy.beginAttempt();
  },
  onFailure(message) {
    retryFailures.push(message);
  }
});
assert.equal(retryPolicy.beginAttempt(), 1);
retryPolicy.awaitAcceptance();
advanceFakeTime(6999);
assert.equal(retryEvents.length, 0);
advanceFakeTime(1);
assert.deepEqual(retryEvents, [{ phase: "accept", attempt: 1, nextAttempt: 2 }]);
assert.equal(retryPolicy.getState().attempt, 2, "A first acceptance timeout must create exactly one fresh attempt.");
retryPolicy.awaitAcceptance();
advanceFakeTime(7000);
assert.equal(retryPolicy.getState().phase, "awaiting-accept",
  "The final attempt must keep waiting instead of turning a slow synchronous render into an error.");
assert.deepEqual(retryFailures, []);
assert.equal(retryPolicy.accept(), true);
advanceFakeTime(60000);
assert.deepEqual(retryFailures, [], "Once the viewer acknowledges render start, the parent must never time out a slow render.");
assert.equal(retryPolicy.getState().phase, "rendering");
retryPolicy.cancel();

const finalFailures = [];
let finalPolicy;
finalPolicy = preview.createRenderAttemptWatchdog({
  maxAttempts: 2,
  startupTimeoutMs: 7000,
  acceptTimeoutMs: 7000,
  createWatchdog: preview.createVisibleTimeWatchdog,
  onRetry() {
    finalPolicy.beginAttempt();
  },
  onFailure(message) {
    finalFailures.push(message);
  }
});
finalPolicy.beginAttempt();
advanceFakeTime(7000);
assert.equal(finalPolicy.getState().attempt, 2);
advanceFakeTime(7000);
advanceFakeTime(7000);
assert.equal(finalFailures.length, 1, "Two failed startup attempts must produce one final error only.");
assert.match(finalFailures[0], /startup timed out.*2 attempts/i);

const sourceA = {};
const sourceB = {};
const messageBase = { channel: "channel-b", artifactId: "artifact-b" };
assert.equal(preview.classifyDrawioViewerMessage({
  source: sourceB,
  expectedSource: sourceB,
  message: { type: "ai-chat-drawio-viewer-ready", channel: "channel-b" },
  channel: "channel-b",
  artifactId: "artifact-b",
  renderRequested: false,
  renderAccepted: false
}), "ready");
assert.equal(preview.classifyDrawioViewerMessage({
  source: sourceA,
  expectedSource: sourceB,
  message: { ...messageBase, type: "ai-chat-drawio-rendered" },
  channel: "channel-b",
  artifactId: "artifact-b",
  renderRequested: true,
  renderAccepted: true
}), "", "A late completion from the discarded first iframe must be ignored.");
assert.equal(preview.classifyDrawioViewerMessage({
  source: sourceB,
  expectedSource: sourceB,
  message: { ...messageBase, artifactId: "stale-artifact", type: "ai-chat-drawio-render-started" },
  channel: "channel-b",
  artifactId: "artifact-b",
  renderRequested: true,
  renderAccepted: false
}), "", "A stale artifact cannot acknowledge the current render request.");
assert.equal(preview.classifyDrawioViewerMessage({
  source: sourceB,
  expectedSource: sourceB,
  message: { channel: "channel-b", type: "ai-chat-drawio-render-error" },
  channel: "channel-b",
  artifactId: "artifact-b",
  renderRequested: true,
  renderAccepted: true
}), "", "A renderer error without the exact artifact id must be rejected.");
assert.equal(preview.classifyDrawioViewerMessage({
  source: sourceB,
  expectedSource: sourceB,
  message: { ...messageBase, type: "ai-chat-drawio-rendered" },
  channel: "channel-b",
  artifactId: "artifact-b",
  renderRequested: true,
  renderAccepted: false
}), "", "A completion cannot skip the render-start acknowledgement.");
assert.equal(preview.classifyDrawioViewerMessage({
  source: sourceB,
  expectedSource: sourceB,
  message: { ...messageBase, type: "ai-chat-drawio-render-started" },
  channel: "channel-b",
  artifactId: "artifact-b",
  renderRequested: true,
  renderAccepted: false
}), "started");
assert.equal(preview.classifyDrawioViewerMessage({
  source: sourceB,
  expectedSource: sourceB,
  message: { ...messageBase, type: "ai-chat-drawio-rendered" },
  channel: "channel-b",
  artifactId: "artifact-b",
  renderRequested: true,
  renderAccepted: true
}), "rendered");
assert.equal(preview.classifyDrawioViewerMessage({
  source: sourceB,
  expectedSource: sourceB,
  message: { ...messageBase, type: "ai-chat-drawio-render-error" },
  channel: "channel-b",
  artifactId: "artifact-b",
  renderRequested: true,
  renderAccepted: true
}), "error");
assert.equal(preview.classifyDrawioViewerMessage({
  source: sourceB,
  expectedSource: sourceB,
  message: { ...messageBase, type: "ai-chat-drawio-render-error" },
  channel: "channel-b",
  artifactId: "artifact-b",
  renderRequested: true,
  renderAccepted: false
}), "error", "An exact explicit viewer error may arrive before synchronous rendering is acknowledged.");

assert.match(previewSource, /drawio-frame-staging/);
assert.match(previewSource, /const DRAWIO_VIEWER_STARTUP_ATTEMPTS = 2/,
  "A transient viewer startup failure must receive exactly one bounded local retry.");
assert.match(previewSource, /function requestRender\(\)[\s\S]*attemptPolicy\.awaitAcceptance\(\)/,
  "Viewer-ready/load must replace the startup watchdog with a bounded render-acceptance handshake.");
assert.ok(
  previewSource.indexOf('window.addEventListener("message", onMessage, true)') < previewSource.lastIndexOf("mountViewerAttempt();"),
  "The parent message listener must exist before the sandbox iframe is navigated and inserted."
);
assert.match(previewSource, /iframe\.addEventListener\("load", onFrameLoad\)/,
  "The iframe load event must recover a lost one-shot viewer-ready message.");
assert.match(previewSource, /classifyDrawioViewerMessage/,
  "Late or mismatched renderer completions must pass the behavior-tested source, channel, artifact, and phase classifier.");
assert.doesNotMatch(previewSource, /Draw\.io renderer timed out after \$\{DRAWIO_RENDER_TIMEOUT_MS\}/,
  "The old combined startup-and-render 7000ms watchdog must not return.");
assert.doesNotMatch(previewSource, /stopped responding after rendering began/,
  "The parent must not impose a hard deadline after the isolated viewer acknowledges that rendering began.");
assert.match(previewSource, /\.drawio-frame-staging \{ inset: 0 auto 0 -200vw; width: 100%; visibility: visible; opacity: 0; pointer-events: none; \}/,
  "The staging iframe must remain renderable while it is visually hidden offscreen.");
assert.doesNotMatch(previewSource, /\.drawio-frame-staging \{ visibility: hidden/,
  "Chromium may skip SVG layout in a visibility-hidden staging iframe.");
assert.match(previewSource, /oldLayer\?\.remove\(\)/, "The old SVG frame is removed only after a fresh renderer succeeds.");
assert.match(previewSource, /clearCurrentArtifact\("No render is available for the latest helper\."\)/,
  "A confirmed latest-helper failure must clear the older rendered artifact.");
assert.match(previewSource, /errorLog = \[entry\]/,
  "The user-facing error log must contain only the latest Draw.io failure.");
assert.match(previewSource, /clearErrorLog\(\);\s*setPreviewState\("ready"\)/,
  "A successful latest render must clear the previous error.");
assert.match(previewSource, /stale renderer completion/);
assert.match(previewSource, /superseded by a newer valid helper/);
assert.match(previewSource, /console\.error\(`\[AI Chat Draw\.io\]/, "Preview failures must reach browser diagnostics.");
assert.match(previewSource, /sandbox", "allow-scripts"/, "The renderer must run in an isolated sandbox without same-origin access.");
assert.doesNotMatch(previewSource, /innerHTML\s*=\s*(?:candidate|xml|artifact)/i, "Untrusted draw.io XML must not be injected into the host page.");
assert.match(previewSource, /function close\(\)/);
assert.match(previewSource, /function reopen\(\)/);
assert.match(previewSource, /function downloadCurrent\(\)/);
assert.match(previewSource, /data-action="maximize"/);
assert.match(previewSource, /function toggleMaximize\(\)/);
assert.match(previewSource, /\.window\.maximized \{ left: 8px; right: 8px; top: 8px; bottom: 8px;/,
  "Maximize must fill the browser viewport with a small safe inset.");
assert.match(previewSource, /maximized \? "Restore" : "Maximize"/);

assert.match(viewerSource, /GraphViewer\?\.processElements/);
assert.match(viewerSource, /ai-chat-drawio-render-error/);
assert.match(viewerSource, /did not produce an SVG before the render timeout/);
assert.match(viewerSource, /activeVisibleElapsedMs\(\) >= RENDER_OUTPUT_TIMEOUT_MS/,
  "The sandbox renderer must not count hidden-tab time as active render time.");
assert.match(viewerSource, /const RENDER_OUTPUT_TIMEOUT_MS = 15000/);
assert.ok(
  viewerSource.indexOf('post("ai-chat-drawio-render-started"') > viewerSource.indexOf("GraphViewer.processElements()"),
  "Render-start acknowledgement must prove that the potentially slow synchronous renderer returned."
);
assert.ok(
  viewerSource.indexOf("if (settleRenderedSvg())") < viewerSource.indexOf("new MutationObserver"),
  "A synchronously produced SVG must be detected before relying on throttled iframe timers."
);
assert.match(viewerSource, /new MutationObserver\(\(\) => \{\s*settleRenderedSvg\(\);\s*\}\)/,
  "Asynchronous SVG insertion must wake completion immediately without waiting for an offscreen interval.");
assert.match(viewerSource, /observer\?\.disconnect\(\)/,
  "The SVG observer must be disconnected on every terminal viewer outcome.");
assert.match(viewerSource, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
assert.doesNotMatch(viewerSource, /https?:\/\//, "The runtime viewer must not fetch a remote renderer.");

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8"));
assert.deepEqual(manifest.content_scripts[0].js.slice(0, 2), ["src/drawio-preview.js", "src/content.js"]);
assert.ok(manifest.sandbox.pages.includes("drawio/viewer.html"));
assert.ok(manifest.web_accessible_resources.some((entry) => entry.resources.includes("vendor/drawio/viewer-static.min.js")));
assert.ok(fs.statSync(path.join(ROOT, "extension", "vendor", "drawio", "viewer-static.min.js")).size > 1_000_000);
assert.ok(fs.existsSync(path.join(ROOT, "extension", "vendor", "drawio", "LICENSE")));
const attribution = fs.readFileSync(path.join(ROOT, "extension", "vendor", "drawio", "ATTRIBUTION.md"), "utf8");
assert.match(attribution, /Apache License 2\.0/);
assert.match(attribution, /v31\.1\.5/);
assert.match(attribution, /a318b4c1f82daab96d1b067169704d11ca118275/);
assert.match(attribution, /13f6a01d141f8edd23213242f2472c7a3eb7637c76144bf7917c76858477c251/);
assert.match(attribution, /not affiliated with,\s+endorsed by, or sponsored by/i);
assert.match(attribution, /Atlassian/i);
const thirdPartyNotices = fs.readFileSync(path.join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8");
assert.match(thirdPartyNotices, /draw\.io viewer/i);
assert.match(thirdPartyNotices, /Apache License 2\.0/);
assert.match(thirdPartyNotices, /does not relicense/i);

testViewerRuntimeBehavior()
  .then(() => console.log("drawio preview tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

async function testViewerRuntimeBehavior() {
  const synchronous = createViewerHarness("sync");
  synchronous.render();
  assert.deepEqual(synchronous.messageTypes(), [
    "ai-chat-drawio-viewer-ready",
    "ai-chat-drawio-render-started",
    "ai-chat-drawio-rendered"
  ], "A synchronously produced SVG must complete immediately after renderer acceptance.");
  assert.equal(synchronous.observerStats().created, 0,
    "Immediate SVG completion must not depend on a MutationObserver or interval tick.");
  assert.equal(synchronous.activeIntervalCount(), 0);

  const asynchronous = createViewerHarness("async");
  asynchronous.render();
  await asynchronous.wait(20);
  assert.deepEqual(asynchronous.messageTypes(), [
    "ai-chat-drawio-viewer-ready",
    "ai-chat-drawio-render-started",
    "ai-chat-drawio-rendered"
  ], "An asynchronously inserted SVG must complete through the mutation observer.");
  assert.deepEqual(asynchronous.observerStats(), { created: 1, disconnected: 1 },
    "Terminal asynchronous success must disconnect its observer.");
  assert.equal(asynchronous.activeIntervalCount(), 0,
    "Terminal asynchronous success must clear its fallback interval.");
  assert.equal(asynchronous.visibilityListenerCount(), 0,
    "Terminal asynchronous success must remove its visibility listener.");

  const missingSvg = createViewerHarness("none", { outputTimeoutMs: 20 });
  missingSvg.render();
  await missingSvg.wait(80);
  assert.deepEqual(missingSvg.messageTypes(), [
    "ai-chat-drawio-viewer-ready",
    "ai-chat-drawio-render-started",
    "ai-chat-drawio-render-error"
  ], "A renderer that returns without ever producing SVG must fail once after its own output budget.");
  assert.deepEqual(missingSvg.observerStats(), { created: 1, disconnected: 1 });
  assert.equal(missingSvg.activeIntervalCount(), 0);
  assert.equal(missingSvg.visibilityListenerCount(), 0);

  const thrown = createViewerHarness("throw");
  thrown.render();
  assert.deepEqual(thrown.messageTypes(), [
    "ai-chat-drawio-viewer-ready",
    "ai-chat-drawio-render-error"
  ], "A synchronous renderer exception must report an exact error without falsely acknowledging render start.");
  assert.equal(thrown.observerStats().created, 0);
  assert.equal(thrown.activeIntervalCount(), 0);
}

function createViewerHarness(mode, options = {}) {
  const messages = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const activeIntervals = new Set();
  const observerCounters = { created: 0, disconnected: 0 };

  class FakeElement {
    constructor(tagName) {
      this.tagName = String(tagName || "div").toUpperCase();
      this.className = "";
      this.attributes = new Map();
      this.children = [];
      this.observers = new Set();
      this.ownText = "";
    }
    setAttribute(name, value) {
      this.attributes.set(String(name), String(value));
    }
    replaceChildren(...children) {
      this.children = children;
      this.notifyMutation();
    }
    appendChild(child) {
      this.children.push(child);
      this.notifyMutation();
      return child;
    }
    querySelector(selector) {
      const matches = (node) => selector === "svg"
        ? node.tagName === "SVG"
        : selector === ".mxgraph" && node.className === "mxgraph";
      const queue = [...this.children];
      while (queue.length > 0) {
        const node = queue.shift();
        if (matches(node)) return node;
        queue.push(...(node.children || []));
      }
      return null;
    }
    closest() {
      return null;
    }
    notifyMutation() {
      for (const observer of this.observers) observer.callback([]);
    }
    get textContent() {
      return this.ownText + this.children.map((child) => child.textContent || "").join("");
    }
    set textContent(value) {
      this.ownText = String(value || "");
      this.children = [];
      this.notifyMutation();
    }
  }

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.target = null;
      observerCounters.created += 1;
    }
    observe(target) {
      this.target = target;
      target.observers.add(this);
    }
    disconnect() {
      if (!this.target) return;
      this.target.observers.delete(this);
      this.target = null;
      observerCounters.disconnected += 1;
    }
  }

  const viewer = new FakeElement("div");
  const parent = {
    postMessage(message) {
      messages.push({ ...message });
    }
  };
  const document = {
    hidden: false,
    visibilityState: "visible",
    getElementById(id) {
      return id === "viewer" ? viewer : null;
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Set());
      documentListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      documentListeners.get(type)?.delete(listener);
    }
  };
  const window = {
    addEventListener(type, listener) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type).add(listener);
    }
  };
  const graphViewer = {
    processElements() {
      const container = viewer.querySelector(".mxgraph");
      if (mode === "throw") throw new Error("synthetic GraphViewer failure");
      if (mode === "sync") container.appendChild(new FakeElement("svg"));
      if (mode === "async") setTimeout(() => container.appendChild(new FakeElement("svg")), 0);
    }
  };
  function trackedSetInterval(callback, delay) {
    const id = setInterval(callback, delay);
    activeIntervals.add(id);
    return id;
  }
  function trackedClearInterval(id) {
    clearInterval(id);
    activeIntervals.delete(id);
  }
  const runtimeSource = options.outputTimeoutMs
    ? viewerSource.replace("const RENDER_OUTPUT_TIMEOUT_MS = 15000;", `const RENDER_OUTPUT_TIMEOUT_MS = ${options.outputTimeoutMs};`)
    : viewerSource;
  const harnessContext = {
    DOMParser: MockDOMParser,
    GraphViewer: graphViewer,
    MutationObserver: FakeMutationObserver,
    URLSearchParams,
    clearInterval: trackedClearInterval,
    console: { error() {} },
    document,
    location: { hash: "#channel=viewer-test" },
    parent,
    setInterval: trackedSetInterval,
    setTimeout,
    window
  };
  vm.createContext(harnessContext);
  vm.runInContext(runtimeSource, harnessContext, { filename: "drawio/viewer.js" });
  return {
    render() {
      for (const listener of windowListeners.get("message") || []) {
        listener({
          source: parent,
          data: {
            type: "ai-chat-drawio-render",
            channel: "viewer-test",
            artifactId: "artifact-runtime-test",
            xml: valid
          }
        });
      }
    },
    messageTypes: () => messages.map((message) => message.type),
    observerStats: () => ({ ...observerCounters }),
    activeIntervalCount: () => activeIntervals.size,
    visibilityListenerCount: () => documentListeners.get("visibilitychange")?.size || 0,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  };
}
