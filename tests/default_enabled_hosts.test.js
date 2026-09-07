#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = path.join(__dirname, "..");
const expectedHosts = ["chatgpt.com", "m365.cloud.microsoft"];
const expectedMaxChainCalls = 100;
const expectedIdleTimeoutMs = 180000;
const expectedMaxOutputChars = 80000;

assert.deepEqual(readConstArray("extension/src/background.js", "DEFAULT_ENABLED_HOSTS"), expectedHosts);
assert.deepEqual(readConstArray("extension/src/content.js", "DEFAULT_ENABLED_HOSTS"), expectedHosts);
assert.deepEqual(readObjectArray("extension/src/popup.js", "enabledHosts"), expectedHosts);
assert.equal(readConstNumber("extension/src/background.js", "DEFAULT_MAX_CHAIN_CALLS"), expectedMaxChainCalls);
assert.equal(readConstNumber("extension/src/content.js", "DEFAULT_MAX_CHAIN_CALLS"), expectedMaxChainCalls);
assert.equal(readObjectNumber("extension/src/popup.js", "maxChainCalls"), expectedMaxChainCalls);
assert.equal(readObjectNumber("extension/src/background.js", "defaultTimeoutMs"), expectedIdleTimeoutMs);
assert.equal(readObjectNumber("extension/src/popup.js", "defaultTimeoutMs"), expectedIdleTimeoutMs);
assert.equal(readConstNumber("server/shell_server.js", "DEFAULT_TIMEOUT_MS"), expectedIdleTimeoutMs);
assert.equal(readObjectNumber("extension/src/background.js", "maxOutputChars"), expectedMaxOutputChars);
assert.equal(readObjectNumber("extension/src/popup.js", "maxOutputChars"), expectedMaxOutputChars);
assert.equal(readConstNumber("server/shell_server.js", "DEFAULT_MAX_OUTPUT_CHARS"), expectedMaxOutputChars);

verifyForwardedOutputLimits().then(() => console.log("default settings tests passed")).catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});

async function verifyForwardedOutputLimits() {
  const source = fs.readFileSync(path.join(rootDir, "extension/src/background.js"), "utf8");
  let settings = {};
  const forwarded = [];
  const context = {
    DEFAULT_SETTINGS: { maxOutputChars: readObjectNumber("extension/src/background.js", "maxOutputChars") },
    syncGet: async () => settings,
    isForceMessage: () => false,
    claimShellCall: async () => ({ seq: 1 }),
    requireShellServerReady: async () => {},
    runShellViaWebSocket: async (payload) => {
      forwarded.push(payload);
      return { ok: true };
    },
    markShellCall: async () => {},
    forwardShellRunProgress: () => {}
  };
  vm.createContext(context);
  for (const functionName of ["handleRunShellMessage", "handleRunBoardMessage"]) {
    const start = source.indexOf(`async function ${functionName}(`);
    const end = source.indexOf("\nasync function ", start + 1);
    assert.ok(start >= 0 && end > start, `Missing isolated handler ${functionName}`);
    vm.runInContext(source.slice(start, end), context);
    for (const [saved, explicit, expected] of [
      [undefined, undefined, expectedMaxOutputChars],
      [20000, undefined, 20000],
      [12345, undefined, 12345],
      [80000, 45678, 45678]
    ]) {
      settings = saved === undefined ? {} : { maxOutputChars: saved };
      await context[functionName]({ id: "output-default", cmd: "printf ok", maxOutputChars: explicit });
      assert.equal(forwarded.at(-1).maxOutputChars, expected,
        `${functionName} must use 80000 only when neither request nor saved setting specifies a limit.`);
    }
  }
}

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

function readConstNumber(relativePath, constName) {
  const source = fs.readFileSync(path.join(rootDir, relativePath), "utf8");
  const match = source.match(new RegExp(`const\\s+${constName}\\s*=\\s*(\\d+)`));
  assert.ok(match, `${constName} is missing in ${relativePath}`);
  return Number(match[1]);
}

function readObjectNumber(relativePath, key) {
  const source = fs.readFileSync(path.join(rootDir, relativePath), "utf8");
  const match = source.match(new RegExp(`${key}\\s*:\\s*(\\d+)`));
  assert.ok(match, `${key} is missing in ${relativePath}`);
  return Number(match[1]);
}
