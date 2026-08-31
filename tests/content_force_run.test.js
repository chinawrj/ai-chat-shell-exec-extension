#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "extension", "src", "content.js"), "utf8");

assert.match(source, /mode:\s*"force",\s*label:\s*"Force run"/);
assert.match(source, /Force run latest helper block \(bypass dedup ledger\)/);
assert.match(source, /async function forceRunLatestShellCall\(\)/);
assert.match(source, /scanForShellCall\(\{\s*force:\s*true,\s*forceCandidateSnapshot\s*\}\)/);
assert.match(source, /let pendingForceRunRequested = false;/);
assert.match(source, /let forceRunInFlight = false;/);
assert.match(source, /if \(Boolean\(activeCallId\) \|\| pendingForceRunRequested \|\| forceRunInFlight \|\|[\s\S]*skillHelperInFlight \|\| skillRecoveryInFlight \|\|[\s\S]*pendingHelperDeliveries\.size > 0 \|\| hasPendingAgentComposerDelivery\(\) \|\|[\s\S]*panelShellHelperActive \|\| isAssistantGenerating\(\)\) \{\s*return;\s*\}/);
assert.match(source, /forceRunInFlight = true;[\s\S]*await scanForShellCall\(\{ force: true, forceCandidateSnapshot \}\);[\s\S]*finally \{\s*forceRunInFlight = false;/);
assert.match(source, /Force run cancelled because the latest helper changed/);
assert.match(source, /getLatestManualActionKind\([\s\S]*skillBoundaryCandidate[\s\S]*\) !== "force"/);
assert.match(source, /function schedulePendingForceRunScan\(\)/);
assert.match(source, /function clearPendingForceRun\(\)/);
assert.match(source, /Waiting for current helper call, then running latest/);
assert.match(source, /function buildForceCallKey\(semanticCallKey\)/);
assert.match(source, /return `\$\{semanticCallKey\}:force:\$\{Date\.now\(\)\}:\$\{forceCallSequence\}`;/);
assert.match(source, /FORCE_RUN_STATUS_HINT = "click Force run to bypass"/);
assert.doesNotMatch(source, /Math\.random\(\)/);
assert.match(source, /runAndReply\(executionCallKey,\s*call,\s*\{\s*force,\s*forceCandidateSnapshot:\s*forceDispatchSnapshot\s*\}\)/);
assert.match(source, /const settings = await chrome\.storage\.sync\.get\(\["requireApproval", "autoSend"\]\);\s*if \(force && !isForceRunCandidateSnapshotCurrent\(forceCandidateSnapshot\)\)/);
assert.match(source, /function isForceRunCandidateSnapshotCurrent\(snapshot\)/);
assert.match(source, /pageIdentity:\s*getCurrentPageIdentity\(\),\s*generation:\s*pageLifecycleGeneration/);
assert.match(source, /snapshot\.pageIdentity !== getCurrentPageIdentity\(\)[\s\S]*snapshot\.generation !== pageLifecycleGeneration/);
assert.match(source, /No helper block found on this page/);
assert.match(source, /setHelperCompletionStatus\(call,\s*response\);[\s\S]*releaseActiveCall\(callToken\);/);
assert.match(source, /function isCurrentCallToken\(callToken\)/);
assert.match(source, /function releaseActiveCall\(callToken\)/);
assert.match(source, /const processedRenderedHelpers = new WeakMap\(\);/);
assert.match(source, /function buildRenderedHelperKey\(candidate, semanticCallKey, pageIdentity = getCurrentPageIdentity\(\)\)/);
assert.match(source, /routeHandoffPreviousPageIdentity/);
assert.match(source, /candidate\?\.blockIndex \?\? candidate\?\.index/);
assert.doesNotMatch(source, /processedSemanticCalls/);
assert.doesNotMatch(source, /processedCalls/);
assert.doesNotMatch(source, /processedNodeSemanticKeys/);
assert.doesNotMatch(source, /shouldSuppressShellCallEcho/);
assert.doesNotMatch(source, /dataset\.aiChatShell(CallKey|SemanticKey)/);

console.log("content force-run tests passed");
