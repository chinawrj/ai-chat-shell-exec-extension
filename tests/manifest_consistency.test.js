#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.join(__dirname, "..");
const rootManifest = readJson(path.join(rootDir, "manifest.json"));
const extensionManifest = readJson(path.join(rootDir, "extension", "manifest.json"));

assert.equal(rootManifest.manifest_version, extensionManifest.manifest_version);
assert.equal(rootManifest.name, extensionManifest.name);
assert.equal(rootManifest.description, extensionManifest.description);
assert.equal(rootManifest.version, extensionManifest.version);
assert.equal(rootManifest.key, extensionManifest.key);
assert.deepEqual(rootManifest.permissions, extensionManifest.permissions);
assert.deepEqual(rootManifest.host_permissions, extensionManifest.host_permissions);

assert.equal(rootManifest.background.service_worker, prefixExtensionPath(extensionManifest.background.service_worker));
assert.equal(rootManifest.background.type, extensionManifest.background.type);
assert.equal(rootManifest.action.default_title, extensionManifest.action.default_title);
assert.equal(rootManifest.action.default_popup, prefixExtensionPath(extensionManifest.action.default_popup));

assert.equal(rootManifest.content_scripts.length, extensionManifest.content_scripts.length);
for (let index = 0; index < extensionManifest.content_scripts.length; index += 1) {
  const rootScript = rootManifest.content_scripts[index];
  const extensionScript = extensionManifest.content_scripts[index];
  assert.deepEqual(rootScript.matches, extensionScript.matches);
  assert.deepEqual(rootScript.js, extensionScript.js.map(prefixExtensionPath));
  assert.equal(rootScript.run_at, extensionScript.run_at);
}

console.log("manifest consistency tests passed");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function prefixExtensionPath(filePath) {
  return `extension/${filePath}`;
}
