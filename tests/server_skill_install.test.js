#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MAX_SKILL_INSTALL_SCRIPT_BYTES,
  SKILL_INSTALL_IDLE_TIMEOUT_MS,
  SKILL_INSTALL_STATE_FILE,
  SkillCatalogService,
  runSkillInstallScript
} = require("../server/skill_catalog");

const temporaryPaths = [];

main()
  .then(() => console.log("server Skill install tests passed"))
  .finally(() => {
    for (const target of temporaryPaths.reverse()) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

async function main() {
  await testDefaultInstallSuccessAndInstalledOnlyCatalog();
  await testFailureMissingScriptStaleAndTimeoutStayUninstalled();
  await testSignalAndMissingExitCodeStayUninstalled();
  await testOutputIdleRunnerSemantics();
  await testConcurrentInstallRunsScriptOnce();
  await testChangesDuringInstallFailClosed();
  await testInstallerSnapshotAndChangeRaceFailClosed();
  await testDefaultRunnerExecutesSnapshotAndCleansIt();
  await testInstallerEnvironmentIsMinimal();
  await testConfiguredEnvironmentReachesInstallAndUninstallOnly();
  await testUninstallFailureAndMalformedEnvironmentFailClosed();
  await testSuccessfulUninstallCommitsAcrossSkillIdentityChanges();
  await testFailedUninstallCannotPreserveAChangedSkillIdentity();
  await testStateRefreshForAddDeleteModifyAndExternalJsonChanges();
  await testInvalidInventoryDoesNotEraseInstalledReceipts();
}

async function testDefaultInstallSuccessAndInstalledOnlyCatalog() {
  const fixture = makeFixture("skill-install-success-");
  const skill = writeSkill(fixture.root, "alpha", "Alpha routes alpha tasks.", "body alpha");
  writeInstaller(path.dirname(skill), "exit 0");
  const beta = writeSkill(fixture.root, "beta", "Beta remains unavailable until installed.", "body beta");
  writeInstaller(path.dirname(beta), "exit 0");
  let runs = 0;
  const service = makeService(fixture, async () => {
    runs += 1;
    return { code: 0, timedOut: false, stdout: "installed", stderr: "" };
  });

  const initialManagement = service.manage();
  assert.equal(initialManagement.ok, true, JSON.stringify(initialManagement.errors));
  assert.equal(initialManagement.skillCount, 0, "Discovered Skills are not installed by default.");
  assert.equal(initialManagement.discoveredSkillCount, 2);
  assert.deepEqual(initialManagement.skills.map((entry) => ({
    id: entry.id,
    installed: entry.installed,
    installAvailable: entry.installAvailable,
    installSha: entry.installSha
  })), initialManagement.skills.map((entry) => ({
    id: entry.id,
    installed: false,
    installAvailable: true,
    installSha: entry.installSha
  })));
  assert.match(initialManagement.skills[0].installSha, /^[a-f0-9]{64}$/);
  assert.deepEqual(service.list().skills, [], "Uninstalled Skills must not enter the AI catalog.");

  const statePath = path.join(fixture.stateDir, SKILL_INSTALL_STATE_FILE);
  const defaultState = readJson(statePath);
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600, "Installation state must be private to the local server user.");
  assert.equal(defaultState.skills.alpha.installed, false);
  assert.equal(defaultState.skills.beta.installed, false);
  assert.match(defaultState.skills.alpha.sha, /^[a-f0-9]{64}$/);

  const initialVersion = initialManagement.version;
  const initialSha = initialManagement.catalogSha;
  const installed = await service.install({
    skillId: "alpha",
    skillSha: initialManagement.skills[0].sha,
    installSha: initialManagement.skills[0].installSha,
    catalogSha: initialManagement.catalogSha
  });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(installed.exitCode, 0);
  assert.equal(installed.installerOutput, undefined, "Successful installer output must not enter any response.");
  assert.equal(installed.skill.installed, true);
  assert.equal(runs, 1);
  assert.equal(installed.catalogSha, initialSha, "Install status does not invent a second effective SHA.");
  assert.equal(installed.version, initialVersion + 1, "An installed-set change must advance the local version.");

  const mixedManagement = service.manage();
  assert.equal(mixedManagement.skills.length, mixedManagement.discoveredSkillCount,
    "View Skills management data must contain one row for every successfully discovered Skill.");
  assert.deepEqual(mixedManagement.skills.map((entry) => [entry.id, entry.installed]), [
    ["alpha", true],
    ["beta", false]
  ], "Installed is row metadata and must never filter uninstalled Skills out of View Skills.");

  const aiList = service.list();
  assert.equal(aiList.skillCount, 1);
  assert.deepEqual(aiList.skills, [{
    id: "alpha",
    name: "alpha",
    description: "Alpha routes alpha tasks.",
    sha: initialManagement.skills[0].sha
  }]);
  const uninstalledLoad = service.load({
    skillId: "beta",
    catalogSha: aiList.catalogSha
  });
  assert.equal(uninstalledLoad.ok, false);
  assert.equal(uninstalledLoad.errorCode, "skill-not-installed", "An uninstalled Skill in a mixed catalog must not be loadable.");
  assert.equal(readJson(statePath).skills.alpha.installed, true);
  assert.equal(readJson(statePath).skills.alpha.installSha, initialManagement.skills[0].installSha);
  assert.match(readJson(statePath).skills.alpha.receipt, /^[a-f0-9]{64}$/);

  const repeated = await service.install({
    skillId: "alpha",
    skillSha: initialManagement.skills[0].sha,
    installSha: initialManagement.skills[0].installSha,
    catalogSha: initialManagement.catalogSha
  });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.alreadyInstalled, true);
  assert.equal(repeated.version, installed.version);
  assert.equal(runs, 1, "An exact installed Skill must be idempotent without rerunning install.sh.");
}

