#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "extension", "src", "content.js"), "utf8");

assert.match(source, /\["force",\s*"Run latest"\]/);
assert.match(source, /async function forceRunLatestShellCall\(\)/);
assert.match(source, /scanForShellCall\(\{\s*force:\s*true\s*\}\)/);
assert.match(source, /forceAttempts/);
assert.match(source, /Waiting for current shell call, then running latest/);
assert.match(source, /function buildForceCallKey\(semanticCallKey\)/);
assert.match(source, /runAndReply\(executionCallKey,\s*call,\s*\{\s*force\s*\}\)/);
assert.match(source, /No shell-call found on this page/);

console.log("content force-run tests passed");
