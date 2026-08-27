#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadContentContext() {
  const localStore = {};
  const sessionStore = {};
  const mutationObservers = [];
  const scheduledTimers = [];
  const context = {
    CSS: { escape: (value) => String(value) },
    Element: class Element {},
    HTMLButtonElement: class HTMLButtonElement {},
    HTMLInputElement: class HTMLInputElement {},
    HTMLTextAreaElement: class HTMLTextAreaElement {},
    InputEvent: class InputEvent {},
    MutationObserver: class MutationObserver {
      constructor(callback) {
        this.callback = callback;
        mutationObservers.push(this);
      }
      observe() {}
      disconnect() {}
    },
    Node: {
      DOCUMENT_POSITION_FOLLOWING: 4,
      DOCUMENT_POSITION_PRECEDING: 2
    },
    chrome: {
      runtime: {
        id: "lkmeogidbglhedgekjgbpbfjkpapnhke",
        sendMessage: async () => ({ ok: true })
      },
      storage: {
        onChanged: { addListener() {} },
        sync: { get: async () => ({ enabled: false }) },
        local: {
          async get(keys) {
            const selected = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              if (Object.prototype.hasOwnProperty.call(localStore, key)) {
                selected[key] = structuredClone(localStore[key]);
              }
            }
            return selected;
          },
          async set(values) {
            for (const [key, value] of Object.entries(values || {})) {
              localStore[key] = structuredClone(value);
            }
          },
          async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              delete localStore[key];
            }
          }
        }
      }
    },
    clearTimeout(timer) {
      if (timer && typeof timer === "object") {
        timer.cancelled = true;
      }
    },
    console,
    document: {
      activeElement: null,
      body: null,
      documentElement: {},
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {}
    },
    location: {
      hostname: "chatgpt.com",
      href: "https://chatgpt.com/",
      origin: "https://chatgpt.com",
      pathname: "/",
      port: "",
      protocol: "https:"
    },
    setTimeout(callback, delay = 0) {
      const timer = {
        callback,
        delay: Number(delay || 0),
        cancelled: false,
        ran: false
      };
      scheduledTimers.push(timer);
      return timer;
    },
    window: {
      confirm: () => true,
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      addEventListener() {},
      removeEventListener() {},
      sessionStorage: {
        getItem: (key) => Object.prototype.hasOwnProperty.call(sessionStore, key)
          ? sessionStore[key]
          : null,
        setItem: (key, value) => {
          sessionStore[key] = String(value);
        },
        removeItem: (key) => {
          delete sessionStore[key];
        }
      }
    }
  };

  vm.createContext(context);
  const source = fs.readFileSync(
    path.join(__dirname, "..", "extension", "src", "content.js"),
    "utf8"
  );
  vm.runInContext(source, context, { filename: "content.js" });
  context.__localStore = localStore;
  context.__mutationObservers = mutationObservers;
  context.__runScheduledTimersThrough = async (maximumDelay) => {
    for (const timer of scheduledTimers) {
      if (timer.cancelled || timer.ran || timer.delay > maximumDelay) {
        continue;
      }
      timer.ran = true;
      await timer.callback();
    }
    await Promise.resolve();
    await Promise.resolve();
  };
  return context;
}

function createShellCall(context, command) {
  return context.parseCallPayload([
    "ai-helper-shell-start",
    command,
    "ai-helper-shell-end"
  ].join("\n"));
}

function createSubmittedUserMessage(text) {
  return {
    innerText: text,
    textContent: text,
    getAttribute(name) {
      return name === "data-message-author-role" ? "user" : "";
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
}

function navigate(context, pathname) {
  context.location.pathname = pathname;
  context.location.href = `${context.location.origin}${pathname}`;
  context.refreshPageLifecycle();
}

function navigateWithoutLifecycleRefresh(context, pathname) {
  context.location.pathname = pathname;
  context.location.href = `${context.location.origin}${pathname}`;
}

async function settleBootstrap() {
  await Promise.resolve();
  await Promise.resolve();
}

async function testExactPluginTextMigratesAcrossRouteChange() {
  const context = loadContentContext();
  await settleBootstrap();
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    requireApproval: false,
    autoSend: true
  });
  context.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);

  let backendRuns = 0;
  let composerWrites = 0;
  let sendAttempts = 0;
  const submitted = [];
  let currentComposer = {
    innerText: "",
    textContent: "",
    isConnected: true
  };
  context.document.querySelectorAll = (selector) =>
    selector.includes("data-message-author-role") ? submitted : [];
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "content-ui-delay") {
      return { ok: true };
    }
    if (payload.type === "run-result-presented") {
      return { ok: true, found: true };
    }
    assert.equal(payload.type, "run-shell");
    backendRuns += 1;
    return {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: "0123456789abcdef",
      exitCode: 0,
      stdout: "route-owned-output"
    };
  };
  context.insertReply = async (text) => {
    composerWrites += 1;
    currentComposer.innerText = text;
    currentComposer.textContent = text;
    return currentComposer;
  };
  context.findReplyInput = async () => currentComposer;
  context.clickSendWhenReady = async (composer) => {
    sendAttempts += 1;
    assert.equal(composer, currentComposer);
    const expectedText = context.getComposerText(composer);
    assert.ok(expectedText);
    if (sendAttempts === 1) {
      return false;
    }
    submitted.push(createSubmittedUserMessage(expectedText));
    composer.innerText = "";
    composer.textContent = "";
    return true;
  };

  const call = createShellCall(context, "printf route-owned-output");
  const first = await context.runAndReply("route-owned-call", call);
  assert.equal(first.pendingDelivery, true);
  assert.equal(backendRuns, 1);
  assert.equal(composerWrites, 1);
  assert.equal(sendAttempts, 1);
  const insertedText = currentComposer.innerText;
  assert.match(insertedText, /route-owned-output/);
  const oldGeneration = vm.runInContext("pageLifecycleGeneration", context);
  const oldIdentity = context.getCurrentPageIdentity();

  // A route-only pushState/replaceState can happen without any DOM mutation.
  // The retry timer itself must refresh/migrate lifecycle state before it
  // chooses the new route-scoped storage key.
  navigateWithoutLifecycleRefresh(context, "/c/route-owned");
  assert.notEqual(context.getCurrentPageIdentity(), oldIdentity);

  await context.retryPendingHelperDeliveries();

  assert.ok(
    vm.runInContext("pageLifecycleGeneration", context) > oldGeneration,
    "The retry path itself must observe and migrate a route-only navigation."
  );
  assert.equal(backendRuns, 1, "Route migration must never execute the helper again.");
  assert.equal(composerWrites, 1, "Route migration must never write the helper result again.");
  assert.equal(sendAttempts, 2, "The migrated delivery should retry only submission.");
  assert.equal(submitted.length, 1, "The exact plugin-owned result should be submitted once.");
  assert.equal(submitted[0].innerText, insertedText);
  assert.equal(currentComposer.innerText, "");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
}

