#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.join(__dirname, "..");
const serverPath = path.join(repoRoot, "server", "shell_server.js");
const serverDir = path.dirname(serverPath);
const stateDir = path.join(repoRoot, ".state");
const ledgerPath = path.join(stateDir, "shell-ledger.json");
const source = fs.readFileSync(serverPath, "utf8");

const hadLedger = fs.existsSync(ledgerPath);
const ledgerBackup = hadLedger ? fs.readFileSync(ledgerPath, "utf8") : "";
fs.mkdirSync(stateDir, { recursive: true });

function writeLedger(calls) {
  fs.writeFileSync(ledgerPath, JSON.stringify({ version: 1, calls }, null, 2));
}

function loadServerContext() {
  const context = {
    Buffer,
    clearTimeout,
    console,
    module: { exports: {} },
    exports: {},
    process,
    require,
    setTimeout,
    __dirname: serverDir,
    __filename: serverPath
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "shell_server.js" });
  return context;
}

try {
  writeLedger({
    recent: { state: "completed", completedAt: Date.now() - 10_000 }
  });
  const recentContext = loadServerContext();
  const recentClaim = recentContext.claimServerShellCall("recent", {
    cmd: "echo recent",
    cwd: "/tmp",
    target: "%1",
    timeoutMs: 30000,
    callMeta: {}
  });
  assert.equal(recentClaim.action, "skip");
  assert.equal(recentClaim.reason, "recently-completed");

  writeLedger({
    stale: { state: "completed", completedAt: Date.now() - 61_000 }
  });
  const staleContext = loadServerContext();
  const staleClaim = staleContext.claimServerShellCall("stale", {
    cmd: "echo stale",
    cwd: "/tmp",
    target: "%2",
    timeoutMs: 30000,
    callMeta: {}
  });
  assert.equal(staleClaim.action, "run");

  writeLedger({
    forced: { state: "completed", completedAt: Date.now() - 5_000 }
  });
  const forcedContext = loadServerContext();
  const forcedClaim = forcedContext.claimServerShellCall("forced", {
    cmd: "echo force",
    cwd: "/tmp",
    target: "%3",
    timeoutMs: 30000,
    callMeta: { force: true }
  });
  assert.equal(forcedClaim.action, "run");
  const forcedLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(forcedLedger.calls.forced.state, "running");
  assert.equal(forcedLedger.calls.forced.forced, true);

  writeLedger({
    oldCompleted: { state: "completed", completedAt: Date.now() - (24 * 60 * 60 * 1000 + 1000) },
    freshCompleted: { state: "completed", completedAt: Date.now() - 1_000 }
  });
  loadServerContext();
  const prunedLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(Boolean(prunedLedger.calls.oldCompleted), false);
  assert.equal(Boolean(prunedLedger.calls.freshCompleted), true);

  console.log("server dedup force tests passed");
} finally {
  if (hadLedger) {
    fs.writeFileSync(ledgerPath, ledgerBackup);
  } else {
    fs.rmSync(ledgerPath, { force: true });
  }
}