async function testFailureMissingScriptStaleAndTimeoutStayUninstalled() {
  const fixture = makeFixture("skill-install-negative-");
  const alpha = writeSkill(fixture.root, "alpha", "Alpha", "body");
  writeInstaller(path.dirname(alpha), "exit 9");
  writeSkill(fixture.root, "missing", "Missing installer", "body");
  const linked = writeSkill(fixture.root, "linked", "Symlink installer", "body");
  fs.symlinkSync(path.join(path.dirname(alpha), "install.sh"), path.join(path.dirname(linked), "install.sh"));
  const oversized = writeSkill(fixture.root, "oversized", "Oversized installer", "body");
  fs.writeFileSync(path.join(path.dirname(oversized), "install.sh"), Buffer.alloc(MAX_SKILL_INSTALL_SCRIPT_BYTES + 1, 0x78));
  const service = makeService(fixture, async () => ({ code: 9, timedOut: false, stdout: "fake success", stderr: "/private/path must stay local" }));
  const management = service.manage();
  const alphaRecord = management.skills.find((entry) => entry.id === "alpha");
  const missingRecord = management.skills.find((entry) => entry.id === "missing");
  const linkedRecord = management.skills.find((entry) => entry.id === "linked");
  const oversizedRecord = management.skills.find((entry) => entry.id === "oversized");
  assert.equal(linkedRecord.installAvailable, false, "Symlinked installers must never become clickable.");
  assert.equal(oversizedRecord.installAvailable, false, "Oversized installers must never become clickable.");

  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  let failed;
  try {
    failed = await service.install({
      skillId: alphaRecord.id,
      skillSha: alphaRecord.sha,
      installSha: alphaRecord.installSha,
      catalogSha: management.catalogSha
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, "installer-failed");
  assert.equal(failed.exitCode, 9);
  assert.equal(failed.installerOutput.stderr, "/private/path must stay local");
  assert.equal(failed.installerOutput.stdout, "fake success");
  assert.equal(failed.installerOutput.stderrTruncated, false);
  assert.equal(failed.installerOutput.stdoutTruncated, false);
  assert.ok(!logged.join("\n").includes("/private/path"), "Installer stderr must not enter shell-server logs.");
  assert.equal(service.list().skillCount, 0);

  const missing = await service.install({
    skillId: missingRecord.id,
    skillSha: missingRecord.sha,
    catalogSha: management.catalogSha
  });
  assert.equal(missing.errorCode, "install-script-unavailable");
  assert.equal((await service.install({
    skillId: linkedRecord.id,
    skillSha: linkedRecord.sha,
    catalogSha: management.catalogSha
  })).errorCode, "install-script-unavailable");
  assert.equal((await service.install({
    skillId: oversizedRecord.id,
    skillSha: oversizedRecord.sha,
    catalogSha: management.catalogSha
  })).errorCode, "install-script-unavailable");
  const staleSkill = await service.install({
    skillId: alphaRecord.id,
    skillSha: "0".repeat(64),
    installSha: alphaRecord.installSha,
    catalogSha: management.catalogSha
  });
  assert.equal(staleSkill.errorCode, "stale-skill");
  const staleCatalog = await service.install({
    skillId: alphaRecord.id,
    skillSha: alphaRecord.sha,
    installSha: alphaRecord.installSha,
    catalogSha: "1".repeat(64)
  });
  assert.equal(staleCatalog.errorCode, "stale-catalog");

  writeInstaller(path.dirname(alpha), "exit 10");
  const staleInstaller = await service.install({
    skillId: alphaRecord.id,
    skillSha: alphaRecord.sha,
    installSha: alphaRecord.installSha,
    catalogSha: management.catalogSha
  });
  assert.equal(staleInstaller.errorCode, "stale-installer");

  const timeoutService = makeService(fixture, async () => ({ code: null, timedOut: true, stdout: "", stderr: "" }));
  const timeoutManagement = timeoutService.manage();
  const timeoutRecord = timeoutManagement.skills.find((entry) => entry.id === "alpha");
  const timedOut = await timeoutService.install({
    skillId: timeoutRecord.id,
    skillSha: timeoutRecord.sha,
    installSha: timeoutRecord.installSha,
    catalogSha: timeoutManagement.catalogSha
  });
  assert.equal(timedOut.errorCode, "installer-timeout");
  assert.equal(timedOut.idleTimeoutSeconds, 600);
  assert.match(timedOut.error, /no stdout or stderr for 600 seconds/i);
  assert.equal(timeoutService.list().skillCount, 0);
}

async function testSignalAndMissingExitCodeStayUninstalled() {
  for (const result of [
    { code: null, signal: "SIGTERM", timedOut: false, stdout: "before signal", stderr: "terminated" },
    { code: 0, signal: "SIGKILL", timedOut: false, stdout: "", stderr: "killed" },
    { code: null, signal: "", timedOut: false, stdout: "", stderr: "missing exit" }
  ]) {
    const fixture = makeFixture("skill-install-signal-");
    const skillPath = writeSkill(fixture.root, "signal-test", "Signal test", "body");
    writeInstaller(path.dirname(skillPath), "exit 0");
    const service = makeService(fixture, async () => result);
    const management = service.manage();
    const record = management.skills[0];
    const installed = await service.install({
      skillId: record.id,
      skillSha: record.sha,
      installSha: record.installSha,
      catalogSha: management.catalogSha
    });
    assert.equal(installed.ok, false, `Result ${JSON.stringify(result)} must fail closed.`);
    assert.equal(installed.errorCode, result.signal ? "installer-signaled" : "installer-failed");
    assert.equal(service.manage().skills[0].installed, false);
    assert.equal(service.list().skillCount, 0, "A signaled or indeterminate installer must never enter the AI catalog.");
  }
}

async function testOutputIdleRunnerSemantics() {
  assert.equal(SKILL_INSTALL_IDLE_TIMEOUT_MS, 600_000);
  const fixture = makeFixture("skill-install-idle-runner-");
  const skillDir = path.join(fixture.root, "runner");
  fs.mkdirSync(skillDir, { recursive: true });
  const scriptPath = path.join(skillDir, "runner.sh");

  fs.writeFileSync(scriptPath, [
    "printf 'stdout-1'",
    "sleep 0.1",
    "printf 'stderr-1' >&2",
    "sleep 0.1",
    "printf 'stdout-2'",
    "sleep 0.1",
    "exit 0"
  ].join("\n"));
  let result = await runSkillInstallScript({
    scriptPath,
    skillDir,
    env: { PATH: process.env.PATH || "/usr/bin:/bin" },
    idleTimeoutMs: 250,
    maxOutputChars: 100
  });
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.idleTimedOut, false, "Alternating stdout/stderr activity must reset one shared idle clock.");
  assert.equal(result.stdout, "stdout-1stdout-2");
  assert.equal(result.stderr, "stderr-1");

  fs.writeFileSync(scriptPath, [
    "printf '0123456789ABCDEFGHIJ'",
    "sleep 0.1",
    "printf 'tail-one'",
    "sleep 0.1",
    "printf 'tail-two'",
    "sleep 0.1",
    "exit 0"
  ].join("\n"));
  result = await runSkillInstallScript({
    scriptPath,
    skillDir,
    env: { PATH: process.env.PATH || "/usr/bin:/bin" },
    idleTimeoutMs: 250,
    maxOutputChars: 12
  });
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.idleTimedOut, false, "Output must reset the idle clock after the capture buffer is already full.");
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stdout, "-onetail-two", "Bounded diagnostics should preserve the most useful output tail.");

  fs.writeFileSync(scriptPath, "printf 'before-idle'; sleep 0.4; printf 'too-late'");
  const timeoutStartedAt = Date.now();
  result = await runSkillInstallScript({
    scriptPath,
    skillDir,
    env: { PATH: process.env.PATH || "/usr/bin:/bin" },
    idleTimeoutMs: 80,
    maxOutputChars: 100
  });
  assert.equal(result.idleTimedOut, true);
  assert.ok(Date.now() - timeoutStartedAt < 1_500, "An idle-killed installer must settle within a bounded grace period.");
  assert.match(result.stdout, /before-idle/);

  fs.writeFileSync(scriptPath, "printf 'before-signal'; kill -TERM $$");
  result = await runSkillInstallScript({
    scriptPath,
    skillDir,
    env: { PATH: process.env.PATH || "/usr/bin:/bin" },
    idleTimeoutMs: 500,
    maxOutputChars: 100
  });
  assert.equal(result.code, null);
  assert.equal(result.signal, "SIGTERM", "The real runner must preserve signal termination instead of coercing it to exit 0.");
  assert.equal(result.idleTimedOut, false);

  fs.writeFileSync(scriptPath, "(while :; do printf 'descendant-output'; sleep 0.03; done) &\nexit 0\n");
  const descendantStartedAt = Date.now();
  result = await runSkillInstallScript({
    scriptPath,
    skillDir,
    env: { PATH: process.env.PATH || "/usr/bin:/bin" },
    idleTimeoutMs: 80,
    maxOutputChars: 100
  });
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.idleTimedOut, false);
  assert.ok(Date.now() - descendantStartedAt < 1_500,
    "A descendant holding inherited stdio must not permanently block the serialized install queue after the installer shell exits.");
}