async function testDifferentUserDraftDoesNotMigrateOrSend() {
  const context = loadContentContext();
  await settleBootstrap();
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    requireApproval: false,
    autoSend: true
  });
  context.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);

  let backendRuns = 0;
  let composerWrites = 0;
  let sendAttempts = 0;
  const submitted = [];
  let currentComposer = {
    innerText: "",
    textContent: "",
    isConnected: true
  };
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "content-ui-delay") {
      return { ok: true };
    }
    if (payload.type === "run-result-presented") {
      throw new Error("An unrelated user draft must not be marked presented.");
    }
    assert.equal(payload.type, "run-shell");
    backendRuns += 1;
    return {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: "fedcba9876543210",
      exitCode: 0,
      stdout: "must-not-adopt"
    };
  };
  context.insertReply = async (text) => {
    composerWrites += 1;
    currentComposer.innerText = text;
    currentComposer.textContent = text;
    return currentComposer;
  };
  context.findReplyInput = async () => currentComposer;
  context.clickSendWhenReady = async () => {
    sendAttempts += 1;
    return false;
  };

  const call = createShellCall(context, "printf must-not-adopt");
  const first = await context.runAndReply("route-user-draft-call", call);
  assert.equal(first.pendingDelivery, true);
  assert.equal(sendAttempts, 1);

  currentComposer.innerText = "This is the user's unrelated draft";
  currentComposer.textContent = currentComposer.innerText;
  navigateWithoutLifecycleRefresh(context, "/c/user-draft");
  await context.retryPendingHelperDeliveries();

  assert.equal(backendRuns, 1);
  assert.equal(composerWrites, 1);
  assert.equal(sendAttempts, 1, "A different draft must never receive a send attempt.");
  assert.deepEqual(submitted, []);
  assert.equal(currentComposer.innerText, "This is the user's unrelated draft");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
}

async function testSubmittedUnconfirmedExactComposerSurvivesRouteAndResumesSendOnly() {
  const context = loadContentContext();
  await settleBootstrap();
  context.chrome.storage.sync.get = async () => ({ enabled: true, requireApproval: false, autoSend: true });
  context.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);

  let backendRuns = 0;
  let composerWrites = 0;
  let sendAttempts = 0;
  let receiptAttempts = 0;
  const submitted = [];
  const composer = { innerText: "", textContent: "", isConnected: true };
  context.document.querySelectorAll = (selector) =>
    selector.includes("data-message-author-role") ? submitted : [];
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "content-ui-delay") return { ok: true };
    if (payload.type === "run-result-presented") {
      receiptAttempts += 1;
      return { ok: true, found: true };
    }
    assert.equal(payload.type, "run-shell");
    backendRuns += 1;
    return {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: "abababababababab",
      exitCode: 0,
      stdout: "route-unconfirmed"
    };
  };
  context.insertReply = async (text) => {
    composerWrites += 1;
    composer.innerText = text;
    composer.textContent = text;
    return composer;
  };
  context.findReplyInput = async () => composer;
  context.clickSendWhenReady = async () => {
    sendAttempts += 1;
    if (sendAttempts === 1) return false;
    submitted.push(createSubmittedUserMessage(composer.innerText));
    composer.innerText = "";
    composer.textContent = "";
    return true;
  };

  const call = createShellCall(context, "printf route-unconfirmed");
  const first = await context.runAndReply("route-unconfirmed", call);
  assert.equal(first.pendingDelivery, true);
  const entry = vm.runInContext("Array.from(pendingHelperDeliveries.values())[0]", context);
  entry.phase = "submitted-unconfirmed";
  entry.composerElement = null;
  entry.lastError = "waiting for exact submitted-message proof";
  await context.persistPendingHelperDeliveries();

  navigateWithoutLifecycleRefresh(context, "/c/submitted-unconfirmed-exact");
  await context.retryPendingHelperDeliveries();

  assert.equal(backendRuns, 1, "Route recovery must never replay the backend operation.");
  assert.equal(composerWrites, 1, "Route recovery must never rewrite the plugin-owned composer.");
  assert.equal(sendAttempts, 2, "Exact route-handoff ownership should resume with one send-only attempt.");
  assert.equal(submitted.length, 1);
  assert.equal(receiptAttempts, 1);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
}

