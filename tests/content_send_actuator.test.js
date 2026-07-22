#!/usr/bin/env node

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const contentSource = fs.readFileSync(
  path.join(__dirname, "..", "extension", "src", "content.js"),
  "utf8"
);

function extractFunctionSource(name) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, "g");
  const matches = Array.from(contentSource.matchAll(pattern));
  assert.equal(matches.length, 1, `${name} must have exactly one function declaration.`);
  const [match] = matches;
  const start = match.index;
  const bodyStart = contentSource.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `Missing body for ${name}`);

  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = bodyStart; index < contentSource.length; index += 1) {
    const char = contentSource[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return contentSource.slice(start, index + 1);
      }
    }
  }
  assert.fail(`Unterminated function ${name}`);
}

function sourceHash(text) {
  return crypto.createHash("sha256").update(`${text}\n`).digest("hex");
}

const v089FunctionHashes = {
  clickSendWhenReady: "b6e86501bce2b46bb035dcff8a353a94c8269389dc9eb14efbf50a26f053d202",
  trySubmitForm: "fd57e66ce5a99ba9f466955c668b68a6a9d0aae0782a481486e4ba312e4f2378",
  tryKeyboardSubmit: "3b82fe8da0c54821b0d53990eb2de69dfe1adf609857df2a9f4bb98fa9636cd8",
  waitForSubmitted: "f9684eacdd75c8c77d6cee16a373377d390e529c5fa85974c50eb7a293bc2c0f",
  findSendButton: "7b8f2ae7c8a2a0d62e4c2403460f223646060e8ba04ebfbd1f5d0e471492e34a"
};

for (const [name, expectedHash] of Object.entries(v089FunctionHashes)) {
  assert.equal(
    sourceHash(extractFunctionSource(name)),
    expectedHash,
    `${name} must remain byte-for-byte equivalent to the v0.8.9 implementation.`
  );
}

const clickSource = extractFunctionSource("clickSendWhenReady");
assert.match(clickSource, /findSendButton\(composer, attempt < 20\)/);
assert.match(clickSource, /attempt === 20 && trySubmitForm\(composer\)/);
assert.match(clickSource, /attempt === 21 && tryKeyboardSubmit\(composer\)/);
assert.doesNotMatch(clickSource, /reserve|budget|maxSendButtonClicks|currentOwnership|sendActuation/);

