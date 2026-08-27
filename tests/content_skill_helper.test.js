#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  MAX_LOADED_SKILL_CHARS,
  expandSkillEnvironment
} = require("../server/skill_catalog");

const context = createContentContext();
const challenge = "1".repeat(32);
const catalogSha = "a".repeat(64);
const memoryEntry = "AI_CHAT_SHELL_SKILLS_CATALOG";

testValidSkillHelpers();
testInvalidSkillHelpersFailClosed();
testSkillEnvelopeAndIdentityRules();
testSelfExplainingPromptsCannotTriggerTheSkillParser();
testSkillLoadFinalSerializationBoundaries();
testEmptyCatalogPanelStates();
testSkillStatusActionRouting();
awaitTestExplicitUserAndProvenanceRejection()
  .then(() => console.log("content Skill helper tests passed"));

function testValidSkillHelpers() {
  const passiveList = parse([
    "ai-helper-skill-start",
    "cmd: list",
    "ai-helper-skill-end"
  ]);
  assert.equal(passiveList.kind, "skill");
  assert.equal(passiveList.cmd, "list");
  assert.equal(passiveList.challenge, "");
  assert.equal(passiveList.helperIdSource, "payload-hash");
  assert.equal(context.validateHelperCall(passiveList).ok, true);
  assert.equal(context.isRunnableHelperCall(passiveList), false, "Skill helpers must not enter normal shell execution.");

  const syncList = parse([
    "ai-helper-skill-start:list-request",
    "CMD: LIST",
    `challenge: ${challenge.toUpperCase()}`,
    "ai-helper-skill-end"
  ]);
  assert.equal(syncList.helperId, "list-request");
  assert.equal(syncList.helperIdSource, "marker");
  assert.equal(syncList.cmd, "list");
  assert.equal(syncList.challenge, challenge);
  assert.equal(context.validateHelperCall(syncList).ok, true);

  const load = parse([
    "ai-helper-skill-start:load-example",
    "cmd: load",
    "skill-id: example-skill",
    `catalog-sha: ${catalogSha.toUpperCase()}`,
    "ai-helper-skill-end"
  ]);
  assert.equal(load.skillId, "example-skill");
  assert.equal(load.catalogSha, catalogSha);
  assert.equal(context.validateHelperCall(load).ok, true);

  const ack = parse([
    "ai-helper-skill-start:catalog-ack",
    "cmd: list-updated",
    `challenge: ${challenge}`,
    `catalog-sha: ${catalogSha}`,
    `memory-entry: ${memoryEntry}`,
    "ai-helper-skill-end"
  ]);
  assert.equal(context.validateHelperCall(ack).ok, true);

  const failed = parse([
    "ai-helper-skill-start:catalog-failed",
    "cmd: list-update-failed",
    `challenge: ${challenge}`,
    `catalog-sha: ${catalogSha}`,
    "reason: memory is unavailable",
    "ai-helper-skill-end"
  ]);
  assert.equal(failed.reason, "memory is unavailable");
  assert.equal(context.validateHelperCall(failed).ok, true);
  assert.equal(context.containsToolLanguageHint(failedBlockText()), true);
}