async function testSubmittedUnconfirmedChangedComposerCancelsAcrossRoute() {
  for (const replacement of ["This is the user's route draft", "Shell call result with non-exact plugin text"]) {
    const context = loadContentContext();
    await settleBootstrap();
    context.chrome.storage.sync.get = async () => ({ enabled: true, requireApproval: false, autoSend: true });
    context.setStatus = () => {};
    vm.runInContext("extensionActive = true; beginPageLifecycle();", context);

    let backendRuns = 0;
    let composerWrites = 0;
    let sendAttempts = 0;
    let receiptAttempts = 0;
    const composer = { innerText: "", textContent: "", isConnected: true };
    context.document.querySelectorAll = () => [];
    context.chrome.runtime.sendMessage = async (payload) => {
      if (payload.type === "content-ui-delay") return { ok: true };
      if (payload.type === "run-result-presented") {
        receiptAttempts += 1;
        return { ok: true, found: true };
      }
      assert.equal(payload.type, "run-shell");
      backendRuns += 1;
      return {
        ok: true,
        executed: true,
        executionCompleted: true,
        executionId: replacement.startsWith("This") ? "cdcdcdcdcdcdcdcd" : "efefefefefefefef",
        exitCode: 0,
        stdout: "route-cancel"
      };
    };
    context.insertReply = async (text) => {
      composerWrites += 1;
      composer.innerText = text;
      composer.textContent = text;
      return composer;
    };
    context.findReplyInput = async () => composer;
    context.clickSendWhenReady = async () => {
      sendAttempts += 1;
      return false;
    };

    const call = createShellCall(context, "printf route-cancel");
    const first = await context.runAndReply(`route-cancel-${replacement.length}`, call);
    assert.equal(first.pendingDelivery, true);
    const entry = vm.runInContext("Array.from(pendingHelperDeliveries.values())[0]", context);
    entry.phase = "submitted-unconfirmed";
    entry.composerElement = null;
    entry.lastError = "waiting for exact submitted-message proof";
    await context.persistPendingHelperDeliveries();
    composer.innerText = replacement;
    composer.textContent = replacement;

    navigateWithoutLifecycleRefresh(context, `/c/submitted-unconfirmed-cancel-${replacement.length}`);
    await context.retryPendingHelperDeliveries();

    assert.equal(backendRuns, 1);
    assert.equal(composerWrites, 1);
    assert.equal(sendAttempts, 1, "A changed route composer must never regain send authority.");
    assert.equal(receiptAttempts, 0);
    assert.equal(composer.innerText, replacement);
    assert.equal(
      vm.runInContext("pendingHelperDeliveries.size", context),
      0,
      "A non-exact non-empty route composer is cancellation, not an indefinitely pending delivery."
    );
  }
}

async function testQueuedFileResultSurvivesRouteWithoutBackendReplay() {
  const context = loadContentContext();
  await settleBootstrap();
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    requireApproval: false,
    autoSend: true
  });
  context.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);

  const call = context.parseCallPayload([
    "ai-helper-file-start",
    "queued-route.txt",
    "queued file result",
    "ai-helper-file-end"
  ].join("\n"));
  const renderRoot = new context.Element();
  const candidate = {
    call,
    node: renderRoot,
    textRoot: renderRoot,
    source: "text",
    blockIndex: 0,
    index: 0
  };
  const semanticCallKey = context.buildSemanticCallKey(call);
  const firstCallKey = context.buildCandidateCallKey(candidate, semanticCallKey);
  context.markCallProcessed(candidate, firstCallKey, semanticCallKey);

  let backendRuns = 0;
  let composerWrites = 0;
  let sendAttempts = 0;
  const submitted = [];
  let composerAvailable = false;
  const composer = { innerText: "", textContent: "", isConnected: true };
  context.document.querySelectorAll = (selector) =>
    selector.includes("data-message-author-role") ? submitted : [];
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "content-ui-delay") {
      return { ok: true };
    }
    assert.equal(payload.type, "write-file");
    backendRuns += 1;
    return {
      ok: true,
      filename: "queued-route.txt",
      path: "/tmp/queued-route.txt",
      bytes: 18
    };
  };
  context.insertReply = async (text) => {
    if (!composerAvailable) {
      throw new Error("composer unavailable during route transition");
    }
    composerWrites += 1;
    composer.innerText = text;
    composer.textContent = text;
    return composer;
  };
  context.findReplyInput = async () => composer;
  context.clickSendWhenReady = async () => {
    sendAttempts += 1;
    submitted.push(createSubmittedUserMessage(context.getComposerText(composer)));
    composer.innerText = "";
    composer.textContent = "";
    return true;
  };

  const first = await context.runAndReply(firstCallKey, call);
  assert.equal(first.pendingDelivery, true);
  assert.equal(backendRuns, 1);
  assert.equal(composerWrites, 0);
  assert.equal(vm.runInContext("Array.from(pendingHelperDeliveries.values())[0].phase", context), "queued");

  navigateWithoutLifecycleRefresh(context, "/c/queued-file-route");
  context.refreshPageLifecycle();
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 1, "Queued backend results must survive a route handoff.");
  assert.equal(vm.runInContext("Array.from(pendingHelperDeliveries.values())[0].phase", context), "queued");
  const secondCallKey = context.buildCandidateCallKey(candidate, semanticCallKey);
  assert.match(
    context.getHandledHelperReason(candidate, secondCallKey, semanticCallKey, call),
    /carried across pending route delivery/,
    "The same rendered file helper must remain handled while its queued result crosses the route."
  );

  composerAvailable = true;
  await context.retryPendingHelperDeliveries();
  assert.equal(backendRuns, 1, "Route recovery must deliver the queued file result without writing the file again.");
  assert.equal(composerWrites, 1);
  assert.equal(sendAttempts, 1);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
}

