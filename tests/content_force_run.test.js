#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "extension", "src", "content.js"), "utf8");

assert.match(source, /\["force",\s*"Run latest"\]/);
assert.match(source, /async function forceRunLatestShellCall\(\)/);
assert.match(source, /scanForShellCall\(\{\s*force:\s*true\s*\}\)/);
assert.match(source, /function buildForceCallKey\(semanticCallKey\)/);
assert.match(source, /runAndReply\(executionCallKey,\s*call,\s*\{\s*force\s*\}\)/);

console.log("content force-run tests passed");