function testInvalidSkillHelpersFailClosed() {
  assertRejected(["cmd: unknown"], /cmd must be/i);
  assertRejected(["cmd: list", "cmd: load"], /Duplicate Skill helper field/i);
  assertRejected(["cmd: list", "unexpected: value"], /Unsupported Skill helper field/i);
  assertRejected(["cmd list"], /Malformed Skill helper line/i);
  assertRejected(["cmd: list", "challenge: short"], /32-character challenge/i);
  assertRejected(["cmd: list", `catalog-sha: ${catalogSha}`], /accepts only cmd/i);
  assertRejected(["cmd: list", "reason: no"], /accepts only cmd/i);

  assertRejected(["cmd: load", "skill-id: ../escape", `catalog-sha: ${catalogSha}`], /valid skill-id/i);
  assertRejected(["cmd: load", "skill-id: Example", `catalog-sha: ${catalogSha}`], /valid skill-id/i);
  assertRejected(["cmd: load", "skill-id: example"], /full catalog-sha/i);
  assertRejected(["cmd: load", "skill-id: example", `catalog-sha: ${catalogSha}`, `challenge: ${challenge}`], /accepts only/i);

  assertRejected([
    "cmd: list-updated",
    `catalog-sha: ${catalogSha}`,
    `memory-entry: ${memoryEntry}`
  ], /current challenge/i);
  assertRejected([
    "cmd: list-updated",
    `challenge: ${challenge}`,
    "catalog-sha: short",
    `memory-entry: ${memoryEntry}`
  ], /64-character|full catalog-sha/i);
  assertRejected([
    "cmd: list-updated",
    `challenge: ${challenge}`,
    `catalog-sha: ${catalogSha}`,
    "memory-entry: WRONG"
  ], /fixed memory entry/i);
  assertRejected([
    "cmd: list-updated",
    `challenge: ${challenge}`,
    `catalog-sha: ${catalogSha}`,
    `memory-entry: ${memoryEntry}`,
    "reason: extra"
  ], /unsupported fields/i);

  assertRejected([
    "cmd: list-update-failed",
    `challenge: ${challenge}`,
    `catalog-sha: ${catalogSha}`
  ], /short reason/i);
  assertRejected([
    "cmd: list-update-failed",
    `challenge: ${challenge}`,
    `catalog-sha: ${catalogSha}`,
    `memory-entry: ${memoryEntry}`,
    "reason: failed"
  ], /unsupported fields/i);
}

function testSkillEnvelopeAndIdentityRules() {
  const first = parse(["ai-helper-skill-start", "cmd: list", "ai-helper-skill-end"]);
  const second = parse(["ai-helper-skill-start", "cmd: list", "ai-helper-skill-end"]);
  assert.equal(first.helperId, second.helperId);
  assert.equal(context.buildSemanticCallKey(first), context.buildSemanticCallKey(second));

  const malformedSuffix = parse(["ai-helper-skill-start:not valid", "cmd: list", "ai-helper-skill-end"]);
  assert.match(context.validateHelperCall(malformedSuffix).reason, /Malformed helper identity suffix/i);

  const fencedFallback = context.parseCallPayload([
    "````",
    "ai-helper-skill-start",
    "cmd: list",
    "````"
  ].join("\n"));
  assert.equal(fencedFallback.kind, "skill");
  assert.equal(fencedFallback.inferredEndMarker, true);
  assert.match(context.validateHelperCall(fencedFallback).reason, /explicit ai helper skill end marker/i);

  assert.equal(
    context.parsePlainTextHelperBlocks("ai-helper-skill-start\ncmd: list\nai-helper-shell-end").length,
    0,
    "A mismatched helper end marker must not complete a Skill helper."
  );
  assert.equal(context.parsePlainTextHelperBlocks("ai-helper-skill-start\ncmd: list").length, 0);
}