async function testSubmittedReceiptAndTombstoneSurviveRouteChange() {
  const context = loadContentContext();
  await settleBootstrap();
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    requireApproval: false,
    autoSend: true
  });
  context.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);

  let backendRuns = 0;
  let composerWrites = 0;
  let sendAttempts = 0;
  let receiptAttempts = 0;
  const submitted = [];
  const composer = { innerText: "", textContent: "", isConnected: true };
  context.document.querySelectorAll = (selector) =>
    selector.includes("data-message-author-role") ? submitted : [];
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "content-ui-delay") {
      return { ok: true };
    }
    if (payload.type === "run-result-presented") {
      receiptAttempts += 1;
      return receiptAttempts === 1
        ? { ok: false, found: true }
        : { ok: true, found: true };
    }
    backendRuns += 1;
    return {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: "0011223344556677",
      exitCode: 0,
      stdout: "receipt-route-output"
    };
  };
  context.insertReply = async (text) => {
    composerWrites += 1;
    composer.innerText = text;
    composer.textContent = text;
    return composer;
  };
  context.clickSendWhenReady = async () => {
    sendAttempts += 1;
    submitted.push(createSubmittedUserMessage(context.getComposerText(composer)));
    composer.innerText = "";
    composer.textContent = "";
    return true;
  };

  const call = createShellCall(context, "printf receipt-route-output");
  await context.runAndReply("route-receipt-call", call);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 1);
  assert.equal(vm.runInContext("Array.from(pendingHelperDeliveries.values())[0].phase", context), "submitted");
  assert.equal(vm.runInContext("hasLocallyPresentedHelperExecution('0011223344556677')", context), true);

  navigateWithoutLifecycleRefresh(context, "/c/receipt-route");
  await context.retryPendingHelperDeliveries();

  assert.equal(vm.runInContext("hasLocallyPresentedHelperExecution('0011223344556677')", context), true);
  assert.equal(backendRuns, 1);
  assert.equal(composerWrites, 1);
  assert.equal(sendAttempts, 1, "Receipt recovery must not submit the message again.");
  assert.equal(receiptAttempts, 2, "Only the failed presentation receipt should retry.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
}

async function testBackendFailureUsesOneWriteSendOnlyRetry() {
  const context = loadContentContext();
  await settleBootstrap();
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    requireApproval: false,
    autoSend: true
  });
  context.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);

  let backendRuns = 0;
  let composerWrites = 0;
  let sendAttempts = 0;
  const submitted = [];
  const composer = { innerText: "", textContent: "", isConnected: true };
  context.document.querySelectorAll = (selector) =>
    selector.includes("data-message-author-role") ? submitted : [];
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "content-ui-delay") {
      return { ok: true };
    }
    backendRuns += 1;
    throw new Error("simulated transport failure");
  };
  context.insertReply = async (text) => {
    composerWrites += 1;
    composer.innerText = text;
    composer.textContent = text;
    return composer;
  };
  context.findReplyInput = async () => composer;
  context.clickSendWhenReady = async () => {
    sendAttempts += 1;
    if (sendAttempts === 1) {
      return false;
    }
    submitted.push(createSubmittedUserMessage(context.getComposerText(composer)));
    composer.innerText = "";
    composer.textContent = "";
    return true;
  };

  const call = createShellCall(context, "printf transport-failure");
  const first = await context.runAndReply("transport-failure-call", call);
  assert.equal(first.deliveryFailed, true);
  await context.retryPendingHelperDeliveries();

  assert.equal(backendRuns, 1, "Local delivery recovery must never retry the failed backend request.");
  assert.equal(composerWrites, 1, "Failure output must be written only once.");
  assert.equal(sendAttempts, 2, "The outer queue should retry only sending exact plugin-owned text.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
}

