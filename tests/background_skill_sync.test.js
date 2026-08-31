#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const localStore = {};
const sessionStore = {};
const syncStore = {};
const websocketPayloads = [];
const tabRemovedListeners = [];
const createdWindows = [];
let challengeSequence = 1;
let catalog = makeCatalog("a", 1);
let installResponseGate = null;
let skillInstallResponseOverride = null;
let windowCreateGate = null;

async function main() {
  let context = createBackgroundContext();
  const chatgptTab1 = sender(11, "https://chatgpt.com/c/one");
  const chatgptTab2 = sender(12, "https://chatgpt.com/c/two");
  const m365Tab = sender(21, "https://m365.cloud.microsoft/chat");

  await testEmptyCatalogSynchronization(context);
  catalog = makeCatalog("a", 1);

  const initial = await context.handleSkillMessage({ type: "skill-state-get" }, chatgptTab1);
  assert.equal(initial.ok, true);
  assert.equal(initial.memoryScope, "https://chatgpt.com");
  assert.equal(initial.memoryEntry, "AI_CHAT_SHELL_SKILLS_CATALOG");
  assert.equal(initial.updateAvailable, true);
  assert.equal(initial.syncing, false);

  let begun = await context.handleSkillMessage({ type: "skill-sync-begin" }, chatgptTab1);
  assert.equal(begun.ok, true, JSON.stringify(begun));
  assert.match(begun.challenge, /^[a-f0-9]{32}$/);
  assert.equal(begun.syncOwnerTabId, 11);
  const sameOwner = await context.handleSkillMessage({ type: "skill-sync-begin" }, chatgptTab1);
  assert.equal(sameOwner.errorCode, "skill-sync-already-active");
  const otherOwnerForced = await context.handleSkillMessage({ type: "skill-sync-begin", force: true }, chatgptTab2);
  assert.equal(otherOwnerForced.errorCode, "skill-sync-owned-by-another-tab", "Force must not steal another tab's active sync.");
  const replacedChallenge = await context.handleSkillMessage({ type: "skill-sync-begin", force: true }, chatgptTab1);
  assert.equal(replacedChallenge.ok, true, JSON.stringify(replacedChallenge));
  assert.equal(replacedChallenge.forced, true);
  assert.notEqual(replacedChallenge.challenge, begun.challenge, "The same owner may force-replace its active challenge.");
  const obsoleteChallengeList = await context.handleSkillMessage({
    type: "skill-sync-list",
    challenge: begun.challenge
  }, chatgptTab1);
  assert.equal(obsoleteChallengeList.errorCode, "skill-sync-challenge-mismatch", "The replaced challenge must become unusable immediately.");
  begun = replacedChallenge;
  const otherOwner = await context.handleSkillMessage({ type: "skill-sync-begin" }, chatgptTab2);
  assert.equal(otherOwner.errorCode, "skill-sync-owned-by-another-tab");
  const ownerState = await context.handleSkillMessage({ type: "skill-state-get" }, chatgptTab1);
  const nonOwnerState = await context.handleSkillMessage({ type: "skill-state-get" }, chatgptTab2);
  assert.equal(ownerState.syncOwnedByCurrentTab, true, "The owner tab must be distinguishable after a state refresh.");
  assert.equal(nonOwnerState.syncOwnedByCurrentTab, false, "A non-owner tab must display that another tab owns the sync.");

  const otherScope = await context.handleSkillMessage({ type: "skill-sync-begin" }, m365Tab);
  assert.equal(otherScope.ok, true, "Different AI origins must have independent memory sync ownership.");
  assert.notEqual(otherScope.challenge, begun.challenge);

  const passiveList = await context.handleSkillMessage({ type: "skill-sync-list" }, chatgptTab2);
  assert.equal(passiveList.ok, true);
  assert.equal(passiveList.syncRequired, false, "A challenge-free catalog query must not acknowledge or alter sync state.");
  assert.equal(passiveList.challenge, "");

  const wrongListChallenge = await context.handleSkillMessage({
    type: "skill-sync-list",
    challenge: "f".repeat(32)
  }, chatgptTab1);
  assert.equal(wrongListChallenge.errorCode, "skill-sync-challenge-mismatch");
  const list = await context.handleSkillMessage({
    type: "skill-sync-list",
    challenge: begun.challenge
  }, chatgptTab1);
  assert.equal(list.ok, true);
  assert.equal(list.syncRequired, true);
  assert.equal(list.catalogSha, catalog.catalogSha);
  assert.equal(list.memoryEntry, "AI_CHAT_SHELL_SKILLS_CATALOG");

  const wrongOwnerAck = await context.handleSkillMessage(ackMessage(list, begun.challenge), chatgptTab2);
  assert.equal(wrongOwnerAck.errorCode, "skill-sync-owner-mismatch");
  const wrongChallengeAck = await context.handleSkillMessage(ackMessage(list, "e".repeat(32)), chatgptTab1);
  assert.equal(wrongChallengeAck.errorCode, "skill-sync-challenge-mismatch");
  const wrongShaAck = await context.handleSkillMessage({
    ...ackMessage(list, begun.challenge),
    catalogSha: "0".repeat(64)
  }, chatgptTab1);
  assert.equal(wrongShaAck.errorCode, "catalog-sha-mismatch");
  const wrongMemoryAck = await context.handleSkillMessage({
    ...ackMessage(list, begun.challenge),
    memoryEntry: "SOME_OTHER_ENTRY"
  }, chatgptTab1);
  assert.equal(wrongMemoryAck.errorCode, "memory-entry-mismatch");
  const wrongVersionAck = await context.handleSkillMessage({
    ...ackMessage(list, begun.challenge),
    catalogVersion: list.version + 1
  }, chatgptTab1);
  assert.equal(wrongVersionAck.errorCode, "catalog-version-mismatch");

  catalog = makeCatalog("b", 2);
  const staleAck = await context.handleSkillMessage(ackMessage(list, begun.challenge), chatgptTab1);
  assert.equal(staleAck.errorCode, "stale-skill-sync-ack");
  assert.equal(staleAck.catalogSha, catalog.catalogSha);
  const latestList = await context.handleSkillMessage({
    type: "skill-sync-list",
    challenge: begun.challenge
  }, chatgptTab1);
  assert.equal(latestList.catalogSha, catalog.catalogSha, "An accumulated sync must collapse to the latest catalog only.");
  const acknowledged = await context.handleSkillMessage(ackMessage(latestList, begun.challenge), chatgptTab1);
  assert.equal(acknowledged.ok, true);
  assert.equal(acknowledged.updateAvailable, false);
  const afterAck = await context.handleSkillMessage({ type: "skill-state-get" }, chatgptTab2);
  assert.equal(afterAck.updateAvailable, false, "A valid ACK must clear all tabs in the same memory scope.");
  assert.equal(afterAck.syncing, false);
  const replay = await context.handleSkillMessage(ackMessage(latestList, begun.challenge), chatgptTab1);
  assert.equal(replay.errorCode, "skill-sync-not-active", "A completed challenge must not be replayable.");

  const forced = await context.handleSkillMessage({ type: "skill-sync-begin", force: true }, chatgptTab1);
  assert.equal(forced.ok, true);
  assert.equal(forced.forced, true);
  assert.notEqual(forced.challenge, begun.challenge);
  assert.equal(forced.version, acknowledged.version, "Force sync must not increment the server catalog version.");
  const forceList = await context.handleSkillMessage({
    type: "skill-sync-list",
    challenge: forced.challenge
  }, chatgptTab1);
  const missingFailureSha = await context.handleSkillMessage({
    type: "skill-sync-failed",
    challenge: forced.challenge,
    reason: "missing sha"
  }, chatgptTab1);
  assert.equal(missingFailureSha.errorCode, "catalog-sha-mismatch");
  const wrongFailureSha = await context.handleSkillMessage({
    type: "skill-sync-failed",
    challenge: forced.challenge,
    catalogSha: "0".repeat(64),
    catalogVersion: forceList.version,
    reason: "wrong sha"
  }, chatgptTab1);
  assert.equal(wrongFailureSha.errorCode, "catalog-sha-mismatch");
  const wrongFailureVersion = await context.handleSkillMessage({
    type: "skill-sync-failed",
    challenge: forced.challenge,
    catalogSha: forceList.catalogSha,
    catalogVersion: forceList.version + 1,
    reason: "wrong version"
  }, chatgptTab1);
  assert.equal(wrongFailureVersion.errorCode, "catalog-version-mismatch");
  const failed = await context.handleSkillMessage({
    type: "skill-sync-failed",
    challenge: forced.challenge,
    catalogSha: forceList.catalogSha,
    catalogVersion: forceList.version,
    reason: "memory unavailable"
  }, chatgptTab1);
  assert.equal(failed.ok, true);
  assert.equal(failed.updateAvailable, true);
  assert.equal(failed.lastSyncError, "memory unavailable");
  const afterForceFailure = await context.handleSkillMessage({ type: "skill-state-get" }, chatgptTab1);
  assert.equal(
    afterForceFailure.updateAvailable,
    true,
    "A failed force sync must keep the green update action visible even when an older ACK has the same SHA."
  );
  assert.equal(afterForceFailure.lastSyncError, "memory unavailable");
  assert.equal(forceList.catalogSha, afterForceFailure.catalogSha);

  const retryAfterFailure = await context.handleSkillMessage({ type: "skill-sync-begin", force: true }, chatgptTab1);
  assert.equal(retryAfterFailure.ok, true);
  const retryList = await context.handleSkillMessage({
    type: "skill-sync-list",
    challenge: retryAfterFailure.challenge
  }, chatgptTab1);
  const retryAck = await context.handleSkillMessage(ackMessage(retryList, retryAfterFailure.challenge), chatgptTab1);
  assert.equal(retryAck.ok, true);
  const afterRetry = await context.handleSkillMessage({ type: "skill-state-get" }, chatgptTab1);
  assert.equal(afterRetry.updateAvailable, false);
  assert.equal(afterRetry.lastSyncError, "");

  catalog = { ...catalog, version: catalog.version + 1 };
  const jsonStateChange = await context.handleSkillMessage({ type: "skill-state-get" }, chatgptTab1);
  assert.equal(
    jsonStateChange.updateAvailable,
    true,
    "A meaningful installation-JSON change must require sync even when the raw catalog SHA is unchanged."
  );
  const jsonChangeBegin = await context.handleSkillMessage({ type: "skill-sync-begin" }, chatgptTab1);
  const jsonChangeList = await context.handleSkillMessage({
    type: "skill-sync-list",
    challenge: jsonChangeBegin.challenge
  }, chatgptTab1);
  catalog = { ...catalog, version: catalog.version + 1 };
  const staleSameShaAck = await context.handleSkillMessage(ackMessage(jsonChangeList, jsonChangeBegin.challenge), chatgptTab1);
  assert.equal(staleSameShaAck.errorCode, "stale-skill-sync-ack", "A same-SHA installation-state race must reject the old list by version.");
  const latestJsonChangeList = await context.handleSkillMessage({
    type: "skill-sync-list",
    challenge: jsonChangeBegin.challenge
  }, chatgptTab1);
  const jsonChangeAck = await context.handleSkillMessage(ackMessage(latestJsonChangeList, jsonChangeBegin.challenge), chatgptTab1);
  assert.equal(jsonChangeAck.ok, true);
  assert.equal((await context.handleSkillMessage({ type: "skill-state-get" }, chatgptTab1)).updateAvailable, false);

  catalog = makeCatalog("c", 3);
  const persistedBegin = await context.handleSkillMessage({ type: "skill-sync-begin" }, chatgptTab1);
  assert.equal(persistedBegin.ok, true);
  context = createBackgroundContext();
  const restored = await context.handleSkillMessage({ type: "skill-state-get" }, chatgptTab2);
  assert.equal(restored.syncing, true, "A service-worker restart must restore the session-owned sync lock.");
  assert.equal(restored.syncOwnerTabId, 11);
  const restoredOtherTab = await context.handleSkillMessage({ type: "skill-sync-begin" }, chatgptTab2);
  assert.equal(restoredOtherTab.errorCode, "skill-sync-owned-by-another-tab");
  const restoredList = await context.handleSkillMessage({
    type: "skill-sync-list",
    challenge: persistedBegin.challenge
  }, chatgptTab1);
  assert.equal(restoredList.ok, true);

  await context.releaseSkillSyncLocksForTab(11);
  const afterOwnerClose = await context.handleSkillMessage({ type: "skill-sync-begin" }, chatgptTab2);
  assert.equal(afterOwnerClose.ok, true, "Closing the owner tab must release the cross-tab lock.");
  const scopeKey = Object.keys(sessionStore).find((key) => key.includes("https://chatgpt.com"));
  sessionStore[scopeKey].expiresAt = Date.now() - 1;
  const afterExpiry = await context.handleSkillMessage({ type: "skill-sync-begin" }, chatgptTab1);
  assert.equal(afterExpiry.ok, true, "An expired owner lease must be replaceable.");

  await context.releaseSkillSyncLocksForTab(11);
  const concurrent = await Promise.all([
    context.handleSkillMessage({ type: "skill-sync-begin" }, chatgptTab1),
    context.handleSkillMessage({ type: "skill-sync-begin" }, chatgptTab2)
  ]);
  assert.equal(concurrent.filter((response) => response.ok === true).length, 1);
  assert.equal(concurrent.filter((response) => response.errorCode === "skill-sync-owned-by-another-tab").length, 1);

  const healthGate = deferred();
  const raceContext = createBackgroundContext({ healthGate });
  const closingTab = sender(77, "https://tab-close-race.example/thread");
  const racingBegin = raceContext.handleSkillMessage({ type: "skill-sync-begin" }, closingTab);
  await Promise.resolve();
  tabRemovedListeners.at(-1)(77);
  healthGate.resolve();
  const closedDuringBegin = await racingBegin;
  assert.equal(closedDuringBegin.ok, false);
  assert.equal(closedDuringBegin.errorCode, "skill-sync-tab-closed");
  await Promise.resolve();
  assert.ok(
    !Object.values(sessionStore).some((value) => Number(value?.ownerTabId) === 77),
    "A tab closed while begin is in flight must not leave an orphan Skill sync lock."
  );

  await assert.rejects(
    () => context.handleSkillMessage({ type: "skill-state-get" }, { tab: { id: 99 }, url: "not a url" }),
    /valid AI page origin/i
  );
  const unsupported = await context.handleSkillMessage({ type: "skill-unknown" }, chatgptTab1);
  assert.equal(unsupported.errorCode, "unsupported-skill-message");

  const catalogList = await context.handleSkillMessage({ type: "skill-catalog-list" }, chatgptTab1);
  assert.equal(catalogList.ok, true);
  const managementList = await context.handleSkillMessage({ type: "skill-management-list" }, chatgptTab1);
  assert.equal(managementList.ok, true);
  assert.ok(websocketPayloads.some((payload) => payload.type === "skill-management-list"));
  const installSha = "d".repeat(64);
  installResponseGate = deferred();
  const installPending = context.handleSkillMessage({
    type: "skill-install",
    skillId: "example",
    skillName: "Example Skill",
    skillSha: catalog.skills[0].sha,
    installSha,
    catalogSha: catalog.catalogSha
  }, chatgptTab1);
  const stateWhileInstalling = await Promise.race([
    context.handleSkillMessage({ type: "skill-state-get" }, chatgptTab1),
    new Promise((resolve) => setTimeout(() => resolve(null), 500))
  ]);
  installResponseGate.resolve();
  installResponseGate = null;
  const install = await installPending;
  assert.equal(stateWhileInstalling?.ok, true, "A long installer must not hold the origin-scoped sync/status lock.");
  assert.equal(install.ok, true);
  assert.equal(install.installFailureToken, undefined, "A successful install must not create a result-window token.");
  const installPayload = websocketPayloads.findLast((payload) => payload.type === "skill-install");
  assert.equal(installPayload.skillId, "example");
  assert.equal(installPayload.skillSha, catalog.skills[0].sha);
  assert.equal(installPayload.installSha, installSha);
  assert.equal(installPayload.catalogSha, catalog.catalogSha);
  assert.equal(installPayload.skillName, undefined, "A display label must not change the authenticated server install protocol.");
  assert.equal(context.getWebSocketWatchdogMs({ type: "skill-install" }), 0,
    "Skill installation must not regain an absolute browser watchdog.");
  assert.equal(context.shouldKeepWebSocketAlive({ type: "skill-install" }), true,
    "Long Skill installation must use the Chrome 116+ WebSocket heartbeat path.");

  skillInstallResponseOverride = {
    ...catalog,
    ok: false,
    type: "skill-install",
    errorCode: "installer-failed",
    error: "Installer exited with code 23.",
    exitCode: 23,
    durationMs: 4321,
    installerOutput: {
      stderr: "\u001b[31m\u009b32m<script>failure</script>\u001b[0m\u0000\u009dhidden-title\u009c\u061c\u200e\u200f\u202e",
      stdout: "setup tail",
      stderrTruncated: true,
      stdoutTruncated: false
    }
  };
  const failedInstall = await context.handleSkillMessage({
    type: "skill-install",
    skillId: "example",
    skillName: "Example Skill",
    skillSha: catalog.skills[0].sha,
    installSha,
    catalogSha: catalog.catalogSha
  }, chatgptTab1);
  skillInstallResponseOverride = null;
  assert.equal(failedInstall.ok, false);
  assert.match(failedInstall.installFailureToken, /^[a-f0-9]{32}$/);
  assert.equal(failedInstall.installerOutput, undefined,
    "Raw installer output must stop in background memory and never enter the chat content-script response.");
  assert.equal(localStore[failedInstall.installFailureToken], undefined);
  assert.equal(sessionStore[failedInstall.installFailureToken], undefined,
    "Failure details must remain ephemeral background memory, not extension storage.");

  const ownerMismatch = await context.handleSkillMessage({
    type: "skill-install-failure-show",
    token: failedInstall.installFailureToken
  }, chatgptTab2);
  assert.equal(ownerMismatch.errorCode, "install-failure-owner-mismatch");
  windowCreateGate = deferred();
  const showing = context.handleSkillMessage({
    type: "skill-install-failure-show",
    token: failedInstall.installFailureToken
  }, chatgptTab1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(createdWindows.length, 1);
  assert.equal(createdWindows[0].type, "popup");
  assert.match(createdWindows[0].url, new RegExp(`${failedInstall.installFailureToken}$`));
  const shownAgain = await context.handleSkillMessage({
    type: "skill-install-failure-show",
    token: failedInstall.installFailureToken
  }, chatgptTab1);
  assert.equal(shownAgain.alreadyShown, true);
  windowCreateGate.resolve();
  windowCreateGate = null;
  const shown = await showing;
  assert.equal(shown.ok, true);
  assert.equal(createdWindows.length, 1, "One failure token must open at most one result window.");

  const rejectedConsumer = await context.handleSkillMessage({
    type: "skill-install-failure-consume",
    token: failedInstall.installFailureToken
  }, { id: context.chrome.runtime.id, url: "https://chatgpt.com/skill-install-result.html" });
  assert.equal(rejectedConsumer.errorCode, "install-failure-consumer-rejected");
  const rejectedPrefixConsumer = await context.handleSkillMessage({
    type: "skill-install-failure-consume",
    token: failedInstall.installFailureToken
  }, {
    id: context.chrome.runtime.id,
    url: `${context.chrome.runtime.getURL("skill-install-result.html")}-spoof#${failedInstall.installFailureToken}`
  });
  assert.equal(rejectedPrefixConsumer.errorCode, "install-failure-consumer-rejected",
    "A URL that merely starts with the extension result-page URL must not consume installer details.");
  const consumed = await context.handleSkillMessage({
    type: "skill-install-failure-consume",
    token: failedInstall.installFailureToken
  }, {
    id: context.chrome.runtime.id,
    url: context.chrome.runtime.getURL(`skill-install-result.html#${failedInstall.installFailureToken}`)
  });
  assert.equal(consumed.ok, true);
  assert.equal(consumed.detail.exitCode, 23);
  assert.equal(consumed.detail.installerOutput.stderr, "<script>failure</script>",
    "The isolated result UI receives plain sanitized text without ANSI, NUL, or bidi controls.");
  assert.equal(consumed.detail.installerOutput.stderrTruncated, true);
  assert.equal(vm.runInContext("pendingSkillInstallFailures.size", context), 0,
    "Reading a result must consume its ephemeral detail exactly once.");

  const expiryToken = context.rememberSkillInstallFailure({
    response: skillInstallResponseOverride || {
      ok: false,
      errorCode: "installer-failed",
      error: "expired detail",
      installerOutput: { stderr: "expired secret" }
    },
    skillId: "expired",
    tabId: 11
  });
  vm.runInContext(`pendingSkillInstallFailures.get(${JSON.stringify(expiryToken)}).expiresAt = 0`, context);
  const expiredShow = await context.handleSkillMessage({ type: "skill-install-failure-show", token: expiryToken }, chatgptTab1);
  assert.equal(expiredShow.errorCode, "install-failure-expired");
  assert.equal(vm.runInContext("pendingSkillInstallFailures.size", context), 0);

  const boundedTokens = [];
  for (let index = 0; index < 9; index += 1) {
    boundedTokens.push(context.rememberSkillInstallFailure({
      response: {
        ok: false,
        errorCode: "installer-failed",
        error: `bounded detail ${index}`,
        installerOutput: {
          stderr: index === 8 ? `discarded-head-${"x".repeat(20_000)}tail-sentinel` : `bounded ${index}`
        }
      },
      skillId: `bounded-${index}`,
      tabId: 11
    }));
  }
  assert.equal(vm.runInContext("pendingSkillInstallFailures.size", context), 8,
    "The ninth pending failure must evict the oldest record instead of growing background memory.");
  assert.equal(vm.runInContext(`pendingSkillInstallFailures.has(${JSON.stringify(boundedTokens[0])})`, context), false);
  assert.equal(vm.runInContext(`pendingSkillInstallFailures.has(${JSON.stringify(boundedTokens[8])})`, context), true);
  const boundedConsumed = await context.handleSkillMessage({
    type: "skill-install-failure-consume",
    token: boundedTokens[8]
  }, {
    id: context.chrome.runtime.id,
    url: context.chrome.runtime.getURL(`skill-install-result.html#${boundedTokens[8]}`)
  });
  assert.equal(boundedConsumed.detail.installerOutput.stderr.length, 20_000);
  assert.doesNotMatch(boundedConsumed.detail.installerOutput.stderr, /discarded-head/,
    "The background must independently keep only the bounded diagnostic tail.");
  assert.match(boundedConsumed.detail.installerOutput.stderr, /tail-sentinel$/);
  for (const token of boundedTokens.slice(1, 8)) {
    await context.handleSkillMessage({ type: "skill-install-failure-discard", token }, chatgptTab1);
  }
  assert.equal(vm.runInContext("pendingSkillInstallFailures.size", context), 0);

  const closeToken = context.rememberSkillInstallFailure({
    response: {
      ok: false,
      errorCode: "installer-failed",
      error: "close cleanup",
      installerOutput: { stderr: "close secret" }
    },
    skillId: "close-cleanup",
    tabId: 98
  });
  assert.match(closeToken, /^[a-f0-9]{32}$/);
  context.__tabRemovedListener(98);
  assert.equal(vm.runInContext("pendingSkillInstallFailures.size", context), 0,
    "Closing the owner tab must immediately erase any unconsumed diagnostic.");

  skillInstallResponseOverride = {
    ...catalog,
    ok: false,
    type: "skill-install",
    errorCode: "installer-failed",
    error: "late failure",
    exitCode: 19,
    installerOutput: { stderr: "late close secret", stdout: "" }
  };
  installResponseGate = deferred();
  const closedDuringInstall = context.handleSkillMessage({
    type: "skill-install",
    skillId: "example",
    skillName: "Example Skill",
    skillSha: catalog.skills[0].sha,
    installSha,
    catalogSha: catalog.catalogSha
  }, sender(99, "https://chatgpt.com/closed-during-install"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  context.__tabRemovedListener(99);
  installResponseGate.resolve();
  installResponseGate = null;
  const lateFailure = await closedDuringInstall;
  skillInstallResponseOverride = null;
  assert.equal(lateFailure.ok, false);
  assert.equal(lateFailure.installerOutput, undefined);
  assert.equal(lateFailure.installFailureToken, undefined,
    "A tab closed during an arbitrarily long install must not create an orphan diagnostic after the response arrives.");
  assert.equal(vm.runInContext("pendingSkillInstallFailures.size", context), 0);
  assert.doesNotMatch(JSON.stringify({ localStore, sessionStore }), /late close secret|close secret|expired secret|setup tail|<script>failure/i,
    "Installer diagnostics must not enter any persistent or session extension store value.");
  const load = await context.handleSkillMessage({
    type: "skill-load",
    skillId: "example",
    catalogSha: catalog.catalogSha
  }, chatgptTab1);
  assert.equal(load.ok, true);
  assert.ok(load.content.includes("loaded example"));
  assert.ok(websocketPayloads.some((payload) => payload.type === "skill-load"));
  assert.equal(localStore["shellCallLedger:v1"], undefined, "Skill traffic must not enter the browser shell ledger.");
}

async function testEmptyCatalogSynchronization(context) {
  const firstOriginTab = sender(31, "https://empty-a.example/chat");
  const sameOriginTab = sender(32, "https://empty-a.example/other");
  const secondOriginTab = sender(41, "https://empty-b.example/chat");

  catalog = makeEmptyCatalog("0", 1);
  const firstInitial = await context.handleSkillMessage({ type: "skill-state-get" }, firstOriginTab);
  const secondInitial = await context.handleSkillMessage({ type: "skill-state-get" }, secondOriginTab);
  assert.equal(firstInitial.skillCount, 0);
  assert.equal(firstInitial.acknowledgedCatalogSha, "");
  assert.equal(firstInitial.updateAvailable, true, "A healthy empty catalog must require its first ACK.");
  assert.equal(secondInitial.updateAvailable, true, "Empty-catalog ACK state must remain origin-scoped.");

  const firstBegin = await context.handleSkillMessage({ type: "skill-sync-begin" }, firstOriginTab);
  assert.equal(firstBegin.ok, true, JSON.stringify(firstBegin));
  assert.equal(firstBegin.skillCount, 0);
  const firstList = await context.handleSkillMessage({
    type: "skill-sync-list",
    challenge: firstBegin.challenge
  }, firstOriginTab);
  assert.equal(firstList.ok, true);
  assert.deepEqual(Array.from(firstList.skills), []);

  const crossOriginAck = await context.handleSkillMessage(
    ackMessage(firstList, firstBegin.challenge),
    secondOriginTab
  );
  assert.equal(crossOriginAck.errorCode, "skill-sync-not-active");
  const firstStillOwned = await context.handleSkillMessage({ type: "skill-state-get" }, sameOriginTab);
  assert.equal(firstStillOwned.syncing, true, "A cross-origin ACK attempt must not consume the real owner's challenge.");

  const firstFailure = await context.handleSkillMessage({
    type: "skill-sync-failed",
    challenge: firstBegin.challenge,
    catalogSha: firstList.catalogSha,
    catalogVersion: firstList.version,
    reason: "empty catalog memory update failed"
  }, firstOriginTab);
  assert.equal(firstFailure.ok, true);
  const afterFailure = await context.handleSkillMessage({ type: "skill-state-get" }, firstOriginTab);
  assert.equal(afterFailure.acknowledgedCatalogSha, "");
  assert.equal(afterFailure.updateAvailable, true);
  assert.equal(afterFailure.lastSyncError, "empty catalog memory update failed");

  const retryBegin = await context.handleSkillMessage({ type: "skill-sync-begin" }, firstOriginTab);
  assert.equal(retryBegin.ok, true, "A first empty-catalog failure must be retryable without Force.");
  assert.notEqual(retryBegin.challenge, firstBegin.challenge);
  const retryList = await context.handleSkillMessage({
    type: "skill-sync-list",
    challenge: retryBegin.challenge
  }, firstOriginTab);
  const firstAck = await context.handleSkillMessage(ackMessage(retryList, retryBegin.challenge), firstOriginTab);
  assert.equal(firstAck.ok, true);
  const firstCurrent = await context.handleSkillMessage({ type: "skill-state-get" }, sameOriginTab);
  assert.equal(firstCurrent.updateAvailable, false, "An acknowledged empty catalog must become current.");
  assert.equal(firstCurrent.acknowledgedCatalogSha, catalog.catalogSha);
  assert.equal(firstCurrent.lastSyncError, "");
  const alreadyCurrent = await context.handleSkillMessage({ type: "skill-sync-begin" }, firstOriginTab);
  assert.equal(alreadyCurrent.errorCode, "skills-already-current", "An empty catalog must not remain permanently pending.");

  const forced = await context.handleSkillMessage({ type: "skill-sync-begin", force: true }, firstOriginTab);
  assert.equal(forced.ok, true, "Force sync must remain available for a current empty catalog.");
  const forcedList = await context.handleSkillMessage({
    type: "skill-sync-list",
    challenge: forced.challenge
  }, firstOriginTab);
  const forcedAck = await context.handleSkillMessage(ackMessage(forcedList, forced.challenge), firstOriginTab);
  assert.equal(forcedAck.ok, true);

  const secondStillPending = await context.handleSkillMessage({ type: "skill-state-get" }, secondOriginTab);
  assert.equal(secondStillPending.updateAvailable, true, "ACKing one origin must not clear another origin.");
  const secondBegin = await context.handleSkillMessage({ type: "skill-sync-begin" }, secondOriginTab);
  const secondList = await context.handleSkillMessage({
    type: "skill-sync-list",
    challenge: secondBegin.challenge
  }, secondOriginTab);
  const secondAck = await context.handleSkillMessage(ackMessage(secondList, secondBegin.challenge), secondOriginTab);
  assert.equal(secondAck.ok, true);

  catalog = makeCatalog("d", 2);
  const nonEmptyChange = await context.handleSkillMessage({ type: "skill-state-get" }, firstOriginTab);
  assert.equal(nonEmptyChange.updateAvailable, true);
  const nonEmptyBegin = await context.handleSkillMessage({ type: "skill-sync-begin" }, firstOriginTab);
  const nonEmptyList = await context.handleSkillMessage({
    type: "skill-sync-list",
    challenge: nonEmptyBegin.challenge
  }, firstOriginTab);
  const nonEmptyAck = await context.handleSkillMessage(ackMessage(nonEmptyList, nonEmptyBegin.challenge), firstOriginTab);
  assert.equal(nonEmptyAck.ok, true);

  catalog = makeEmptyCatalog("1", 3);
  const removedLastSkill = await context.handleSkillMessage({ type: "skill-state-get" }, firstOriginTab);
  assert.equal(removedLastSkill.skillCount, 0);
  assert.equal(removedLastSkill.updateAvailable, true, "Removing the last Skill must require clearing the AI memory catalog.");
  const emptyAgainBegin = await context.handleSkillMessage({ type: "skill-sync-begin" }, firstOriginTab);
  const emptyAgainList = await context.handleSkillMessage({
    type: "skill-sync-list",
    challenge: emptyAgainBegin.challenge
  }, firstOriginTab);
  assert.deepEqual(Array.from(emptyAgainList.skills), []);
  const emptyAgainAck = await context.handleSkillMessage(ackMessage(emptyAgainList, emptyAgainBegin.challenge), firstOriginTab);
  assert.equal(emptyAgainAck.ok, true);
  const emptyAgainCurrent = await context.handleSkillMessage({ type: "skill-state-get" }, firstOriginTab);
  assert.equal(emptyAgainCurrent.updateAvailable, false);

  const malformedAckTab = sender(51, "https://malformed-ack.example/chat");
  localStore["skillCatalogAck:v1:https://malformed-ack.example"] = {
    version: 1,
    catalogSha: "too-short",
    catalogVersion: 3,
    acknowledgedAt: Date.now(),
    lastSyncError: ""
  };
  const malformedAckState = await context.handleSkillMessage({ type: "skill-state-get" }, malformedAckTab);
  assert.equal(malformedAckState.acknowledgedCatalogSha, "");
  assert.equal(malformedAckState.updateAvailable, true, "A malformed persisted ACK must be treated as never acknowledged.");

  catalog = {
    ...makeEmptyCatalog("2", 4),
    ok: false,
    errors: [{ code: "test-invalid", message: "invalid empty catalog" }]
  };
  const invalidState = await context.handleSkillMessage({ type: "skill-state-get" }, malformedAckTab);
  assert.equal(invalidState.ok, false);
  assert.equal(invalidState.updateAvailable, false, "An invalid catalog must fail closed instead of requesting synchronization.");
  const invalidBegin = await context.handleSkillMessage({ type: "skill-sync-begin" }, malformedAckTab);
  assert.equal(invalidBegin.errorCode, "skill-catalog-invalid");
}

function createBackgroundContext({ healthGate } = {}) {
  const context = {
    AbortController,
    URL,
    chrome: {
      runtime: {
        id: "lkmeogidbglhedgekjgbpbfjkpapnhke",
        getManifest: () => ({ version: "0.11.2" }),
        getURL: (resource) => `chrome-extension://lkmeogidbglhedgekjgbpbfjkpapnhke/${resource}`,
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        onMessage: { addListener() {} }
      },
      tabs: {
        onRemoved: {
          addListener(callback) {
            tabRemovedListeners.push(callback);
            context.__tabRemovedListener = callback;
          }
        },
        sendMessage: async () => ({ ok: true })
      },
      windows: {
        create: async (options) => {
          createdWindows.push({ ...options });
          if (windowCreateGate) {
            await windowCreateGate.promise;
          }
          return { id: createdWindows.length };
        }
      },
      storage: {
        sync: storageArea(syncStore, true),
        local: storageArea(localStore),
        session: storageArea(sessionStore)
      }
    },
    clearInterval,
    clearTimeout,
    console,
    crypto: {
      getRandomValues(bytes) {
        const value = challengeSequence;
        challengeSequence += 1;
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = (value + index) & 0xff;
        }
        return bytes;
      }
    },
    fetch: async () => {
      if (healthGate) {
        await healthGate.promise;
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          allowedOrigin: "chrome-extension://lkmeogidbglhedgekjgbpbfjkpapnhke",
          releaseVersion: "0.11.2",
          serverReleaseVersion: "0.11.2",
          protocolVersion: 11,
          serverProtocolVersion: 11,
          helperProtocolVersion: 4,
          skillProtocolVersion: 4
        })
      };
    },
    setInterval,
    setTimeout(callback, delay, ...args) {
      const timer = setTimeout(callback, delay, ...args);
      if (Number(delay) >= 60_000) {
        timer.unref?.();
      }
      return timer;
    },
    WebSocket: FakeWebSocket
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, "..", "extension", "src", "background.js"), "utf8");
  vm.runInContext(source, context, { filename: "background.js" });
  return context;
}

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    setTimeout(() => {
      this.readyState = 1;
      this.emit("open", {});
    }, 0);
  }

  addEventListener(type, callback) {
    this.listeners[type] ||= [];
    this.listeners[type].push(callback);
  }

  send(text) {
    const payload = JSON.parse(text);
    websocketPayloads.push(payload);
    setTimeout(async () => {
      if (payload.type === "skill-install" && installResponseGate) {
        await installResponseGate.promise;
      }
      const response = skillServerResponse(payload);
      this.emit("message", { data: JSON.stringify(response) });
    }, 0);
  }

  close() {
    this.readyState = 3;
  }

  emit(type, event) {
    for (const callback of this.listeners[type] || []) {
      callback(event);
    }
  }
}