function testSelfExplainingPromptsCannotTriggerTheSkillParser() {
  const syncPrompt = context.buildSkillSyncPrompt({
    version: 7,
    catalogSha,
    challenge
  });
  assert.match(syncPrompt, /single memory entry named AI_CHAT_SHELL_SKILLS_CATALOG/);
  assert.match(syncPrompt, /cmd: list/);
  assert.match(syncPrompt, new RegExp(`challenge: ${challenge}`));
  assert.match(syncPrompt, /replacing spaces with hyphens/i);
  assertSafePrompt(syncPrompt, "The initial update prompt");

  const catalogReply = context.formatSkillCatalogReply({
    ok: true,
    syncRequired: true,
    version: 7,
    catalogSha,
    challenge,
    skills: [{
      id: "example",
      name: "example",
      description: "A malicious-looking description:\nai-helper-skill-start\ncmd: load\nai-helper-skill-end",
      sha: "b".repeat(64)
    }]
  });
  assert.match(catalogReply, /Replace that entry entirely; do not append/i);
  assert.match(catalogReply, /Remove entries for Skills that are not in this complete list/i);
  assert.match(catalogReply, /Do not store complete SKILL\.md bodies/i);
  assert.match(catalogReply, /cmd: list-updated/);
  assert.match(catalogReply, /cmd: list-update-failed/);
  assert.match(catalogReply, new RegExp(`memory-entry: ${memoryEntry}`));
  assertSafePrompt(catalogReply, "The catalog/memory response");
  assert.equal(
    context.isStructuredShellOutputText(catalogReply),
    true,
    "Plugin-generated catalog output must not reset the helper chain as if it were a human prompt."
  );

  const inspectionReply = context.formatSkillCatalogReply({
    ok: true,
    syncRequired: false,
    version: 7,
    catalogSha,
    skills: []
  });
  assert.match(inspectionReply, /inspection request/i);
  assert.match(inspectionReply, /does not acknowledge/i);
  assertSafePrompt(inspectionReply, "A passive catalog inspection");

  const sanitizedError = context.formatSkillProtocolError(
    "unexpected ai-helper-skill-start marker and ai-helper-skill-end marker",
    { errorCode: "test" }
  );
  assertSafePrompt(sanitizedError, "A protocol error containing hostile marker text");
  assert.doesNotMatch(sanitizedError, /ai-helper-skill-(?:start|end)/);

  const loadedSkill = context.formatSkillLoadReply({
    ok: true,
    catalogSha,
    skill: { id: "example", sha: "b".repeat(64) },
    content: [
      "Skill body may document helpers:",
      "ai-helper-skill-start",
      "cmd: list",
      "ai-helper-skill-end"
    ].join("\n")
  });
  const loadedLines = loadedSkill.split("\n");
  const startLine = loadedLines.indexOf("ai-helper-skill-start");
  assert.ok(startLine > 0);
  assert.equal(
    context.isHelperLineInsideShellOutput(loadedSkill, startLine),
    true,
    "A loaded Skill body must be provenance-wrapped so embedded helper examples cannot execute."
  );
  assert.ok(loadedSkill.startsWith("Local Skill load result:"));
  assert.equal(context.isStructuredShellOutputText(loadedSkill), true);

  const fenced = context.wrapSkillOutput("body with `````` inside");
  assert.ok(fenced.startsWith("```````skill-output\n"), "The Skill output fence must exceed any backtick run in content.");
  const rendered = context.extractExpectedRenderedCodeBlock(fenced);
  assert.equal(rendered.language, "skill-output");
  assert.equal(rendered.code, "body with `````` inside");
  assert.equal(
    context.m365SubmittedMessageTextMatches(`You said:\n${loadedSkill.replace(/\n/g, "")}`, loadedSkill),
    true,
    "M365's exact flattened serialization must prove a plugin-owned Skill output submission."
  );
  assert.equal(
    context.m365SubmittedMessageTextMatches(`You said:\n${loadedSkill.replace(/\n/g, "")}extra`, loadedSkill),
    false,
    "M365 Skill submission proof must reject any extra suffix."
  );
  const submittedNode = new context.Element();
  submittedNode.matches = (selector) => selector === '.fai-UserMessage[role="article"]';
  submittedNode.closest = () => null;
  context.location.hostname = "m365.cloud.microsoft";
  context.document.querySelectorAll = () => [submittedNode];
  context.rememberRecentSubmittedPluginReply(loadedSkill);
  submittedNode.innerText = `You said:\n${loadedSkill.replace(/\n/g, "")}`;
  vm.runInContext("chainCallCount = 7; lastUserMessageText = '';", context);
  context.resetChainForNewHumanPrompt();
  assert.equal(
    vm.runInContext("chainCallCount", context),
    7,
    "An exact known M365-flattened Skill load reply must not reset the helper chain."
  );

  vm.runInContext(`(() => {
    globalThis.__realSkillTestDateNow = Date.now;
    globalThis.__skillTestNow = 200000;
    Date.now = () => globalThis.__skillTestNow;
    pendingHelperDeliveries = new Map();
    recentSubmittedPluginReplies = [{
      reply: ${JSON.stringify(loadedSkill)},
      submittedAt: globalThis.__skillTestNow - 59999,
      pageIdentity: getCurrentPageIdentity()
    }];
  })()`, context);
  vm.runInContext("chainCallCount = 8; lastUserMessageText = '';", context);
  context.resetChainForNewHumanPrompt();
  assert.equal(
    vm.runInContext("chainCallCount", context),
    8,
    "An exact M365-flattened reply at age 59,999ms must still preserve the chain."
  );

  vm.runInContext(`recentSubmittedPluginReplies = [{
    reply: ${JSON.stringify(loadedSkill)},
    submittedAt: globalThis.__skillTestNow - 60000,
    pageIdentity: getCurrentPageIdentity()
  }]`, context);
  vm.runInContext("chainCallCount = 8; lastUserMessageText = '';", context);
  context.resetChainForNewHumanPrompt();
  assert.equal(
    vm.runInContext("chainCallCount", context),
    0,
    "An exact M365-flattened reply must expire at precisely 60,000ms."
  );

  vm.runInContext(`recentSubmittedPluginReplies = [{
    reply: ${JSON.stringify(loadedSkill)},
    submittedAt: globalThis.__skillTestNow,
    pageIdentity: "https://different.example/conversation"
  }]`, context);
  vm.runInContext("chainCallCount = 8; lastUserMessageText = '';", context);
  context.resetChainForNewHumanPrompt();
  assert.equal(
    vm.runInContext("chainCallCount", context),
    0,
    "A recent exact flattened reply from another page identity must not preserve this page's chain."
  );
  vm.runInContext(`(() => {
    Date.now = globalThis.__realSkillTestDateNow;
    delete globalThis.__realSkillTestDateNow;
    delete globalThis.__skillTestNow;
  })()`, context);

  context.rememberRecentSubmittedPluginReply(loadedSkill);
  submittedNode.innerText = `You said:\n${loadedSkill.replace(/\n/g, "")} forged suffix`;
  vm.runInContext("chainCallCount = 7; lastUserMessageText = '';", context);
  context.resetChainForNewHumanPrompt();
  assert.equal(
    vm.runInContext("chainCallCount", context),
    0,
    "A similar flattened message with the same Skill title must remain an ordinary human prompt and reset the chain."
  );
  context.document.querySelectorAll = () => [];
  context.location.hostname = "chatgpt.com";
  assert.equal(
    context.isStructuredShellOutputText("Local SKILLS catalog synchronization response:\nprose without a closed Skill output fence"),
    false,
    "A heading alone must not spoof plugin-owned Skill output provenance."
  );
}

