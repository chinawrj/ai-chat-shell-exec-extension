#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const context = createContentContext();

testStableSemanticIdleDeadline();
testRealExecutionPausesRatherThanResets();
testNonExecutionChurnCannotPreventIdle();
testCandidateAndLifecycleChangesResetTheDeadline();
testGenericForceDispatch()
  .then(() => console.log("content Force run idle tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

function testStableSemanticIdleDeadline() {
  vm.runInContext(`
    pageLifecycleGeneration = 7;
    globalThis.shellA = { call: { kind: "shell", cmd: "printf one" } };
    globalThis.shellARedraw = { call: { kind: "shell", cmd: "printf one" } };
    setPanelDetectedManualHelper([shellA], shellA, null);
  `, context);
  assert.equal(vm.runInContext("refreshPanelForceRunIdleClock(1000)", context), false);
  assert.equal(vm.runInContext("refreshPanelForceRunIdleClock(20_999)", context), false);

  vm.runInContext(
    "setPanelDetectedManualHelper([shellARedraw], shellARedraw, null);",
    context
  );
  assert.equal(
    vm.runInContext("panelForceRunIdleAccumulatedMs", context),
    0,
    "A DOM redraw of the same semantic helper must not reset or synthesize elapsed time."
  );
  assert.equal(vm.runInContext("panelForceRunIdleStartedAt", context), 1000);
  assert.equal(vm.runInContext("refreshPanelForceRunIdleClock(21_000)", context), true);
  assert.equal(vm.runInContext("panelForceRunIdleReady", context), true);
}

function testRealExecutionPausesRatherThanResets() {
  vm.runInContext(`
    resetPanelForceRunIdleState({ clearCandidate: true });
    setPanelDetectedManualHelper([shellA], shellA, null);
    refreshPanelForceRunIdleClock(100_000);
    activeCallId = "running-call";
  `, context);
  assert.equal(vm.runInContext("refreshPanelForceRunIdleClock(105_000)", context), false);
  assert.equal(vm.runInContext("panelForceRunIdleAccumulatedMs", context), 5000);
  assert.equal(vm.runInContext("refreshPanelForceRunIdleClock(999_999)", context), false);
  assert.equal(
    vm.runInContext("panelForceRunIdleAccumulatedMs", context),
    5000,
    "Wall time spent in a real backend execution must not count as idle."
  );
  vm.runInContext("activeCallId = '';", context);
  assert.equal(vm.runInContext("refreshPanelForceRunIdleClock(200_000)", context), false);
  assert.equal(vm.runInContext("refreshPanelForceRunIdleClock(214_999)", context), false);
  assert.equal(vm.runInContext("refreshPanelForceRunIdleClock(215_000)", context), true);
}

function testNonExecutionChurnCannotPreventIdle() {
  vm.runInContext(`
    resetPanelForceRunIdleState({ clearCandidate: true });
    setPanelDetectedManualHelper([shellA], shellA, null);
    pendingHelperDeliveries = new Map([["delivery", {}]]);
    pendingAgentDelivery = { sent: false, cancelled: false };
    isAssistantGenerating = () => true;
  `, context);
  assert.equal(vm.runInContext("refreshPanelForceRunIdleClock(300_000)", context), false);
  assert.equal(vm.runInContext("refreshPanelForceRunIdleClock(320_000)", context), true);
  assert.equal(
    vm.runInContext("isPanelForceRunExecutionActive()", context),
    false,
    "Composer delivery, agent drafts, and assistant DOM activity are not backend execution."
  );
}

function testCandidateAndLifecycleChangesResetTheDeadline() {
  vm.runInContext(`
    pendingHelperDeliveries = new Map();
    pendingAgentDelivery = null;
    isAssistantGenerating = () => false;
    resetPanelForceRunIdleState({ clearCandidate: true });
    setPanelDetectedManualHelper([shellA], shellA, null);
    refreshPanelForceRunIdleClock(400_000);
    refreshPanelForceRunIdleClock(410_000);
    globalThis.shellB = { call: { kind: "shell", cmd: "printf two" } };
    setPanelDetectedManualHelper([shellB], shellB, null);
  `, context);
  assert.equal(vm.runInContext("panelForceRunIdleStartedAt", context), 0);
  assert.equal(vm.runInContext("panelForceRunIdleAccumulatedMs", context), 0);
  assert.equal(vm.runInContext("refreshPanelForceRunIdleClock(420_000)", context), false);
  assert.equal(vm.runInContext("refreshPanelForceRunIdleClock(439_999)", context), false);
  assert.equal(vm.runInContext("refreshPanelForceRunIdleClock(440_000)", context), true);

  vm.runInContext(`
    pageLifecycleGeneration += 1;
    setPanelDetectedManualHelper([shellB], shellB, null);
  `, context);
  assert.equal(vm.runInContext("panelForceRunIdleReady", context), false);
  assert.equal(vm.runInContext("panelForceRunIdleStartedAt", context), 0);

  vm.runInContext("setPanelDetectedManualHelper([], null, null);", context);
  assert.equal(vm.runInContext("panelForceRunAvailable", context), false);
  assert.equal(vm.runInContext("panelDetectedManualHelperKey", context), "");
  assert.equal(vm.runInContext("refreshPanelForceRunIdleClock(999_999)", context), false);
}

async function testGenericForceDispatch() {
  vm.runInContext(`
    activeCallId = "";
    skillHelperInFlight = false;
    skillRecoveryInFlight = false;
    forceRunInFlight = false;
    panelShellHelperActive = false;
    pendingForceRunRequested = false;
    refreshPageLifecycle = () => false;
    getConversationRoot = () => ({});
    extractShellCallCandidates = () => [globalThis.selectedCandidate];
    getLastForceEligibleRunnableCandidate = () => globalThis.selectedKind === "force"
      ? globalThis.selectedCandidate
      : null;
    getLastEligibleSkillCandidate = () => globalThis.selectedKind === "skill"
      ? globalThis.selectedCandidate
      : null;
    getLatestManualActionKind = () => globalThis.selectedKind;
    processLatestSkillRecovery = async (options) => {
      globalThis.dispatched = options?.forceDetected === true ? "skill" : "wrong-skill";
      return true;
    };
    forceRunLatestShellCall = async () => {
      globalThis.dispatched = "force";
      return true;
    };
    globalThis.selectedCandidate = { call: { kind: "skill", cmd: "load" } };
    globalThis.selectedKind = "skill";
    globalThis.dispatched = "";
  `, context);
  assert.equal(await context.forceRunLatestDetectedHelper(), true);
  assert.equal(context.dispatched, "skill");

  context.selectedCandidate = { call: { kind: "shell", cmd: "printf routed" } };
  context.selectedKind = "force";
  context.dispatched = "";
  assert.equal(await context.forceRunLatestDetectedHelper(), true);
  assert.equal(context.dispatched, "force");

  vm.runInContext(`
    globalThis.forcePanelInvocations = 0;
    globalThis.skillPanelInvocations = 0;
    forceRunLatestDetectedHelper = async () => { forcePanelInvocations += 1; };
    processLatestSkillRecovery = async () => { skillPanelInvocations += 1; };
    handlePanelAction("force", { isTrusted: false });
    handlePanelAction("skill-recovery", { isTrusted: false });
  `, context);
  await Promise.resolve();
  assert.equal(context.forcePanelInvocations, 0, "Synthetic page clicks must not invoke Force run.");
  assert.equal(context.skillPanelInvocations, 0, "Synthetic page clicks must not expose Skill recovery.");
  vm.runInContext(`
    handlePanelAction("force", { isTrusted: true });
    handlePanelAction("skill-recovery", { isTrusted: true });
  `, context);
  await Promise.resolve();
  assert.equal(context.forcePanelInvocations, 1);
  assert.equal(context.skillPanelInvocations, 1);
}

function createContentContext() {
  let nextTimerId = 1;
  const timers = new Map();
  const fakeWindow = {
    confirm: () => true,
    addEventListener() {},
    removeEventListener() {},
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    }
  };
  const loaded = {
    CSS: { escape: (value) => String(value) },
    Element: class Element {},
    HTMLElement: class HTMLElement {},
    InputEvent: class InputEvent {},
    MutationObserver: class MutationObserver {},
    Node: {
      DOCUMENT_POSITION_FOLLOWING: 4,
      DOCUMENT_POSITION_PRECEDING: 2
    },
    chrome: {
      runtime: {
        id: "lkmeogidbglhedgekjgbpbfjkpapnhke",
        onMessage: { addListener() {} }
      },
      storage: {
        onChanged: { addListener() {} },
        sync: { get: () => new Promise(() => {}) },
        local: {
          get: async () => ({}),
          set: async () => {},
          remove: async () => {}
        }
      }
    },
    clearTimeout,
    console,
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {}
    },
    location: {
      href: "https://chatgpt.com/c/force-idle-test",
      hostname: "chatgpt.com",
      origin: "https://chatgpt.com",
      pathname: "/c/force-idle-test",
      protocol: "https:"
    },
    setTimeout,
    window: fakeWindow
  };
  vm.createContext(loaded);
  const source = fs.readFileSync(path.join(__dirname, "..", "extension", "src", "content.js"), "utf8");
  vm.runInContext(source, loaded, { filename: "content.js" });
  return loaded;
}