function skillServerResponse(payload) {
  if (payload.type === "skill-catalog-status" || payload.type === "skill-catalog-rescan") {
    return { ...catalog, type: "skill-catalog-status" };
  }
  if (payload.type === "skill-catalog-list") {
    return { ...catalog, type: "skill-catalog-status", skills: catalog.skills };
  }
  if (payload.type === "skill-management-list") {
    return {
      ...catalog,
      type: "skill-management-list",
      discoveredSkillCount: catalog.skills.length,
      skills: catalog.skills.map((skill) => ({ ...skill, installed: true, installAvailable: true }))
    };
  }
  if (payload.type === "skill-install") {
    if (skillInstallResponseOverride) {
      return { ...skillInstallResponseOverride };
    }
    return {
      ...catalog,
      ok: true,
      type: "skill-install",
      exitCode: 0,
      skill: { ...catalog.skills[0], installed: true, installAvailable: true }
    };
  }
  if (payload.type === "skill-load") {
    if (payload.catalogSha !== catalog.catalogSha) {
      return { ...catalog, ok: false, type: "skill-load", errorCode: "stale-catalog", error: "stale" };
    }
    return {
      ok: true,
      type: "skill-load",
      catalogSha: catalog.catalogSha,
      version: catalog.version,
      skill: catalog.skills[0],
      content: `loaded ${payload.skillId}`
    };
  }
  return { ok: false, error: `Unexpected test WebSocket payload: ${payload.type}` };
}