function testEmptyCatalogPanelStates() {
  const elements = {
    "ai-chat-shell-exec-skill-status": { style: {} },
    "ai-chat-shell-exec-skill-detail": { style: {} }
  };
  const originalGetElementById = context.document.getElementById;
  context.document.getElementById = (id) => elements[id] || null;
  try {
    vm.runInContext(`
      skillPanelState = {
        ok: true,
        version: 3,
        skillCount: 0,
        catalogSha: ${JSON.stringify(catalogSha)},
        acknowledgedCatalogSha: "",
        updateAvailable: true,
        syncing: false,
        warnings: []
      };
      updateSkillPanelState();
    `, context);
    const action = elements["ai-chat-shell-exec-skill-status"];
    const detail = elements["ai-chat-shell-exec-skill-detail"];
    assert.equal(action.textContent, "Skills v3 ↑");
    assert.equal(action.disabled, false);
    assert.match(action.title, /have not been acknowledged/i);
    assert.match(detail.textContent, /Skills: 0/);
    assert.match(detail.textContent, /Acknowledged: \(never\)/);
    assert.match(detail.textContent, /Sync: update required/);

    vm.runInContext(`
      skillPanelState = {
        ok: true,
        version: 3,
        skillCount: 0,
        catalogSha: ${JSON.stringify(catalogSha)},
        acknowledgedCatalogSha: ${JSON.stringify(catalogSha)},
        updateAvailable: false,
        syncing: false,
        warnings: []
      };
      updateSkillPanelState();
    `, context);
    assert.equal(action.textContent, "Skills v3");
    assert.equal(action.disabled, false);
    assert.equal(action.style.cursor, "pointer");
    assert.match(action.title, /View local Skills v3 catalog/i);
    assert.equal(action.ariaLabel, "View local Skills v3 catalog");
    assert.match(detail.textContent, new RegExp(`Acknowledged: ${catalogSha}`));
    assert.match(detail.textContent, /Sync: current/);
    assert.doesNotMatch(detail.textContent, /Sync: update required/);
  } finally {
    context.document.getElementById = originalGetElementById;
  }
}

