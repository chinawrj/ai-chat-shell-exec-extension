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

const v086AndV089FunctionHashes = {
  clickSendWhenReady: "b6e86501bce2b46bb035dcff8a353a94c8269389dc9eb14efbf50a26f053d202",
  trySubmitForm: "fd57e66ce5a99ba9f466955c668b68a6a9d0aae0782a481486e4ba312e4f2378",
  tryKeyboardSubmit: "3b82fe8da0c54821b0d53990eb2de69dfe1adf609857df2a9f4bb98fa9636cd8",
  waitForSubmitted: "f9684eacdd75c8c77d6cee16a373377d390e529c5fa85974c50eb7a293bc2c0f",
  findSendButton: "7b8f2ae7c8a2a0d62e4c2403460f223646060e8ba04ebfbd1f5d0e471492e34a"
};

for (const [name, expectedHash] of Object.entries(v086AndV089FunctionHashes)) {
  assert.equal(
    sourceHash(extractFunctionSource(name)),
    expectedHash,
    `${name} must remain byte-for-byte equivalent to the identical v0.8.6/v0.8.9 implementation.`
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
assert.doesNotMatch(guardedBoundarySource, /await callbacks\.onStarted/);
assert.match(guardedBoundarySource, /stopStaleSideEffect/);
assert.match(guardedBoundarySource, /targetComposer\?\.closest\?\.\("form, footer, main, body"\)/);
assert.match(guardedBoundarySource, /sawTrustedComposerMutation/);
assert.match(guardedBoundarySource, /callbacks\.onStarted/);
assert.match(guardedBoundarySource, /waitForOriginalSendActuatorComposerOwnership/);
assert.match(guardedBoundarySource, /waitForOriginalSendActuatorSubmissionProof/);
assert.match(guardedBoundarySource, /ORIGINAL_SEND_ACTUATOR_CANCELLED/);
assert.doesNotMatch(guardedBoundarySource, /clickSendWhenReady\(composer,/);
assert.doesNotMatch(guardedBoundarySource, /isOriginalSendActuatorEventOwnedByComposer|buttonForm|composerForm/);

const retrySource = extractFunctionSource("retryInsertedPendingHelperDelivery");
assert.match(retrySource, /entry\.sendActuatorGeneration/);
assert.match(retrySource, /onStarted:/);
assert.match(retrySource, /waiting for manual send without repeating send actions/);
assert.match(retrySource, /send ownership guard is not ready; will retry without rewriting the composer/);
assert.match(
  retrySource,
  /entry\.lastError = entry\.sendActuatorGeneration === pageLifecycleGeneration/,
  "A preflight ownership veto must not be reported as a completed v0.8.6\/v0.8.9 actuator run."
);

const sleepSource = extractFunctionSource("sleep");
assert.match(sleepSource, /contentUiDelay\(ms\)/);
assert.match(sleepSource, /activeOriginalSendActuatorGuard/);
assert.match(sleepSource, /Promise\.reject\(ORIGINAL_SEND_ACTUATOR_CANCELLED\)/);
assert.match(extractFunctionSource("contentUiDelay"), /type: "content-ui-delay"/);

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
  document.activeElement = null;
  const context = {
    COMPOSER_HANDOFF_SETTLE_ATTEMPTS: 4,
    COMPOSER_HANDOFF_SETTLE_DELAY_MS: 0,
    Element: FakeElement,
    ORIGINAL_SEND_ACTUATOR_CANCELLED: Symbol("cancelled"),
    activeOriginalSendActuatorGuard: null,
    chrome: {
      storage: {
        local: {
          set: async (snapshot) => context.storageWrites.push(snapshot)
        }
      },
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
    composerOwnershipTextsMatch: (actual, expected) =>
      String(actual || "").trim() === String(expected || "").trim(),
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
    isInsideShellToolPanel: (composer) => composer?.insidePanel === true,
    isEditableElement: () => true,
    isVisibleElement: (composer) => composer?.visible !== false,
    lastComposerElement: null,
    lastComposerSelector: "",
    location: { host: "chatgpt.com" },
    normalizeCommand: (value) => String(value || "").replace(/\r\n?/g, "\n").trim(),
    buildStableSelector: (composer) => composer?.id ? `#${composer.id}` : "",
    composerProfileKey: () => "composer:test",
    storageWrites: [],
    setTimeout,
    submittedCount: 0
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunctionSource("isOriginalSendActuatorGuardCurrent"),
    extractFunctionSource("hasCompetingVisibleUserDraft"),
    extractFunctionSource("isConfidentCompetingReplyComposerCandidate"),
    extractFunctionSource("isOriginalSendActuatorEventForComposer"),
    extractFunctionSource("isLikelyReplyComposerCandidate"),
    extractFunctionSource("isStrongReplyComposerCandidate"),
    extractFunctionSource("rememberComposer"),
    extractFunctionSource("waitForOriginalSendActuatorComposerOwnership"),
    extractFunctionSource("waitForOriginalSendActuatorSubmissionProof"),
    extractFunctionSource("runOriginalSendActuatorForOwnedComposer"),
    extractFunctionSource("contentUiDelay"),
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
  const searchBox = new FakeElement("find an old chat");
  searchBox.attributes = { role: "textbox", "aria-label": "Search chats" };
  assert.equal(context.isLikelyReplyComposerCandidate(commandBox), false);
  assert.equal(context.isLikelyReplyComposerCandidate(chatBox), true);
  assert.equal(context.isLikelyReplyComposerCandidate(unlabeledTextarea), true);
  assert.equal(context.isStrongReplyComposerCandidate(commandBox), false);
  assert.equal(context.isStrongReplyComposerCandidate(chatBox), true);
  assert.equal(context.isStrongReplyComposerCandidate(unlabeledTextarea), false);
  assert.equal(context.isLikelyReplyComposerCandidate(searchBox), false, "Search textboxes are not reply composers.");
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
  let calls = 0;
  context.clickSendWhenReady = async () => {
    calls += 1;
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
  assert.equal(calls, 0, "A proven competing user draft must stop the stale actuator before it discovers or clicks a button.");
  assert.equal(prevented, false);
}

async function verifyLowerScoredVisibleReplyDraftStillBlocksSend() {
  const { context, FakeElement, FakeTarget } = createGuardHarness();
  const pluginComposer = new FakeElement("plugin output");
  pluginComposer.root = new FakeTarget();
  pluginComposer.score = 100;
  const userDraftComposer = new FakeElement("user draft");
  userDraftComposer.root = new FakeTarget();
  userDraftComposer.score = 1;
  context.currentComposer = pluginComposer;
  context.document.activeElement = pluginComposer;
  context.visibleComposers = [pluginComposer, userDraftComposer];
  let calls = 0;
  let starts = 0;
  context.clickSendWhenReady = async () => {
    calls += 1;
    return false;
  };

  const sent = await context.runOriginalSendActuatorForOwnedComposer(
    pluginComposer,
    () => true,
    "plugin output",
    { onStarted: () => { starts += 1; } }
  );
  assert.equal(sent, false);
  assert.equal(
    calls,
    0,
    "Any visible reply composer containing a different user draft blocks sending, even when it is neither active nor the highest-scored candidate."
  );
  assert.equal(starts, 0, "A rejected competing draft must not consume the lifecycle's sole actuator generation.");
}

async function verifyInactiveGenericToolTextareaDoesNotBlockSend() {
  const { context, FakeElement, FakeTarget } = createGuardHarness();
  const pluginComposer = new FakeElement("plugin output");
  pluginComposer.root = new FakeTarget();
  pluginComposer.attributes = { role: "textbox", "aria-label": "Chat composer" };
  const toolTextarea = new FakeElement("Inspect the local parser and reply to master.");
  toolTextarea.root = new FakeTarget();
  toolTextarea.tagName = "TEXTAREA";
  toolTextarea.attributes = {};
  context.currentComposer = pluginComposer;
  context.document.activeElement = pluginComposer;
  context.visibleComposers = [pluginComposer, toolTextarea];
  context.clickSendWhenReady = async () => {
    context.submittedCount = 1;
    return true;
  };

  const sent = await context.runOriginalSendActuatorForOwnedComposer(
    pluginComposer,
    () => true,
    "plugin output"
  );
  assert.equal(
    sent,
    true,
    "An inactive generic tool textarea must not veto a proven reply composer merely because it is visible and prefilled."
  );

  toolTextarea.innerText = "active user draft";
  toolTextarea.textContent = "active user draft";
  context.document.activeElement = toolTextarea;
  context.submittedCount = 0;
  context.clickSendWhenReady = async () => {
    assert.fail("An active ambiguous textarea must fail closed before the send actuator runs.");
  };
  const blocked = await context.runOriginalSendActuatorForOwnedComposer(
    pluginComposer,
    () => true,
    "plugin output"
  );
  assert.equal(blocked, false);
}

async function verifyPreflightVetoDoesNotConsumeOrMisreportActuatorGeneration() {
  const composer = { innerText: "plugin output", textContent: "plugin output" };
  let wrapperCalls = 0;
  let startedCalls = 0;
  let retrySchedules = 0;
  const context = {
    pageLifecycleGeneration: 7,
    findReplyInput: async () => composer,
    getValidatedComposerOwnershipText: () => "plugin output",
    withComposerDeliveryLease: async (_metadata, action) => action({ id: "lease" }),
    isComposerDeliveryTokenCurrent: () => true,
    runOriginalSendActuatorForOwnedComposer: async () => {
      wrapperCalls += 1;
      return false;
    },
    inspectCurrentComposerOwnership: async () => ({ state: "owned", composer }),
    getComposerText: (node) => node?.innerText || "",
    persistPendingHelperDeliveries: async () => {},
    setPendingHelperDeliveryStatus: () => {},
    schedulePendingHelperDeliveryRetry: () => { retrySchedules += 1; },
    cancelPendingHelperDeliveryAfterComposerRemoval: async () => false,
    finalizePendingHelperDelivery: async () => true
  };
  vm.createContext(context);
  vm.runInContext(extractFunctionSource("retryInsertedPendingHelperDelivery"), context);
  const entry = {
    callId: "preflight-veto",
    pageIdentity: "page",
    reply: "plugin output",
    phase: "inserted"
  };

  assert.equal(await context.retryInsertedPendingHelperDelivery(entry, { autoSend: true }), false);
  assert.equal(wrapperCalls, 1);
  assert.equal(entry.sendActuatorGeneration, undefined, "A guard veto before onStarted must not consume the lifecycle generation.");
  assert.equal(entry.lastError, "send ownership guard is not ready; will retry without rewriting the composer");
  assert.equal(retrySchedules, 1);

  context.runOriginalSendActuatorForOwnedComposer = async (_composer, _continue, _expected, callbacks) => {
    wrapperCalls += 1;
    startedCalls += 1;
    await callbacks.onStarted();
    return false;
  };
  assert.equal(await context.retryInsertedPendingHelperDelivery(entry, { autoSend: true }), false);
  assert.equal(startedCalls, 1);
  assert.equal(entry.sendActuatorGeneration, 7);
  assert.equal(
    entry.lastError,
    "the original v0.8.9 send attempt finished; waiting for manual send without repeating send actions"
  );
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

async function verifyOverlappingExactRedrawDoesNotAbort() {
  const { context, FakeElement, FakeTarget } = createGuardHarness();
  const oldComposer = new FakeElement("plugin output");
  oldComposer.root = new FakeTarget();
  const replacementComposer = new FakeElement("plugin output");
  replacementComposer.root = new FakeTarget();
  context.currentComposer = replacementComposer;
  context.visibleComposers = [oldComposer, replacementComposer];
  let prevented = false;
  context.clickSendWhenReady = async () => {
    context.document.emit("click", {
      type: "click",
      target: {},
      isTrusted: false,
      preventDefault() { prevented = true; },
      stopImmediatePropagation() {}
    });
    context.submittedCount = 1;
    return true;
  };

  const sent = await context.runOriginalSendActuatorForOwnedComposer(
    oldComposer,
    () => true,
    "plugin output"
  );
  assert.equal(sent, true);
  assert.equal(prevented, false, "A second visible composer with the exact plugin text is a redraw copy, not a competing draft.");
}

async function verifyEmptyFirstRedrawSettlesForOneHandoff() {
  const { context, FakeElement, FakeTarget } = createGuardHarness();
  const oldComposer = new FakeElement("plugin output");
  oldComposer.root = new FakeTarget();
  const replacementComposer = new FakeElement("");
  replacementComposer.root = new FakeTarget();
  context.currentComposer = oldComposer;
  context.visibleComposers = [oldComposer];
  const calls = [];
  let ownershipChecks = 0;
  context.inspectCurrentComposerOwnership = async (_preferred, expected) => {
    ownershipChecks += 1;
    if (ownershipChecks === 1) {
      return { state: "changed", composer: replacementComposer, text: "" };
    }
    replacementComposer.innerText = expected;
    replacementComposer.textContent = expected;
    context.currentComposer = replacementComposer;
    context.visibleComposers = [replacementComposer];
    return { state: "owned", composer: replacementComposer, text: expected };
  };
  context.clickSendWhenReady = async (composer) => {
    calls.push(composer);
    if (composer === oldComposer) {
      oldComposer.isConnected = false;
      context.currentComposer = replacementComposer;
      context.visibleComposers = [replacementComposer];
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
  assert.equal(sent, true, "An empty-first framework redraw must settle into the one existing handoff.");
  assert.deepEqual(calls, [oldComposer, replacementComposer], "The outer actuator may touch at most the old and one replacement composer.");
  assert.equal(ownershipChecks, 2);
}

async function verifyUnrelatedSearchMutationDoesNotAbort() {
  const { context, FakeElement, FakeTarget } = createGuardHarness();
  const composer = new FakeElement("plugin output");
  composer.root = new FakeTarget();
  const searchBox = new FakeElement("search query");
  searchBox.root = new FakeTarget();
  searchBox.attributes = { role: "textbox", "aria-label": "Search chats" };
  context.currentComposer = composer;
  context.visibleComposers = [composer, searchBox];
  context.document.activeElement = searchBox;
  context.clickSendWhenReady = async () => {
    context.document.emit("input", {
      type: "input",
      target: searchBox,
      isTrusted: true
    });
    context.submittedCount = 1;
    return true;
  };

  const sent = await context.runOriginalSendActuatorForOwnedComposer(
    composer,
    () => true,
    "plugin output"
  );
  assert.equal(sent, true, "Typing in an unrelated search editor must not cancel plugin-owned composer submission.");
}

async function verifyTrustedHostClearWaitsForDelayedSubmissionProof() {
  const { context, FakeElement, FakeTarget } = createGuardHarness();
  const composer = new FakeElement("plugin output");
  composer.root = new FakeTarget();
  context.currentComposer = composer;
  context.visibleComposers = [composer];
  let delays = 0;
  let cancellations = 0;
  context.chrome.runtime.sendMessage = async () => {
    delays += 1;
    if (delays === 1) {
      context.submittedCount = 1;
    }
    return { ok: true };
  };
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
    "plugin output",
    { onUserCancellation: () => { cancellations += 1; } }
  );
  assert.equal(sent, true, "A host-cleared composer is submission when the exact user message appears moments later.");
  assert.equal(cancellations, 0, "Delayed host rendering must not be reported as user cancellation.");
}

async function verifyActuatorHeuristicWithoutSubmissionProofStaysPending() {
  const { context, FakeElement, FakeTarget } = createGuardHarness();
  const composer = new FakeElement("plugin output");
  composer.root = new FakeTarget();
  context.currentComposer = composer;
  context.visibleComposers = [composer];
  context.clickSendWhenReady = async () => {
    composer.innerText = "";
    composer.textContent = "";
    return true;
  };

  const sent = await context.runOriginalSendActuatorForOwnedComposer(
    composer,
    () => true,
    "plugin output"
  );
  assert.equal(
    sent,
    false,
    "The pinned actuator's cleared-composer heuristic cannot prove submission without a new exact user-message root."
  );
}

async function verifyOnStartedPersistenceCannotDelayFirstActuatorCall() {
  const { context, FakeElement, FakeTarget } = createGuardHarness();
  const composer = new FakeElement("plugin output");
  composer.root = new FakeTarget();
  context.currentComposer = composer;
  context.visibleComposers = [composer];
  let generationRecorded = false;
  let actuatorCalls = 0;
  context.clickSendWhenReady = async () => {
    actuatorCalls += 1;
    assert.equal(generationRecorded, true);
    context.submittedCount = 1;
    return true;
  };

  const sent = await context.runOriginalSendActuatorForOwnedComposer(
    composer,
    () => true,
    "plugin output",
    {
      onStarted: () => {
        generationRecorded = true;
        return new Promise(() => {});
      }
    }
  );
  assert.equal(sent, true);
  assert.equal(actuatorCalls, 1, "Unresolved persistence must not create a pre-actuator redraw window.");
}

async function verifyActuatorGenerationStartsOnlyAfterGuardAcquisition() {
  const { context, FakeElement, FakeTarget } = createGuardHarness();
  const composer = new FakeElement("plugin output");
  composer.root = new FakeTarget();
  context.currentComposer = composer;
  context.visibleComposers = [composer];
  context.activeOriginalSendActuatorGuard = { occupied: true };
  let started = 0;
  const callbacks = { onStarted: () => { started += 1; } };

  const blocked = await context.runOriginalSendActuatorForOwnedComposer(
    composer,
    () => true,
    "plugin output",
    callbacks
  );
  assert.equal(blocked, false);
  assert.equal(started, 0, "A delivery that never acquires the outer guard must not consume its lifecycle actuator generation.");

  context.activeOriginalSendActuatorGuard = null;
  context.clickSendWhenReady = async () => false;
  await context.runOriginalSendActuatorForOwnedComposer(
    composer,
    () => true,
    "plugin output",
    callbacks
  );
  assert.equal(started, 1, "The lifecycle generation is recorded exactly when the actuator actually starts.");
}

async function verifyPanelAndSearchInputsAreNeverRememberedAsComposer() {
  const { context, FakeElement } = createGuardHarness();
  const panelInput = new FakeElement("master");
  panelInput.id = "agent-id";
  panelInput.insidePanel = true;
  const searchBox = new FakeElement("query");
  searchBox.id = "chat-search";
  searchBox.attributes = { role: "textbox", "aria-label": "Search chats" };
  const replyComposer = new FakeElement("");
  replyComposer.id = "prompt-textarea";
  replyComposer.attributes = { role: "textbox", "aria-label": "Chat with ChatGPT" };

  context.rememberComposer(panelInput);
  context.rememberComposer(searchBox);
  assert.equal(context.lastComposerElement, null);
  assert.equal(context.storageWrites.length, 0);

  context.rememberComposer(replyComposer);
  await Promise.resolve();
  assert.equal(context.lastComposerElement, replyComposer);
  assert.equal(context.storageWrites.length, 1);
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
  .then(verifyLowerScoredVisibleReplyDraftStillBlocksSend)
  .then(verifyInactiveGenericToolTextareaDoesNotBlockSend)
  .then(verifyPreflightVetoDoesNotConsumeOrMisreportActuatorGeneration)
  .then(verifyAnotherFormsSendButtonRetainsV089Authority)
  .then(verifyReparentedDetachedLoopCancelsBeforeNextSideEffect)
  .then(verifyExactRedrawGetsOneBoundedHandoff)
  .then(verifyOverlappingExactRedrawDoesNotAbort)
  .then(verifyEmptyFirstRedrawSettlesForOneHandoff)
  .then(verifyUnrelatedSearchMutationDoesNotAbort)
  .then(verifyTrustedHostClearWaitsForDelayedSubmissionProof)
  .then(verifyActuatorHeuristicWithoutSubmissionProofStaysPending)
  .then(verifyOnStartedPersistenceCannotDelayFirstActuatorCall)
  .then(verifyActuatorGenerationStartsOnlyAfterGuardAcquisition)
  .then(verifyPanelAndSearchInputsAreNeverRememberedAsComposer)
  .then(verifyTrustedDeletionCannotBecomeSubmissionProof)
  .then(() => console.log("content send actuator matches v0.8.6/v0.8.9"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
