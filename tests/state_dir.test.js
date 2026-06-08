#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.join(__dirname, "..");
const serverPath = path.join(repoRoot, "server", "shell_server.js");
const serverDir = path.dirname(serverPath);
const source = fs.readFileSync(serverPath, "utf8");
const installScript = fs.readFileSync(path.join(repoRoot, "scripts", "install_shell_server_agent.sh"), "utf8");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-shell-state-dir-"));
const originalStateDir = process.env.AI_CHAT_SHELL_STATE_DIR;

try {
  assert.match(installScript, /Cleaning up any legacy LaunchAgent/);
  assert.match(installScript, /uninstall_shell_server_agent\.sh/);
  assert.match(installScript, /exec "\$SCRIPT_DIR\/start_shell_server\.sh"/);
  assert.doesNotMatch(installScript, /\$ROOT_DIR\/scripts\/start_shell_server\.sh/);
  assert.doesNotMatch(installScript, /RunAtLoad|KeepAlive|launchctl bootstrap|StandardOutPath|StandardErrorPath/);

  const expectedDefaultStateDir = path.join(repoRoot, ".state");
  const defaultContext = loadServerContext();
  assert.equal(defaultContext.getDefaultStateDir(), expectedDefaultStateDir);
  assert.equal(defaultContext.getStateDir(), expectedDefaultStateDir);
  assert.equal(defaultContext.getStateStatus({ create: false }).source, "project-root");

  const missingStateDir = path.join(tmpRoot, "missing-state");
  const missingContext = loadServerContext(missingStateDir);
  assert.equal(missingContext.getStateDir(), missingStateDir);
  const created = missingContext.getStateStatus({ create: true });
  assert.equal(created.ok, true);
  for (const subdir of ["tmux-runs", "board-panes", "vision", "bin"]) {
    assert.equal(fs.statSync(path.join(missingStateDir, subdir)).isDirectory(), true);
  }

  const stateFile = path.join(tmpRoot, "state-file");
  fs.writeFileSync(stateFile, "not a directory\n");
  const fileContext = loadServerContext(stateFile);
  const fileStatus = fileContext.getStateStatus({ create: true });
  assert.equal(fileStatus.ok, true);
  assert.equal(fileStatus.repaired, true);
  assert.equal(fs.statSync(stateFile).isDirectory(), true);
  assert.equal(findBrokenSiblings(stateFile, "state-path").length, 1);

  const subpathConflict = path.join(tmpRoot, "subpath-conflict");
  fs.mkdirSync(subpathConflict, { recursive: true });
  fs.writeFileSync(path.join(subpathConflict, "tmux-runs"), "not a directory\n");
  const subpathContext = loadServerContext(subpathConflict);
  const subpathStatus = subpathContext.getStateStatus({ create: true });
  assert.equal(subpathStatus.ok, true);
  assert.equal(subpathStatus.repaired, true);
  assert.equal(fs.statSync(path.join(subpathConflict, "tmux-runs")).isDirectory(), true);
  assert.equal(findBrokenSiblings(path.join(subpathConflict, "tmux-runs"), "state-subpath-tmux-runs").length, 1);

  const corruptLedgerDir = path.join(tmpRoot, "corrupt-ledger");
  fs.mkdirSync(corruptLedgerDir, { recursive: true });
  fs.writeFileSync(path.join(corruptLedgerDir, "shell-ledger.json"), "{not json");
  const corruptContext = loadServerContext(corruptLedgerDir);
  assert.equal(corruptContext.getStateStatus({ create: true }).ok, true);
  assert.equal(findBrokenSiblings(path.join(corruptLedgerDir, "shell-ledger.json"), "ledger").length, 1);
  const claim = corruptContext.claimServerShellCall("recover-ledger", {
    cmd: "echo recover",
    cwd: "/tmp",
    target: "%1",
    timeoutMs: 30000,
    callMeta: {}
  });
  assert.equal(claim.action, "run");
  const recoveredLedger = JSON.parse(fs.readFileSync(path.join(corruptLedgerDir, "shell-ledger.json"), "utf8"));
  assert.equal(recoveredLedger.calls["recover-ledger"].state, "running");

  const ledgerDirState = path.join(tmpRoot, "ledger-dir-state");
  const ledgerDirContext = loadServerContext(ledgerDirState);
  assert.equal(ledgerDirContext.getStateStatus({ create: true }).ok, true);
  fs.mkdirSync(path.join(ledgerDirState, "shell-ledger.json"), { recursive: true });
  const ledgerDirClaim = ledgerDirContext.claimServerShellCall("repair-ledger-dir", {
    cmd: "echo ledger dir",
    cwd: "/tmp",
    target: "%1",
    timeoutMs: 30000,
    callMeta: {}
  });
  assert.equal(ledgerDirClaim.action, "run");
  assert.equal(fs.statSync(path.join(ledgerDirState, "shell-ledger.json")).isFile(), true);
  assert.equal(findBrokenSiblings(path.join(ledgerDirState, "shell-ledger.json"), "ledger").length, 1);

  const logPathState = path.join(tmpRoot, "log-path-state");
  const logPathContext = loadServerContext(logPathState);
  assert.equal(logPathContext.getStateStatus({ create: true }).ok, true);
  const stdoutLogPath = path.join(logPathState, "shell-server.out.log");
  fs.mkdirSync(stdoutLogPath, { recursive: true });
  const logRepair = logPathContext.prepareStateLogFile(stdoutLogPath);
  assert.equal(logRepair.repairs.length, 1);
  assert.equal(fs.statSync(stdoutLogPath).isFile(), true);
  assert.equal(findBrokenSiblings(stdoutLogPath, "log-file").length, 1);
  fs.writeFileSync(stdoutLogPath, "stale log\n");
  const truncatedLog = logPathContext.prepareStateLogFile(stdoutLogPath, { truncate: true });
  assert.equal(truncatedLog.repairs.length, 0);
  assert.equal(fs.statSync(stdoutLogPath).size, 0);

  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    const lockedStateDir = path.join(tmpRoot, "locked-state");
    fs.mkdirSync(lockedStateDir, { recursive: true, mode: 0o500 });
    fs.chmodSync(lockedStateDir, 0o500);
    try {
      const lockedContext = loadServerContext(lockedStateDir);
      const lockedStatus = lockedContext.getStateStatus({ create: true });
      assert.equal(lockedStatus.ok, false);
      assert.match(lockedStatus.error, /not usable|permission|EACCES|EPERM/);
    } finally {
      fs.chmodSync(lockedStateDir, 0o700);
    }
  }

  console.log("state dir tests passed");
} finally {
  restoreEnv("AI_CHAT_SHELL_STATE_DIR", originalStateDir);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function loadServerContext(stateDir) {
  if (arguments.length === 0) {
    delete process.env.AI_CHAT_SHELL_STATE_DIR;
  } else {
    process.env.AI_CHAT_SHELL_STATE_DIR = stateDir;
  }
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

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function findBrokenSiblings(originalPath, reason) {
  const dir = path.dirname(originalPath);
  const base = path.basename(originalPath);
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith(`${base}.broken-${reason}-`));
}