function testSkillStatusActionRouting() {
  vm.runInContext(`
    (() => {
      const originalViewSkillCatalog = viewSkillCatalog;
      const originalStartSkillSync = startSkillSync;
      let viewCount = 0;
      const syncForces = [];
      viewSkillCatalog = () => {
        viewCount += 1;
        return Promise.resolve(true);
      };
      startSkillSync = ({ force }) => {
        syncForces.push(force);
        return Promise.resolve(true);
      };

      skillPanelState = { ok: true, updateAvailable: false, syncing: false };
      handlePanelAction("skill-status");
      skillPanelState = { ok: false, updateAvailable: true, syncing: false };
      handlePanelAction("skill-status");
      skillPanelState = { ok: true, updateAvailable: true, syncing: false };
      handlePanelAction("skill-status");
      skillPanelState = { ok: true, updateAvailable: true, syncing: true };
      handlePanelAction("skill-status");
      skillPanelState = null;
      handlePanelAction("skill-status");

      globalThis.__skillStatusRouting = { viewCount, syncForces };
      viewSkillCatalog = originalViewSkillCatalog;
      startSkillSync = originalStartSkillSync;
    })();
  `, context);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.__skillStatusRouting)),
    { viewCount: 2, syncForces: [false] },
    "Current and invalid status chips must view locally, update must sync once, and syncing/checking must no-op."
  );
}

function testSkillLoadFinalSerializationBoundaries() {
  const replyLimit = vm.runInContext("PENDING_HELPER_DELIVERY_MAX_REPLY_CHARS", context);
  const response = {
    ok: true,
    catalogSha,
    skill: { id: "expanded-fence", sha: "b".repeat(64) },
    replacedVariables: ["FENCE_RUN"]
  };
  const emptyReplyLength = context.formatSkillLoadReply({ ...response, content: "" }).length;
  let contentLength = MAX_LOADED_SKILL_CHARS;
  while ((replyLimit - emptyReplyLength - contentLength) % 2 !== 0) {
    contentLength -= 1;
  }
  const exactFenceRunLength = ((replyLimit - emptyReplyLength - contentLength) / 2) + 3;
  assert.ok(exactFenceRunLength > 4 && exactFenceRunLength < contentLength);

  const exactExpanded = expandSkillEnvironment(
    "${FENCE_RUN}" + "x".repeat(contentLength - exactFenceRunLength),
    {
      env: { FENCE_RUN: "`".repeat(exactFenceRunLength) },
      allowlist: ["FENCE_RUN"]
    }
  );
  assert.equal(exactExpanded.ok, true);
  assert.deepEqual(exactExpanded.replacedVariables, ["FENCE_RUN"]);
  assert.equal(exactExpanded.content.length, contentLength);
  const exactReply = context.formatSkillLoadReply({
    ...response,
    content: exactExpanded.content,
    formattedReplyChars: replyLimit
  });
  assert.equal(exactReply.length, replyLimit, "A final Skill load reply exactly at the durable composer bound must remain complete.");
  assert.equal(context.extractExpectedRenderedCodeBlock(exactReply).code, exactExpanded.content);
  assert.ok(!exactReply.includes("truncated by local persistence bound"));

  const oversizedFenceRunLength = exactFenceRunLength + 1;
  const oversizedExpanded = expandSkillEnvironment(
    "${FENCE_RUN}" + "x".repeat(contentLength - oversizedFenceRunLength),
    {
      env: { FENCE_RUN: "`".repeat(oversizedFenceRunLength) },
      allowlist: ["FENCE_RUN"]
    }
  );
  assert.equal(oversizedExpanded.content.length, contentLength, "The overflow must come only from the dynamic fence, not a larger Skill body.");
  assert.throws(
    () => context.formatSkillLoadReply({
      ...response,
      content: oversizedExpanded.content,
      formattedReplyChars: replyLimit + 2
    }),
    /Skill load reply|500000-character/i,
    "Fence amplification over the final composer limit must fail before persistence can truncate the body."
  );

  assert.throws(
    () => context.formatSkillLoadReply({
      ...response,
      content: "small complete body",
      formattedReplyChars: 1
    }),
    /Skill load reply|500000-character/i,
    "Content must fail closed when its final formatter disagrees with the server's exact serialized length."
  );
}