const findButtonSource = extractFunctionSource("findSendButton");
assert.match(findButtonSource, /if \(bound\) \{\s+return bound;/);
assert.match(findButtonSource, /composer\?\.closest\("form, footer, main, body"\) \|\| document/);
assert.doesNotMatch(findButtonSource, /isBoundSendButtonAssociatedWithComposer|isSendButtonAssociatedWithComposer/);

const guardedBoundarySource = extractFunctionSource("runOriginalSendActuatorForOwnedComposer");
assert.match(guardedBoundarySource, /sent = await clickSendWhenReady\(guard\.composer\)/);
assert.match(guardedBoundarySource, /stopStaleSideEffect/);
assert.match(guardedBoundarySource, /targetComposer\?\.closest\?\.\("form, footer, main, body"\)/);
assert.match(guardedBoundarySource, /sawTrustedComposerMutation/);
assert.match(guardedBoundarySource, /ORIGINAL_SEND_ACTUATOR_CANCELLED/);
assert.doesNotMatch(guardedBoundarySource, /clickSendWhenReady\(composer,/);
assert.doesNotMatch(guardedBoundarySource, /isOriginalSendActuatorEventOwnedByComposer|buttonForm|composerForm/);

const retrySource = extractFunctionSource("retryInsertedPendingHelperDelivery");
assert.match(retrySource, /entry\.sendActuatorGeneration/);
assert.match(retrySource, /waiting for manual send without repeating send actions/);

const sleepSource = extractFunctionSource("sleep");
assert.match(sleepSource, /type: "content-ui-delay"/);
assert.match(sleepSource, /activeOriginalSendActuatorGuard/);
assert.match(sleepSource, /Promise\.reject\(ORIGINAL_SEND_ACTUATOR_CANCELLED\)/);

function createGuardHarness() {
  class FakeTarget {
    constructor() {
      this.listeners = new Map();
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }

    emit(type, event) {
      for (const listener of this.listeners.get(type) || []) {
        listener(event);
      }
    }
  }

  class FakeElement extends FakeTarget {
    constructor(text = "") {
      super();
      this.innerText = text;
      this.textContent = text;
      this.isConnected = true;
      this.visible = true;
      this.root = null;
      this.tagName = "DIV";
      this.attributes = { role: "textbox" };
    }

    closest() {
      return this.root;
    }

    getAttribute(name) {
      return this.attributes[name] || "";
    }
  }

  const document = new FakeTarget();
  const context = {
    Element: FakeElement,
    ORIGINAL_SEND_ACTUATOR_CANCELLED: Symbol("cancelled"),
    activeOriginalSendActuatorGuard: null,
    chrome: {
      runtime: {
        sendMessage: async () => ({ ok: true })
      }
    },
    closestEditable: (target) => target instanceof FakeElement ? target : null,
    countSubmittedMessagesMatching: () => context.submittedCount,
    document,
    editableScore: (composer) => Number(composer?.score || 100),
    findBoundSendButton: () => null,
    findCurrentReplyInputSynchronously: () => context.currentComposer || null,
    getVisibleReplyInputCandidates: () => context.visibleComposers || (context.currentComposer ? [context.currentComposer] : []),
    getComposerText: (composer) => String(composer?.innerText || composer?.textContent || "").trim(),
    getValidatedComposerOwnershipText: (composer, expected) =>
      String(composer?.innerText || composer?.textContent || "").trim() === String(expected || "").trim()
        ? String(expected || "").trim()
        : "",
    inspectCurrentComposerOwnership: async (_preferred, expected) => {
      const composer = context.currentComposer;
      const actual = String(composer?.innerText || composer?.textContent || "").trim();
      if (!composer) {
        return { state: "unavailable", composer: null, text: "" };
      }
      if (actual && actual === String(expected || "").trim()) {
        return { state: "owned", composer, text: actual };
      }
      return { state: "changed", composer, text: "" };
    },
    isInsideShellToolPanel: () => false,
    isEditableElement: () => true,
    isVisibleElement: (composer) => composer?.visible !== false,
    lastComposerElement: null,
    setTimeout,
    submittedCount: 0
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunctionSource("isOriginalSendActuatorGuardCurrent"),
    extractFunctionSource("isOriginalSendActuatorEventForComposer"),
    extractFunctionSource("isLikelyReplyComposerCandidate"),
    extractFunctionSource("isStrongReplyComposerCandidate"),
    extractFunctionSource("runOriginalSendActuatorForOwnedComposer"),
    extractFunctionSource("sleep")
  ].join("\n\n"), context);
  return { context, FakeElement, FakeTarget };
}

async function verifyReplyComposerCandidateClassification() {
  const { context, FakeElement } = createGuardHarness();
  const commandBox = new FakeElement("printf test");
  commandBox.tagName = "TEXTAREA";
  commandBox.attributes = { placeholder: "Shell command" };
  const chatBox = new FakeElement("user draft");
  chatBox.tagName = "TEXTAREA";
  chatBox.attributes = { placeholder: "Message the assistant" };
  const unlabeledTextarea = new FakeElement("user draft");
  unlabeledTextarea.tagName = "TEXTAREA";
  unlabeledTextarea.attributes = {};
  assert.equal(context.isLikelyReplyComposerCandidate(commandBox), false);
  assert.equal(context.isLikelyReplyComposerCandidate(chatBox), true);
  assert.equal(context.isLikelyReplyComposerCandidate(unlabeledTextarea), true);
  assert.equal(context.isStrongReplyComposerCandidate(commandBox), false);
  assert.equal(context.isStrongReplyComposerCandidate(chatBox), true);
  assert.equal(context.isStrongReplyComposerCandidate(unlabeledTextarea), false);
}

async function verifyConnectedVisibleOldComposerCannotSendNewUserDraft() {
  const { context, FakeElement, FakeTarget } = createGuardHarness();
  const oldComposer = new FakeElement("plugin output");
  oldComposer.root = new FakeTarget();
  const currentComposer = new FakeElement("user draft");
  currentComposer.root = new FakeTarget();
  oldComposer.score = 100;
  currentComposer.score = 10;
  context.currentComposer = currentComposer;
  context.visibleComposers = [oldComposer, currentComposer];
  let prevented = false;
  context.clickSendWhenReady = async () => {
    context.document.emit("click", {
      type: "click",
      target: {},
      isTrusted: false,
      preventDefault() { prevented = true; },
      stopImmediatePropagation() {}
    });
    return false;
  };

  const sent = await context.runOriginalSendActuatorForOwnedComposer(
    oldComposer,
    () => true,
    "plugin output"
  );
  assert.equal(sent, false);
  assert.equal(prevented, true, "A connected visible stale composer must not authorize the current draft's button.");
}

async function verifyAnotherFormsSendButtonRetainsV089Authority() {
  const { context, FakeElement, FakeTarget } = createGuardHarness();
  const composerForm = new FakeTarget();
  const anotherForm = new FakeTarget();
  const composer = new FakeElement("plugin output");
  composer.root = composerForm;
  context.currentComposer = composer;
  let prevented = false;
  context.clickSendWhenReady = async () => {
    context.document.emit("click", {
      type: "click",
      target: { form: anotherForm },
      isTrusted: false,
      preventDefault() { prevented = true; },
      stopImmediatePropagation() {}
    });
    context.submittedCount = 1;
    return true;
  };

  const sent = await context.runOriginalSendActuatorForOwnedComposer(
    composer,
    () => true,
    "plugin output"
  );
  assert.equal(sent, true);
  assert.equal(prevented, false, "Outer ownership guards must not reintroduce form/button association filtering.");
}

async function verifyReparentedDetachedLoopCancelsBeforeNextSideEffect() {
  const { context, FakeElement, FakeTarget } = createGuardHarness();
  const composer = new FakeElement("plugin output");
  composer.root = new FakeTarget();
  context.currentComposer = composer;
  let attemptedAfterSleep = false;
  let resolveBackgroundDelay = null;
  context.chrome.runtime.sendMessage = () => new Promise((resolve) => {
    resolveBackgroundDelay = resolve;
  });
  context.clickSendWhenReady = async () => {
    const pendingSleep = context.sleep(0);
    assert.equal(typeof resolveBackgroundDelay, "function");
    composer.root = new FakeTarget();
    composer.isConnected = false;
    resolveBackgroundDelay({ ok: true });
    await pendingSleep;
    attemptedAfterSleep = true;
    return false;
  };

  const sent = await context.runOriginalSendActuatorForOwnedComposer(
    composer,
    () => true,
    "plugin output"
  );
  assert.equal(sent, false);
  assert.equal(attemptedAfterSleep, false, "Ownership loss must abort the old 80-round loop at its next await boundary.");
}

async function verifyDetachedComposerCannotSendCurrentUserDraft() {
  const { context, FakeElement, FakeTarget } = createGuardHarness();
  const oldRoot = new FakeTarget();
  const oldComposer = new FakeElement("plugin output");
  oldComposer.root = oldRoot;
  const currentComposer = new FakeElement("user draft");
  context.currentComposer = oldComposer;
  let documentClickPrevented = false;
  let detachedClickPrevented = false;
  let calls = 0;
  context.clickSendWhenReady = async () => {
    calls += 1;
    oldComposer.isConnected = false;
    context.currentComposer = currentComposer;
    context.document.emit("click", {
      type: "click",
      target: {},
      isTrusted: false,
      preventDefault() { documentClickPrevented = true; },
      stopImmediatePropagation() {}
    });
    oldRoot.emit("click", {
      type: "click",
      target: {},
      isTrusted: false,
      preventDefault() { detachedClickPrevented = true; },
      stopImmediatePropagation() {}
    });
    return false;
  };

  const sent = await context.runOriginalSendActuatorForOwnedComposer(
    oldComposer,
    () => true,
    "plugin output"
  );
  assert.equal(sent, false);
  assert.equal(calls, 1, "A user draft must not receive a redraw handoff.");
  assert.equal(documentClickPrevented, true, "The current document button must lose stale send authority.");
  assert.equal(detachedClickPrevented, true, "Detached composer-tree events must be captured locally.");
}

async function verifyExactRedrawGetsOneBoundedHandoff() {
  const { context, FakeElement, FakeTarget } = createGuardHarness();
  const oldComposer = new FakeElement("plugin output");
  oldComposer.root = new FakeTarget();
  const replacementComposer = new FakeElement("plugin output");
  replacementComposer.root = new FakeTarget();
  context.currentComposer = oldComposer;
  const calls = [];
  context.clickSendWhenReady = async (composer) => {
    calls.push(composer);
    if (composer === oldComposer) {
      oldComposer.isConnected = false;
      context.currentComposer = replacementComposer;
      return false;
    }
    context.submittedCount = 1;
    return true;
  };

  const sent = await context.runOriginalSendActuatorForOwnedComposer(
    oldComposer,
    () => true,
    "plugin output"
  );
  assert.equal(sent, true);
  assert.deepEqual(calls, [oldComposer, replacementComposer]);
}

async function verifyTrustedDeletionCannotBecomeSubmissionProof() {
  const { context, FakeElement, FakeTarget } = createGuardHarness();
  const composer = new FakeElement("plugin output");
  composer.root = new FakeTarget();
  context.currentComposer = composer;
  context.clickSendWhenReady = async () => {
    composer.innerText = "";
    composer.textContent = "";
    context.document.emit("input", {
      type: "input",
      target: composer,
      isTrusted: true
    });
    return true;
  };

  const sent = await context.runOriginalSendActuatorForOwnedComposer(
    composer,
    () => true,
    "plugin output"
  );
  assert.equal(sent, false, "Trusted user deletion must override v0.8.9's empty-composer heuristic.");
}

Promise.resolve()
  .then(verifyReplyComposerCandidateClassification)
  .then(verifyDetachedComposerCannotSendCurrentUserDraft)
  .then(verifyConnectedVisibleOldComposerCannotSendNewUserDraft)
  .then(verifyAnotherFormsSendButtonRetainsV089Authority)
  .then(verifyReparentedDetachedLoopCancelsBeforeNextSideEffect)
  .then(verifyExactRedrawGetsOneBoundedHandoff)
  .then(verifyTrustedDeletionCannotBecomeSubmissionProof)
  .then(() => console.log("content send actuator matches v0.8.9"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