async function testRejectedFeedbackUsesOneWriteSendOnlyRetry() {
  const context = loadContentContext();
  await settleBootstrap();
  context.chrome.storage.sync.get = async () => ({ enabled: true, autoSend: true });
  context.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);

  let composerWrites = 0;
  let sendAttempts = 0;
  const submitted = [];
  const composer = { innerText: "", textContent: "", isConnected: true };
  context.document.querySelectorAll = (selector) =>
    selector.includes("data-message-author-role") ? submitted : [];
  context.insertReply = async (text) => {
    composerWrites += 1;
    composer.innerText = text;
    composer.textContent = text;
    return composer;
  };
  context.findReplyInput = async () => composer;
  context.clickSendWhenReady = async () => {
    sendAttempts += 1;
    if (sendAttempts === 1) {
      return false;
    }
    submitted.push(createSubmittedUserMessage(context.getComposerText(composer)));
    composer.innerText = "";
    composer.textContent = "";
    return true;
  };

  const call = createShellCall(context, "printf rejected");
  assert.equal(await context.replyWithRejectedCall(call, "simulated rejection"), false);
  await context.retryPendingHelperDeliveries();

  assert.equal(composerWrites, 1, "Rejected feedback must never be inserted twice.");
  assert.equal(sendAttempts, 2, "Rejected feedback may retry sending but must not be rewritten.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
}

async function testSameLifecycleRetriesExactOwnedComposerWithoutRewrite() {
  const context = loadContentContext();
  await settleBootstrap();
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    requireApproval: false,
    autoSend: true
  });
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);

  let backendRuns = 0;
  let composerWrites = 0;
  let sendAttempts = 0;
  let receiptAttempts = 0;
  const submitted = [];
  const statuses = [];
  const composer = { innerText: "", textContent: "", isConnected: true };
  context.document.querySelectorAll = (selector) =>
    selector.includes("data-message-author-role") ? submitted : [];
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "content-ui-delay") {
      return { ok: true };
    }
    if (payload.type === "run-result-presented") {
      receiptAttempts += 1;
      return { ok: true, found: true };
    }
    assert.equal(payload.type, "run-shell");
    backendRuns += 1;
    return {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: "0a0b0c0d0e0f1011",
      exitCode: 0,
      stdout: "same-lifecycle-retry"
    };
  };
  context.insertReply = async (text) => {
    composerWrites += 1;
    composer.innerText = text;
    composer.textContent = text;
    return composer;
  };
  context.findReplyInput = async () => composer;
  context.clickSendWhenReady = async () => {
    sendAttempts += 1;
    if (sendAttempts === 1) {
      return false;
    }
    submitted.push(createSubmittedUserMessage(context.getComposerText(composer)));
    composer.innerText = "";
    composer.textContent = "";
    return true;
  };
  context.setStatus = (text, state) => statuses.push({ text, state });

  const call = createShellCall(context, "printf same-lifecycle-retry");
  const first = await context.runAndReply("same-lifecycle-retry", call);
  assert.equal(first.pendingDelivery, true);
  assert.equal(sendAttempts, 1);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 1);

  await context.retryPendingHelperDeliveries();

  assert.equal(backendRuns, 1, "Send-only recovery must never repeat the shell backend operation.");
  assert.equal(composerWrites, 1, "Send-only recovery must never rewrite exact plugin-owned composer text.");
  assert.equal(sendAttempts, 2, "An exact owned composer must get a bounded send-only retry in the same lifecycle.");
  assert.equal(submitted.length, 1, "The helper result must be submitted exactly once.");
  assert.equal(receiptAttempts, 1, "Exactly one canonical presentation receipt is expected.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
  assert.match(statuses.at(-1)?.text || "", /Shell helper completed/);
}

async function testChangedOrDeletedComposerNeverRetriesSend() {
  for (const replacement of ["User replacement draft", ""]) {
    const context = loadContentContext();
    await settleBootstrap();
    context.chrome.storage.sync.get = async () => ({
      enabled: true,
      requireApproval: false,
      autoSend: true
    });
    vm.runInContext("extensionActive = true; beginPageLifecycle();", context);

    let backendRuns = 0;
    let composerWrites = 0;
    let sendAttempts = 0;
    let receiptAttempts = 0;
    const composer = { innerText: "", textContent: "", isConnected: true };
    context.chrome.runtime.sendMessage = async (payload) => {
      if (payload.type === "content-ui-delay") {
        return { ok: true };
      }
      if (payload.type === "run-result-presented") {
        receiptAttempts += 1;
        return { ok: true, found: true };
      }
      assert.equal(payload.type, "run-shell");
      backendRuns += 1;
      return {
        ok: true,
        executed: true,
        executionCompleted: true,
        executionId: replacement ? "1111222233334444" : "5555666677778888",
        exitCode: 0,
        stdout: "must-not-resend"
      };
    };
    context.insertReply = async (text) => {
      composerWrites += 1;
      composer.innerText = text;
      composer.textContent = text;
      return composer;
    };
    context.findReplyInput = async () => composer;
    context.clickSendWhenReady = async () => {
      sendAttempts += 1;
      return false;
    };
    context.setStatus = () => {};

    const call = createShellCall(context, `printf ${replacement ? "changed" : "deleted"}`);
    const first = await context.runAndReply(`composer-${replacement ? "changed" : "deleted"}`, call);
    assert.equal(first.pendingDelivery, true);
    composer.innerText = replacement;
    composer.textContent = replacement;

    await context.retryPendingHelperDeliveries();

    assert.equal(backendRuns, 1);
    assert.equal(composerWrites, 1);
    assert.equal(sendAttempts, 1, "Changed or deleted composer content revokes all send-only retry authority.");
    assert.equal(receiptAttempts, 0);
    assert.equal(composer.innerText, replacement);
    assert.equal(
      vm.runInContext("pendingHelperDeliveries.size", context),
      replacement ? 0 : 1,
      replacement
        ? "A changed non-empty draft is an explicit cancellation."
        : "An empty composer without trusted deletion evidence stays submitted-unconfirmed, but never regains send authority."
    );
    if (!replacement) {
      assert.equal(
        vm.runInContext("Array.from(pendingHelperDeliveries.values())[0].phase", context),
        "submitted-unconfirmed"
      );
    }
  }
}