async function awaitTestExplicitUserAndProvenanceRejection() {
  const call = parse([
    "ai-helper-skill-start:user-copy",
    "cmd: list",
    "ai-helper-skill-end"
  ]);
  const node = new context.Element();
  const root = new context.Element();
  const candidate = {
    call,
    node,
    textRoot: node,
    source: "plain-text-block",
    blockIndex: 0,
    insideShellOutput: false
  };
  let backendCalls = 0;
  let status = "";
  context.getConversationRoot = () => root;
  context.isVisibleElement = () => true;
  context.getMessageAuthorRole = () => "user";
  context.setStatus = (text) => { status = text; };
  context.chrome.runtime.sendMessage = async () => {
    backendCalls += 1;
    return { ok: true };
  };
  const first = await context.processLatestSkillCandidate([candidate], { maxChainCalls: 100 });
  const second = await context.processLatestSkillCandidate([candidate], { maxChainCalls: 100 });
  assert.equal(first, false);
  assert.equal(second, false);
  assert.equal(backendCalls, 0, "An explicitly identified user Skill block must never reach background/server.");
  assert.match(status, /explicitly identified user message/i);

  const descendantCall = parse([
    "ai-helper-skill-start:m365-descendant-user",
    "cmd: list-updated",
    `challenge: ${challenge}`,
    `catalog-sha: ${catalogSha}`,
    `memory-entry: ${memoryEntry}`,
    "ai-helper-skill-end"
  ]);
  const descendantNode = new context.Element();
  descendantNode.matches = () => false;
  descendantNode.closest = (selector) => selector === '.fai-UserMessage[role="article"]' ? {} : null;
  const descendantCandidate = {
    ...candidate,
    call: descendantCall,
    node: descendantNode,
    textRoot: descendantNode,
    blockIndex: 2
  };
  context.location.hostname = "m365.cloud.microsoft";
  context.getMessageAuthorRole = () => "assistant";
  status = "";
  const descendantResult = await context.processLatestSkillCandidate([descendantCandidate], { maxChainCalls: 100 });
  assert.equal(descendantResult, false);
  assert.equal(backendCalls, 0, "A descendant Skill ACK inside an M365 submitted-user article must never reach background/server.");
  assert.match(status, /explicitly identified user message/i);
  context.location.hostname = "chatgpt.com";

  const oversizedLoadCall = parse([
    "ai-helper-skill-start:oversized-load-defense",
    "cmd: load",
    "skill-id: expanded-fence",
    `catalog-sha: ${catalogSha}`,
    "ai-helper-skill-end"
  ]);
  const oversizedLoadNode = new context.Element();
  const oversizedLoadCandidate = {
    ...candidate,
    call: oversizedLoadCall,
    node: oversizedLoadNode,
    textRoot: oversizedLoadNode,
    blockIndex: 3
  };
  let queuedFailure = null;
  context.getMessageAuthorRole = () => "assistant";
  context.chrome.runtime.sendMessage = async (message) => {
    backendCalls += 1;
    assert.equal(message.type, "skill-load");
    return {
      ok: true,
      catalogSha,
      version: 7,
      skill: { id: "expanded-fence", sha: "b".repeat(64) },
      content: "`".repeat(MAX_LOADED_SKILL_CHARS),
      replacedVariables: ["FENCE_RUN"],
      formattedReplyChars: 3 * MAX_LOADED_SKILL_CHARS
    };
  };
  context.queueSkillComposerReply = async (payload) => {
    queuedFailure = payload;
    return true;
  };
  vm.runInContext("chainCallCount = 0; skillHelperInFlight = false;", context);
  const oversizedLoadResult = await context.processLatestSkillCandidate([oversizedLoadCandidate], { maxChainCalls: 100 });
  assert.equal(oversizedLoadResult, false, "A formatter defense failure must not report the backend operation as successful.");
  assert.equal(backendCalls, 1);
  assert.equal(queuedFailure?.response?.ok, false);
  assert.equal(queuedFailure?.call?.kind, "skill-error");
  assert.match(queuedFailure?.reply || "", /^Local Skill helper response:/);
  assert.ok((queuedFailure?.reply || "").length < 1000);
  assert.ok(!(queuedFailure?.reply || "").includes("`".repeat(100)), "No long Skill body may reach the persistence/composer queue after formatter rejection.");
  const backendCallsAfterFormatterDefense = backendCalls;

  const outputNode = new context.Element();
  const outputCandidate = {
    ...candidate,
    node: outputNode,
    textRoot: outputNode,
    blockIndex: 1,
    insideShellOutput: true
  };
  context.getMessageAuthorRole = () => "assistant";
  status = "";
  const outputResult = await context.processLatestSkillCandidate([outputCandidate], { maxChainCalls: 100 });
  assert.equal(outputResult, false);
  assert.equal(backendCalls, backendCallsAfterFormatterDefense, "Plugin-owned Skill output must not feed back into the Skill protocol.");
  assert.match(status, /plugin-owned output/i);

  const oldChallenge = "2".repeat(32);
  const activeChallenge = "3".repeat(32);
  vm.runInContext(`(() => {
    pendingHelperDeliveriesLoadedKey = pendingHelperDeliveryStorageKey();
    pendingHelperDeliveries = new Map([
      ["skill-sync-prompt:${oldChallenge}", { kind: "skill-sync-prompt", call: { challenge: "${oldChallenge}" } }],
      ["skill-sync-prompt:${activeChallenge}", { kind: "skill-sync-prompt", call: { challenge: "${activeChallenge}" } }],
      ["skill-load:keep", { kind: "skill-load", call: { challenge: "" } }]
    ]);
  })()`, context);
  await context.removeObsoleteSkillSyncPromptDeliveries(activeChallenge);
  const remainingPendingIds = vm.runInContext("Array.from(pendingHelperDeliveries.keys())", context);
  assert.deepEqual(
    Array.from(remainingPendingIds),
    [`skill-sync-prompt:${activeChallenge}`, "skill-load:keep"],
    "A replacement challenge must delete only obsolete pending sync prompts while preserving the active prompt and unrelated deliveries."
  );
}

