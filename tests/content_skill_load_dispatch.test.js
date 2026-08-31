#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const context = createContentContext();

testLiveGenerationEvidenceSurvivesRemoval();
testGenerationEvidenceIsCandidateBound();
testGenerationEpochCarriesOnlyTrackedRootsAcrossRoute();
testUnrelatedGenerationCannotReviveKnownHistory();
testTwoPhaseHistoricalRedrawCannotBecomeLive();
testSkillForceEligibilityFailsClosed();
testLatestManualActionIsUnambiguous();
testColdHistoryRequiresExplicitSkillRecovery()
  .then(() => testColdBaselineSurvivesRedrawButYieldsToLiveGeneration())
  .then(() => testStaleBackendResultCannotEnterAnotherChat())
  .then(() => testRetainedRouteRedrawKeepsExactlyOneBackendDispatch())
  .then(() => testDetachAfterRouteAcceptanceCannotQueueResult())
  .then(() => testSkillRecoveryAbortsAcrossRouteAwait())
  .then(() => testSkillRecoveryRejectsSameUrlTranscriptReplacement())
  .then(() => testSkillSingleFlightAlwaysWakesScanner())
  .then(() => testForceRecoveryIsSingleFlight())
  .then(() => testForceScanRejectsCandidateReplacementDuringAwait())
  .then(() => testForceRunAndReplyRejectsReplacementDuringSettingsAwait())
  .then(() => testForceRunAndReplyRejectsRouteChangeWithRetainedDom())
  .then(() => console.log("content Skill load dispatch tests passed"))
  .catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });

function testLiveGenerationEvidenceSurvivesRemoval() {
  const stop = new context.Element({ role: "button", label: "Stop generating" });
  vm.runInContext("assistantGenerationObservedForLifecycle = false", context);
  context.observeAssistantGenerationEvidence([{ addedNodes: [], removedNodes: [stop] }]);
  assert.equal(
    vm.runInContext("assistantGenerationObservedForLifecycle", context),
    true,
    "A removed generation control in the same mutation batch must still prove that the helper is live."
  );

  vm.runInContext("assistantGenerationObservedForLifecycle = false; assistantGenerationEvidenceUntil = 0; assistantGenerationEpoch = null", context);
  context.observeAssistantGenerationEvidence([{ addedNodes: [new context.Element()], removedNodes: [] }]);
  assert.equal(
    vm.runInContext("assistantGenerationObservedForLifecycle", context),
    false,
    "An ordinary history-render mutation must not bypass the cold-start history gate."
  );

  vm.runInContext("assistantGenerationObservedForLifecycle = false; assistantGenerationEvidenceUntil = 0; assistantGenerationEpoch = null", context);
  context.observeAssistantGenerationEvidence(
    [{ addedNodes: [], removedNodes: [stop] }],
    { allowRemovedControls: false }
  );
  assert.equal(
    vm.runInContext("assistantGenerationObservedForLifecycle", context),
    false,
    "A Stop control removed from the previous route must not prove generation in the new lifecycle."
  );
}

