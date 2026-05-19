#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.join(__dirname, "..");
const expectedHosts = ["chatgpt.com", "m365.cloud.microsoft"];

assert.deepEqual(readConstArray("extension/src/background.js", "DEFAULT_ENABLED_HOSTS"), expectedHosts);
assert.deepEqual(readConstArray("extension/src/content.js", "DEFAULT_ENABLED_HOSTS"), expectedHosts);
assert.deepEqual(readObjectArray("extension/src/popup.js", "enabledHosts"), expectedHosts);

console.log("default enabled hosts tests passed");

function readConstArray(relativePath, constName) {
  const source = fs.readFileSync(path.join(rootDir, relativePath), "utf8");
  const match = source.match(new RegExp(`const\\s+${constName}\\s*=\\s*(\\[[^\\]]*\\])`));
  assert.ok(match, `${constName} is missing in ${relativePath}`);
  return JSON.parse(match[1]);
}

function readObjectArray(relativePath, key) {
  const source = fs.readFileSync(path.join(rootDir, relativePath), "utf8");
  const match = source.match(new RegExp(`${key}\\s*:\\s*(\\[[^\\]]*\\])`));
  assert.ok(match, `${key} is missing in ${relativePath}`);
  return JSON.parse(match[1]);
}