function makeCatalog(seed, version) {
  const catalogSha = seed.repeat(64).slice(0, 64);
  const skillSha = String.fromCharCode(seed.charCodeAt(0) + 1).repeat(64).slice(0, 64);
  return {
    ok: true,
    catalogSha,
    version,
    skillCount: 1,
    rootCount: 1,
    errors: [],
    warnings: [],
    skills: [{ id: "example", name: "example", description: "Example Skill", sha: skillSha }]
  };
}

function makeEmptyCatalog(seed, version) {
  return {
    ok: true,
    catalogSha: seed.repeat(64).slice(0, 64),
    version,
    skillCount: 0,
    rootCount: 1,
    errors: [],
    warnings: [],
    skills: []
  };
}

function ackMessage(list, challenge) {
  return {
    type: "skill-sync-ack",
    challenge,
    catalogSha: list.catalogSha,
    catalogVersion: list.version,
    memoryEntry: "AI_CHAT_SHELL_SKILLS_CATALOG"
  };
}

function sender(tabId, url) {
  return { origin: new URL(url).origin, url, tab: { id: tabId, url } };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function storageArea(store, callbackGet = false) {
  return {
    get(keys, callback) {
      const result = selectStoreValues(store, keys);
      if (typeof callback === "function") {
        callback(result);
      }
      return callbackGet && typeof callback === "function" ? undefined : Promise.resolve(result);
    },
    set(values, callback) {
      Object.assign(store, values);
      callback?.();
      return Promise.resolve();
    },
    remove(keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete store[key];
      }
      callback?.();
      return Promise.resolve();
    }
  };
}

function selectStoreValues(store, keys) {
  if (keys === null || keys === undefined) {
    return { ...store };
  }
  if (typeof keys === "string") {
    return { [keys]: store[keys] };
  }
  if (Array.isArray(keys)) {
    return Object.fromEntries(keys.map((key) => [key, store[key]]));
  }
  return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
    key,
    store[key] === undefined ? fallback : store[key]
  ]));
}

main().then(() => console.log("background Skill sync tests passed"));
