#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadContentContext() {
  const localStore = {};
  const sessionStore = {};
  const context = {
    CSS: { escape: (value) => String(value) },
    Element: class Element {},
    HTMLButtonElement: class HTMLButtonElement {},
    HTMLInputElement: class HTMLInputElement {},
    HTMLTextAreaElement: class HTMLTextAreaElement {},
    InputEvent: class InputEvent {},
    MutationObserver: class MutationObserver {
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
    clearTimeout() {},
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
    setTimeout: () => 1,
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
  return context;
}

function createShellCall(context, command) {
  return context.parseCallPayload([
    "ai-helper-shell-start",
    command,
    "ai-helper-shell-end"
  ].join("\n"));
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
    submitted.push({
      innerText: expectedText,
      textContent: expectedText
    });
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
  let composerAvailable = false;
  const composer = { innerText: "", textContent: "", isConnected: true };
  context.chrome.runtime.sendMessage = async (payload) => {
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
  const composer = { innerText: "", textContent: "", isConnected: true };
  context.chrome.runtime.sendMessage = async (payload) => {
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
  const composer = { innerText: "", textContent: "", isConnected: true };
  context.chrome.runtime.sendMessage = async () => {
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
  assert.equal(sendAttempts, 1, "The persistent queue must not restart the v0.8.9 actuator.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 1);
}

async function testRejectedFeedbackUsesOneWriteSendOnlyRetry() {
  const context = loadContentContext();
  await settleBootstrap();
  context.chrome.storage.sync.get = async () => ({ enabled: true, autoSend: true });
  context.setStatus = () => {};
  vm.runInContext("extensionActive = true; beginPageLifecycle();", context);

  let composerWrites = 0;
  let sendAttempts = 0;
  const composer = { innerText: "", textContent: "", isConnected: true };
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
    composer.innerText = "";
    composer.textContent = "";
    return true;
  };

  const call = createShellCall(context, "printf rejected");
  assert.equal(await context.replyWithRejectedCall(call, "simulated rejection"), false);
  await context.retryPendingHelperDeliveries();

  assert.equal(composerWrites, 1, "Rejected feedback must never be inserted twice.");
  assert.equal(sendAttempts, 1, "Rejected feedback must not restart the v0.8.9 actuator.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 1);
}

testExactPluginTextMigratesAcrossRouteChange()
  .then(() => testDifferentUserDraftDoesNotMigrateOrSend())
  .then(() => testQueuedFileResultSurvivesRouteWithoutBackendReplay())
  .then(() => testSubmittedReceiptAndTombstoneSurviveRouteChange())
  .then(() => testBackendFailureUsesOneWriteSendOnlyRetry())
  .then(() => testRejectedFeedbackUsesOneWriteSendOnlyRetry())
  .then(() => {
    console.log("content route delivery tests passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