async function testConcurrentInstallRunsScriptOnce() {
  const fixture = makeFixture("skill-install-concurrent-");
  const skillPath = writeSkill(fixture.root, "race", "Race", "body");
  writeInstaller(path.dirname(skillPath), "exit 0");
  let runs = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const service = makeService(fixture, async () => {
    runs += 1;
    await gate;
    return { code: 0, timedOut: false, stdout: "", stderr: "" };
  });
  const record = service.manage().skills[0];
  const request = {
    skillId: record.id,
    skillSha: record.sha,
    installSha: record.installSha,
    catalogSha: service.manage().catalogSha
  };
  const first = service.install(request);
  const second = service.install(request);
  await Promise.resolve();
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.alreadyInstalled, true);
  assert.equal(runs, 1, "Double-click or multi-tab concurrency must launch one installer.");
}

async function testChangesDuringInstallFailClosed() {
  const fixture = makeFixture("skill-install-change-race-");
  const skillPath = writeSkill(fixture.root, "changing", "Changing", "revision one");
  writeInstaller(path.dirname(skillPath), "exit 0");
  let release;
  let started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const startedGate = new Promise((resolve) => {
    started = resolve;
  });
  const service = makeService(fixture, async () => {
    started();
    await gate;
    return { code: 0, timedOut: false, stdout: "", stderr: "" };
  });
  const management = service.manage();
  const record = management.skills[0];
  const pending = service.install({
    skillId: record.id,
    skillSha: record.sha,
    installSha: record.installSha,
    catalogSha: management.catalogSha
  });
  await startedGate;
  fs.appendFileSync(skillPath, "\nrevision two");
  release();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "skill-changed-during-install");
  assert.equal(service.list().skillCount, 0);
}