async function testDelayedSubmissionProofAcrossRetryFinalizesOnce() {
  const context = loadContentContext();
  await settleBootstrap();
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    requireApproval: false,
    autoSend: true
  });
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);

  const submitted = [];
  const statuses = [];
  const composer = { innerText: "", textContent: "", isConnected: true };
  let expectedReply = "";
  let receiptAttempts = 0;
  let backendRuns = 0;
  let composerWrites = 0;
  let sendAttempts = 0;
  context.document.querySelectorAll = (selector) =>
    selector.includes("data-message-author-role") ? submitted : [];
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "content-ui-delay") {
      return { ok: true };
    }
    if (payload.type === "run-result-presented") {
      receiptAttempts += 1;
      return { ok: true, found: true };
    }
    assert.equal(payload.type, "run-shell");
    backendRuns += 1;
    return {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: "9999aaaabbbbcccc",
      exitCode: 0,
      stdout: "delayed-proof"
    };
  };
  context.insertReply = async (text) => {
    composerWrites += 1;
    expectedReply = text;
    composer.innerText = text;
    composer.textContent = text;
    return composer;
  };
  context.findReplyInput = async () => composer;
  context.clickSendWhenReady = async () => {
    sendAttempts += 1;
    composer.innerText = "";
    composer.textContent = "";
    return true;
  };
  context.setStatus = (text, state) => statuses.push({ text, state });

  const call = createShellCall(context, "printf delayed-proof");
  const first = await context.runAndReply("delayed-proof", call);
  assert.equal(first.pendingDelivery, true);
  assert.equal(receiptAttempts, 0);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 1);

  await context.retryPendingHelperDeliveries();
  assert.equal(receiptAttempts, 0, "The first later retry still has no exact submitted root.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 1);
  assert.equal(
    vm.runInContext("Array.from(pendingHelperDeliveries.values())[0].phase", context),
    "submitted-unconfirmed"
  );

  submitted.push(createSubmittedUserMessage(expectedReply));
  await context.retryPendingHelperDeliveries();

  assert.equal(backendRuns, 1);
  assert.equal(composerWrites, 1);
  assert.equal(sendAttempts, 1, "Delayed proof recovery must not click send a second time after the composer was cleared.");
  assert.equal(receiptAttempts, 1);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
  assert.ok(!statuses.some(({ text }) => /cancelled because composer content/.test(text)));
  assert.match(statuses.at(-1)?.text || "", /Shell helper completed/);
}

async function testMissingSubmissionProofNeverReportsCompleted() {
  const context = loadContentContext();
  await settleBootstrap();
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    requireApproval: false,
    autoSend: true
  });
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);

  const statuses = [];
  const composer = { innerText: "", textContent: "", isConnected: true };
  let receiptAttempts = 0;
  let backendRuns = 0;
  let composerWrites = 0;
  let sendAttempts = 0;
  context.document.querySelectorAll = () => [];
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "content-ui-delay") {
      return { ok: true };
    }
    if (payload.type === "run-result-presented") {
      receiptAttempts += 1;
      return { ok: true, found: true };
    }
    assert.equal(payload.type, "run-shell");
    backendRuns += 1;
    return {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: "ddddeeeeffff0000",
      exitCode: 0,
      stdout: "never-proved"
    };
  };
  context.insertReply = async (text) => {
    composerWrites += 1;
    composer.innerText = text;
    composer.textContent = text;
    return composer;
  };
  context.findReplyInput = async () => composer;
  context.clickSendWhenReady = async () => {
    sendAttempts += 1;
    composer.innerText = "";
    composer.textContent = "";
    return true;
  };
  context.setStatus = (text, state) => statuses.push({ text, state });

  const call = createShellCall(context, "printf never-proved");
  const first = await context.runAndReply("never-proved", call);
  assert.equal(first.pendingDelivery, true);
  await context.retryPendingHelperDeliveries();

  assert.equal(backendRuns, 1);
  assert.equal(composerWrites, 1);
  assert.equal(sendAttempts, 1);
  assert.equal(receiptAttempts, 0);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 1);
  assert.equal(
    vm.runInContext("Array.from(pendingHelperDeliveries.values())[0].phase", context),
    "submitted-unconfirmed",
    "An empty composer without proof remains observable and must never regain send authority."
  );
  assert.ok(
    !statuses.some(({ text }) => text === "Shell helper completed"),
    `No exact submitted root means completion must never be reported: ${JSON.stringify(statuses)}`
  );
  assert.match(
    statuses.at(-1)?.text || "",
    /Waiting for the matching submitted chat message/,
    "The panel must distinguish submission-proof waiting from terminal completion."
  );
  assert.equal(statuses.at(-1)?.state, "running");
}