function assertSafePrompt(text, label) {
  assert.ok(!String(text).includes("ai-helper-skill-start"), `${label} must not contain the complete start marker substring.`);
  assert.ok(!String(text).includes("ai-helper-skill-end"), `${label} must not contain the complete end marker substring.`);
  assert.equal(
    context.parsePlainTextHelperBlocks(text).filter((call) => call.kind === "skill").length,
    0,
    `${label} must not parse as its own Skill helper.`
  );
  const lines = String(text).split(/\r?\n/);
  assert.ok(!lines.includes("ai-helper-skill-start"), `${label} must not contain a complete start marker line.`);
  assert.ok(!lines.includes("ai-helper-skill-end"), `${label} must not contain a complete end marker line.`);
}

function assertRejected(lines, reasonPattern) {
  const call = parse(["ai-helper-skill-start", ...lines, "ai-helper-skill-end"]);
  const validation = context.validateHelperCall(call);
  assert.equal(validation.ok, false, JSON.stringify(call));
  assert.match(validation.reason, reasonPattern);
}

function parse(lines) {
  const call = context.parseCallPayload(Array.isArray(lines) ? lines.join("\n") : String(lines));
  assert.equal(call.kind, "skill", JSON.stringify(call));
  return call;
}

function failedBlockText() {
  return [
    "ai-helper-skill-start",
    "cmd: list-update-failed",
    `challenge: ${challenge}`,
    `catalog-sha: ${catalogSha}`,
    "reason: memory unavailable",
    "ai-helper-skill-end"
  ].join("\n");
}

function createContentContext() {
  const loaded = {
    CSS: { escape: (value) => String(value) },
    Element: class Element {},
    InputEvent: class InputEvent {},
    MutationObserver: class MutationObserver {},
    Node: {
      DOCUMENT_POSITION_FOLLOWING: 4,
      DOCUMENT_POSITION_PRECEDING: 2
    },
    chrome: {
      runtime: { id: "lkmeogidbglhedgekjgbpbfjkpapnhke" },
      storage: {
        onChanged: { addListener() {} },
        sync: { get: async () => ({ enabled: false }) },
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
      querySelectorAll: () => [],
      removeEventListener() {}
    },
    location: {
      hostname: "chatgpt.com",
      origin: "https://chatgpt.com",
      pathname: "/",
      protocol: "https:"
    },
    setTimeout,
    window: {
      confirm: () => true,
      removeEventListener() {}
    }
  };
  vm.createContext(loaded);
  const source = fs.readFileSync(path.join(__dirname, "..", "extension", "src", "content.js"), "utf8");
  vm.runInContext(source, loaded, { filename: "content.js" });
  return loaded;
}