async function testInstallerSnapshotAndChangeRaceFailClosed() {
  const fixture = makeFixture("skill-install-script-race-");
  const skillPath = writeSkill(fixture.root, "snapshot", "Snapshot", "body");
  const skillDir = path.dirname(skillPath);
  const sourceInstaller = path.join(skillDir, "install.sh");
  writeInstaller(skillDir, "printf original");
  const originalInstaller = fs.readFileSync(sourceInstaller, "utf8");
  let release;
  let started;
  let executionPath = "";
  const gate = new Promise((resolve) => { release = resolve; });
  const startedGate = new Promise((resolve) => { started = resolve; });
  const service = makeService(fixture, async ({ scriptPath }) => {
    executionPath = scriptPath;
    assert.notEqual(scriptPath, sourceInstaller, "Installer execution must use a private immutable snapshot.");
    assert.equal(fs.readFileSync(scriptPath, "utf8"), originalInstaller);
    started();
    await gate;
    assert.equal(fs.readFileSync(scriptPath, "utf8"), originalInstaller, "Source replacement must not alter the executable snapshot.");
    return { code: 0, timedOut: false, stdout: "", stderr: "" };
  });
  const management = service.manage();
  const record = management.skills[0];
  const pending = service.install({
    skillId: record.id,
    skillSha: record.sha,
    installSha: record.installSha,
    catalogSha: management.catalogSha
  });
  await startedGate;
  writeInstaller(skillDir, "printf replaced");
  release();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "skill-changed-during-install", "A post-run installer-SHA change must fail closed.");
  assert.equal(service.list().skillCount, 0);
  assert.equal(fs.existsSync(executionPath), false, "Private installer snapshots must be removed after execution.");
}