async function testReceiptPendingStatusKeepsCompletionAndDoesNotResend() {
  const context = loadContentContext();
  await settleBootstrap();
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    requireApproval: false,
    autoSend: true
  });
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);

  const submitted = [];
  const statuses = [];
  const composer = { innerText: "", textContent: "", isConnected: true };
  let backendRuns = 0;
  let composerWrites = 0;
  let sendAttempts = 0;
  let receiptAttempts = 0;
  context.document.querySelectorAll = (selector) =>
    selector.includes("data-message-author-role") ? submitted : [];
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "content-ui-delay") {
      return { ok: true };
    }
    if (payload.type === "run-result-presented") {
      receiptAttempts += 1;
      return receiptAttempts === 1
        ? { ok: false, found: true }
        : { ok: true, found: true };
    }
    assert.equal(payload.type, "run-shell");
    backendRuns += 1;
    return {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: "1234123412341234",
      exitCode: 0,
      stdout: "receipt-pending"
    };
  };
  context.insertReply = async (text) => {
    composerWrites += 1;
    composer.innerText = text;
    composer.textContent = text;
    return composer;
  };
  context.findReplyInput = async () => composer;
  context.clickSendWhenReady = async () => {
    sendAttempts += 1;
    submitted.push(createSubmittedUserMessage(context.getComposerText(composer)));
    composer.innerText = "";
    composer.textContent = "";
    return true;
  };
  context.setStatus = (text, state) => statuses.push({ text, state });

  const call = createShellCall(context, "printf receipt-pending");
  const first = await context.runAndReply("receipt-pending", call);
  assert.equal(first.pendingDelivery, false, "The result is presented even while its server receipt remains pending.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 1);
  assert.match(statuses.at(-1)?.text || "", /Shell helper completed/);
  assert.match(statuses.at(-1)?.text || "", /receipt acknowledgement/i);

  await context.retryPendingHelperDeliveries();

  assert.equal(backendRuns, 1);
  assert.equal(composerWrites, 1);
  assert.equal(sendAttempts, 1);
  assert.equal(receiptAttempts, 2);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
}

async function testRemountedHistoricalExactRootIsNotFreshSubmissionProof() {
  const context = loadContentContext();
  await settleBootstrap();
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);

  const call = createShellCall(context, "printf virtualized-history");
  const reply = "Shell call result:\n\n```shell-output\n$ printf virtualized-history\nstdout:\nvirtualized-history\n```";
  const historicalRoot = createSubmittedUserMessage(reply);
  let submitted = [historicalRoot];
  let receiptAttempts = 0;
  const statuses = [];
  const composer = { innerText: reply, textContent: reply, isConnected: true };
  context.document.querySelectorAll = (selector) =>
    selector.includes("data-message-author-role") ? submitted : [];
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "run-result-presented") {
      receiptAttempts += 1;
      return { ok: true, found: true };
    }
    if (payload.type === "content-ui-delay") {
      return { ok: true };
    }
    throw new Error(`Unexpected runtime message: ${payload.type}`);
  };
  context.findReplyInput = async () => composer;
  context.setStatus = (text, state) => statuses.push({ text, state });

  const entry = await context.rememberPendingHelperDelivery(
    "virtualized-history",
    call,
    {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: "abcdabcdabcdabcd",
      exitCode: 0,
      stdout: "virtualized-history"
    },
    reply,
    { autoSend: false }
  );
  assert.equal(entry.submittedMessageCountBefore, 1);
  entry.phase = "inserted";

  submitted = [];
  assert.equal(context.countSubmittedMessagesMatching(reply), 0);
  submitted = [historicalRoot];
  assert.equal(context.countSubmittedMessagesMatching(reply), 1);
  const finalized = await context.attemptPendingHelperDelivery(entry, { autoSend: false });

  assert.equal(finalized, false, "Reattaching the same historical exact root is not a fresh current submission.");
  assert.equal(receiptAttempts, 0);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 1);
  assert.ok(!statuses.some(({ text }) => text === "Shell helper completed"));
}

async function createObserverSubmissionProofFixture({ historicalRoot = null } = {}) {
  const context = loadContentContext();
  await settleBootstrap();
  context.chrome.storage.sync.get = async () => ({
    enabled: true,
    requireApproval: false,
    autoSend: true
  });
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);

  const call = createShellCall(context, "printf observer-proof");
  const reply = "Shell call result:\n\n```shell-output\n$ printf observer-proof\nstdout:\nobserver-proof\n```";
  let submitted = historicalRoot ? [historicalRoot] : [];
  let receiptAttempts = 0;
  context.document.querySelectorAll = (selector) =>
    selector.includes("data-message-author-role") ? submitted : [];
  context.chrome.runtime.sendMessage = async (payload) => {
    if (payload.type === "run-result-presented") {
      receiptAttempts += 1;
      return { ok: true, found: true };
    }
    if (payload.type === "content-ui-delay") {
      return { ok: true };
    }
    throw new Error(`Unexpected runtime message: ${payload.type}`);
  };
  context.findReplyInput = async () => null;
  context.setStatus = () => {};

  const entry = await context.rememberPendingHelperDelivery(
    "observer-proof",
    call,
    {
      ok: true,
      executed: true,
      executionCompleted: true,
      executionId: "facefacefaceface",
      exitCode: 0,
      stdout: "observer-proof"
    },
    reply,
    { autoSend: true }
  );
  entry.phase = "submitted-unconfirmed";
  entry.composerElement = null;
  entry.lastError = "waiting for exact submitted-message proof";
  await context.persistPendingHelperDeliveries();
  context.schedulePendingHelperDeliveryRetry();
  context.observeThread();

  return {
    context,
    entry,
    reply,
    getReceiptAttempts: () => receiptAttempts,
    setSubmitted(nextSubmitted) {
      submitted = nextSubmitted;
    }
  };
}

