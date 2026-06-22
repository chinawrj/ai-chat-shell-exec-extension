#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "extension", "src", "content.js"), "utf8");

assert.match(source, /mode:\s*"force",\s*label:\s*"Force run"/);
assert.match(source, /Force run latest helper block \(bypass dedup ledger\)/);
assert.match(source, /async function forceRunLatestShellCall\(\)/);
assert.match(source, /scanForShellCall\(\{\s*force:\s*true\s*\}\)/);
assert.match(source, /let pendingForceRunRequested = false;/);
assert.match(source, /function schedulePendingForceRunScan\(\)/);
assert.match(source, /function clearPendingForceRun\(\)/);
assert.match(source, /Waiting for current helper call, then running latest/);
assert.match(source, /function buildForceCallKey\(semanticCallKey\)/);
assert.match(source, /return `\$\{semanticCallKey\}:force:\$\{Date\.now\(\)\}:\$\{forceCallSequence\}`;/);
assert.match(source, /FORCE_RUN_STATUS_HINT = "click Force run to bypass"/);
assert.doesNotMatch(source, /Math\.random\(\)/);
assert.match(source, /runAndReply\(executionCallKey,\s*call,\s*\{\s*force\s*\}\)/);
assert.match(source, /No helper block found on this page/);
assert.match(source, /setHelperCompletionStatus\(call,\s*response\);\s*activeCallId = "";/);
assert.match(source, /const processedNodeSemanticKeys = new WeakMap\(\);/);
assert.match(source, /processedNodeSemanticKeys\.set\(candidate\.node,\s*semanticCallKey\);/);
assert.match(source, /processedNodeSemanticKeys\.get\(candidate\.node\) === semanticCallKey/);
assert.doesNotMatch(source, /dataset\.aiChatShell(CallKey|SemanticKey)/);

console.log("content force-run tests passed");
