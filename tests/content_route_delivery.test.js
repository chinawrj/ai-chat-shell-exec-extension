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
  context.clickSendWhenReady = async (composer, _shouldContinue, expectedText) => {
    sendAttempts += 1;
    assert.equal(composer, currentComposer);
    assert.equal(context.getValidatedComposerOwnershipText(composer, expectedText), expectedText);
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

  // A SPA route change invalidates the old lifecycle token and may replace the
  // editor node. Exact plugin-owned text in the current visible composer is
  // continuity proof for send-only ownership; it never authorizes a rewrite.
  currentComposer.isConnected = false;
  currentComposer = {
    innerText: insertedText,
    textContent: insertedText,
    isConnected: true
  };
  navigate(context, "/c/route-owned");
  assert.notEqual(context.getCurrentPageIdentity(), oldIdentity);
  assert.ok(
    vm.runInContext("pageLifecycleGeneration", context) > oldGeneration,
    "The route change must invalidate the old lifecycle generation."
  );

  await context.retryPendingHelperDeliveries();

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

  currentComposer.isConnected = false;
  currentComposer = {
    innerText: "This is the user's unrelated draft",
    textContent: "This is the user's unrelated draft",
    isConnected: true
  };
  navigate(context, "/c/user-draft");
  await context.retryPendingHelperDeliveries();

  assert.equal(backendRuns, 1);
  assert.equal(composerWrites, 1);
  assert.equal(sendAttempts, 1, "A different draft must never receive a send attempt.");
  assert.deepEqual(submitted, []);
  assert.equal(currentComposer.innerText, "This is the user's unrelated draft");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", context), 0);
}

testExactPluginTextMigratesAcrossRouteChange()
  .then(() => testDifferentUserDraftDoesNotMigrateOrSend())
  .then(() => {
    console.log("content route delivery tests passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
