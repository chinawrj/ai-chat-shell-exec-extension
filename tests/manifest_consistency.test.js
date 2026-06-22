#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.join(__dirname, "..");
const rootManifest = readJson(path.join(rootDir, "manifest.json"));
const extensionManifest = readJson(path.join(rootDir, "extension", "manifest.json"));
const contentSource = fs.readFileSync(path.join(rootDir, "extension", "src", "content.js"), "utf8");
const backgroundSource = fs.readFileSync(path.join(rootDir, "extension", "src", "background.js"), "utf8");
const changelog = fs.readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8");

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

const version = extensionManifest.version;
assert.match(contentSource, new RegExp(`const CONTENT_SCRIPT_VERSION = "${escapeRegExp(version)}";`));
assert.match(contentSource, /type: "extension-version"/);
assert.match(contentSource, /type: "tmux-ensure"/);
assert.match(contentSource, /type: "tmux-reset-forai"/);
assert.match(contentSource, /type: "shell-health"/);
assert.match(contentSource, /Checking shell server and ForAI tmux session/);
assert.match(contentSource, /Reset tmux/);
assert.match(contentSource, /Server protocol mismatch/);
assert.match(contentSource, /formatServerProtocolStatus/);
assert.match(contentSource, /helper protocol/);
assert.match(contentSource, /visionAvailable/);
assert.match(contentSource, /visualTmuxApps/);
assert.match(contentSource, /vision ok/);
assert.doesNotMatch(contentSource, /vision unavailable/);
assert.match(contentSource, /Server offline:/);
assert.match(contentSource, /Extension version mismatch: page v/);
assert.match(contentSource, /Extension v\$\{getDisplayVersion\(\)\}; \$\{formatServerProtocolStatus\(health\)\}/);
assert.match(backgroundSource, /message\.type === "extension-version"/);
assert.match(backgroundSource, /message\.type === "tmux-ensure"/);
assert.match(backgroundSource, /message\.type === "tmux-reset-forai"/);
assert.match(backgroundSource, /const REQUIRED_SERVER_PROTOCOL_VERSION = 4/);
assert.match(backgroundSource, /const REQUIRED_HELPER_PROTOCOL_VERSION = 2/);
assert.match(backgroundSource, /startsWith\("vision-"\)/);
assert.match(backgroundSource, /function handleVisionMessage\(/);
assert.match(backgroundSource, /BACKGROUND_VISION_MESSAGE_TYPES/);
assert.match(backgroundSource, /VISION_COMMAND_MESSAGE_TYPES/);
assert.doesNotMatch(backgroundSource, /"vision-list-windows"/);
assert.doesNotMatch(backgroundSource, /"vision-tmux-run-line"/);
assert.doesNotMatch(backgroundSource, /"vision-tmux-run"/);
assert.match(backgroundSource, /function buildProtocolMismatchMessage\(/);
assert.match(backgroundSource, /function requireShellServerReady\(\)/);
assert.match(backgroundSource, /function getExtensionVersionInfo\(\)/);
assert.match(backgroundSource, /body\?\.error/);
assert.match(changelog, new RegExp(`## \\[${escapeRegExp(version)}\\]`));
assert.equal(fs.existsSync(path.join(rootDir, "docs", "release-notes", `v${version}.md`)), true);

console.log("manifest consistency tests passed");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function prefixExtensionPath(filePath) {
  return `extension/${filePath}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