function testGenerationEpochCarriesOnlyTrackedRootsAcrossRoute() {
  const local = createContentContext();
  const conversation = new local.Element();
  const helperRoot = new local.Element({ author: "assistant" });
  helperRoot.textContent = "ai-helper-skill-start:route-completion\ncmd: load";
  conversation.append(helperRoot);
  local.__epochConversation = conversation;
  vm.runInContext("getConversationRoot = () => globalThis.__epochConversation; observedPageIdentity = location.href; pageLifecycleGeneration = 50;", local);
  const stop = new local.Element({ role: "button", label: "Stop generating" });
  local.observeAssistantGenerationEvidence([{ addedNodes: [stop], removedNodes: [] }]);
  local.trackAssistantGenerationHelperRoots([{ target: helperRoot, addedNodes: [], removedNodes: [] }]);

  local.location.href = "https://chatgpt.com/c/assigned-during-generation";
  local.refreshPageLifecycle();
  const call = local.parseCallPayload([
    "ai-helper-skill-start:route-completion",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"2".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n"));
  helperRoot.textContent = call.raw;
  const candidate = { call, node: helperRoot, textRoot: helperRoot, source: "text", blockIndex: 0 };
  local.__epochCandidate = candidate;
  vm.runInContext("extractShellCallCandidates = () => [globalThis.__epochCandidate];", local);
  assert.equal(local.observeAssistantGenerationEvidence(
    [{ target: helperRoot, addedNodes: [], removedNodes: [stop] }],
    { allowRemovedControls: false }
  ), true, "The short generation epoch must survive URL assignment after the Stop control disappears.");
  local.markLiveGeneratedHelperCandidates([{ target: helperRoot, addedNodes: [], removedNodes: [stop] }]);
  assert.equal(local.isLiveGeneratedHelperCandidate(candidate), true,
    "A helper completed in the exact pre-route tracked assistant root must remain live after route assignment.");

  const unrelatedRoot = new local.Element({ author: "assistant" });
  unrelatedRoot.textContent = call.raw;
  conversation.append(unrelatedRoot);
  const unrelatedCandidate = { ...candidate, node: unrelatedRoot, textRoot: unrelatedRoot };
  local.__epochCandidate = unrelatedCandidate;
  local.markLiveGeneratedHelperCandidates([{ target: unrelatedRoot, addedNodes: [], removedNodes: [] }]);
  assert.equal(local.isLiveGeneratedHelperCandidate(unrelatedCandidate), false,
    "A new historical root from the post-route batch must not inherit an old route's removed Stop evidence.");
}

function testUnrelatedGenerationCannotReviveKnownHistory() {
  const local = createContentContext();
  const conversation = new local.Element();
  const historyRoot = new local.Element({ author: "assistant" });
  const call = local.parseCallPayload([
    "ai-helper-skill-start:known-history",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"3".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n"));
  historyRoot.textContent = call.raw;
  conversation.append(historyRoot);
  const candidate = { call, node: historyRoot, textRoot: historyRoot, source: "text", blockIndex: 0 };
  local.__knownConversation = conversation;
  local.__knownCandidate = candidate;
  vm.runInContext(`
    getConversationRoot = () => globalThis.__knownConversation;
    extractShellCallCandidates = () => [globalThis.__knownCandidate];
  `, local);
  local.rememberKnownRenderedHelperSemantics();
  const stop = new local.Element({ role: "button", label: "Stop generating" });
  local.observeAssistantGenerationEvidence([{ addedNodes: [stop], removedNodes: [] }]);
  local.trackAssistantGenerationHelperRoots([{ target: historyRoot, addedNodes: [], removedNodes: [] }]);
  local.markLiveGeneratedHelperCandidates([{ target: historyRoot, addedNodes: [], removedNodes: [] }]);
  assert.equal(local.isLiveGeneratedHelperCandidate(candidate), false,
    "A known cold-history helper redrawn while another response is generating must remain historical.");
}

function testTwoPhaseHistoricalRedrawCannotBecomeLive() {
  const local = createContentContext();
  const conversation = new local.Element();
  const historyRoot = new local.Element({ author: "assistant" });
  const call = local.parseCallPayload([
    "ai-helper-skill-start:two-phase-history",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"4".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n"));
  historyRoot.textContent = call.raw;
  conversation.append(historyRoot);
  const candidate = { call, node: historyRoot, textRoot: historyRoot, source: "text", blockIndex: 0 };
  const semanticCallKey = local.buildSemanticCallKey(call);
  local.__twoPhaseConversation = conversation;
  local.__twoPhaseCandidates = [candidate];
  vm.runInContext(`
    getConversationRoot = () => globalThis.__twoPhaseConversation;
    extractShellCallCandidates = () => globalThis.__twoPhaseCandidates;
  `, local);
  local.rememberKnownRenderedHelperSemantics();
  local.markCallBaselineIgnored(candidate, semanticCallKey);

  const stop = new local.Element({ role: "button", label: "Stop generating" });
  local.observeAssistantGenerationEvidence([{ type: "childList", target: conversation, addedNodes: [stop], removedNodes: [] }]);

  const clearRecord = {
    type: "characterData",
    target: historyRoot,
    oldValue: call.raw,
    addedNodes: [],
    removedNodes: []
  };
  historyRoot.textContent = "";
  local.__twoPhaseCandidates = [];
  local.refreshKnownRenderedHelperSemantics([clearRecord]);

  const restoreRecord = {
    type: "characterData",
    target: historyRoot,
    oldValue: "",
    addedNodes: [],
    removedNodes: []
  };
  historyRoot.textContent = call.raw;
  local.__twoPhaseCandidates = [candidate];
  local.markLiveGeneratedHelperCandidates([restoreRecord]);
  local.refreshKnownRenderedHelperSemantics([restoreRecord]);

  assert.equal(local.isLiveGeneratedHelperCandidate(candidate), false,
    "A historical Skill cleared and restored in separate observer batches must remain historical during unrelated generation.");
  assert.equal(local.isBaselineIgnoredHelperCandidate(candidate, semanticCallKey), true,
    "Two-phase framework redraw must preserve the exact cold-history baseline marker.");
  assert.equal(local.getLastActionableSkillCandidate([candidate], conversation), candidate,
    "The fail-closed historical Skill must remain available through explicit Process Skill recovery.");
}

function testSkillForceEligibilityFailsClosed() {
  const assistant = new context.Element({ author: "assistant" });
  const user = new context.Element({ author: "user" });
  const call = { kind: "skill", cmd: "load", skillId: "example", catalogSha: "a".repeat(64) };
  const assistantCandidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  const userCandidate = { call, node: user, textRoot: user, source: "text", blockIndex: 0 };

  assert.equal(
    context.getLastActionableSkillCandidate([assistantCandidate], assistant),
    assistantCandidate,
    "A fresh assistant Skill helper must expose the validated manual recovery action."
  );
  assert.equal(
    context.getLastActionableSkillCandidate([userCandidate], user),
    null,
    "A helper copied into an explicitly identified user message must never expose recovery."
  );

  const outputCandidate = { ...assistantCandidate, insideShellOutput: true };
  assert.equal(
    context.getLastActionableSkillCandidate([outputCandidate], assistant),
    null,
    "A Skill marker inside plugin-owned output must never expose recovery."
  );

  const semanticKey = context.buildSemanticCallKey(call);
  context.markCallProcessed(assistantCandidate, "unused-call-key", semanticKey);
  assert.equal(
    context.getLastActionableSkillCandidate([assistantCandidate], assistant),
    null,
    "A processed Skill helper must not leave a no-op recovery action visible."
  );
}

function testGenerationEvidenceIsCandidateBound() {
  const local = createContentContext();
  const container = new local.Element();
  const helper = new local.Element({ author: "assistant" });
  const stop = new local.Element({ role: "button", label: "Stop generating" });
  container.append(helper);
  container.append(stop);
  assert.equal(
    local.mutationRecordTouchesElement({ target: container, addedNodes: [stop], removedNodes: [] }, helper),
    false,
    "A Stop-control sibling mutation must not make a historical helper live merely because they share an ancestor."
  );
  const helperChild = new local.Element();
  helper.append(helperChild);
  assert.equal(
    local.mutationRecordTouchesElement({ target: helper, addedNodes: [helperChild], removedNodes: [] }, helper),
    true,
    "A mutation in the exact helper render root must remain eligible for candidate-bound generation proof."
  );
}

function testLatestManualActionIsUnambiguous() {
  const local = createContentContext();
  const assistant = new local.Element({ author: "assistant" });
  const skill = { call: { kind: "skill", cmd: "list" }, node: assistant, textRoot: assistant };
  const shell = { call: { kind: "shell", cmd: "printf shell" }, node: assistant, textRoot: assistant };
  assert.equal(local.getLatestManualActionKind([shell, skill], shell, skill), "skill");
  assert.equal(local.getLatestManualActionKind([skill, shell], shell, skill), "force");
  assert.equal(local.getLatestManualActionKind([skill], null, skill), "skill");
  assert.equal(local.getLatestManualActionKind([shell], shell, null), "force");
}

async function testColdHistoryRequiresExplicitSkillRecovery() {
  const assistant = new context.Element({ author: "assistant" });
  const call = context.parseCallPayload([
    "ai-helper-skill-start:cold-history",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"c".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n"));
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  const semanticKey = context.buildSemanticCallKey(call);
  context.markCallBaselineIgnored(candidate, semanticKey);
  let backendCalls = 0;
  context.chrome.runtime.sendMessage = async () => {
    backendCalls += 1;
    return { ok: false, error: "expected test rejection" };
  };
  vm.runInContext("queueSkillComposerReply = async () => true;", context);
  assert.equal(await context.processLatestSkillCandidate([candidate], { maxChainCalls: 100 }), false);
  assert.equal(backendCalls, 0, "An ignored historical Skill must stay inert on later automatic scans.");
  assert.equal(context.getLastActionableSkillCandidate([candidate], assistant), candidate,
    "The ignored historical Skill should remain available to the separate explicit recovery action.");
  assert.equal(
    await context.processLatestSkillCandidate([candidate], { maxChainCalls: 100 }, { allowBaselineRecovery: true }),
    false
  );
  assert.equal(backendCalls, 1, "Explicit Skill recovery must dispatch exactly one validated backend request.");
  assert.equal(context.getLastActionableSkillCandidate([candidate], assistant), null);
}

async function testColdBaselineSurvivesRedrawButYieldsToLiveGeneration() {
  const local = createContentContext();
  const assistant = new local.Element({ author: "assistant" });
  const call = local.parseCallPayload([
    "ai-helper-skill-start:recycled-root",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"d".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n"));
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  const semanticKey = local.buildSemanticCallKey(call);
  local.markCallBaselineIgnored(candidate, semanticKey);
  local.__candidate = candidate;
  local.__conversation = assistant;
  vm.runInContext("helperRenderRootGenerations.set(__candidate.textRoot, 1);", local);
  let backendCalls = 0;
  local.chrome.runtime.sendMessage = async () => {
    backendCalls += 1;
    return { ok: false, error: "expected test rejection" };
  };
  vm.runInContext("queueSkillComposerReply = async () => true;", local);
  assert.equal(await local.processLatestSkillCandidate([candidate], { maxChainCalls: 100 }), false);
  assert.equal(backendCalls, 0, "A same-root redraw without generation proof must preserve the cold baseline.");

  vm.runInContext("extractShellCallCandidates = () => [__candidate]; getConversationRoot = () => __conversation;", local);
  local.markLiveGeneratedHelperCandidates([{
    target: assistant,
    addedNodes: [new local.Element()],
    removedNodes: []
  }]);
  assert.equal(local.isBaselineIgnoredHelperCandidate(candidate, semanticKey), false,
    "Candidate-bound live generation must release the exact recycled helper from its old cold baseline.");
  assert.equal(await local.processLatestSkillCandidate([candidate], { maxChainCalls: 100 }), false);
  assert.equal(backendCalls, 1, "The later genuinely generated same-payload Skill must dispatch exactly once.");
}

async function testStaleBackendResultCannotEnterAnotherChat() {
  const local = createContentContext();
  const oldRoot = new local.Element();
  const assistant = new local.Element({ author: "assistant" });
  oldRoot.append(assistant);
  local.__conversation = oldRoot;
  vm.runInContext("getConversationRoot = () => __conversation; observedPageIdentity = location.href; pageLifecycleGeneration = 20;", local);
  const call = local.parseCallPayload([
    "ai-helper-skill-start:stale-backend",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"e".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n"));
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  let resolveBackend;
  local.chrome.runtime.sendMessage = () => new Promise((resolve) => { resolveBackend = resolve; });
  const pending = local.processLatestSkillCandidate([candidate], { maxChainCalls: 100 });
  await Promise.resolve();
  assert.equal(typeof resolveBackend, "function", "The test backend request must be in flight before navigation.");
  local.location.href = "https://chatgpt.com/c/new-chat";
  assistant.isConnected = false;
  local.__conversation = new local.Element();
  resolveBackend({ ok: true, skillId: "example", body: "must not cross chats" });
  assert.equal(await pending, false);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", local), 0,
    "A backend result whose originating render root left the chat must not be queued in the new chat.");
}

async function testRetainedRouteRedrawKeepsExactlyOneBackendDispatch() {
  const local = createContentContext();
  const conversation = new local.Element();
  const assistant = new local.Element({ author: "assistant" });
  conversation.append(assistant);
  local.__conversation = conversation;
  const call = local.parseCallPayload([
    "ai-helper-skill-start:retained-route",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"f".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n"));
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  local.__candidate = candidate;
  vm.runInContext(`
    getConversationRoot = () => __conversation;
    extractShellCallCandidates = () => [__candidate];
    observedPageIdentity = location.href;
    pageLifecycleGeneration = 40;
    queueSkillComposerReply = async () => true;
  `, local);
  let backendCalls = 0;
  let resolveBackend;
  local.chrome.runtime.sendMessage = () => {
    backendCalls += 1;
    return new Promise((resolve) => { resolveBackend = resolve; });
  };
  const first = local.processLatestSkillCandidate([candidate], { maxChainCalls: 100 });
  await Promise.resolve();
  local.location.href = "https://chatgpt.com/c/permanent-route";
  local.refreshPageLifecycle();
  vm.runInContext(`
    processedRenderedHelpers.delete(__candidate.textRoot);
    helperRenderRootGenerations.set(__candidate.textRoot, getHelperRenderRootGeneration(__candidate.textRoot) + 1);
  `, local);
  resolveBackend({ ok: true, skillId: "example", body: "retained result" });
  assert.equal(await first, true);
  assert.equal(backendCalls, 1);
  assert.equal(await local.processLatestSkillCandidate([candidate], { maxChainCalls: 100 }), false);
  assert.equal(backendCalls, 1,
    "A retained exact helper redrawn during its route handoff must be reclaimed in the new generation, not loaded twice.");
}

async function testDetachAfterRouteAcceptanceCannotQueueResult() {
  const local = createContentContext();
  const conversation = new local.Element();
  const assistant = new local.Element({ author: "assistant" });
  conversation.append(assistant);
  const call = local.parseCallPayload([
    "ai-helper-skill-start:detach-after-route-accept",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"4".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n"));
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  local.__lateConversation = conversation;
  local.__lateCandidate = candidate;
  vm.runInContext(`
    getConversationRoot = () => globalThis.__lateConversation;
    extractShellCallCandidates = () => [globalThis.__lateCandidate];
    observedPageIdentity = location.href;
    pageLifecycleGeneration = 60;
  `, local);
  let resolveBackend;
  let resolveSettings;
  let settingsRequested = false;
  local.chrome.runtime.sendMessage = () => new Promise((resolve) => { resolveBackend = resolve; });
  local.chrome.storage.sync.get = async (keys) => {
    if (Array.isArray(keys) && keys.includes("autoSend")) {
      settingsRequested = true;
      return new Promise((resolve) => { resolveSettings = resolve; });
    }
    return { enabled: true };
  };
  const pending = local.processLatestSkillCandidate([candidate], { maxChainCalls: 100 });
  await Promise.resolve();
  local.location.href = "https://chatgpt.com/c/accepted-then-replaced";
  local.refreshPageLifecycle();
  resolveBackend({ ok: true, skillId: "example", body: "must remain owned" });
  for (let i = 0; i < 8 && !settingsRequested; i += 1) {
    await Promise.resolve();
  }
  assert.equal(settingsRequested, true, "The route-retained result must reach the guarded queue preflight.");
  assistant.isConnected = false;
  local.__lateConversation = new local.Element();
  local.__lateCandidate = null;
  resolveSettings({ autoSend: true });
  await pending;
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", local), 0,
    "Detaching the exact helper after route acceptance but before queue persistence must still block cross-chat delivery.");
}

async function testSkillRecoveryAbortsAcrossRouteAwait() {
  const local = createContentContext();
  const conversation = new local.Element();
  const assistant = new local.Element({ author: "assistant" });
  conversation.append(assistant);
  const call = local.parseCallPayload([
    "ai-helper-skill-start:manual-route-await",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"1".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n"));
  local.__manualCandidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  local.__manualConversation = conversation;
  vm.runInContext("observedPageIdentity = location.href; pageLifecycleGeneration = 30;", local);
  let releaseLoad;
  local.__loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  vm.runInContext(`
    getConversationRoot = () => globalThis.__manualConversation;
    extractShellCallCandidates = () => [globalThis.__manualCandidate];
    loadPendingHelperDeliveriesForCurrentPage = async () => globalThis.__loadGate;
    globalThis.__manualRecoveryDispatches = 0;
    processLatestSkillCandidate = async () => { globalThis.__manualRecoveryDispatches += 1; return true; };
  `, local);
  const pending = local.processLatestSkillRecovery();
  await Promise.resolve();
  local.location.href = "https://chatgpt.com/c/replaced-before-manual-recovery";
  releaseLoad();
  assert.equal(await pending, false);
  assert.equal(vm.runInContext("globalThis.__manualRecoveryDispatches", local), 0,
    "A Process Skill click must fail closed if the page lifecycle changes during its awaited preflight.");
}

async function testSkillRecoveryRejectsSameUrlTranscriptReplacement() {
  const local = createContentContext();
  const originalConversation = new local.Element();
  const originalRoot = new local.Element({ author: "assistant" });
  originalConversation.append(originalRoot);
  const originalCall = local.parseCallPayload([
    "ai-helper-skill-start:same-url-original",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"5".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n"));
  const originalCandidate = {
    call: originalCall,
    node: originalRoot,
    textRoot: originalRoot,
    source: "text",
    blockIndex: 0
  };
  local.__sameUrlConversation = originalConversation;
  local.__sameUrlCandidate = originalCandidate;
  let releaseLoad;
  local.__sameUrlGate = new Promise((resolve) => { releaseLoad = resolve; });
  vm.runInContext(`
    observedPageIdentity = location.href;
    pageLifecycleGeneration = 70;
    getConversationRoot = () => globalThis.__sameUrlConversation;
    extractShellCallCandidates = () => globalThis.__sameUrlCandidate ? [globalThis.__sameUrlCandidate] : [];
    loadPendingHelperDeliveriesForCurrentPage = async () => globalThis.__sameUrlGate;
    globalThis.__sameUrlDispatches = 0;
    processLatestSkillCandidate = async () => { globalThis.__sameUrlDispatches += 1; return true; };
  `, local);
  const pending = local.processLatestSkillRecovery();
  await Promise.resolve();
  const replacementConversation = new local.Element();
  const replacementRoot = new local.Element({ author: "assistant" });
  replacementConversation.append(replacementRoot);
  local.__sameUrlConversation = replacementConversation;
  local.__sameUrlCandidate = {
    ...originalCandidate,
    node: replacementRoot,
    textRoot: replacementRoot
  };
  releaseLoad();
  assert.equal(await pending, false);
  assert.equal(vm.runInContext("globalThis.__sameUrlDispatches", local), 0,
    "Process Skill must remain bound to the clicked render root even when a different transcript appears at the same URL.");
}

async function testSkillSingleFlightAlwaysWakesScanner() {
  let wakeups = 0;
  vm.runInContext("scheduleScan = () => { globalThis.__skillWakeups += 1; }; globalThis.__skillWakeups = 0; skillHelperInFlight = true;", context);
  assert.equal(await context.processLatestSkillCandidate([], { maxChainCalls: 100 }), false);
  assert.equal(vm.runInContext("globalThis.__skillWakeups", context), 1, "An in-flight Skill must leave a retry wake-up.");

  const assistant = new context.Element({ author: "assistant" });
  const call = context.parseCallPayload([
    "ai-helper-skill-start:dispatch-wakeup",
    "cmd: list",
    "ai-helper-skill-end"
  ].join("\n"));
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  context.__singleFlightCandidate = candidate;
  context.__singleFlightConversation = assistant;
  context.chrome.runtime.sendMessage = async () => ({ ok: true, catalogSha: "b".repeat(64), version: 1, skills: [] });
  vm.runInContext(`
    skillHelperInFlight = false;
    getConversationRoot = () => globalThis.__singleFlightConversation;
    extractShellCallCandidates = () => [globalThis.__singleFlightCandidate];
    queueSkillComposerReply = async () => true;
  `, context);
  assert.equal(await context.processLatestSkillCandidate([candidate], { maxChainCalls: 100 }), true);
  wakeups = vm.runInContext("globalThis.__skillWakeups", context);
  assert.equal(wakeups, 2, "Releasing the Skill single-flight lock must schedule one final scan.");
}

async function testForceRecoveryIsSingleFlight() {
  const local = createContentContext();
  const conversation = new local.Element();
  const assistant = new local.Element({ author: "assistant" });
  conversation.append(assistant);
  const shellCandidate = {
    call: { kind: "shell", cmd: "printf force" },
    node: assistant,
    textRoot: assistant,
    source: "text",
    blockIndex: 0
  };
  local.__forceConversation = conversation;
  local.__forceCandidates = [shellCandidate];
  vm.runInContext(`(() => {
    getConversationRoot = () => globalThis.__forceConversation;
    extractShellCallCandidates = () => globalThis.__forceCandidates;
    globalThis.__forceScans = 0;
    globalThis.__forceGate = new Promise((resolve) => { globalThis.__releaseForce = resolve; });
    scanForShellCall = async () => {
      globalThis.__forceScans += 1;
      await globalThis.__forceGate;
      clearPendingForceRun();
    };
  })()`, local);
  const first = local.forceRunLatestShellCall();
  const second = local.forceRunLatestShellCall();
  await Promise.resolve();
  assert.equal(vm.runInContext("globalThis.__forceScans", local), 1, "Two immediate recovery clicks must share one dispatch.");
  local.__releaseForce();
  await Promise.all([first, second]);
  assert.equal(vm.runInContext("forceRunInFlight", local), false);
  assert.equal(vm.runInContext("pendingForceRunRequested", local), false);

  vm.runInContext("activeCallId = 'file-call'; panelShellHelperActive = false;", local);
  await local.forceRunLatestShellCall();
  assert.equal(vm.runInContext("globalThis.__forceScans", local), 1,
    "A hidden stale Force click must not scan while any non-shell backend helper call is active.");
  assert.equal(vm.runInContext("pendingForceRunRequested", local), false,
    "A hidden stale Force click must not queue work behind a file, board, or agent backend call.");
  vm.runInContext("activeCallId = '';", local);

  vm.runInContext("skillHelperInFlight = true;", local);
  await local.forceRunLatestShellCall();
  assert.equal(vm.runInContext("globalThis.__forceScans", local), 1,
    "A stale/synthetic Force click must not start executable work while a Skill backend request owns the manual-action state.");
  vm.runInContext("skillHelperInFlight = false;", local);

  const skillCandidate = {
    call: { kind: "skill", cmd: "list" },
    node: assistant,
    textRoot: assistant,
    source: "text",
    blockIndex: 1
  };
  local.__forceCandidates = [shellCandidate, skillCandidate];
  await local.forceRunLatestShellCall();
  assert.equal(vm.runInContext("globalThis.__forceScans", local), 1,
    "A stale Force click must not execute an older shell when a newer eligible Skill is DOM-latest.");
}

async function testForceScanRejectsCandidateReplacementDuringAwait() {
  const local = createContentContext();
  const oldRoot = new local.Element({ author: "assistant" });
  const newRoot = new local.Element({ author: "assistant" });
  const conversation = new local.Element();
  conversation.append(oldRoot);
  const oldCandidate = {
    call: { kind: "shell", cmd: "printf old-force" },
    node: oldRoot,
    textRoot: oldRoot,
    source: "text",
    blockIndex: 0
  };
  const newCandidate = {
    call: { kind: "shell", cmd: "printf replacement-force" },
    node: newRoot,
    textRoot: newRoot,
    source: "text",
    blockIndex: 0
  };
  local.__forceAwaitConversation = conversation;
  local.__forceAwaitCandidates = [oldCandidate];
  local.__forceAwaitSnapshot = local.createRenderedHelperCandidateSnapshot(oldCandidate);
  let releaseLoad;
  local.__forceAwaitGate = new Promise((resolve) => { releaseLoad = resolve; });
  local.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100
  });
  vm.runInContext(`
    extensionActive = true;
    observedPageIdentity = location.href;
    getConversationRoot = () => globalThis.__forceAwaitConversation;
    extractShellCallCandidates = () => globalThis.__forceAwaitCandidates;
    loadPendingHelperDeliveriesForCurrentPage = async () => globalThis.__forceAwaitGate;
    schedulePendingHelperDeliveryRetry = () => {};
    updateSiteActionButton = () => {};
    globalThis.__forceAwaitRuns = 0;
    runAndReply = async () => { globalThis.__forceAwaitRuns += 1; return {}; };
  `, local);
  const pending = local.scanForShellCall({
    force: true,
    forceCandidateSnapshot: local.__forceAwaitSnapshot
  });
  await Promise.resolve();
  conversation.children = [newRoot];
  newRoot.parentElement = conversation;
  oldRoot.isConnected = false;
  local.__forceAwaitCandidates = [newCandidate];
  releaseLoad();
  await pending;
  assert.equal(vm.runInContext("globalThis.__forceAwaitRuns", local), 0,
    "Force must stay bound to the clicked executable candidate and fail closed if the transcript replaces it during an awaited preflight.");
}

async function testForceRunAndReplyRejectsReplacementDuringSettingsAwait() {
  const local = createContentContext();
  const oldRoot = new local.Element({ author: "assistant" });
  const newRoot = new local.Element({ author: "assistant" });
  const conversation = new local.Element();
  conversation.append(oldRoot);
  const oldCandidate = {
    call: { kind: "shell", cmd: "printf old-settings-force" },
    node: oldRoot,
    textRoot: oldRoot,
    source: "text",
    blockIndex: 0
  };
  const newCandidate = {
    call: { kind: "shell", cmd: "printf replacement-settings-force" },
    node: newRoot,
    textRoot: newRoot,
    source: "text",
    blockIndex: 0
  };
  local.__forceSettingsConversation = conversation;
  local.__forceSettingsCandidates = [oldCandidate];
  local.__forceSettingsSnapshot = local.createRenderedHelperCandidateSnapshot(oldCandidate);
  vm.runInContext(`
    extensionActive = true;
    observedPageIdentity = location.href;
    getConversationRoot = () => globalThis.__forceSettingsConversation;
    extractShellCallCandidates = () => globalThis.__forceSettingsCandidates;
    globalThis.__forceSettingsSends = 0;
    sendRunShellMessage = async () => {
      globalThis.__forceSettingsSends += 1;
      return { ok: true, stdout: "unexpected" };
    };
  `, local);
  assert.equal(local.isForceRunCandidateSnapshotCurrent(local.__forceSettingsSnapshot), true,
    "An unchanged DOM-latest shell candidate must remain eligible at the final Force dispatch boundary.");

  let releaseSettings;
  let settingsRequested;
  const settingsGate = new Promise((resolve) => { releaseSettings = resolve; });
  const requested = new Promise((resolve) => { settingsRequested = resolve; });
  local.chrome.storage.sync.get = async () => {
    settingsRequested();
    return settingsGate;
  };
  const pending = local.runAndReply(
    "force-settings-await",
    oldCandidate.call,
    { force: true, forceCandidateSnapshot: local.__forceSettingsSnapshot }
  );
  await requested;
  conversation.children = [newRoot];
  newRoot.parentElement = conversation;
  oldRoot.isConnected = false;
  local.__forceSettingsCandidates = [newCandidate];
  releaseSettings({ requireApproval: false, autoSend: true });
  const outcome = await pending;
  assert.equal(outcome?.staleCandidate, true,
    "Force must report a stale candidate when the transcript changes during its last awaited preflight.");
  assert.equal(vm.runInContext("globalThis.__forceSettingsSends", local), 0,
    "No backend helper call may start after the Force candidate changes during settings loading.");
}

async function testForceRunAndReplyRejectsRouteChangeWithRetainedDom() {
  const local = createContentContext();
  const oldRoot = new local.Element({ author: "assistant" });
  const conversation = new local.Element();
  conversation.append(oldRoot);
  const candidate = {
    call: { kind: "shell", cmd: "printf old-route-force" },
    node: oldRoot,
    textRoot: oldRoot,
    source: "text",
    blockIndex: 0
  };
  local.__forceRouteConversation = conversation;
  local.__forceRouteCandidates = [candidate];
  vm.runInContext(`
    extensionActive = true;
    observedPageIdentity = location.href;
    getConversationRoot = () => globalThis.__forceRouteConversation;
    extractShellCallCandidates = () => globalThis.__forceRouteCandidates;
    globalThis.__forceRouteSends = 0;
    sendRunShellMessage = async () => {
      globalThis.__forceRouteSends += 1;
      return { ok: true, stdout: "unexpected" };
    };
  `, local);
  local.__forceRouteSnapshot = local.createRenderedHelperCandidateSnapshot(candidate);

  let releaseSettings;
  let settingsRequested;
  const settingsGate = new Promise((resolve) => { releaseSettings = resolve; });
  const requested = new Promise((resolve) => { settingsRequested = resolve; });
  local.chrome.storage.sync.get = async () => {
    settingsRequested();
    return settingsGate;
  };
  const pending = local.runAndReply(
    "force-route-await",
    candidate.call,
    { force: true, forceCandidateSnapshot: local.__forceRouteSnapshot }
  );
  await requested;
  local.location.href = "https://chatgpt.com/c/different-chat";
  releaseSettings({ requireApproval: false, autoSend: true });
  const outcome = await pending;
  assert.equal(outcome?.staleCandidate, true,
    "Force must invalidate its click when the chat route changes, even if the old transcript DOM is still retained.");
  assert.equal(vm.runInContext("globalThis.__forceRouteSends", local), 0,
    "A retained old transcript must never authorize Force execution in a new page lifecycle.");
}

function createContentContext() {
  class Element {
    constructor({ author = "", role = "", label = "" } = {}) {
      this.author = author;
      this.role = role;
      this.label = label;
      this.textContent = label;
      this.children = [];
      this.parentElement = null;
      this.isConnected = true;
    }

    append(child) {
      child.parentElement = this;
      child.isConnected = this.isConnected;
      this.children.push(child);
      return child;
    }

    contains(node) {
      return node === this || this.children.some((child) => child.contains(node));
    }

    closest(selector) {
      if (String(selector).includes("data-message-author-role") && this.author) {
        return this;
      }
      return null;
    }

    getAttribute(name) {
      if (name === "data-message-author-role") return this.author;
      if (name === "role") return this.role;
      if (name === "aria-label") return this.label;
      return "";
    }

    matches(selector) {
      return (this.role === "button" && String(selector).includes("[role='button']")) ||
        (this.role === "button" && String(selector).includes("button"));
    }

    querySelectorAll() {
      return this.children;
    }

    getBoundingClientRect() {
      return { width: 100, height: 24 };
    }
  }

  const loaded = {
    CSS: { escape: (value) => String(value) },
    Element,
    HTMLElement: Element,
    InputEvent: class InputEvent {},
    MutationObserver: class MutationObserver {},
    Node: { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
    chrome: {
      runtime: { id: "lkmeogidbglhedgekjgbpbfjkpapnhke" },
      storage: {
        onChanged: { addListener() {} },
        sync: { get: async () => ({ enabled: false }) },
        local: { get: async () => ({}), set: async () => {}, remove: async () => {} }
      }
    },
    clearTimeout,
    console,
    crypto: { randomUUID: () => "dispatch-test" },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      removeEventListener() {}
    },
    location: {
      href: "https://chatgpt.com/",
      hostname: "chatgpt.com",
      origin: "https://chatgpt.com",
      pathname: "/",
      protocol: "https:"
    },
    setTimeout,
    window: {
      confirm: () => true,
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      removeEventListener() {}
    }
  };
  vm.createContext(loaded);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "extension", "src", "content.js"), "utf8"),
    loaded,
    { filename: "content.js" }
  );
  return loaded;
}