async function emitObserverPageMutation(fixture, addedNodes) {
  const observer = fixture.context.__mutationObservers.at(-1);
  assert.ok(observer, "The pending-delivery race fixture must install its page MutationObserver.");
  observer.callback([{
    type: "childList",
    target: new fixture.context.Element(),
    addedNodes,
    removedNodes: []
  }]);
  await fixture.context.__runScheduledTimersThrough(0);
  for (let index = 0; index < 30; index += 1) {
    await Promise.resolve();
  }
}

async function testFreshSubmittedRootMutationFinalizesBeforeDelayedRetry() {
  const fixture = await createObserverSubmissionProofFixture();
  const freshRoot = createSubmittedUserMessage(fixture.reply);
  fixture.setSubmitted([freshRoot]);

  await emitObserverPageMutation(fixture, [freshRoot]);

  assert.equal(
    fixture.getReceiptAttempts(),
    1,
    "A fresh exact submitted-message mutation must finalize immediately instead of waiting for the existing 2s retry."
  );
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", fixture.context), 0);
}

async function testObserverMutationWithoutFreshExactProofDoesNotFinalize() {
  const negativeCases = [
    {
      name: "non-matching submitted root",
      createHistoricalRoot: () => null,
      createVisibleRoots: (reply) => [createSubmittedUserMessage(`${reply} changed`)]
    },
    {
      name: "historical exact root remount",
      createHistoricalRoot: (reply) => createSubmittedUserMessage(reply),
      createVisibleRoots: (_reply, historicalRoot) => [historicalRoot]
    },
    {
      name: "unrelated page mutation with no submitted proof",
      createHistoricalRoot: () => null,
      createVisibleRoots: () => []
    }
  ];

  for (const negativeCase of negativeCases) {
    const reply = "Shell call result:\n\n```shell-output\n$ printf observer-proof\nstdout:\nobserver-proof\n```";
    const historicalRoot = negativeCase.createHistoricalRoot(reply);
    const fixture = await createObserverSubmissionProofFixture({ historicalRoot });
    fixture.setSubmitted([]);
    const visibleRoots = negativeCase.createVisibleRoots(fixture.reply, historicalRoot);
    fixture.setSubmitted(visibleRoots);

    await emitObserverPageMutation(fixture, visibleRoots);

    assert.equal(
      fixture.getReceiptAttempts(),
      0,
      `${negativeCase.name} must not produce a presentation receipt.`
    );
    assert.equal(
      vm.runInContext("pendingHelperDeliveries.size", fixture.context),
      1,
      `${negativeCase.name} must remain pending until genuinely fresh exact proof exists.`
    );
    assert.equal(fixture.entry.phase, "submitted-unconfirmed");
  }
}

async function runTests() {
  const cases = [
    ["exact route handoff", testExactPluginTextMigratesAcrossRouteChange],
    ["route user draft", testDifferentUserDraftDoesNotMigrateOrSend],
    ["submitted-unconfirmed exact route handoff", testSubmittedUnconfirmedExactComposerSurvivesRouteAndResumesSendOnly],
    ["submitted-unconfirmed route cancellation", testSubmittedUnconfirmedChangedComposerCancelsAcrossRoute],
    ["queued file route carry", testQueuedFileResultSurvivesRouteWithoutBackendReplay],
    ["receipt route carry", testSubmittedReceiptAndTombstoneSurviveRouteChange],
    ["backend failure one-write", testBackendFailureUsesOneWriteSendOnlyRetry],
    ["rejected feedback one-write", testRejectedFeedbackUsesOneWriteSendOnlyRetry],
    ["same lifecycle send-only retry", testSameLifecycleRetriesExactOwnedComposerWithoutRewrite],
    ["changed/deleted composer cancellation", testChangedOrDeletedComposerNeverRetriesSend],
    ["delayed proof across retry", testDelayedSubmissionProofAcrossRetryFinalizesOnce],
    ["missing proof is not completion", testMissingSubmissionProofNeverReportsCompleted],
    ["receipt pending status", testReceiptPendingStatusKeepsCompletionAndDoesNotResend],
    ["historical root remount", testRemountedHistoricalExactRootIsNotFreshSubmissionProof],
    ["observer fresh proof immediate finalize", testFreshSubmittedRootMutationFinalizesBeforeDelayedRetry],
    ["observer mutation negative proofs", testObserverMutationWithoutFreshExactProofDoesNotFinalize]
  ];
  const filter = String(process.env.TEST_FILTER || "").trim().toLowerCase();
  const selected = filter
    ? cases.filter(([name]) => name.toLowerCase().includes(filter))
    : cases;
  assert.ok(selected.length > 0, `No content route delivery test matched TEST_FILTER=${filter}`);
  for (const [name, testCase] of selected) {
    await testCase();
    console.log(`ok - ${name}`);
  }
}

let watchdog = null;
Promise.race([
  runTests(),
  new Promise((_, reject) => {
    watchdog = setTimeout(() => reject(new Error("content route delivery tests timed out before completion")), 15_000);
  })
])
  .then(() => {
    console.log("content route delivery tests passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(watchdog));