async function testInstallerEnvironmentIsMinimal() {
  const fixture = makeFixture("skill-install-env-");
  const skillPath = writeSkill(fixture.root, "environment", "Environment", "body");
  writeInstaller(path.dirname(skillPath), "exit 0");
  let receivedEnv;
  const service = new SkillCatalogService({
    stateDir: fixture.stateDir,
    env: {
      AI_HELPER_SKILL_PATHS: fixture.root,
      HOME: fixture.root,
      PATH: "/test/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      SECRET_TOKEN: "must-not-leak",
      AWS_SECRET_ACCESS_KEY: "must-not-leak-either"
    },
    cwd: fixture.root,
    homeDir: fixture.root,
    cacheMs: 0,
    runInstallScript: async ({ env }) => {
      receivedEnv = env;
      return { code: 0, timedOut: false, stdout: "", stderr: "" };
    }
  });
  const management = service.manage();
  const record = management.skills[0];
  const result = await service.install({
    skillId: record.id,
    skillSha: record.sha,
    installSha: record.installSha,
    catalogSha: management.catalogSha
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(receivedEnv.HOME, fixture.root);
  assert.equal(receivedEnv.PATH, "/test/bin:/usr/bin:/bin");
  assert.equal(receivedEnv.LANG, "C.UTF-8");
  assert.equal(Object.prototype.hasOwnProperty.call(receivedEnv, "SECRET_TOKEN"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(receivedEnv, "AWS_SECRET_ACCESS_KEY"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(receivedEnv, "AI_HELPER_SKILL_PATHS"), false);
}

async function testConfiguredEnvironmentReachesInstallAndUninstallOnly() {
  const fixture = makeFixture("skill-lifecycle-env-");
  const skillPath = writeSkill(fixture.root, "environment-lifecycle", "Environment lifecycle", "body");
  const skillDir = path.dirname(skillPath);
  writeInstaller(skillDir, "printf '%s' \"$SKILL_LIFECYCLE_VALUE\" > install-env.txt");
  writeUninstaller(skillDir, "printf '%s' \"$SKILL_LIFECYCLE_VALUE\" > uninstall-env.txt");
  const envPath = path.join(fixture.root, "lifecycle.env");
  fs.writeFileSync(envPath, "SKILL_LIFECYCLE_VALUE=from configured file\n", { mode: 0o600 });
  const service = new SkillCatalogService({
    stateDir: fixture.stateDir,
    env: {
      AI_HELPER_SKILL_PATHS: fixture.root,
      AI_CHAT_SHELL_ENV_FILE: envPath,
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: fixture.root,
      SERVER_ONLY_SECRET: "must-not-leak"
    },
    cwd: fixture.root,
    homeDir: fixture.root,
    cacheMs: 0
  });

  let management = service.manage();
  const initial = management.skills.find((entry) => entry.id === "environment-lifecycle");
  assert.equal(initial.installAvailable, true);
  assert.equal(initial.uninstallAvailable, true);
  assert.match(initial.uninstallSha, /^[a-f0-9]{64}$/);
  const installed = await service.install({
    skillId: initial.id,
    skillSha: initial.sha,
    installSha: initial.installSha,
    catalogSha: management.catalogSha
  });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(fs.readFileSync(path.join(skillDir, "install-env.txt"), "utf8"), "from configured file");

  fs.writeFileSync(envPath, "SKILL_LIFECYCLE_VALUE=fresh uninstall value\n", { mode: 0o600 });
  management = service.manage();
  const current = management.skills.find((entry) => entry.id === initial.id);
  assert.equal(current.installed, true);
  const uninstalled = await service.uninstall({
    skillId: current.id,
    skillSha: current.sha,
    uninstallSha: current.uninstallSha,
    catalogSha: management.catalogSha
  });
  assert.equal(uninstalled.ok, true, JSON.stringify(uninstalled));
  assert.equal(uninstalled.skill.installed, false);
  assert.equal(fs.readFileSync(path.join(skillDir, "uninstall-env.txt"), "utf8"), "fresh uninstall value",
    "Uninstall must reread the configured environment file instead of reusing the install snapshot.");
  assert.equal(service.list().skills.length, 0, "Successfully uninstalled Skills must immediately leave the AI catalog.");
  assert.equal(readJson(path.join(fixture.stateDir, SKILL_INSTALL_STATE_FILE)).skills[current.id].installed, false);
  assert.deepEqual(fs.readdirSync(fixture.stateDir).filter((name) => /skill-(?:install|uninstall)-run-/.test(name)), [],
    "Install and uninstall snapshots must both be removed.");
}

async function testUninstallFailureAndMalformedEnvironmentFailClosed() {
  const fixture = makeFixture("skill-uninstall-negative-");
  const skillPath = writeSkill(fixture.root, "negative-lifecycle", "Negative lifecycle", "body");
  const skillDir = path.dirname(skillPath);
  writeInstaller(skillDir, "exit 0");
  writeUninstaller(skillDir, "exit 17");
  const envPath = path.join(fixture.root, "negative.env");
  fs.writeFileSync(envPath, "VISIBLE_TO_SCRIPT=ok\n", { mode: 0o600 });
  let uninstallShouldFail = true;
  let executions = 0;
  const service = new SkillCatalogService({
    stateDir: fixture.stateDir,
    env: {
      AI_HELPER_SKILL_PATHS: fixture.root,
      AI_CHAT_SHELL_ENV_FILE: envPath,
      PATH: process.env.PATH || "/usr/bin:/bin",
      SERVER_ONLY_SECRET: "must-not-leak"
    },
    cwd: fixture.root,
    homeDir: fixture.root,
    cacheMs: 0,
    runInstallScript: async ({ scriptPath, env }) => {
      executions += 1;
      assert.equal(env.VISIBLE_TO_SCRIPT, "ok");
      assert.equal(Object.prototype.hasOwnProperty.call(env, "SERVER_ONLY_SECRET"), false);
      if (path.basename(scriptPath) === "uninstall.sh" && uninstallShouldFail) {
        return { code: 17, timedOut: false, stdout: "local uninstall stdout", stderr: "local uninstall stderr" };
      }
      return { code: 0, timedOut: false, stdout: "", stderr: "" };
    }
  });
  let management = service.manage();
  let record = management.skills[0];
  assert.equal((await service.install({
    skillId: record.id,
    skillSha: record.sha,
    installSha: record.installSha,
    catalogSha: management.catalogSha
  })).ok, true);

  management = service.manage();
  record = management.skills[0];
  const failed = await service.uninstall({
    skillId: record.id,
    skillSha: record.sha,
    uninstallSha: record.uninstallSha,
    catalogSha: management.catalogSha
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, "uninstaller-failed");
  assert.equal(failed.exitCode, 17);
  assert.equal(failed.installerOutput.stderr, "local uninstall stderr");
  assert.equal(service.manage().skills[0].installed, true, "A failed uninstaller must keep the Skill installed.");

  uninstallShouldFail = false;
  fs.writeFileSync(envPath, "ENV_SECRET_MUST_NOT_LEAK\n", { mode: 0o600 });
  const executionsBeforeMalformed = executions;
  management = service.manage();
  record = management.skills[0];
  const malformed = await service.uninstall({
    skillId: record.id,
    skillSha: record.sha,
    uninstallSha: record.uninstallSha,
    catalogSha: management.catalogSha
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.errorCode, "uninstaller-launch-failed");
  assert.ok(!JSON.stringify(malformed).includes("ENV_SECRET_MUST_NOT_LEAK"));
  assert.equal(executions, executionsBeforeMalformed, "Malformed environment files must fail before spawning the uninstaller.");
  assert.equal(service.manage().skills[0].installed, true);

  fs.rmSync(path.join(skillDir, "uninstall.sh"));
  delete service.env.AI_CHAT_SHELL_ENV_FILE;
  management = service.manage();
  record = management.skills[0];
  assert.equal(record.uninstallAvailable, false);
  assert.equal((await service.uninstall({
    skillId: record.id,
    skillSha: record.sha,
    catalogSha: management.catalogSha
  })).errorCode, "uninstall-script-unavailable");
}

async function testSuccessfulUninstallCommitsAcrossSkillIdentityChanges() {
  for (const changedFile of ["SKILL.md", "install.sh"]) {
    const fixture = makeFixture(`skill-uninstall-change-${changedFile.toLowerCase().replace(/\W/g, "-")}-`);
    const skillPath = writeSkill(fixture.root, "changing-lifecycle", "Changing lifecycle", "body");
    const skillDir = path.dirname(skillPath);
    writeInstaller(skillDir, "exit 0");
    writeUninstaller(skillDir, "exit 0");
    let executions = 0;
    const service = makeService(fixture, async () => {
      executions += 1;
      if (executions === 2) {
        if (changedFile === "SKILL.md") {
          fs.appendFileSync(skillPath, "\nchanged during uninstall");
        } else {
          writeInstaller(skillDir, "printf changed-during-uninstall; exit 0");
        }
      }
      return { code: 0, timedOut: false, stdout: "", stderr: "" };
    });

    let management = service.manage();
    let record = management.skills[0];
    assert.equal((await service.install({
      skillId: record.id,
      skillSha: record.sha,
      installSha: record.installSha,
      catalogSha: management.catalogSha
    })).ok, true);

    management = service.manage();
    record = management.skills[0];
    const result = await service.uninstall({
      skillId: record.id,
      skillSha: record.sha,
      uninstallSha: record.uninstallSha,
      catalogSha: management.catalogSha
    });
    assert.equal(result.ok, true, `${changedFile} changes after a successful immutable uninstaller must not produce a false failure.`);
    assert.equal(result.skill.installed, false);
    assert.equal(service.manage().skills[0].installed, false);
    assert.equal(service.list().skills.length, 0, "A successful uninstall must atomically remove even a changed Skill identity from the AI catalog.");
    assert.equal(readJson(path.join(fixture.stateDir, SKILL_INSTALL_STATE_FILE)).skills[record.id].installed, false);
  }
}

async function testFailedUninstallCannotPreserveAChangedSkillIdentity() {
  for (const changedFile of ["SKILL.md", "install.sh"]) {
    const fixture = makeFixture(`skill-uninstall-failed-change-${changedFile.toLowerCase().replace(/\W/g, "-")}-`);
    const skillPath = writeSkill(fixture.root, "failed-changing-lifecycle", "Failed changing lifecycle", "body");
    const skillDir = path.dirname(skillPath);
    writeInstaller(skillDir, "exit 0");
    writeUninstaller(skillDir, "exit 23");
    let executions = 0;
    const service = makeService(fixture, async () => {
      executions += 1;
      if (executions === 2) {
        if (changedFile === "SKILL.md") {
          fs.appendFileSync(skillPath, "\nchanged before failed exit");
        } else {
          writeInstaller(skillDir, "printf changed-before-failed-exit; exit 0");
        }
        return { code: 23, timedOut: false, stdout: "", stderr: "failed after changing identity" };
      }
      return { code: 0, timedOut: false, stdout: "", stderr: "" };
    });

    let management = service.manage();
    let record = management.skills[0];
    assert.equal((await service.install({
      skillId: record.id,
      skillSha: record.sha,
      installSha: record.installSha,
      catalogSha: management.catalogSha
    })).ok, true);

    management = service.manage();
    record = management.skills[0];
    const result = await service.uninstall({
      skillId: record.id,
      skillSha: record.sha,
      uninstallSha: record.uninstallSha,
      catalogSha: management.catalogSha
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "uninstaller-failed");
    assert.equal(readJson(path.join(fixture.stateDir, SKILL_INSTALL_STATE_FILE)).skills[record.id].installed, true,
      "A failed uninstaller must not proactively clear the prior receipt before reconciliation.");
    assert.equal(service.manage().skills[0].installed, false,
      `A failed uninstaller cannot transfer the old installation receipt to a changed ${changedFile} identity.`);
    assert.equal(service.list().skills.length, 0);
  }
}

async function testDefaultRunnerExecutesSnapshotAndCleansIt() {
  const fixture = makeFixture("skill-install-default-runner-");
  const skillPath = writeSkill(fixture.root, "default-runner", "Default runner", "body");
  const skillDir = path.dirname(skillPath);
  writeInstaller(skillDir, "printf installed > installed-by-snapshot.txt");
  const service = makeService(fixture);
  const management = service.manage();
  const record = management.skills[0];
  const result = await service.install({
    skillId: record.id,
    skillSha: record.sha,
    installSha: record.installSha,
    catalogSha: management.catalogSha
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(skillDir, "installed-by-snapshot.txt"), "utf8"), "installed");
  assert.deepEqual(fs.readdirSync(fixture.stateDir).filter((name) => name.startsWith("skill-install-run-")), [],
    "The real /bin/sh runner must not leave executable snapshots behind.");
}

async function testStateRefreshForAddDeleteModifyAndExternalJsonChanges() {
  const fixture = makeFixture("skill-install-refresh-");
  const alphaPath = writeSkill(fixture.root, "alpha", "Alpha", "body");
  writeInstaller(path.dirname(alphaPath), "exit 0");
  const service = makeService(fixture, async () => ({ code: 0, timedOut: false, stdout: "", stderr: "" }));
  let management = service.manage();
  const statePath = path.join(fixture.stateDir, SKILL_INSTALL_STATE_FILE);
  const initialVersion = management.version;

  const betaPath = writeSkill(fixture.root, "beta", "Beta", "body");
  writeInstaller(path.dirname(betaPath), "exit 0");
  management = service.manage();
  let state = readJson(statePath);
  assert.deepEqual(Object.keys(state.skills), ["alpha", "beta"]);
  assert.equal(state.skills.beta.installed, false, "A newly discovered Skill must be added to JSON as uninstalled.");
  assert.equal(management.version, initialVersion + 1);

  state.updatedAt = new Date(Date.now() + 1000).toISOString();
  fs.writeFileSync(statePath, `${JSON.stringify({ updatedAt: state.updatedAt, skills: state.skills, schemaVersion: state.schemaVersion }, null, 2)}\n`);
  assert.equal(service.manage().version, management.version, "Formatting, field order, and updatedAt-only changes must not create a false update.");

  const alphaRecord = management.skills.find((entry) => entry.id === "alpha");
  const installed = await service.install({
    skillId: alphaRecord.id,
    skillSha: alphaRecord.sha,
    installSha: alphaRecord.installSha,
    catalogSha: management.catalogSha
  });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  management = service.manage();
  assert.equal(management.skills.find((entry) => entry.id === "alpha").installed, true);

  state = readJson(statePath);
  state.skills.beta.installed = true;
  state.skills.beta.installedAt = new Date().toISOString();
  state.skills.beta.receipt = "e".repeat(64);
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const spoofRejected = service.manage();
  assert.equal(spoofRejected.skills.find((entry) => entry.id === "beta").installed, false,
    "External JSON edits without a server-owned successful-install receipt must fail closed.");
  assert.equal(spoofRejected.skills.find((entry) => entry.id === "alpha").installed, true,
    "Rejecting a spoofed record must not erase another Skill's valid receipt.");
  assert.equal(spoofRejected.version, management.version + 1,
    "A meaningful installed-state spoof must advance the version once while being repaired.");
  management = spoofRejected;

  const oldInstallSha = management.skills.find((entry) => entry.id === "alpha").installSha;
  writeInstaller(path.dirname(alphaPath), "printf changed-installer; exit 0");
  const installerChanged = service.manage();
  assert.equal(installerChanged.skills.find((entry) => entry.id === "alpha").installed, false,
    "An install.sh SHA change must invalidate its prior successful installation proof.");
  assert.notEqual(installerChanged.skills.find((entry) => entry.id === "alpha").installSha, oldInstallSha);
  assert.equal(installerChanged.version, management.version + 1);

  fs.appendFileSync(alphaPath, "\nchanged");
  const modified = service.manage();
  assert.equal(modified.skills.find((entry) => entry.id === "alpha").installed, false, "A changed SKILL.md SHA must reset installed state.");
  assert.equal(readJson(statePath).skills.alpha.installed, false);

  const tamperedState = readJson(statePath);
  tamperedState.skills.alpha.sha = "f".repeat(64);
  fs.writeFileSync(statePath, `${JSON.stringify(tamperedState, null, 2)}\n`);
  const repairedMismatch = service.manage();
  assert.equal(repairedMismatch.version, modified.version + 1, "A meaningful record-SHA change in installation JSON must advance the version once.");
  assert.equal(readJson(statePath).skills.alpha.installed, false);
  assert.notEqual(readJson(statePath).skills.alpha.sha, "f".repeat(64));

  fs.rmSync(path.dirname(betaPath), { recursive: true, force: true });
  service.manage();
  assert.deepEqual(Object.keys(readJson(statePath).skills), ["alpha"], "Deleted Skills must be removed from installation JSON.");

  fs.writeFileSync(statePath, "{broken");
  const repaired = service.manage();
  assert.equal(repaired.skillCount, 0);
  assert.equal(readJson(statePath).schemaVersion, 2);
  assert.equal(readJson(statePath).skills.alpha.installed, false);
}

async function testInvalidInventoryDoesNotEraseInstalledReceipts() {
  const fixture = makeFixture("skill-install-invalid-inventory-");
  const skillPath = writeSkill(fixture.root, "durable", "Durable installed Skill", "body");
  writeInstaller(path.dirname(skillPath), "exit 0");
  const service = makeService(fixture, async () => ({
    code: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: ""
  }));
  const initial = service.manage();
  const record = initial.skills[0];
  const installed = await service.install({
    skillId: record.id,
    skillSha: record.sha,
    installSha: record.installSha,
    catalogSha: initial.catalogSha
  });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  const installedVersion = installed.version;
  const installStatePath = path.join(fixture.stateDir, SKILL_INSTALL_STATE_FILE);
  const catalogStatePath = path.join(fixture.stateDir, "skill-catalog-state.json");
  const installStateBefore = fs.readFileSync(installStatePath, "utf8");
  const catalogStateBefore = fs.readFileSync(catalogStatePath, "utf8");

  const malformedDir = path.join(fixture.root, "malformed");
  fs.mkdirSync(malformedDir);
  fs.writeFileSync(path.join(malformedDir, "SKILL.md"), "---\nname: malformed\n---\nbody\n");
  const partial = service.manage();
  assert.equal(partial.ok, false);
  assert.equal(partial.skills.find((skill) => skill.id === "durable")?.installed, true,
    "A valid installed row may remain visible read-only while another Skill makes the inventory invalid.");
  assert.equal(fs.readFileSync(installStatePath, "utf8"), installStateBefore,
    "A partial invalid scan must not rewrite authenticated installation receipts.");
  assert.equal(fs.readFileSync(catalogStatePath, "utf8"), catalogStateBefore,
    "A partial invalid scan must not replace the last authoritative catalog state.");
  fs.rmSync(malformedDir, { recursive: true, force: true });
  let recovered = service.manage();
  assert.equal(recovered.skills.find((skill) => skill.id === "durable")?.installed, true);
  assert.equal(recovered.version, installedVersion,
    "Recovery to the exact last authoritative inventory must not invent a catalog version.");

  const offlineRoot = `${fixture.root}-offline`;
  fs.renameSync(fixture.root, offlineRoot);
  try {
    const unavailable = service.manage();
    assert.equal(unavailable.ok, false);
    assert.ok(unavailable.errors.some((error) => error.code === "skill-root-missing"));
    assert.deepEqual(unavailable.skills, []);
    assert.equal(fs.readFileSync(installStatePath, "utf8"), installStateBefore,
      "A temporarily unavailable explicit root must not erase installed receipts.");
    assert.equal(fs.readFileSync(catalogStatePath, "utf8"), catalogStateBefore,
      "A temporarily unavailable explicit root must not replace the last authoritative catalog state.");
  } finally {
    fs.renameSync(offlineRoot, fixture.root);
  }
  recovered = service.manage();
  assert.equal(recovered.skills.find((skill) => skill.id === "durable")?.installed, true,
    "View Skills must recover the installed row when the configured root returns.");
  assert.equal(recovered.version, installedVersion);

  const defaultHome = makeTempDir("skill-install-default-home-");
  const defaultRoot = path.join(defaultHome, ".claude", "skills");
  const defaultStateDir = makeTempDir("skill-install-default-state-");
  const defaultSkillPath = writeSkill(defaultRoot, "default-durable", "Default-root installed Skill", "body");
  writeInstaller(path.dirname(defaultSkillPath), "exit 0");
  const defaultService = new SkillCatalogService({
    stateDir: defaultStateDir,
    env: {},
    cwd: defaultHome,
    homeDir: defaultHome,
    cacheMs: 0,
    runInstallScript: async () => ({
      code: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: ""
    })
  });
  const defaultInitial = defaultService.manage();
  const defaultRecord = defaultInitial.skills[0];
  const defaultInstalled = await defaultService.install({
    skillId: defaultRecord.id,
    skillSha: defaultRecord.sha,
    installSha: defaultRecord.installSha,
    catalogSha: defaultInitial.catalogSha
  });
  assert.equal(defaultInstalled.ok, true, JSON.stringify(defaultInstalled));
  const defaultInstalledVersion = defaultInstalled.version;
  const defaultInstallStatePath = path.join(defaultStateDir, SKILL_INSTALL_STATE_FILE);
  const defaultCatalogStatePath = path.join(defaultStateDir, "skill-catalog-state.json");
  const defaultInstallStateBefore = fs.readFileSync(defaultInstallStatePath, "utf8");
  const defaultCatalogStateBefore = fs.readFileSync(defaultCatalogStatePath, "utf8");
  const offlineDefaultRoot = `${defaultRoot}-offline`;
  fs.renameSync(defaultRoot, offlineDefaultRoot);
  try {
    const unavailableDefault = defaultService.manage();
    assert.equal(unavailableDefault.ok, false,
      "A default root that previously contained persisted Skills must fail closed while missing.");
    assert.ok(unavailableDefault.errors.some((error) => error.code === "skill-root-missing"));
    assert.equal(fs.readFileSync(defaultInstallStatePath, "utf8"), defaultInstallStateBefore,
      "A temporarily missing populated default root must not erase authenticated installation receipts.");
    assert.equal(fs.readFileSync(defaultCatalogStatePath, "utf8"), defaultCatalogStateBefore,
      "A temporarily missing populated default root must not advance or replace catalog state.");
  } finally {
    fs.renameSync(offlineDefaultRoot, defaultRoot);
  }
  const defaultRecovered = defaultService.manage();
  assert.equal(defaultRecovered.skills.find((skill) => skill.id === "default-durable")?.installed, true);
  assert.equal(defaultRecovered.version, defaultInstalledVersion,
    "Restoring the same default-root inventory must restore installation without a false version change.");
}

function makeFixture(prefix) {
  const root = makeTempDir(`${prefix}root-`);
  const stateDir = makeTempDir(`${prefix}state-`);
  return { root, stateDir };
}

function makeService(fixture, runInstallScript) {
  return new SkillCatalogService({
    stateDir: fixture.stateDir,
    env: { AI_HELPER_SKILL_PATHS: fixture.root },
    cwd: fixture.root,
    homeDir: fixture.root,
    cacheMs: 0,
    runInstallScript
  });
}

function writeSkill(root, id, description, body) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const skillPath = path.join(dir, "SKILL.md");
  fs.writeFileSync(skillPath, [
    "---",
    `name: ${id}`,
    `description: ${description}`,
    "---",
    body
  ].join("\n"));
  return skillPath;
}

function writeInstaller(skillDir, body) {
  fs.writeFileSync(path.join(skillDir, "install.sh"), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
}

function writeUninstaller(skillDir, body) {
  fs.writeFileSync(path.join(skillDir, "uninstall.sh"), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function makeTempDir(prefix) {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(target);
  return target;
}
