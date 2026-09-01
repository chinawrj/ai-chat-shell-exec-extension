#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const context = createContentContext();

testLiveGenerationEvidenceSurvivesRemoval();
testStableGenerationControlEvidenceBoundaries();
testGenerationEvidenceIsCandidateBound();
testGenerationEpochCarriesOnlyTrackedRootsAcrossRoute();
testUnrelatedGenerationCannotReviveKnownHistory();
testTwoPhaseHistoricalRedrawCannotBecomeLive();
testCompleteHelperCannotBorrowUnrelatedGeneration();
testStaleRouteStopNodeCannotProveLaterHydration();
testReusedStopNodeStartsASeparateSameRouteGeneration();
testOldResponseCannotCompleteAfterLaterUserTurn();
testSameBatchRouteStopReconciliation();
testRouteCarriedResponseSurvivesExpiredTail();
testRouteCarriedStopCannotAuthorizeNewRoot();
testRouteCarriedRecycledElementsCannotAuthorizeRewrittenChat();
testSkillForceEligibilityFailsClosed();
testLatestManualActionIsUnambiguous();
testColdHistoryRequiresExplicitSkillRecovery()
  .then(() => testLateHydratedHistoryRequiresExplicitSkillRecovery())
  .then(() => testLateHydratedShellRequiresExplicitForce())
  .then(() => testVisibleOldRouteStopCannotAuthorizeReplacementHistory())
  .then(() => testLiveStopSkillCompletionDispatchesExactlyOnce())
  .then(() => testAtomicCurrentAssistantSkillDispatchesExactlyOnce())
  .then(() => testUnknownRoleAtomicSkillFailsClosed())
  .then(() => testColdBaselineSurvivesRedrawButYieldsToLiveGeneration())
  .then(() => testStaleBackendResultCannotEnterAnotherChat())
  .then(() => testRetainedRouteRedrawKeepsExactlyOneBackendDispatch())
  .then(() => testDetachAfterRouteAcceptanceCannotQueueResult())
  .then(() => testSameRootGenerationChangeRejectsBackendResult())
  .then(() => testDetachedBackendResultRemainsManuallyRecoverable())
  .then(() => testQueuedSkillResultRejectsSameUrlTranscriptReplacement())
  .then(() => testQueuedSkillWriteAbortsDuringSameUrlReplacement())
  .then(() => testQueuedSkillResultSurvivesOneRouteHandoff())
  .then(() => testQueuedSkillResultCannotCrossIntoAnotherChat())
  .then(() => testQueuedSkillAttemptCannotWriteAfterTwoRoutes())
  .then(() => testWrittenSkillPhasesCannotResumeAfterRoute())
  .then(() => testWrittenSkillPhasesAbortDuringSameUrlReplacement())
  .then(() => testStaleInsertedCancellationCannotClearNewRouteQueue())
  .then(() => testTrustedMutationCancellationCannotClearNewRouteQueue())
  .then(() => testTrustedMutationCancellationCannotClearSameUrlReplacementQueue())
  .then(() => testTrustedCancellationRechecksAfterAsyncGuardResolution())
  .then(() => testRestoredQueuedSkillRequiresMatchingTranscript())
  .then(() => testLegacyRestoredQueuedSkillWithoutOriginIsDiscarded())
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
    false,
    "A removed-only control without a prior observed generation must not turn late-hydrated history into a live helper."
  );

  vm.runInContext("assistantGenerationObservedForLifecycle = false; assistantGenerationEvidenceUntil = 0; assistantGenerationEpoch = null", context);
  context.observeAssistantGenerationEvidence([{ addedNodes: [stop], removedNodes: [] }]);
  context.observeAssistantGenerationEvidence([{ addedNodes: [], removedNodes: [stop] }]);
  assert.equal(
    vm.runInContext("assistantGenerationObservedForLifecycle", context),
    true,
    "After a fresh Stop add establishes the epoch, its later removal must preserve the bounded completion tail."
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

function testStableGenerationControlEvidenceBoundaries() {
  const local = createContentContext();
  const stableControl = new local.Element({ role: "button", label: "停止生成" });
  const stableGetAttribute = stableControl.getAttribute.bind(stableControl);
  stableControl.getAttribute = (name) => name === "data-testid"
    ? "stop-button"
    : stableGetAttribute(name);
  assert.equal(local.isAssistantGenerationControl(stableControl), true,
    "A production stable Stop test id must prove generation independently of localized button text.");

  const authoredControl = new local.Element({
    author: "assistant",
    role: "button",
    label: "停止生成"
  });
  const authoredGetAttribute = authoredControl.getAttribute.bind(authoredControl);
  authoredControl.getAttribute = (name) => name === "data-testid"
    ? "stop-button"
    : authoredGetAttribute(name);
  assert.equal(local.isAssistantGenerationControl(authoredControl), false,
    "A stable-looking Stop id rendered inside authored assistant content is untrusted page text.");

  const panelControl = new local.Element({ role: "button", label: "停止生成" });
  const panelGetAttribute = panelControl.getAttribute.bind(panelControl);
  panelControl.getAttribute = (name) => name === "data-testid"
    ? "stop-button"
    : panelGetAttribute(name);
  panelControl.closest = (selector) => String(selector).includes("data-message-author-role")
    ? null
    : {};
  assert.equal(local.isAssistantGenerationControl(panelControl), false,
    "A stable-looking Stop id inside the extension panel must not become generation evidence.");

  const genericStop = new local.Element({ role: "button", label: "Stop" });
  assert.equal(local.isAssistantGenerationControl(genericStop), false,
    "An unrelated generic Stop button remains insufficient generation evidence.");
}

function testGenerationEpochCarriesOnlyTrackedRootsAcrossRoute() {
  const local = createContentContext();
  const conversation = new local.Element();
  const user = new local.Element({ author: "user" });
  user.textContent = "assign this generated response to its permanent URL";
  const helperRoot = new local.Element({ author: "assistant" });
  helperRoot.textContent = "ai-helper-skill-start:route-completion\ncmd: load";
  conversation.append(user);
  conversation.append(helperRoot);
  local.__epochConversation = conversation;
  vm.runInContext("getConversationRoot = () => globalThis.__epochConversation; observedPageIdentity = location.href; pageLifecycleGeneration = 50;", local);
  const stop = new local.Element({ role: "button", label: "Stop generating" });
  local.observeAssistantGenerationEvidence([{ addedNodes: [stop], removedNodes: [] }]);
  local.trackAssistantGenerationHelperRoots([{ target: helperRoot, addedNodes: [], removedNodes: [] }]);

  local.location.href = "https://chatgpt.com/c/assigned-during-generation";
  local.refreshPageLifecycle();
  const completedHelperText = [
    "ai-helper-skill-start:route-completion",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"2".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n");
  const call = local.parseCallPayload(completedHelperText);
  helperRoot.textContent = completedHelperText;
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

function testCompleteHelperCannotBorrowUnrelatedGeneration() {
  const local = createContentContext();
  const conversation = new local.Element();
  const assistant = new local.Element({ author: "assistant" });
  const currentUser = new local.Element({ author: "user" });
  const call = local.parseCallPayload([
    "ai-helper-skill-start:unrelated-complete",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"8".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n"));
  assistant.textContent = [
    "ai-helper-skill-start:unrelated-complete",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"8".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n");
  conversation.append(assistant);
  conversation.append(currentUser);
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  local.__unrelatedCompleteConversation = conversation;
  local.__unrelatedCompleteCandidates = [candidate];
  vm.runInContext(`
    getConversationRoot = () => globalThis.__unrelatedCompleteConversation;
    extractShellCallCandidates = () => globalThis.__unrelatedCompleteCandidates;
  `, local);

  const stop = new local.Element({ role: "button", label: "Stop generating" });
  local.observeAssistantGenerationEvidence([{ target: conversation, addedNodes: [stop], removedNodes: [] }]);
  const completeArrival = [{
    type: "childList",
    target: conversation,
    addedNodes: [assistant],
    removedNodes: []
  }];
  local.trackAssistantGenerationHelperRoots(completeArrival);
  local.markLiveGeneratedHelperCandidates(completeArrival);
  assert.equal(local.isLiveGeneratedHelperCandidate(candidate), false,
    "A complete historical helper before the current user turn must not borrow unrelated Stop evidence.");
  local.markUnprovenAutomaticHelperCandidatesAsBaseline([candidate]);
  assert.equal(local.getLastActionableSkillCandidate([candidate], conversation), candidate,
    "The fail-closed complete helper must remain available through explicit Process Skill recovery.");
}

function testStaleRouteStopNodeCannotProveLaterHydration() {
  const local = createContentContext();
  const stop = new local.Element({ role: "button", label: "Stop generating" });
  local.__reusedStopControls = [stop];
  local.document.querySelectorAll = (selector) => String(selector).includes("button")
    ? local.__reusedStopControls
    : [];
  vm.runInContext("observedPageIdentity = location.href; pageLifecycleGeneration = 12;", local);
  local.location.href = "https://chatgpt.com/c/reused-stop-node";
  local.refreshPageLifecycle();

  local.__reusedStopControls = [];
  local.observeAssistantGenerationEvidence([{
    type: "childList",
    target: new local.Element(),
    addedNodes: [],
    removedNodes: [stop]
  }], { allowRemovedControls: false });
  assert.equal(local.isAssistantGenerating(), false,
    "Removing a previous-route Stop must not create current-route generation evidence.");

  const conversation = new local.Element();
  const user = new local.Element({ author: "user" });
  const assistant = new local.Element({ author: "assistant" });
  assistant.textContent = "ai-helper-skill-start:reused-stop\ncmd: load";
  conversation.append(user);
  conversation.append(assistant);
  local.__reusedStopConversation = conversation;
  local.__reusedStopCandidates = [];
  vm.runInContext(`
    getConversationRoot = () => globalThis.__reusedStopConversation;
    extractShellCallCandidates = () => globalThis.__reusedStopCandidates;
  `, local);
  local.__reusedStopControls = [stop];
  assert.equal(local.observeAssistantGenerationEvidence([{
    type: "childList",
    target: conversation,
    addedNodes: [stop],
    removedNodes: []
  }]), false, "A Stop node snapshotted from the old route must remain stale for the entire new page lifecycle.");
  local.trackAssistantGenerationHelperRoots([{
    type: "childList",
    target: conversation,
    addedNodes: [assistant],
    removedNodes: []
  }]);

  const call = local.parseCallPayload([
    "ai-helper-skill-start:reused-stop",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"7".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n"));
  assistant.textContent = call.raw;
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  local.__reusedStopCandidates = [candidate];
  local.markLiveGeneratedHelperCandidates([{
    type: "characterData",
    target: assistant,
    oldValue: "ai-helper-skill-start:reused-stop\ncmd: load",
    addedNodes: [],
    removedNodes: []
  }]);
  assert.equal(local.isLiveGeneratedHelperCandidate(candidate), false,
    "Reusing an old-route Stop during late transcript hydration must not authorize the historical helper.");
  local.markUnprovenAutomaticHelperCandidatesAsBaseline([candidate]);
  assert.equal(local.getLastActionableSkillCandidate([candidate], conversation), candidate,
    "The fail-closed historical helper must remain available through explicit Process Skill recovery.");
}

function testReusedStopNodeStartsASeparateSameRouteGeneration() {
  const local = createContentContext();
  const conversation = new local.Element();
  const user = new local.Element({ author: "user" });
  const firstAssistant = new local.Element({ author: "assistant" });
  firstAssistant.textContent = "ai-helper-skill-start:first-generation\ncmd: load";
  conversation.append(user);
  conversation.append(firstAssistant);
  local.__sameRouteConversation = conversation;
  local.__sameRouteControls = [];
  local.__sameRouteCandidates = [];
  local.document.querySelectorAll = (selector) => String(selector).includes("button")
    ? local.__sameRouteControls
    : [];
  vm.runInContext(`
    getConversationRoot = () => globalThis.__sameRouteConversation;
    extractShellCallCandidates = () => globalThis.__sameRouteCandidates;
  `, local);

  const reusedStop = new local.Element({ role: "button", label: "Stop generating" });
  local.__sameRouteControls = [reusedStop];
  local.observeAssistantGenerationEvidence([{
    type: "childList",
    target: conversation,
    addedNodes: [reusedStop, firstAssistant],
    removedNodes: []
  }]);
  local.trackAssistantGenerationHelperRoots([{
    type: "childList",
    target: firstAssistant,
    addedNodes: [firstAssistant],
    removedNodes: []
  }]);

  local.__sameRouteControls = [];
  local.observeAssistantGenerationEvidence([{
    type: "childList",
    target: conversation,
    addedNodes: [],
    removedNodes: [reusedStop]
  }]);

  firstAssistant.isConnected = false;
  const secondAssistant = new local.Element({ author: "assistant" });
  const secondHelperText = [
    "ai-helper-skill-start:second-generation",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"9".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n");
  const call = local.parseCallPayload(secondHelperText);
  secondAssistant.textContent = secondHelperText;
  conversation.append(secondAssistant);
  const candidate = {
    call,
    node: secondAssistant,
    textRoot: secondAssistant,
    source: "text",
    blockIndex: 0
  };
  local.__sameRouteCandidates = [candidate];
  local.__sameRouteControls = [reusedStop];
  const secondBatch = [{
    type: "childList",
    target: conversation,
    addedNodes: [reusedStop, secondAssistant],
    removedNodes: [firstAssistant]
  }];
  assert.equal(local.observeAssistantGenerationEvidence(secondBatch), true);
  local.trackAssistantGenerationHelperRoots(secondBatch);
  local.markLiveGeneratedHelperCandidates(secondBatch);
  assert.equal(
    vm.runInContext("assistantGenerationEpoch?.responseMessageRoot === globalThis.__sameRouteConversation.children[2]", local),
    true,
    "A separately removed and re-added host Stop node must bind the new assistant response, not remain owned by the old generation."
  );
  assert.equal(local.isLiveGeneratedHelperCandidate(candidate), true,
    "A host that reuses its Stop DOM node must not cause a genuine later Skill helper to be missed.");
}

function testOldResponseCannotCompleteAfterLaterUserTurn() {
  const local = createContentContext();
  const conversation = new local.Element();
  const firstUser = new local.Element({ author: "user" });
  const oldAssistant = new local.Element({ author: "assistant" });
  oldAssistant.textContent = "ai-helper-skill-start:old-response\ncmd: load";
  conversation.append(firstUser);
  conversation.append(oldAssistant);
  local.__laterUserConversation = conversation;
  local.__laterUserCandidates = [];
  vm.runInContext(`
    getConversationRoot = () => globalThis.__laterUserConversation;
    extractShellCallCandidates = () => globalThis.__laterUserCandidates;
  `, local);
  const stop = new local.Element({ role: "button", label: "Stop generating" });
  local.observeAssistantGenerationEvidence([{
    type: "childList",
    target: conversation,
    addedNodes: [stop, oldAssistant],
    removedNodes: []
  }]);
  local.trackAssistantGenerationHelperRoots([{
    type: "childList",
    target: oldAssistant,
    addedNodes: [oldAssistant],
    removedNodes: []
  }]);

  const laterUser = new local.Element({ author: "user" });
  conversation.append(laterUser);
  const call = local.parseCallPayload([
    "ai-helper-skill-start:old-response",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"a".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n"));
  oldAssistant.textContent = call.raw;
  const candidate = { call, node: oldAssistant, textRoot: oldAssistant, source: "text", blockIndex: 0 };
  local.__laterUserCandidates = [candidate];
  const completion = [{
    type: "characterData",
    target: oldAssistant,
    addedNodes: [],
    removedNodes: [stop]
  }];
  assert.equal(local.observeAssistantGenerationEvidence(completion), false,
    "A later explicit user turn must end the old assistant generation epoch immediately.");
  local.markLiveGeneratedHelperCandidates(completion);
  assert.equal(local.isLiveGeneratedHelperCandidate(candidate), false,
    "An old response completing after the next user turn must never dispatch its Skill helper automatically.");
}

function testSameBatchRouteStopReconciliation() {
  for (const movedFromOldRoute of [false, true]) {
    const local = createContentContext();
    const stop = new local.Element({ role: "button", label: "Stop generating" });
    local.__sameBatchControls = [];
    local.document.querySelectorAll = (selector) => String(selector).includes("button")
      ? local.__sameBatchControls
      : [];
    vm.runInContext("observedPageIdentity = location.href; pageLifecycleGeneration = 22;", local);
    local.location.href = `https://chatgpt.com/c/same-batch-stop-${movedFromOldRoute}`;
    local.__sameBatchControls = [stop];
    assert.equal(local.refreshPageLifecycle(), true);
    assert.equal(local.isAssistantGenerating(), false,
      "The route-transition snapshot must initially treat every already-visible Stop as stale.");
    const records = [{
      type: "childList",
      target: new local.Element(),
      addedNodes: [stop],
      removedNodes: movedFromOldRoute ? [stop] : []
    }];
    local.reconcileStaleRouteGenerationControls(records);
    assert.equal(
      local.isAssistantGenerating(),
      !movedFromOldRoute,
      movedFromOldRoute
        ? "A Stop moved from the old tree in the route batch must remain stale."
        : "A newly added Stop in the route batch must prove the first current-route response."
    );
    const evidence = local.observeAssistantGenerationEvidence(records, { allowRemovedControls: false });
    assert.equal(evidence, !movedFromOldRoute,
      "The route batch itself must distinguish a genuinely new Stop from a moved old Stop.");
    if (movedFromOldRoute) {
      assert.equal(local.observeAssistantGenerationEvidence([{
        type: "childList",
        target: new local.Element(),
        addedNodes: [new local.Element()],
        removedNodes: []
      }]), false,
      "A moved old Stop must remain stale across a later unrelated observer batch.");
      assert.equal(local.isAssistantGenerating(), false,
        "A moved old Stop must not become current-route generation evidence one batch later.");
    }
  }
}

function testRouteCarriedResponseSurvivesExpiredTail() {
  const local = createContentContext();
  const conversation = new local.Element();
  const user = new local.Element({ author: "user" });
  user.textContent = "load the slow route skill";
  const assistant = new local.Element({ author: "assistant" });
  assistant.textContent = "ai-helper-skill-start:slow-route\ncmd: load";
  conversation.append(user);
  conversation.append(assistant);
  local.__slowRouteConversation = conversation;
  local.__slowRouteCandidates = [];
  vm.runInContext(`
    getConversationRoot = () => globalThis.__slowRouteConversation;
    extractShellCallCandidates = () => globalThis.__slowRouteCandidates;
    observedPageIdentity = location.href;
  `, local);
  const stop = new local.Element({ role: "button", label: "Stop generating" });
  local.observeAssistantGenerationEvidence([{
    type: "childList",
    target: conversation,
    addedNodes: [stop, assistant],
    removedNodes: []
  }]);
  local.trackAssistantGenerationHelperRoots([{ target: assistant, addedNodes: [assistant], removedNodes: [] }]);
  assert.equal(vm.runInContext("assistantGenerationEpoch?.responseMessageRoot === globalThis.__slowRouteConversation.children[1]", local), true);

  local.location.href = "https://chatgpt.com/c/slow-assigned-route";
  local.refreshPageLifecycle();
  vm.runInContext("assistantGenerationEvidenceUntil = 0", local);
  const completedHelperText = [
    "ai-helper-skill-start:slow-route",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"4".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n");
  const call = local.parseCallPayload(completedHelperText);
  assistant.textContent = completedHelperText;
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  local.__slowRouteCandidates = [candidate];
  const completion = [{
    type: "characterData",
    target: assistant,
    oldValue: "ai-helper-skill-start:slow-route\ncmd: load",
    addedNodes: [],
    removedNodes: [stop]
  }];
  assert.equal(local.observeAssistantGenerationEvidence(completion, { allowRemovedControls: false }), true,
    "A mutation in the exact carried response root must survive the old three-second tail.");
  local.markLiveGeneratedHelperCandidates(completion);
  assert.equal(local.isLiveGeneratedHelperCandidate(candidate), true,
    "A slow helper completing in the frozen pre-route response root must stay live.");
}

function testRouteCarriedStopCannotAuthorizeNewRoot() {
  const local = createContentContext();
  const conversation = new local.Element();
  const user = new local.Element({ author: "user" });
  user.textContent = "load only the tracked route response";
  const oldAssistant = new local.Element({ author: "assistant" });
  oldAssistant.textContent = "ai-helper-skill-start:old-route-root\ncmd: load";
  conversation.append(user);
  conversation.append(oldAssistant);
  local.__frozenRouteConversation = conversation;
  local.__frozenRouteCandidates = [];
  vm.runInContext(`
    getConversationRoot = () => globalThis.__frozenRouteConversation;
    extractShellCallCandidates = () => globalThis.__frozenRouteCandidates;
    observedPageIdentity = location.href;
  `, local);
  const stop = new local.Element({ role: "button", label: "Stop generating" });
  local.observeAssistantGenerationEvidence([{ target: conversation, addedNodes: [stop, oldAssistant], removedNodes: [] }]);
  local.trackAssistantGenerationHelperRoots([{ target: oldAssistant, addedNodes: [oldAssistant], removedNodes: [] }]);
  local.location.href = "https://chatgpt.com/c/replacement-route-root";
  local.refreshPageLifecycle();
  vm.runInContext("assistantGenerationEvidenceUntil = 0; initialThreadSettled = true", local);

  const newAssistant = new local.Element({ author: "assistant" });
  const call = local.parseCallPayload([
    "ai-helper-skill-start:new-route-root",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"5".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n"));
  newAssistant.textContent = call.raw;
  conversation.append(newAssistant);
  const candidate = { call, node: newAssistant, textRoot: newAssistant, source: "text", blockIndex: 0 };
  local.__frozenRouteCandidates = [candidate];
  const arrival = [{ target: conversation, addedNodes: [newAssistant], removedNodes: [] }];
  const active = local.observeAssistantGenerationEvidence(arrival, { allowRemovedControls: false });
  if (active) {
    local.trackAssistantGenerationHelperRoots(arrival);
    local.markLiveGeneratedHelperCandidates(arrival);
  }
  assert.equal(local.isLiveGeneratedHelperCandidate(candidate), false,
    "A retained old-route Stop must never authorize a new post-route response root.");
  local.markUnprovenAutomaticHelperCandidatesAsBaseline([candidate]);
  assert.equal(local.getLastActionableSkillCandidate([candidate], conversation), candidate,
    "The rejected post-route root must remain explicitly recoverable.");
}

function testRouteCarriedRecycledElementsCannotAuthorizeRewrittenChat() {
  const local = createContentContext();
  const conversation = new local.Element();
  const user = new local.Element({ author: "user" });
  user.textContent = "chat A request";
  const assistant = new local.Element({ author: "assistant" });
  assistant.textContent = "ai-helper-skill-start:chat-a-partial\ncmd: load";
  conversation.append(user);
  conversation.append(assistant);
  local.__recycledRouteConversation = conversation;
  local.__recycledRouteCandidates = [];
  vm.runInContext(`
    getConversationRoot = () => globalThis.__recycledRouteConversation;
    extractShellCallCandidates = () => globalThis.__recycledRouteCandidates;
    observedPageIdentity = location.href;
  `, local);
  const stop = new local.Element({ role: "button", label: "Stop generating" });
  local.observeAssistantGenerationEvidence([{
    type: "childList",
    target: conversation,
    addedNodes: [stop, assistant],
    removedNodes: []
  }]);
  local.trackAssistantGenerationHelperRoots([{
    type: "childList",
    target: assistant,
    addedNodes: [assistant],
    removedNodes: []
  }]);

  local.location.href = "https://chatgpt.com/c/recycled-route-elements";
  assert.equal(local.refreshPageLifecycle(), true);
  user.textContent = "chat B unrelated request";
  const helperText = [
    "ai-helper-skill-start:chat-b-rewrite",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"b".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n");
  const call = local.parseCallPayload(helperText);
  assistant.textContent = helperText;
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  local.__recycledRouteCandidates = [candidate];
  vm.runInContext("assistantGenerationEvidenceUntil = 0", local);
  const rewrite = [{
    type: "characterData",
    target: assistant,
    addedNodes: [],
    removedNodes: [stop]
  }];
  assert.equal(local.observeAssistantGenerationEvidence(rewrite, { allowRemovedControls: false }), false,
    "Rewriting the same user/assistant Elements for another chat must invalidate route-carried generation evidence.");
  local.markLiveGeneratedHelperCandidates(rewrite);
  assert.equal(local.isLiveGeneratedHelperCandidate(candidate), false,
    "DOM object reuse across chats must not authorize the rewritten Skill helper.");

  local.location.href = "https://chatgpt.com/c/a-second-route";
  assert.equal(local.refreshPageLifecycle(), true);
  assert.equal(vm.runInContext("assistantGenerationEpoch", local), null,
    "A generation epoch may cross at most one provisional-to-permanent route assignment.");
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
  assistant.textContent = call.raw;
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

async function testLateHydratedHistoryRequiresExplicitSkillRecovery() {
  const local = createContentContext();
  const conversation = new local.Element();
  local.__lateHistoryConversation = conversation;
  local.__lateHistoryCandidates = [];
  let backendCalls = 0;
  local.chrome.runtime.sendMessage = async (message) => {
    if (message?.type === "skill-load") {
      backendCalls += 1;
    }
    return { ok: false, error: "expected test rejection" };
  };
  local.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100,
    autoSend: true
  });
  vm.runInContext(`
    extensionActive = true;
    observedPageIdentity = location.href;
    getConversationRoot = () => globalThis.__lateHistoryConversation;
    extractShellCallCandidates = () => globalThis.__lateHistoryCandidates;
    loadPendingHelperDeliveriesForCurrentPage = async () => {};
    schedulePendingHelperDeliveryRetry = () => {};
    scheduleScan = () => {};
    updateSiteActionButton = () => {};
    queueSkillComposerReply = async () => true;
    lastThreadText = "";
    lastThreadTextAt = 0;
  `, local);

  await local.scanForShellCall();
  assert.equal(vm.runInContext("initialThreadSettled", local), true,
    "The regression must begin after an empty fresh lifecycle has explicitly settled.");

  const user = new local.Element({ author: "user" });
  const assistant = new local.Element({ author: "assistant" });
  const helperText = [
    "ai-helper-skill-start:late-history",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"6".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n");
  const call = local.parseCallPayload(helperText);
  assistant.textContent = "ai-helper-skill-start:late-history\ncmd: load";
  conversation.append(user);
  conversation.append(assistant);
  assert.equal(local.observeAssistantGenerationEvidence([{
    target: conversation,
    addedNodes: [user, assistant],
    removedNodes: []
  }]), false,
  "A late historical user+partial-assistant pair must not create generation evidence without a trusted control.");
  assistant.textContent = helperText;
  conversation.textContent = helperText;
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  local.__lateHistoryCandidates = [candidate];
  const completion = [{ target: assistant, addedNodes: [new local.Element()], removedNodes: [] }];
  assert.equal(local.observeAssistantGenerationEvidence(completion), false,
    "Completing the late historical helper must not self-bootstrap a generation epoch.");
  local.markLiveGeneratedHelperCandidates(completion);
  assert.equal(local.isLiveGeneratedHelperCandidate(candidate), false);
  vm.runInContext(`
    lastThreadText = normalizeText(globalThis.__lateHistoryConversation.textContent);
    lastThreadTextAt = 0;
  `, local);

  await local.scanForShellCall();
  assert.deepEqual(
    {
      backendCalls,
      processSkillActionable: local.getLastActionableSkillCandidate([candidate], conversation) === candidate
    },
    { backendCalls: 0, processSkillActionable: true },
    "A historical Skill mounted after the initial empty lifecycle settled must stay inert and expose Process Skill."
  );
}

async function testLateHydratedShellRequiresExplicitForce() {
  const local = createContentContext();
  const conversation = new local.Element();
  local.__lateShellConversation = conversation;
  local.__lateShellCandidates = [];
  local.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100,
    autoSend: true
  });
  vm.runInContext(`
    extensionActive = true;
    observedPageIdentity = location.href;
    getConversationRoot = () => globalThis.__lateShellConversation;
    extractShellCallCandidates = () => globalThis.__lateShellCandidates;
    loadPendingHelperDeliveriesForCurrentPage = async () => {};
    schedulePendingHelperDeliveryRetry = () => {};
    scheduleScan = () => {};
    updateSiteActionButton = () => {};
    globalThis.__lateShellBackendRuns = 0;
    runAndReply = async () => {
      globalThis.__lateShellBackendRuns += 1;
      return {};
    };
    lastThreadText = "";
    lastThreadTextAt = 0;
  `, local);
  await local.scanForShellCall();
  assert.equal(vm.runInContext("initialThreadSettled", local), true,
    "The Shell regression must begin after the empty lifecycle is settled.");

  const user = new local.Element({ author: "user" });
  const assistant = new local.Element({ author: "assistant" });
  const helperText = [
    "ai-helper-shell-start:late-shell-history",
    "printf late-history",
    "ai-helper-shell-end"
  ].join("\n");
  const call = local.parseCallPayload(helperText);
  assistant.textContent = helperText;
  conversation.append(user);
  conversation.append(assistant);
  conversation.textContent = helperText;
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  local.__lateShellCandidates = [candidate];
  const hydration = [{ target: conversation, addedNodes: [user, assistant], removedNodes: [] }];
  assert.equal(local.observeAssistantGenerationEvidence(hydration), false,
    "A late historical user+assistant Shell pair must not self-bootstrap generation evidence.");
  local.markLiveGeneratedHelperCandidates(hydration);
  assert.equal(local.isLiveGeneratedHelperCandidate(candidate), false);
  vm.runInContext(`
    lastThreadText = normalizeText(globalThis.__lateShellConversation.textContent);
    lastThreadTextAt = 0;
  `, local);

  await local.scanForShellCall();
  const forceCandidate = local.getLastForceEligibleRunnableCandidate([candidate], conversation);
  assert.deepEqual(
    {
      backendRuns: vm.runInContext("globalThis.__lateShellBackendRuns", local),
      forceAvailable: forceCandidate === candidate,
      latestManualAction: local.getLatestManualActionKind([candidate], forceCandidate, null)
    },
    { backendRuns: 0, forceAvailable: true, latestManualAction: "force" },
    "A late hydrated historical Shell helper must remain inert while exposing Force run."
  );
}

async function testVisibleOldRouteStopCannotAuthorizeReplacementHistory() {
  for (const kind of ["shell", "skill"]) {
    const local = createContentContext();
    const oldStop = new local.Element({ role: "button", label: "Stop generating" });
    local.__oldRouteControls = [oldStop];
    local.document.querySelectorAll = (selector) => String(selector).includes("button")
      ? local.__oldRouteControls
      : [];
    local.__replacementConversation = new local.Element();
    local.__replacementCandidates = [];
    let skillBackendCalls = 0;
    local.chrome.runtime.sendMessage = async (message) => {
      if (message?.type === "skill-load") {
        skillBackendCalls += 1;
      }
      return { ok: false, error: "unexpected replacement-history dispatch" };
    };
    local.chrome.storage.sync.get = async () => ({
      enabled: true,
      enabledHosts: ["chatgpt.com"],
      maxChainCalls: 100,
      autoSend: true
    });
    vm.runInContext(`
      extensionActive = true;
      observedPageIdentity = location.href;
      initialThreadSettled = true;
      getConversationRoot = () => globalThis.__replacementConversation;
      extractShellCallCandidates = () => globalThis.__replacementCandidates;
      loadPendingHelperDeliveriesForCurrentPage = async () => {};
      schedulePendingHelperDeliveryRetry = () => {};
      scheduleScan = () => {};
      updateSiteActionButton = () => {};
      queueSkillComposerReply = async () => true;
      globalThis.__replacementShellRuns = 0;
      runAndReply = async () => {
        globalThis.__replacementShellRuns += 1;
        return {};
      };
    `, local);

    local.location.href = `https://chatgpt.com/c/replacement-${kind}`;
    local.refreshPageLifecycle();
    assert.equal(local.isAssistantGenerating(), false,
      `A still-visible Stop control captured from the old route must not block replacement ${kind} recovery forever.`);
    const assistant = new local.Element({ author: "assistant" });
    const helperText = kind === "skill"
      ? [
          `ai-helper-skill-start:old-route-${kind}`,
          "cmd: load",
          "skill-id: example",
          `catalog-sha: ${"9".repeat(64)}`,
          "ai-helper-skill-end"
        ].join("\n")
      : [
          `ai-helper-shell-start:old-route-${kind}`,
          "printf old-route-history",
          "ai-helper-shell-end"
        ].join("\n");
    const call = local.parseCallPayload(helperText);
    assistant.textContent = helperText;
    local.__replacementConversation.append(assistant);
    local.__replacementConversation.textContent = helperText;
    const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
    local.__replacementCandidates = [candidate];
    const evidenceActive = local.observeAssistantGenerationEvidence([{
      target: local.__replacementConversation,
      addedNodes: [assistant],
      removedNodes: []
    }], { allowRemovedControls: false });
    if (evidenceActive) {
      local.trackAssistantGenerationHelperRoots([{ target: assistant, addedNodes: [assistant], removedNodes: [] }]);
      local.markLiveGeneratedHelperCandidates([{ target: assistant, addedNodes: [assistant], removedNodes: [] }]);
    }
    assert.equal(local.isLiveGeneratedHelperCandidate(candidate), false,
      `A Stop control retained from the old route must not make replacement ${kind} history live.`);
    vm.runInContext(`
      lastThreadText = normalizeText(globalThis.__replacementConversation.textContent);
      lastThreadTextAt = 0;
    `, local);
    await local.scanForShellCall();
    assert.deepEqual(
      {
        shellRuns: vm.runInContext("globalThis.__replacementShellRuns", local),
        skillBackendCalls
      },
      { shellRuns: 0, skillBackendCalls: 0 },
      `Visible old-route Stop evidence must not auto-dispatch replacement ${kind} history.`
    );
  }
}

async function testLiveStopSkillCompletionDispatchesExactlyOnce() {
  const local = createContentContext();
  const conversation = new local.Element();
  const user = new local.Element({ author: "user" });
  const assistant = new local.Element({ author: "assistant" });
  assistant.textContent = "ai-helper-skill-start:live-stop\ncmd: load";
  conversation.append(user);
  conversation.append(assistant);
  conversation.textContent = assistant.textContent;
  local.__liveStopConversation = conversation;
  local.__liveStopCandidates = [];
  vm.runInContext(`
    extensionActive = true;
    observedPageIdentity = location.href;
    initialThreadSettled = true;
    getConversationRoot = () => globalThis.__liveStopConversation;
    extractShellCallCandidates = () => globalThis.__liveStopCandidates;
    loadPendingHelperDeliveriesForCurrentPage = async () => {};
    schedulePendingHelperDeliveryRetry = () => {};
    scheduleScan = () => {};
    updateSiteActionButton = () => {};
    queueSkillComposerReply = async () => true;
  `, local);
  const stop = new local.Element({ role: "button", label: "Stop generating" });
  local.observeAssistantGenerationEvidence([{ target: conversation, addedNodes: [stop], removedNodes: [] }]);
  local.trackAssistantGenerationHelperRoots([{ target: assistant, addedNodes: [assistant], removedNodes: [] }]);

  const helperText = [
    "ai-helper-skill-start:live-stop",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"a".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n");
  const call = local.parseCallPayload(helperText);
  assistant.textContent = helperText;
  conversation.textContent = helperText;
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  local.__liveStopCandidates = [candidate];
  local.markLiveGeneratedHelperCandidates([{ target: assistant, addedNodes: [new local.Element()], removedNodes: [stop] }]);
  assert.equal(local.isLiveGeneratedHelperCandidate(candidate), true,
    "A Skill completed in the exact Stop-tracked assistant root must retain live generation proof.");
  let backendCalls = 0;
  local.chrome.runtime.sendMessage = async (message) => {
    if (message?.type === "skill-load") {
      backendCalls += 1;
    }
    return {
      ok: true,
      catalogSha: "a".repeat(64),
      skill: { id: "example", sha: "b".repeat(64) },
      content: "live Skill body"
    };
  };
  local.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100,
    autoSend: true
  });
  vm.runInContext(`
    lastThreadText = normalizeText(globalThis.__liveStopConversation.textContent);
    lastThreadTextAt = 0;
  `, local);
  await local.scanForShellCall();
  await local.scanForShellCall();
  assert.equal(backendCalls, 1,
    "A genuinely live Stop-tracked Skill completion must dispatch exactly once across repeated scans.");
}

async function testAtomicCurrentAssistantSkillDispatchesExactlyOnce() {
  const local = createContentContext();
  const conversation = new local.Element();
  const user = new local.Element({ author: "user" });
  const assistant = new local.Element({ author: "assistant" });
  const helperText = [
    "ai-helper-skill-start:atomic-current",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"6".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n");
  const call = local.parseCallPayload(helperText);
  assistant.textContent = helperText;
  conversation.append(user);
  conversation.append(assistant);
  conversation.textContent = helperText;
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  local.__atomicConversation = conversation;
  local.__atomicCandidates = [candidate];
  vm.runInContext(`
    extensionActive = true;
    observedPageIdentity = location.href;
    initialThreadSettled = true;
    getConversationRoot = () => globalThis.__atomicConversation;
    extractShellCallCandidates = () => globalThis.__atomicCandidates;
    loadPendingHelperDeliveriesForCurrentPage = async () => {};
    schedulePendingHelperDeliveryRetry = () => {};
    scheduleScan = () => {};
    updateSiteActionButton = () => {};
    queueSkillComposerReply = async () => true;
  `, local);
  let backendCalls = 0;
  local.chrome.runtime.sendMessage = async () => {
    backendCalls += 1;
    return {
      ok: true,
      catalogSha: "6".repeat(64),
      skill: { id: "example", sha: "7".repeat(64) },
      content: "atomic Skill body"
    };
  };
  local.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100,
    autoSend: true
  });
  const stop = new local.Element({ role: "button", label: "Stop generating" });
  const atomicBatch = [{
    type: "childList",
    target: conversation,
    addedNodes: [stop, assistant],
    removedNodes: []
  }];
  assert.equal(local.observeAssistantGenerationEvidence(atomicBatch), true);
  local.trackAssistantGenerationHelperRoots(atomicBatch);
  local.markLiveGeneratedHelperCandidates(atomicBatch);
  assert.equal(local.isLiveGeneratedHelperCandidate(candidate), true,
    "A complete current assistant helper in the same observer batch as generation evidence must be live.");
  vm.runInContext(`
    lastThreadText = normalizeText(globalThis.__atomicConversation.textContent);
    lastThreadTextAt = 0;
  `, local);
  await local.scanForShellCall();
  await local.scanForShellCall();
  assert.equal(backendCalls, 1,
    "An atomic current-assistant Skill must dispatch exactly once across repeated scans.");
}

async function testUnknownRoleAtomicSkillFailsClosed() {
  const local = createContentContext();
  const conversation = new local.Element();
  const user = new local.Element({ author: "user" });
  const unknown = new local.Element();
  const helperText = [
    "ai-helper-skill-start:atomic-unknown",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"8".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n");
  const call = local.parseCallPayload(helperText);
  unknown.textContent = helperText;
  conversation.append(user);
  conversation.append(unknown);
  conversation.textContent = helperText;
  const candidate = { call, node: unknown, textRoot: unknown, source: "text", blockIndex: 0 };
  local.__unknownConversation = conversation;
  local.__unknownCandidates = [candidate];
  vm.runInContext(`
    extensionActive = true;
    observedPageIdentity = location.href;
    initialThreadSettled = true;
    getConversationRoot = () => globalThis.__unknownConversation;
    extractShellCallCandidates = () => globalThis.__unknownCandidates;
    loadPendingHelperDeliveriesForCurrentPage = async () => {};
    schedulePendingHelperDeliveryRetry = () => {};
    scheduleScan = () => {};
    updateSiteActionButton = () => {};
    queueSkillComposerReply = async () => true;
  `, local);
  let backendCalls = 0;
  local.chrome.runtime.sendMessage = async () => {
    backendCalls += 1;
    return { ok: false };
  };
  local.chrome.storage.sync.get = async () => ({
    enabled: true,
    enabledHosts: ["chatgpt.com"],
    maxChainCalls: 100,
    autoSend: true
  });
  const stop = new local.Element({ role: "button", label: "Stop generating" });
  const batch = [{ target: conversation, addedNodes: [stop, unknown], removedNodes: [] }];
  local.observeAssistantGenerationEvidence(batch);
  local.trackAssistantGenerationHelperRoots(batch);
  local.markLiveGeneratedHelperCandidates(batch);
  vm.runInContext(`
    lastThreadText = normalizeText(globalThis.__unknownConversation.textContent);
    lastThreadTextAt = 0;
  `, local);
  await local.scanForShellCall();
  assert.equal(backendCalls, 0,
    "An unknown-role helper must not borrow generation proof even when it is atomic and DOM-latest.");
  assert.equal(local.isBaselineIgnoredHelperCandidate(candidate), true);
  assert.equal(local.getLastActionableSkillCandidate([candidate], conversation), candidate,
    "Unknown-role helpers must fail closed while preserving explicit Process Skill recovery.");
}

async function testColdBaselineSurvivesRedrawButYieldsToLiveGeneration() {
  const local = createContentContext();
  const conversation = new local.Element();
  const user = new local.Element({ author: "user" });
  const assistant = new local.Element({ author: "assistant" });
  conversation.append(user);
  conversation.append(assistant);
  const call = local.parseCallPayload([
    "ai-helper-skill-start:recycled-root",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"d".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n"));
  assistant.textContent = "ai-helper-skill-start:recycled-root";
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  const semanticKey = local.buildSemanticCallKey(call);
  local.markCallBaselineIgnored(candidate, semanticKey);
  local.__candidate = candidate;
  local.__conversation = conversation;
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
  const stop = new local.Element({ role: "button", label: "Stop generating" });
  local.observeAssistantGenerationEvidence([{ target: conversation, addedNodes: [stop], removedNodes: [] }]);
  local.trackAssistantGenerationHelperRoots([{ target: assistant, addedNodes: [assistant], removedNodes: [] }]);
  assert.equal(vm.runInContext("assistantGenerationEpoch?.responseMessageRoot === __candidate.textRoot", local), true,
    "The positive recycled-root path must bind the exact current assistant message.");
  local.markLiveGeneratedHelperCandidates([{
    target: assistant,
    addedNodes: [new local.Element()],
    removedNodes: []
  }]);
  assert.equal(local.isLiveGeneratedHelperCandidate(candidate), true,
    "The tracked recycled helper must receive exact candidate-bound live proof.");
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

async function testSameRootGenerationChangeRejectsBackendResult() {
  const local = createContentContext();
  const conversation = new local.Element();
  const assistant = new local.Element({ author: "assistant" });
  conversation.append(assistant);
  const helperText = [
    "ai-helper-skill-start:same-root-generation",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"2".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n");
  const call = local.parseCallPayload(helperText);
  assistant.textContent = helperText;
  conversation.textContent = helperText;
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  local.__sameRootConversation = conversation;
  local.__sameRootCandidates = [candidate];
  vm.runInContext(`
    getConversationRoot = () => globalThis.__sameRootConversation;
    extractShellCallCandidates = () => globalThis.__sameRootCandidates;
    observedPageIdentity = location.href;
    pageLifecycleGeneration = 90;
  `, local);
  let resolveBackend;
  local.chrome.runtime.sendMessage = () => new Promise((resolve) => { resolveBackend = resolve; });
  const pending = local.processLatestSkillCandidate([candidate], { maxChainCalls: 100 });
  await Promise.resolve();

  assistant.textContent = "This root now renders unrelated assistant text.";
  local.__sameRootCandidates = [];
  local.invalidateRenderedHelperTracking([{
    type: "characterData",
    target: assistant,
    oldValue: helperText,
    addedNodes: [],
    removedNodes: []
  }]);
  assistant.textContent = helperText;
  local.__sameRootCandidates = [candidate];
  resolveBackend({
    ok: true,
    catalogSha: "2".repeat(64),
    skill: { id: "example", sha: "3".repeat(64) },
    content: "stale body"
  });
  assert.equal(await pending, false,
    "A backend result must lose ownership when its render root changes generation, even if the old helper text returns.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", local), 0,
    "A same-root helper→other→helper race must not queue the old backend response.");
  assert.equal(local.getLastActionableSkillCandidate([candidate], conversation), candidate,
    "The restored exact helper must remain recoverable manually after the stale response is rejected.");
}

async function testDetachedBackendResultRemainsManuallyRecoverable() {
  const local = createContentContext();
  const conversation = new local.Element();
  const assistant = new local.Element({ author: "assistant" });
  conversation.append(assistant);
  const helperText = [
    "ai-helper-skill-start:detached-backend",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"4".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n");
  const call = local.parseCallPayload(helperText);
  assistant.textContent = helperText;
  conversation.textContent = helperText;
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  local.__detachedConversation = conversation;
  local.__detachedCandidates = [candidate];
  vm.runInContext(`
    getConversationRoot = () => globalThis.__detachedConversation;
    extractShellCallCandidates = () => globalThis.__detachedCandidates;
    observedPageIdentity = location.href;
    pageLifecycleGeneration = 91;
  `, local);
  let resolveBackend;
  local.chrome.runtime.sendMessage = () => new Promise((resolve) => { resolveBackend = resolve; });
  const pending = local.processLatestSkillCandidate([candidate], { maxChainCalls: 100 });
  await Promise.resolve();

  assistant.isConnected = false;
  local.__detachedCandidates = [];
  local.invalidateRenderedHelperTracking([{
    type: "childList",
    target: conversation,
    addedNodes: [],
    removedNodes: [assistant]
  }]);
  resolveBackend({
    ok: true,
    catalogSha: "4".repeat(64),
    skill: { id: "example", sha: "5".repeat(64) },
    content: "detached body"
  });
  assert.equal(await pending, false,
    "A backend result completed while its exact helper root is detached must be discarded.");

  assistant.isConnected = true;
  local.__detachedCandidates = [candidate];
  local.markUnprovenAutomaticHelperCandidatesAsBaseline([candidate]);
  assert.equal(local.getLastActionableSkillCandidate([candidate], conversation), candidate,
    "Reattaching the helper must expose Process Skill instead of leaving a permanent processed dead-end.");
}

async function testQueuedSkillResultRejectsSameUrlTranscriptReplacement() {
  const local = createContentContext();
  const originalConversation = new local.Element();
  const originalRoot = new local.Element({ author: "assistant" });
  originalConversation.append(originalRoot);
  const helperText = [
    "ai-helper-skill-start:queued-same-url",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"c".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n");
  const call = local.parseCallPayload(helperText);
  originalRoot.textContent = helperText;
  originalConversation.textContent = helperText;
  const candidate = { call, node: originalRoot, textRoot: originalRoot, source: "text", blockIndex: 0 };
  local.__queuedSkillConversation = originalConversation;
  local.__queuedSkillCandidates = [candidate];
  let backendCalls = 0;
  local.chrome.runtime.sendMessage = async (message) => {
    if (message?.type === "skill-load") {
      backendCalls += 1;
    }
    return {
      ok: true,
      catalogSha: "c".repeat(64),
      skill: { id: "example", sha: "d".repeat(64) },
      content: "queued Skill body"
    };
  };
  local.chrome.storage.sync.get = async () => ({ autoSend: true });
  vm.runInContext(`
    observedPageIdentity = location.href;
    pageLifecycleGeneration = 80;
    getConversationRoot = () => globalThis.__queuedSkillConversation;
    extractShellCallCandidates = () => globalThis.__queuedSkillCandidates;
    schedulePendingHelperDeliveryRetry = () => {};
    deliverHelperReply = async () => false;
  `, local);

  assert.equal(await local.processLatestSkillCandidate([candidate], { maxChainCalls: 100 }), true);
  assert.equal(backendCalls, 1, "The Skill backend must finish exactly once before the composer-absent recovery race.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", local), 1,
    "A completed Skill result must remain queued while the composer is absent.");
  const pendingEntry = vm.runInContext("Array.from(pendingHelperDeliveries.values())[0]", local);
  assert.equal(pendingEntry.phase, "queued");

  originalRoot.isConnected = false;
  local.__queuedSkillConversation = new local.Element();
  local.__queuedSkillCandidates = [];
  vm.runInContext(`
    globalThis.__queuedSkillComposerWrites = 0;
    deliverHelperReply = async () => {
      globalThis.__queuedSkillComposerWrites += 1;
      return true;
    };
  `, local);
  assert.equal(await local.attemptPendingHelperDelivery(pendingEntry, { autoSend: true }), false,
    "A queued Skill result must fail closed after same-URL transcript replacement.");
  assert.deepEqual(
    {
      composerWrites: vm.runInContext("globalThis.__queuedSkillComposerWrites", local),
      pending: vm.runInContext("pendingHelperDeliveries.size", local),
      backendCalls
    },
    { composerWrites: 0, pending: 0, backendCalls: 1 },
    "Retry after same-URL transcript replacement must discard the stale result without a composer write or backend replay."
  );
}

async function testQueuedSkillWriteAbortsDuringSameUrlReplacement() {
  const local = createContentContext();
  const conversation = new local.Element();
  const assistant = new local.Element({ author: "assistant" });
  const helperText = [
    "ai-helper-skill-start:queued-same-url-await",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"c".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n");
  const call = local.parseCallPayload(helperText);
  assistant.textContent = helperText;
  conversation.append(assistant);
  conversation.textContent = helperText;
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  local.__sameUrlAwaitConversation = conversation;
  local.__sameUrlAwaitCandidates = [candidate];
  let releaseComposer;
  local.__sameUrlAwaitComposerGate = new Promise((resolve) => {
    releaseComposer = resolve;
  });
  local.HTMLTextAreaElement = local.Element;
  local.HTMLInputElement = class HTMLInputElement {};
  local.Event = class Event {};
  vm.runInContext(`
    observedPageIdentity = location.href;
    pageLifecycleGeneration = 99;
    initialThreadSettled = true;
    getConversationRoot = () => globalThis.__sameUrlAwaitConversation;
    extractShellCallCandidates = () => globalThis.__sameUrlAwaitCandidates;
    schedulePendingHelperDeliveryRetry = () => {};
    globalThis.__sameUrlAwaitFindStarted = false;
    findReplyInput = async () => {
      globalThis.__sameUrlAwaitFindStarted = true;
      return globalThis.__sameUrlAwaitComposerGate;
    };
  `, local);
  const dispatchContext = local.createSkillDispatchContext(candidate);
  const entry = await local.rememberPendingHelperDelivery(
    "queued-same-url-await",
    { ...call, kind: "skill-load" },
    { ok: true },
    "Local Skill load result: same URL old transcript",
    { autoSend: true },
    {
      skillOriginProof: local.createStoredSkillOriginProof(dispatchContext),
      lifecycleGuard: () => local.isSkillDispatchContextCurrent(dispatchContext)
    }
  );
  const attempt = local.attemptPendingHelperDelivery(entry, { autoSend: true });
  for (let round = 0; round < 8; round += 1) {
    await Promise.resolve();
    if (vm.runInContext("globalThis.__sameUrlAwaitFindStarted", local)) break;
  }
  assert.equal(vm.runInContext("globalThis.__sameUrlAwaitFindStarted", local), true);

  assistant.isConnected = false;
  local.__sameUrlAwaitConversation = new local.Element();
  local.__sameUrlAwaitCandidates = [];
  let focusCount = 0;
  let mutationCount = 0;
  const replacementComposer = new local.Element();
  replacementComposer.focus = () => { focusCount += 1; };
  replacementComposer.dispatchEvent = () => { mutationCount += 1; };
  releaseComposer(replacementComposer);
  assert.equal(await attempt, false);
  assert.deepEqual({
    focusCount,
    mutationCount,
    pending: vm.runInContext("pendingHelperDeliveries.size", local)
  }, {
    focusCount: 0,
    mutationCount: 0,
    pending: 0
  }, "A same-URL transcript replacement during composer discovery must be rejected before focus or write.");
}

async function testQueuedSkillResultSurvivesOneRouteHandoff() {
  const local = createContentContext();
  const conversation = new local.Element();
  const assistant = new local.Element({ author: "assistant" });
  const helperText = [
    "ai-helper-skill-start:queued-route-handoff",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"e".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n");
  const call = local.parseCallPayload(helperText);
  assistant.textContent = helperText;
  conversation.append(assistant);
  conversation.textContent = helperText;
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  local.__queuedRouteConversation = conversation;
  local.__queuedRouteCandidates = [candidate];
  local.chrome.runtime.sendMessage = async () => ({
    ok: true,
    catalogSha: "e".repeat(64),
    skill: { id: "example", sha: "f".repeat(64) },
    content: "queued route body"
  });
  local.chrome.storage.sync.get = async () => ({ autoSend: true });
  vm.runInContext(`
    observedPageIdentity = location.href;
    pageLifecycleGeneration = 93;
    getConversationRoot = () => globalThis.__queuedRouteConversation;
    extractShellCallCandidates = () => globalThis.__queuedRouteCandidates;
    schedulePendingHelperDeliveryRetry = () => {};
    deliverHelperReply = async () => false;
  `, local);
  assert.equal(await local.processLatestSkillCandidate([candidate], { maxChainCalls: 100 }), true);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", local), 1);

  local.location.href = "https://chatgpt.com/c/permanent-queued-route";
  assert.equal(local.refreshPageLifecycle(), true);
  const migrated = vm.runInContext("Array.from(pendingHelperDeliveries.values())[0]", local);
  assert.ok(migrated, "The completed queued Skill result must migrate to the assigned route.");
  assert.ok(migrated.skillOriginProof, "The route handoff must retain stored origin proof.");
  assert.equal(migrated.skillRouteHandoffPending, true);
  assert.equal(typeof migrated.volatileLifecycleGuard, "function");
  migrated.restored = true;
  vm.runInContext("initialThreadSettled = true", local);
  vm.runInContext(`
    globalThis.__queuedRouteWrites = 0;
    deliverHelperReply = async () => {
      globalThis.__queuedRouteWrites += 1;
      return false;
    };
  `, local);
  await local.attemptPendingHelperDelivery(migrated, { autoSend: true });
  assert.equal(vm.runInContext("globalThis.__queuedRouteWrites", local), 1,
    "A queued backend result may remain deliverable once only when the exact helper root survives the route handoff.");
  assert.equal(migrated.skillRouteHandoffPending, false);
  assert.equal(migrated.skillOriginProof.pageIdentity, local.location.href);
}

async function testQueuedSkillResultCannotCrossIntoAnotherChat() {
  const local = createContentContext();
  const conversation = new local.Element();
  const assistant = new local.Element({ author: "assistant" });
  const helperText = [
    "ai-helper-skill-start:queued-cross-chat",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"1".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n");
  const call = local.parseCallPayload(helperText);
  assistant.textContent = helperText;
  conversation.append(assistant);
  conversation.textContent = helperText;
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  local.__crossChatConversation = conversation;
  local.__crossChatCandidates = [candidate];
  local.chrome.runtime.sendMessage = async () => ({
    ok: true,
    catalogSha: "1".repeat(64),
    skill: { id: "example", sha: "2".repeat(64) },
    content: "must remain in the originating chat"
  });
  local.chrome.storage.sync.get = async () => ({ autoSend: true });
  vm.runInContext(`
    observedPageIdentity = location.href;
    pageLifecycleGeneration = 94;
    getConversationRoot = () => globalThis.__crossChatConversation;
    extractShellCallCandidates = () => globalThis.__crossChatCandidates;
    schedulePendingHelperDeliveryRetry = () => {};
    deliverHelperReply = async () => false;
  `, local);
  assert.equal(await local.processLatestSkillCandidate([candidate], { maxChainCalls: 100 }), true);

  assistant.isConnected = false;
  local.__crossChatConversation = new local.Element();
  local.__crossChatCandidates = [];
  local.location.href = "https://chatgpt.com/c/unrelated-existing-chat";
  assert.equal(local.refreshPageLifecycle(), true);
  const migrated = vm.runInContext("Array.from(pendingHelperDeliveries.values())[0]", local);
  assert.ok(migrated);
  migrated.restored = true;
  vm.runInContext(`
    initialThreadSettled = true;
    globalThis.__crossChatWrites = 0;
    deliverHelperReply = async () => { globalThis.__crossChatWrites += 1; return false; };
  `, local);
  assert.equal(await local.attemptPendingHelperDelivery(migrated, { autoSend: true }), false);
  assert.deepEqual({
    writes: vm.runInContext("globalThis.__crossChatWrites", local),
    pending: vm.runInContext("pendingHelperDeliveries.size", local)
  }, { writes: 0, pending: 0 },
  "A URL change plus a different transcript must discard local Skill content without writing it into another chat.");
}

async function testQueuedSkillAttemptCannotWriteAfterTwoRoutes() {
  const local = createContentContext();
  const conversation = new local.Element();
  const assistant = new local.Element({ author: "assistant" });
  const helperText = [
    "ai-helper-skill-start:queued-two-routes",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"3".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n");
  const call = local.parseCallPayload(helperText);
  assistant.textContent = helperText;
  conversation.append(assistant);
  conversation.textContent = helperText;
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  local.__twoRouteConversation = conversation;
  local.__twoRouteCandidates = [candidate];
  let releaseComposer;
  let findStarted = false;
  local.__twoRouteComposerGate = new Promise((resolve) => {
    releaseComposer = resolve;
  });
  local.HTMLTextAreaElement = local.Element;
  local.HTMLInputElement = class HTMLInputElement {};
  local.Event = class Event {};
  local.chrome.storage.sync.get = async () => ({ autoSend: true });
  vm.runInContext(`
    observedPageIdentity = location.href;
    pageLifecycleGeneration = 95;
    initialThreadSettled = true;
    getConversationRoot = () => globalThis.__twoRouteConversation;
    extractShellCallCandidates = () => globalThis.__twoRouteCandidates;
    schedulePendingHelperDeliveryRetry = () => {};
    findReplyInput = async () => {
      globalThis.__twoRouteFindStarted = true;
      return globalThis.__twoRouteComposerGate;
    };
    globalThis.__twoRouteFindStarted = false;
  `, local);
  const dispatchContext = local.createSkillDispatchContext(candidate);
  const entry = await local.rememberPendingHelperDelivery(
    "queued-two-routes",
    { ...call, kind: "skill-load" },
    { ok: true },
    "Local Skill load result: must stay in chat A",
    { autoSend: true },
    {
      skillOriginProof: local.createStoredSkillOriginProof(dispatchContext),
      lifecycleGuard: () => local.isSkillDispatchContextCurrent(dispatchContext)
    }
  );
  const attempt = local.attemptPendingHelperDelivery(entry, { autoSend: true });
  for (let round = 0; round < 8; round += 1) {
    await Promise.resolve();
    findStarted = vm.runInContext("globalThis.__twoRouteFindStarted", local);
    if (findStarted) break;
  }
  assert.equal(findStarted, true, "The stale-write regression must pause inside composer discovery.");

  local.location.href = "https://chatgpt.com/c/first-assigned-route";
  assert.equal(local.refreshPageLifecycle(), true);
  local.location.href = "https://chatgpt.com/c/unrelated-second-route";
  assert.equal(local.refreshPageLifecycle(), true);
  let focusCount = 0;
  let mutationCount = 0;
  const composer = new local.Element();
  composer.focus = () => { focusCount += 1; };
  composer.dispatchEvent = () => { mutationCount += 1; };
  releaseComposer(composer);
  assert.equal(await attempt, false);
  await vm.runInContext("pendingHelperDeliveryStorageTail.catch(() => {})", local);
  assert.deepEqual({
    focusCount,
    mutationCount,
    pending: vm.runInContext("pendingHelperDeliveries.size", local)
  }, {
    focusCount: 0,
    mutationCount: 0,
    pending: 0
  }, "An old queued Skill attempt released after two routes must be cancelled before focus or any composer DOM write.");
}

async function testWrittenSkillPhasesCannotResumeAfterRoute() {
  for (const phase of ["inserted", "submitted-unconfirmed"]) {
    const local = createContentContext();
    const conversation = new local.Element();
    const assistant = new local.Element({ author: "assistant" });
    const helperText = [
      `ai-helper-skill-start:route-${phase}`,
      "cmd: load",
      "skill-id: example",
      `catalog-sha: ${"5".repeat(64)}`,
      "ai-helper-skill-end"
    ].join("\n");
    const call = local.parseCallPayload(helperText);
    assistant.textContent = helperText;
    conversation.append(assistant);
    conversation.textContent = helperText;
    const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
    local.__writtenPhaseConversation = conversation;
    local.__writtenPhaseCandidates = [candidate];
    let releaseComposer;
    local.__writtenPhaseComposerGate = new Promise((resolve) => {
      releaseComposer = resolve;
    });
    local.chrome.storage.sync.get = async () => ({ autoSend: true });
    vm.runInContext(`
      observedPageIdentity = location.href;
      pageLifecycleGeneration = 96;
      initialThreadSettled = true;
      getConversationRoot = () => globalThis.__writtenPhaseConversation;
      extractShellCallCandidates = () => globalThis.__writtenPhaseCandidates;
      schedulePendingHelperDeliveryRetry = () => {};
      globalThis.__writtenPhaseFindStarted = false;
      globalThis.__writtenPhaseSendCalls = 0;
      findReplyInput = async () => {
        globalThis.__writtenPhaseFindStarted = true;
        return globalThis.__writtenPhaseComposerGate;
      };
      runOriginalSendActuatorForOwnedComposer = async () => {
        globalThis.__writtenPhaseSendCalls += 1;
        return true;
      };
    `, local);
    const dispatchContext = local.createSkillDispatchContext(candidate);
    const entry = await local.rememberPendingHelperDelivery(
      `route-${phase}`,
      { ...call, kind: "skill-load" },
      { ok: true },
      `Local Skill load result: ${phase}`,
      { autoSend: true },
      {
        skillOriginProof: local.createStoredSkillOriginProof(dispatchContext),
        lifecycleGuard: () => local.isSkillDispatchContextCurrent(dispatchContext)
      }
    );
    entry.phase = phase;
    const attempt = local.attemptPendingHelperDelivery(entry, { autoSend: true });
    for (let round = 0; round < 8; round += 1) {
      await Promise.resolve();
      if (vm.runInContext("globalThis.__writtenPhaseFindStarted", local)) break;
    }
    assert.equal(vm.runInContext("globalThis.__writtenPhaseFindStarted", local), true,
      `The ${phase} regression must pause during composer discovery.`);
    local.location.href = `https://chatgpt.com/c/after-${phase}`;
    assert.equal(local.refreshPageLifecycle(), true);
    releaseComposer(new local.Element());
    assert.equal(await attempt, false);
    assert.deepEqual({
      sendCalls: vm.runInContext("globalThis.__writtenPhaseSendCalls", local),
      pending: vm.runInContext("pendingHelperDeliveries.size", local)
    }, {
      sendCalls: 0,
      pending: 0
    }, `A ${phase} Skill delivery must lose all send/finalize authority after a route transition.`);
  }
}

async function testWrittenSkillPhasesAbortDuringSameUrlReplacement() {
  for (const phase of ["inserted", "submitted-unconfirmed"]) {
    const local = createContentContext();
    const conversation = new local.Element();
    const assistant = new local.Element({ author: "assistant" });
    const helperText = [
      `ai-helper-skill-start:same-url-${phase}`,
      "cmd: load",
      "skill-id: example",
      `catalog-sha: ${"6".repeat(64)}`,
      "ai-helper-skill-end"
    ].join("\n");
    const call = local.parseCallPayload(helperText);
    assistant.textContent = helperText;
    conversation.append(assistant);
    conversation.textContent = helperText;
    const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
    local.__sameUrlPhaseConversation = conversation;
    local.__sameUrlPhaseCandidates = [candidate];
    let releaseComposer;
    local.__sameUrlPhaseComposerGate = new Promise((resolve) => {
      releaseComposer = resolve;
    });
    vm.runInContext(`
      observedPageIdentity = location.href;
      pageLifecycleGeneration = 100;
      initialThreadSettled = true;
      getConversationRoot = () => globalThis.__sameUrlPhaseConversation;
      extractShellCallCandidates = () => globalThis.__sameUrlPhaseCandidates;
      schedulePendingHelperDeliveryRetry = () => {};
      globalThis.__sameUrlPhaseFindStarted = false;
      globalThis.__sameUrlPhaseSendCalls = 0;
      findReplyInput = async () => {
        globalThis.__sameUrlPhaseFindStarted = true;
        return globalThis.__sameUrlPhaseComposerGate;
      };
      runOriginalSendActuatorForOwnedComposer = async () => {
        globalThis.__sameUrlPhaseSendCalls += 1;
        return true;
      };
    `, local);
    const dispatchContext = local.createSkillDispatchContext(candidate);
    const entry = await local.rememberPendingHelperDelivery(
      `same-url-${phase}`,
      { ...call, kind: "skill-load" },
      { ok: true },
      `Local Skill load result: same URL ${phase}`,
      { autoSend: true },
      {
        skillOriginProof: local.createStoredSkillOriginProof(dispatchContext),
        lifecycleGuard: () => local.isSkillDispatchContextCurrent(dispatchContext)
      }
    );
    entry.phase = phase;
    const attempt = local.attemptPendingHelperDelivery(entry, { autoSend: true });
    for (let round = 0; round < 8; round += 1) {
      await Promise.resolve();
      if (vm.runInContext("globalThis.__sameUrlPhaseFindStarted", local)) break;
    }
    assert.equal(vm.runInContext("globalThis.__sameUrlPhaseFindStarted", local), true);
    assistant.isConnected = false;
    local.__sameUrlPhaseConversation = new local.Element();
    local.__sameUrlPhaseCandidates = [];
    releaseComposer({
      innerText: entry.reply,
      textContent: entry.reply,
      isConnected: true
    });
    assert.equal(await attempt, false);
    assert.deepEqual({
      sendCalls: vm.runInContext("globalThis.__sameUrlPhaseSendCalls", local),
      pending: vm.runInContext("pendingHelperDeliveries.size", local)
    }, {
      sendCalls: 0,
      pending: 0
    }, `A same-URL transcript replacement must revoke ${phase} send/finalize authority after composer discovery.`);
  }
}

async function testStaleInsertedCancellationCannotClearNewRouteQueue() {
  const local = createContentContext();
  const conversation = new local.Element();
  const assistant = new local.Element({ author: "assistant" });
  const helperText = [
    "ai-helper-skill-start:stale-cancel",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"7".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n");
  const call = local.parseCallPayload(helperText);
  assistant.textContent = helperText;
  conversation.append(assistant);
  conversation.textContent = helperText;
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  local.__staleCancelConversation = conversation;
  local.__staleCancelCandidates = [candidate];
  let releaseProof;
  local.__staleCancelProofGate = new Promise((resolve) => {
    releaseProof = resolve;
  });
  const occupiedComposer = {
    innerText: "new user draft",
    textContent: "new user draft",
    isConnected: true
  };
  local.__staleCancelComposer = occupiedComposer;
  vm.runInContext(`
    observedPageIdentity = location.href;
    pageLifecycleGeneration = 97;
    initialThreadSettled = true;
    getConversationRoot = () => globalThis.__staleCancelConversation;
    extractShellCallCandidates = () => globalThis.__staleCancelCandidates;
    schedulePendingHelperDeliveryRetry = () => {};
    findReplyInput = async () => globalThis.__staleCancelComposer;
    globalThis.__staleCancelProofStarted = false;
    waitForPendingHelperSubmissionProof = async () => {
      globalThis.__staleCancelProofStarted = true;
      return globalThis.__staleCancelProofGate;
    };
  `, local);
  const dispatchContext = local.createSkillDispatchContext(candidate);
  const oldEntry = await local.rememberPendingHelperDelivery(
    "stale-cancel-old",
    { ...call, kind: "skill-load" },
    { ok: true },
    "Local Skill load result: old route",
    { autoSend: true },
    {
      skillOriginProof: local.createStoredSkillOriginProof(dispatchContext),
      lifecycleGuard: () => local.isSkillDispatchContextCurrent(dispatchContext)
    }
  );
  oldEntry.phase = "inserted";
  const oldAttempt = local.attemptPendingHelperDelivery(oldEntry, { autoSend: true });
  for (let round = 0; round < 8; round += 1) {
    await Promise.resolve();
    if (vm.runInContext("globalThis.__staleCancelProofStarted", local)) break;
  }
  assert.equal(vm.runInContext("globalThis.__staleCancelProofStarted", local), true,
    "The old inserted delivery must pause while checking submission proof.");

  local.location.href = "https://chatgpt.com/c/new-route-with-new-result";
  assert.equal(local.refreshPageLifecycle(), true);
  const newEntry = await local.rememberPendingHelperDelivery(
    "new-route-result",
    { kind: "shell", cmd: "printf new-route" },
    { ok: true, executionId: "0123456789abcdef" },
    "new route result",
    { autoSend: true }
  );
  releaseProof(false);
  assert.equal(await oldAttempt, false);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", local), 1,
    "A stale old-route cancellation must not clear a newly queued delivery in the current route.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.get('new-route-result')", local), newEntry);
}

async function testTrustedMutationCancellationCannotClearNewRouteQueue() {
  const local = createContentContext();
  const conversation = new local.Element();
  const assistant = new local.Element({ author: "assistant" });
  const helperText = [
    "ai-helper-skill-start:trusted-mutation-cancel",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"8".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n");
  const call = local.parseCallPayload(helperText);
  assistant.textContent = helperText;
  conversation.append(assistant);
  conversation.textContent = helperText;
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  local.__trustedCancelConversation = conversation;
  local.__trustedCancelCandidates = [candidate];
  let releaseProof;
  local.__trustedCancelProofGate = new Promise((resolve) => {
    releaseProof = resolve;
  });
  vm.runInContext(`
    observedPageIdentity = location.href;
    pageLifecycleGeneration = 98;
    initialThreadSettled = true;
    getConversationRoot = () => globalThis.__trustedCancelConversation;
    extractShellCallCandidates = () => globalThis.__trustedCancelCandidates;
    schedulePendingHelperDeliveryRetry = () => {};
    globalThis.__trustedCancelProofStarted = false;
    waitForPendingHelperSubmissionProof = async () => {
      globalThis.__trustedCancelProofStarted = true;
      return globalThis.__trustedCancelProofGate;
    };
  `, local);
  const dispatchContext = local.createSkillDispatchContext(candidate);
  const oldEntry = await local.rememberPendingHelperDelivery(
    "trusted-cancel-old",
    { ...call, kind: "skill-load" },
    { ok: true },
    "Local Skill load result: old trusted mutation",
    { autoSend: true },
    {
      skillOriginProof: local.createStoredSkillOriginProof(dispatchContext),
      lifecycleGuard: () => local.isSkillDispatchContextCurrent(dispatchContext)
    }
  );
  oldEntry.phase = "inserted";
  const staleCancellation = local.cancelPendingHelperDeliveryAfterComposerRemoval(oldEntry);
  for (let round = 0; round < 8; round += 1) {
    await Promise.resolve();
    if (vm.runInContext("globalThis.__trustedCancelProofStarted", local)) break;
  }
  assert.equal(vm.runInContext("globalThis.__trustedCancelProofStarted", local), true);

  local.location.href = "https://chatgpt.com/c/new-route-after-trusted-edit";
  assert.equal(local.refreshPageLifecycle(), true);
  const newEntry = await local.rememberPendingHelperDelivery(
    "new-route-after-trusted-edit",
    { kind: "shell", cmd: "printf current" },
    { ok: true, executionId: "fedcba9876543210" },
    "current route result",
    { autoSend: true }
  );
  releaseProof(false);
  assert.equal(await staleCancellation, false);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", local), 1,
    "The no-token trusted-mutation path must revalidate ownership after its proof await.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.get('new-route-after-trusted-edit')", local), newEntry);
}

async function testTrustedMutationCancellationCannotClearSameUrlReplacementQueue() {
  const local = createContentContext();
  const conversation = new local.Element();
  const assistant = new local.Element({ author: "assistant" });
  const helperText = [
    "ai-helper-skill-start:trusted-same-url-cancel",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"0".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n");
  const call = local.parseCallPayload(helperText);
  assistant.textContent = helperText;
  conversation.append(assistant);
  conversation.textContent = helperText;
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  local.__trustedSameUrlConversation = conversation;
  local.__trustedSameUrlCandidates = [candidate];
  let releaseProof;
  local.__trustedSameUrlProofGate = new Promise((resolve) => {
    releaseProof = resolve;
  });
  vm.runInContext(`
    observedPageIdentity = location.href;
    pageLifecycleGeneration = 101;
    initialThreadSettled = true;
    getConversationRoot = () => globalThis.__trustedSameUrlConversation;
    extractShellCallCandidates = () => globalThis.__trustedSameUrlCandidates;
    schedulePendingHelperDeliveryRetry = () => {};
    globalThis.__trustedSameUrlProofStarted = false;
    waitForPendingHelperSubmissionProof = async () => {
      globalThis.__trustedSameUrlProofStarted = true;
      return globalThis.__trustedSameUrlProofGate;
    };
  `, local);
  const dispatchContext = local.createSkillDispatchContext(candidate);
  const oldEntry = await local.rememberPendingHelperDelivery(
    "trusted-same-url-old",
    { ...call, kind: "skill-load" },
    { ok: true },
    "Local Skill load result: old same URL trusted mutation",
    { autoSend: true },
    {
      skillOriginProof: local.createStoredSkillOriginProof(dispatchContext),
      lifecycleGuard: () => local.isSkillDispatchContextCurrent(dispatchContext)
    }
  );
  oldEntry.phase = "inserted";
  const staleCancellation = local.cancelPendingHelperDeliveryAfterComposerRemoval(oldEntry);
  for (let round = 0; round < 8; round += 1) {
    await Promise.resolve();
    if (vm.runInContext("globalThis.__trustedSameUrlProofStarted", local)) break;
  }
  assert.equal(vm.runInContext("globalThis.__trustedSameUrlProofStarted", local), true);

  assistant.isConnected = false;
  local.__trustedSameUrlConversation = new local.Element();
  local.__trustedSameUrlCandidates = [];
  const newEntry = await local.rememberPendingHelperDelivery(
    "trusted-same-url-new",
    { kind: "shell", cmd: "printf replacement" },
    { ok: true, executionId: "0011223344556677" },
    "replacement route result",
    { autoSend: true }
  );
  releaseProof(false);
  assert.equal(await staleCancellation, false);
  assert.equal(vm.runInContext("pendingHelperDeliveries.size", local), 1,
    "A stale same-URL cancellation must delete only its old Skill entry, never the replacement queue.");
  assert.equal(vm.runInContext("pendingHelperDeliveries.get('trusted-same-url-new')", local), newEntry);
}

async function testTrustedCancellationRechecksAfterAsyncGuardResolution() {
  const local = createContentContext();
  const conversation = new local.Element();
  const assistant = new local.Element({ author: "assistant" });
  const helperText = [
    "ai-helper-skill-start:post-guard-cancel",
    "cmd: load",
    "skill-id: example",
    `catalog-sha: ${"1".repeat(64)}`,
    "ai-helper-skill-end"
  ].join("\n");
  const call = local.parseCallPayload(helperText);
  assistant.textContent = helperText;
  conversation.append(assistant);
  conversation.textContent = helperText;
  const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
  local.__postGuardConversation = conversation;
  local.__postGuardCandidates = [candidate];
  vm.runInContext(`
    observedPageIdentity = location.href;
    pageLifecycleGeneration = 102;
    initialThreadSettled = true;
    getConversationRoot = () => globalThis.__postGuardConversation;
    extractShellCallCandidates = () => globalThis.__postGuardCandidates;
    schedulePendingHelperDeliveryRetry = () => {};
    waitForPendingHelperSubmissionProof = async () => false;
  `, local);
  const dispatchContext = local.createSkillDispatchContext(candidate);
  const oldEntry = await local.rememberPendingHelperDelivery(
    "post-guard-old",
    { ...call, kind: "skill-load" },
    { ok: true },
    "Local Skill load result: post guard old",
    { autoSend: true },
    {
      skillOriginProof: local.createStoredSkillOriginProof(dispatchContext),
      lifecycleGuard: () => local.isSkillDispatchContextCurrent(dispatchContext)
    }
  );
  oldEntry.phase = "inserted";
  const currentEntry = await local.rememberPendingHelperDelivery(
    "post-guard-current",
    { kind: "shell", cmd: "printf still-current" },
    { ok: true, executionId: "8899aabbccddeeff" },
    "current result must survive",
    { autoSend: true }
  );

  const originalGuard = oldEntry.volatileLifecycleGuard;
  let guardCalls = 0;
  oldEntry.volatileLifecycleGuard = () => {
    guardCalls += 1;
    const current = originalGuard() === true;
    if (guardCalls === 2) {
      queueMicrotask(() => {
        assistant.isConnected = false;
        local.__postGuardConversation = new local.Element();
        local.__postGuardCandidates = [];
      });
    }
    return current;
  };

  assert.equal(
    await local.cancelPendingHelperDeliveryAfterComposerRemoval(oldEntry),
    false,
    "Same-URL replacement after the async guard resolves must revoke cancellation authority."
  );
  assert.ok(guardCalls >= 3, "Cancellation must perform a final synchronous origin preflight.");
  assert.equal(
    vm.runInContext("pendingHelperDeliveries.get('post-guard-old')", local),
    undefined,
    "The stale exact Skill entry should be discarded by the stale-origin cleanup path."
  );
  assert.equal(
    vm.runInContext("pendingHelperDeliveries.get('post-guard-current')", local),
    currentEntry,
    "The stale cancellation must not clear another current pending result."
  );
}

async function testRestoredQueuedSkillRequiresMatchingTranscript() {
  for (const changed of [false, true]) {
    const local = createContentContext();
    const conversation = new local.Element();
    const assistant = new local.Element({ author: "assistant" });
    const helperText = [
      `ai-helper-skill-start:restored-${changed ? "changed" : "same"}`,
      "cmd: load",
      "skill-id: example",
      `catalog-sha: ${"6".repeat(64)}`,
      "ai-helper-skill-end"
    ].join("\n");
    const call = local.parseCallPayload(helperText);
    assistant.textContent = helperText;
    conversation.append(assistant);
    conversation.textContent = helperText;
    const candidate = { call, node: assistant, textRoot: assistant, source: "text", blockIndex: 0 };
    local.__restoredConversation = conversation;
    local.__restoredCandidates = [candidate];
    vm.runInContext(`
      getConversationRoot = () => globalThis.__restoredConversation;
      extractShellCallCandidates = () => globalThis.__restoredCandidates;
      observedPageIdentity = location.href;
      pageLifecycleGeneration = 92;
      initialThreadSettled = true;
      schedulePendingHelperDeliveryRetry = () => {};
    `, local);
    const context = local.createSkillDispatchContext(candidate);
    const proof = local.createStoredSkillOriginProof(context);
    const entry = await local.rememberPendingHelperDelivery(
      `restored-${changed}`,
      { ...call, kind: "skill-load" },
      { ok: true },
      "Local Skill load result: restored transcript proof",
      { autoSend: true },
      { skillOriginProof: proof }
    );
    entry.restored = true;
    let writes = 0;
    local.deliverHelperReply = undefined;
    vm.runInContext(`
      deliverHelperReply = async () => {
        globalThis.__restoredWrites += 1;
        return false;
      };
      globalThis.__restoredWrites = 0;
    `, local);
    if (changed) {
      conversation.textContent = `${helperText}\nA different transcript message appeared.`;
    }
    await local.attemptPendingHelperDelivery(entry, { autoSend: true });
    writes = vm.runInContext("globalThis.__restoredWrites", local);
    assert.equal(writes, changed ? 0 : 1,
      changed
        ? "A restored queued Skill result must not write when the same-URL transcript fingerprint changed."
        : "A restored queued Skill result must remain deliverable when the exact transcript proof is unchanged.");
    if (changed) {
      assert.equal(vm.runInContext("pendingHelperDeliveries.size", local), 0,
        "A mismatched restored Skill result must be removed from the pending queue.");
    }
  }
}

async function testLegacyRestoredQueuedSkillWithoutOriginIsDiscarded() {
  const local = createContentContext();
  vm.runInContext(`
    initialThreadSettled = true;
    schedulePendingHelperDeliveryRetry = () => {};
    globalThis.__legacySkillWrites = 0;
    deliverHelperReply = async () => {
      globalThis.__legacySkillWrites += 1;
      return false;
    };
  `, local);
  const entry = await local.rememberPendingHelperDelivery(
    "legacy-skill-without-origin",
    { kind: "skill-load", cmd: "load", skillId: "example" },
    { ok: true },
    "Local Skill load result: legacy unguarded entry",
    { autoSend: true }
  );
  entry.restored = true;
  await local.attemptPendingHelperDelivery(entry, { autoSend: true });
  assert.deepEqual(
    {
      writes: vm.runInContext("globalThis.__legacySkillWrites", local),
      pending: vm.runInContext("pendingHelperDeliveries.size", local)
    },
    { writes: 0, pending: 0 },
    "A restored pre-fix Skill reply with neither transcript proof nor trusted route handoff must fail closed."
  );
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
