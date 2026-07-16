#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const serverModulePath = path.resolve(__dirname, "..", "server", "shell_server.js");
const originalEnv = {
  socket: process.env.AI_CHAT_SHELL_TMUX_SOCKET,
  session: process.env.AI_CHAT_SHELL_TMUX_SESSION,
  host: process.env.AI_CHAT_SHELL_HOST_WINDOW,
  board: process.env.AI_CHAT_SHELL_BOARD_WINDOW,
  cwd: process.env.AI_CHAT_SHELL_FORAI_CWD,
  state: process.env.AI_CHAT_SHELL_STATE_DIR,
  runner: process.env.AI_CHAT_SHELL_RUNNER,
  delayedRunnerMarker: process.env.AI_CHAT_SHELL_DELAYED_RUNNER_MARKER,
  delayedRunnerOnce: process.env.AI_CHAT_SHELL_DELAYED_RUNNER_ONCE
};

main()
  .then(() => {
    console.log("tmux shell lifecycle integration tests passed");
  })
  .finally(() => {
    delete require.cache[require.resolve(serverModulePath)];
    restoreEnv("AI_CHAT_SHELL_TMUX_SOCKET", originalEnv.socket);
    restoreEnv("AI_CHAT_SHELL_TMUX_SESSION", originalEnv.session);
    restoreEnv("AI_CHAT_SHELL_HOST_WINDOW", originalEnv.host);
    restoreEnv("AI_CHAT_SHELL_BOARD_WINDOW", originalEnv.board);
    restoreEnv("AI_CHAT_SHELL_FORAI_CWD", originalEnv.cwd);
    restoreEnv("AI_CHAT_SHELL_STATE_DIR", originalEnv.state);
    restoreEnv("AI_CHAT_SHELL_RUNNER", originalEnv.runner);
    restoreEnv("AI_CHAT_SHELL_DELAYED_RUNNER_MARKER", originalEnv.delayedRunnerMarker);
    restoreEnv("AI_CHAT_SHELL_DELAYED_RUNNER_ONCE", originalEnv.delayedRunnerOnce);
  })
  .catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });

async function main() {
  assert.equal(commandExists("tmux"), true, "tmux shell lifecycle integration tests require tmux on PATH.");

  const failures = [];
  for (const [name, scenario] of [
    ["server restart while a helper owns the pane", testServerRestartRecovery],
    ["manual foreground work blocks helper injection", testManualForegroundSerialization],
    ["foreground child shells block helper injection", testForegroundChildShellSerialization],
    ["queued followers resolve cwd after the pane becomes idle", testQueuedFollowerCwdResolution],
    ["owner release failure preserves completion proof", testOwnerReleaseFailureRecovery],
    ["respawned pane shell does not inherit duplicate history", testRespawnedPaneShellDedupIsolation],
    ["Ctrl+C before the executed marker", testPreExecutionInterrupt]
  ]) {
    try {
      await scenario();
    } catch (error) {
      failures.push(`${name}:\n${error.stack || error.message || String(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\n\n"));
  }
}

async function testRespawnedPaneShellDedupIsolation() {
  await withFixture("respawn-dedup", async (fixture) => {
    const server = freshServerModule();
    await server.ensureForAiTmuxLayout();
    const originalPane = server.resolveDefaultShellPane(await server.listTmuxPanes()).pane;
    const outputPath = path.join(fixture.tmpDir, "respawn-dedup-output.txt");
    const command = `printf 'executed\\n' >> ${shellQuote(outputPath)}`;

    const original = await runHelper(server, "respawn-dedup-original", command, 3000);
    assert.equal(original.exitCode, 0, JSON.stringify(original));
    assert.notEqual(original.duplicate, true, JSON.stringify(original));
    assert.equal(fs.readFileSync(outputPath, "utf8"), "executed\n");

    runTmux(fixture.socketPath, [
      "respawn-pane",
      "-k",
      "-t",
      originalPane.id,
      "-c",
      fixture.cwd
    ]);
    await waitForCondition(async () => {
      const current = (await server.listTmuxPanes()).find((pane) => pane.id === originalPane.id);
      if (!current || current.panePid === originalPane.panePid) {
        return false;
      }
      return (await server.getTmuxPaneReadiness(current)).ready;
    }, 5000, "respawned pane shell to become ready with a new pane pid");

    const respawnedPane = server.resolveDefaultShellPane(await server.listTmuxPanes()).pane;
    assert.equal(respawnedPane.id, originalPane.id, "tmux respawn-pane must preserve the pane id for this regression.");
    assert.equal(respawnedPane.serverPid, originalPane.serverPid);
    assert.equal(respawnedPane.sessionCreated, originalPane.sessionCreated);
    assert.notEqual(respawnedPane.panePid, originalPane.panePid, "tmux respawn-pane must replace the shell process.");

    const afterRespawn = await runHelper(server, "respawn-dedup-new-shell", command, 3000);
    assert.equal(afterRespawn.exitCode, 0, JSON.stringify(afterRespawn));
    assert.notEqual(afterRespawn.duplicate, true, "A new pane shell has not executed the old command and must not be suppressed.");
    assert.equal(fs.readFileSync(outputPath, "utf8"), "executed\nexecuted\n");
  });
}

async function testForegroundChildShellSerialization() {
  await withFixture("child-shell", async (fixture) => {
    const server = freshServerModule();
    await server.ensureForAiTmuxLayout();
    const pane = server.resolveDefaultShellPane(await server.listTmuxPanes()).pane;
    const childShell = fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh";
    const shellName = path.basename(childShell);

    const naturalStart = `LIFECYCLE_CHILD_SHELL_NATURAL_START_${Date.now()}`;
    const naturalDone = `LIFECYCLE_CHILD_SHELL_NATURAL_DONE_${Date.now()}`;
    const naturalFollower = `LIFECYCLE_CHILD_SHELL_NATURAL_FOLLOWER_${Date.now()}`;
    const naturalBody = `printf '${naturalStart}\\n'; IFS= read -r answer; printf '${naturalDone}:%s\\n' "$answer"`;
    sendPaneCommand(fixture.socketPath, pane.id, `${childShell} -c ${shellQuote(naturalBody)}`);
    await waitForPaneText(fixture.socketPath, pane.id, naturalStart, 5000);
    assert.equal(readPaneCurrentCommand(fixture.socketPath, pane.id), shellName, "The regression must exercise a child shell whose command name matches an idle prompt shell.");

    let naturalSettled = false;
    const naturalFollowerPromise = runHelper(
      server,
      "child-shell-natural-follower",
      `printf '${naturalFollower}\\n'`,
      1000
    ).finally(() => {
      naturalSettled = true;
    });
    await sleep(750);
    assert.equal(naturalSettled, false, "A foreground child shell blocked in read must not be mistaken for the interactive prompt.");
    assert.doesNotMatch(capturePane(fixture.socketPath, pane.id), new RegExp(naturalFollower));

    sendPaneCommand(fixture.socketPath, pane.id, "resume-child-shell");
    const naturalResponse = await withDeadline(naturalFollowerPromise, 3000, "helper after child shell natural exit");
    assert.equal(naturalResponse.exitCode, 0, JSON.stringify(naturalResponse));
    assert.equal(naturalResponse.timedOut, false, JSON.stringify(naturalResponse));
    assert.match(naturalResponse.stdout, new RegExp(naturalFollower));
    assert.match(capturePane(fixture.socketPath, pane.id), new RegExp(`${naturalDone}:resume-child-shell`));

    const interruptStart = `LIFECYCLE_CHILD_SHELL_INTERRUPT_START_${Date.now()}`;
    const interruptFollower = `LIFECYCLE_CHILD_SHELL_INTERRUPT_FOLLOWER_${Date.now()}`;
    const interruptBody = `printf '${interruptStart}\\n'; IFS= read -r answer`;
    sendPaneCommand(fixture.socketPath, pane.id, `${childShell} -c ${shellQuote(interruptBody)}`);
    await waitForPaneText(fixture.socketPath, pane.id, interruptStart, 5000);
    assert.equal(readPaneCurrentCommand(fixture.socketPath, pane.id), shellName);

    let interruptSettled = false;
    const interruptFollowerPromise = runHelper(
      server,
      "child-shell-interrupt-follower",
      `printf '${interruptFollower}\\n'`,
      1000
    ).finally(() => {
      interruptSettled = true;
    });
    await sleep(500);
    assert.equal(interruptSettled, false, "A helper must wait behind a foreground child shell until Ctrl+C releases it.");
    assert.doesNotMatch(capturePane(fixture.socketPath, pane.id), new RegExp(interruptFollower));

    const interruptedAt = Date.now();
    runTmux(fixture.socketPath, ["send-keys", "-t", pane.id, "C-c"]);
    const interruptResponse = await withDeadline(interruptFollowerPromise, 3000, "helper after child shell Ctrl+C");
    assert.ok(Date.now() - interruptedAt < 2000, JSON.stringify(interruptResponse));
    assert.equal(interruptResponse.exitCode, 0, JSON.stringify(interruptResponse));
    assert.match(interruptResponse.stdout, new RegExp(interruptFollower));
  });
}

async function testOwnerReleaseFailureRecovery() {
  await withFixture("release-failure", async (fixture) => {
    const server = freshServerModule();
    await server.ensureForAiTmuxLayout();
    const pane = server.resolveDefaultShellPane(await server.listTmuxPanes()).pane;
    const initialLedgerKey = `initial-owner-ledger-${Date.now()}`;
    const initiallyBoundOwner = await server.acquirePersistentTmuxPaneOwner(pane, {
      socketPath: fixture.socketPath,
      kind: "shell",
      cmd: "initial owner binding probe",
      ledgerKey: initialLedgerKey
    });
    const initiallyBoundEncoded = runTmux(fixture.socketPath, [
      "show-options", "-p", "-v", "-t", pane.id, "@ai_chat_shell_exec_owner"
    ]).trim();
    const initiallyBoundPersisted = JSON.parse(Buffer.from(initiallyBoundEncoded, "base64url").toString("utf8"));
    assert.equal(initiallyBoundPersisted.ledgerKey, initialLedgerKey, "The first persisted owner claim must already identify its ledger reservation.");
    assert.equal(await server.releasePersistentTmuxPaneOwner(initiallyBoundOwner), true);

    const mutateOwnerScript = [
      "const { execFileSync } = require('node:child_process');",
      `const paneId = ${JSON.stringify(pane.id)};`,
      "const socket = process.env.AI_CHAT_SHELL_TMUX_SOCKET;",
      "const base = ['-S', socket];",
      "const encoded = execFileSync('tmux', [...base, 'show-options', '-p', '-v', '-t', paneId, '@ai_chat_shell_exec_owner'], { encoding: 'utf8' }).trim();",
      "const owner = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));",
      "owner.releaseFailureTest = true;",
      "const mutated = Buffer.from(JSON.stringify(owner), 'utf8').toString('base64url');",
      "execFileSync('tmux', [...base, 'set-option', '-p', '-t', paneId, '@ai_chat_shell_exec_owner', mutated]);"
    ].join(" ");
    const command = `${shellQuote(process.execPath)} -e ${shellQuote(mutateOwnerScript)}; printf 'RELEASE_FAILURE_COMMAND_DONE\\n'`;
    const original = await runHelper(server, "release-failure-original", command, 3000);
    assert.equal(original.exitCode, 0, JSON.stringify(original));
    assert.match(original.stdout, /RELEASE_FAILURE_COMMAND_DONE/);

    const retainedEncoded = runTmux(fixture.socketPath, [
      "show-options", "-p", "-v", "-t", pane.id, "@ai_chat_shell_exec_owner"
    ]).trim();
    assert.ok(retainedEncoded, "A conditionally failed owner release must retain the recovery lease.");
    const retainedOwner = JSON.parse(Buffer.from(retainedEncoded, "base64url").toString("utf8"));
    assert.equal(retainedOwner.releaseFailureTest, true);
    assert.equal(fs.existsSync(retainedOwner.statusPath), true, "Status proof must survive an unconfirmed release.");
    assert.equal(fs.existsSync(retainedOwner.executedPath), true, "Executed proof must survive an unconfirmed release.");

    const follower = await runHelper(server, "release-failure-follower", "printf 'RELEASE_FAILURE_FOLLOWER\\n'", 3000);
    assert.equal(follower.exitCode, 0, JSON.stringify(follower));
    assert.match(follower.stdout, /RELEASE_FAILURE_FOLLOWER/);
    assert.equal(fs.existsSync(retainedOwner.statusPath), false, "Recovered proof files should be removed only after the stale lease is cleared.");

    const duplicate = await runHelper(server, "release-failure-duplicate", command, 3000);
    assert.equal(duplicate.duplicate, true, JSON.stringify(duplicate));
    assert.equal(duplicate.skipped, true, JSON.stringify(duplicate));
  });
}

async function testQueuedFollowerCwdResolution() {
  await withFixture("queued-cwd", async (fixture) => {
    const server = freshServerModule();
    await server.ensureForAiTmuxLayout();
    const pane = server.resolveDefaultShellPane(await server.listTmuxPanes()).pane;
    const shellCwd = fs.realpathSync(fixture.cwd);
    const leaderCwd = path.join(fixture.tmpDir, "leader-cwd");
    fs.mkdirSync(leaderCwd);
    const expectedLeaderCwd = fs.realpathSync(leaderCwd);
    const leaderStartedPath = path.join(fixture.tmpDir, "cwd-leader-started");

    const leaderPromise = runHelper(server, "queued-cwd-leader", [
      `printf 'started\\n' > ${shellQuote(leaderStartedPath)}`,
      "sleep 3"
    ].join("; "), 1000, { cwd: expectedLeaderCwd });
    await waitForFileText(leaderStartedPath, "started", 5000);
    const followerCallKey = `queued-cwd-follower-${Date.now()}`;
    const followerPromise = runHelper(server, "queued-cwd-follower", "pwd", 1000, { callKey: followerCallKey });
    await waitForCondition(
      () => server.getTmuxShellPaneQueueDepth(pane) >= 2,
      5000,
      "cwd follower to enter the pane queue"
    );
    const queuedStatus = await server.handleMessageText(JSON.stringify({
      type: "run-status",
      callKey: followerCallKey
    }));
    assert.equal(queuedStatus.found, true, JSON.stringify(queuedStatus));
    assert.equal(queuedStatus.state, "running", JSON.stringify(queuedStatus));
    assert.equal(queuedStatus.phase, "queued", JSON.stringify(queuedStatus));
    assert.equal(queuedStatus.queued, true, JSON.stringify(queuedStatus));
    const queuedLedger = JSON.parse(fs.readFileSync(path.join(fixture.stateDir, "shell-ledger.json"), "utf8"));
    const queuedEntry = Object.values(queuedLedger.calls || {}).find((entry) => entry.callKey === followerCallKey);
    assert.ok(queuedEntry, `Missing queued ledger entry for ${followerCallKey}`);
    assert.equal(queuedEntry.executionKey, "", "A queued follower must not have duplicate authority before dispatch.");
    assert.equal(queuedEntry.cwd, "", "A queued follower must not capture cwd before reaching the queue head.");
    const leaderResponse = await withDeadline(leaderPromise, 6000, "explicit-cwd leader");
    const followerResponse = await withDeadline(followerPromise, 6000, "implicit-cwd queued follower");
    assert.equal(leaderResponse.exitCode, 0, JSON.stringify(leaderResponse));
    assert.equal(followerResponse.exitCode, 0, JSON.stringify(followerResponse));
    assert.equal(followerResponse.queued, true, JSON.stringify(followerResponse));
    assert.equal(followerResponse.timedOut, false, JSON.stringify(followerResponse));
    assert.equal(followerResponse.cwd, shellCwd, JSON.stringify(followerResponse));
    assert.equal(followerResponse.stdout.trim(), shellCwd, JSON.stringify(followerResponse));
  });
}

async function testServerRestartRecovery() {
  await withFixture("restart", async (fixture) => {
    const firstServer = freshServerModule();
    await firstServer.ensureForAiTmuxLayout();
    const pane = firstServer.resolveDefaultShellPane(await firstServer.listTmuxPanes()).pane;
    const leaderStartedPath = path.join(fixture.tmpDir, "restart-leader-started");
    const leaderToken = `LIFECYCLE_RESTART_LEADER_${Date.now()}`;
    const followerToken = `LIFECYCLE_RESTART_FOLLOWER_${Date.now()}`;

    const leaderPromise = runHelper(firstServer, "restart-leader", [
      `printf 'started\\n' > ${shellQuote(leaderStartedPath)}`,
      `printf '${leaderToken}\\n'`,
      "sleep 5",
      "printf 'leader-done\\n'"
    ].join("; "), 1000);
    await waitForFileText(leaderStartedPath, "started", 5000);

    // Loading a fresh module instance models the loss of all in-memory queue
    // state when the local shell server process is restarted while tmux lives on.
    const restartedServer = freshServerModule();
    let followerSettled = false;
    const followerPromise = runHelper(
      restartedServer,
      "restart-follower",
      `printf '${followerToken}\\n'`,
      1000
    ).finally(() => {
      followerSettled = true;
    });

    await sleep(3500);
    const followerSettledWhileLeaderWasBusy = followerSettled;
    const paneTextWhileLeaderWasBusy = capturePane(fixture.socketPath, pane.id);

    const leaderResponse = await withDeadline(leaderPromise, 8000, "leader after simulated server restart");
    const followerResponse = await withDeadline(followerPromise, 8000, "follower after simulated server restart");
    assert.equal(followerSettledWhileLeaderWasBusy, false, "A restarted server must recover the busy-pane lease instead of injecting a second runner.");
    assert.doesNotMatch(paneTextWhileLeaderWasBusy, new RegExp(followerToken));
    assert.equal(leaderResponse.exitCode, 0, JSON.stringify(leaderResponse));
    assert.equal(followerResponse.exitCode, 0, JSON.stringify(followerResponse));
    assert.equal(followerResponse.executed, true, JSON.stringify(followerResponse));
    assert.equal(followerResponse.executionCompleted, true, JSON.stringify(followerResponse));
    assert.equal(followerResponse.timedOut, false, JSON.stringify(followerResponse));
    assert.match(followerResponse.stdout, new RegExp(followerToken));

    const paneText = capturePane(fixture.socketPath, pane.id);
    assert.doesNotMatch(paneText, /can't open input file|No such file or directory/);
  });
}

async function testManualForegroundSerialization() {
  await withFixture("manual", async (fixture) => {
    const server = freshServerModule();
    await server.ensureForAiTmuxLayout();
    const pane = server.resolveDefaultShellPane(await server.listTmuxPanes()).pane;

    const naturalStart = `LIFECYCLE_MANUAL_NATURAL_START_${Date.now()}`;
    const naturalDone = `LIFECYCLE_MANUAL_NATURAL_DONE_${Date.now()}`;
    const naturalFollower = `LIFECYCLE_MANUAL_NATURAL_FOLLOWER_${Date.now()}`;
    sendPaneCommand(fixture.socketPath, pane.id, `printf '${naturalStart}\\n'; sleep 5; printf '${naturalDone}\\n'`);
    await waitForPaneText(fixture.socketPath, pane.id, naturalStart, 5000);

    let naturalSettled = false;
    const naturalFollowerPromise = runHelper(
      server,
      "manual-natural-follower",
      `printf '${naturalFollower}\\n'`,
      1000
    ).finally(() => {
      naturalSettled = true;
    });
    await sleep(3500);
    const naturalSettledWhilePaneWasBusy = naturalSettled;
    const paneTextWhileNaturalCommandWasBusy = capturePane(fixture.socketPath, pane.id);

    const naturalResponse = await withDeadline(naturalFollowerPromise, 8000, "helper after manual foreground natural exit");
    await waitForPaneText(fixture.socketPath, pane.id, naturalDone, 5000);
    assert.equal(naturalSettledWhilePaneWasBusy, false, "A helper must wait while non-helper foreground work owns the tmux pane.");
    assert.doesNotMatch(paneTextWhileNaturalCommandWasBusy, new RegExp(naturalFollower));
    assert.equal(naturalResponse.exitCode, 0, JSON.stringify(naturalResponse));
    assert.equal(naturalResponse.timedOut, false, JSON.stringify(naturalResponse));
    assert.match(naturalResponse.stdout, new RegExp(naturalFollower));
    assert.match(capturePane(fixture.socketPath, pane.id), new RegExp(naturalDone));

    const interruptStart = `LIFECYCLE_MANUAL_INTERRUPT_START_${Date.now()}`;
    const interruptFollower = `LIFECYCLE_MANUAL_INTERRUPT_FOLLOWER_${Date.now()}`;
    sendPaneCommand(fixture.socketPath, pane.id, `printf '${interruptStart}\\n'; sleep 60`);
    await waitForPaneText(fixture.socketPath, pane.id, interruptStart, 5000);
    let interruptFollowerSettled = false;
    const interruptFollowerPromise = runHelper(
      server,
      "manual-interrupt-follower",
      `printf '${interruptFollower}\\n'`,
      1000
    ).finally(() => {
      interruptFollowerSettled = true;
    });
    await sleep(500);
    assert.equal(interruptFollowerSettled, false, "The helper must remain pending until manual foreground work exits.");
    assert.doesNotMatch(capturePane(fixture.socketPath, pane.id), new RegExp(interruptFollower));

    const interruptedAt = Date.now();
    runTmux(fixture.socketPath, ["send-keys", "-t", pane.id, "C-c"]);
    const interruptResponse = await withDeadline(interruptFollowerPromise, 3000, "helper after manual foreground Ctrl+C");
    assert.ok(Date.now() - interruptedAt < 2000, JSON.stringify(interruptResponse));
    assert.equal(interruptResponse.exitCode, 0, JSON.stringify(interruptResponse));
    assert.equal(interruptResponse.timedOut, false, JSON.stringify(interruptResponse));
    assert.match(interruptResponse.stdout, new RegExp(interruptFollower));
  });
}

async function testPreExecutionInterrupt() {
  await withFixture("pre-marker", async (fixture) => {
    const delayedRunnerMarker = path.join(fixture.tmpDir, "delayed-runner-ready");
    const delayedRunnerOnce = path.join(fixture.tmpDir, "delayed-runner-once");
    const delayedRunner = path.join(fixture.tmpDir, "delayed-runner.sh");
    fs.writeFileSync(delayedRunner, [
      "#!/bin/sh",
      "if [ ! -e \"$AI_CHAT_SHELL_DELAYED_RUNNER_ONCE\" ]; then",
      "  printf '1\\n' > \"$AI_CHAT_SHELL_DELAYED_RUNNER_ONCE\"",
      "  printf 'ready\\n' > \"$AI_CHAT_SHELL_DELAYED_RUNNER_MARKER\"",
      "  trap 'exit 130' INT TERM HUP",
      "  sleep 10",
      "fi",
      "exec /bin/zsh \"$@\"",
      ""
    ].join("\n"), { mode: 0o755 });
    process.env.AI_CHAT_SHELL_RUNNER = delayedRunner;
    process.env.AI_CHAT_SHELL_DELAYED_RUNNER_MARKER = delayedRunnerMarker;
    process.env.AI_CHAT_SHELL_DELAYED_RUNNER_ONCE = delayedRunnerOnce;

    const server = freshServerModule();
    await server.ensureForAiTmuxLayout();
    const pane = server.resolveDefaultShellPane(await server.listTmuxPanes()).pane;
    const commandToken = `LIFECYCLE_PRE_MARKER_COMMAND_${Date.now()}`;
    const followerToken = `LIFECYCLE_PRE_MARKER_FOLLOWER_${Date.now()}`;
    const command = `printf '${commandToken}\\n'`;
    const leaderPromise = runHelper(server, "pre-marker-leader", command, 1000);
    await waitForFileText(delayedRunnerMarker, "ready", 5000);

    const followerPromise = runHelper(
      server,
      "pre-marker-follower",
      `printf '${followerToken}\\n'`,
      1000
    );
    await waitForCondition(
      () => server.getTmuxShellPaneQueueDepth(pane) >= 2,
      5000,
      "pre-execution follower to enter the pane queue"
    );

    const interruptedAt = Date.now();
    runTmux(fixture.socketPath, ["send-keys", "-t", pane.id, "C-c"]);
    const leaderRace = await Promise.race([
      leaderPromise.then((response) => ({ response, late: false })),
      sleep(2500).then(() => ({ response: null, late: true }))
    ]);
    const leaderResponse = leaderRace.response || await withDeadline(
      leaderPromise,
      3000,
      "late pre-execution Ctrl+C response cleanup"
    );
    const interruptLatencyMs = Date.now() - interruptedAt;
    const followerResponse = await withDeadline(followerPromise, 3000, "queued follower after pre-execution Ctrl+C");
    assert.ok(interruptLatencyMs < 2000, JSON.stringify({ interruptLatencyMs, leaderResponse }));
    assert.equal(leaderResponse.executed, false, JSON.stringify(leaderResponse));
    assert.equal(leaderResponse.executionCompleted, false, JSON.stringify(leaderResponse));
    assert.equal(leaderResponse.timedOut, false, JSON.stringify(leaderResponse));
    assert.ok(
      leaderResponse.interrupted === true || leaderResponse.cancelled === true,
      `Pre-execution Ctrl+C must be reported as interrupted/cancelled without execution proof: ${JSON.stringify(leaderResponse)}`
    );

    assert.equal(followerResponse.exitCode, 0, JSON.stringify(followerResponse));
    assert.equal(followerResponse.timedOut, false, JSON.stringify(followerResponse));
    assert.match(followerResponse.stdout, new RegExp(followerToken));

    const retryResponse = await runHelper(server, "pre-marker-retry", command, 3000);
    assert.equal(retryResponse.exitCode, 0, JSON.stringify(retryResponse));
    assert.equal(retryResponse.executed, true, JSON.stringify(retryResponse));
    assert.equal(retryResponse.executionCompleted, true, JSON.stringify(retryResponse));
    assert.notEqual(retryResponse.duplicate, true, JSON.stringify(retryResponse));
    assert.match(retryResponse.stdout, new RegExp(commandToken));
  });
}

async function withFixture(label, task) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `tmux-shell-lifecycle-${label}-`));
  const socketPath = path.join(tmpDir, "tmux.sock");
  const cwd = path.join(tmpDir, "cwd");
  const stateDir = path.join(tmpDir, "state");
  fs.mkdirSync(cwd);
  process.env.AI_CHAT_SHELL_TMUX_SOCKET = socketPath;
  process.env.AI_CHAT_SHELL_TMUX_SESSION = "ForAI";
  process.env.AI_CHAT_SHELL_HOST_WINDOW = "host";
  process.env.AI_CHAT_SHELL_BOARD_WINDOW = "board";
  process.env.AI_CHAT_SHELL_FORAI_CWD = cwd;
  process.env.AI_CHAT_SHELL_STATE_DIR = stateDir;
  delete process.env.AI_CHAT_SHELL_RUNNER;
  delete process.env.AI_CHAT_SHELL_DELAYED_RUNNER_MARKER;
  delete process.env.AI_CHAT_SHELL_DELAYED_RUNNER_ONCE;

  try {
    await task({ tmpDir, socketPath, cwd, stateDir });
  } finally {
    delete require.cache[require.resolve(serverModulePath)];
    spawnSync("tmux", ["-S", socketPath, "kill-server"], { encoding: "utf8" });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function freshServerModule() {
  delete require.cache[require.resolve(serverModulePath)];
  return require(serverModulePath);
}

function runHelper(server, id, cmd, timeoutMs, extra = {}) {
  return server.handleMessageText(JSON.stringify({
    type: "run",
    id,
    callKey: `${id}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    cmd,
    timeoutMs,
    maxOutputChars: 20000,
    ...extra
  }));
}

function sendPaneCommand(socketPath, paneId, command) {
  runTmux(socketPath, ["send-keys", "-t", paneId, "-l", command]);
  runTmux(socketPath, ["send-keys", "-t", paneId, "Enter"]);
}

function capturePane(socketPath, paneId) {
  return runTmux(socketPath, ["capture-pane", "-p", "-J", "-S", "-200", "-t", paneId]);
}

function readPaneCurrentCommand(socketPath, paneId) {
  return runTmux(socketPath, ["display-message", "-p", "-t", paneId, "#{pane_current_command}"]).trim();
}

function runTmux(socketPath, args) {
  const result = spawnSync("tmux", ["-S", socketPath, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `tmux ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function commandExists(command) {
  return spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).status === 0;
}

async function waitForPaneText(socketPath, paneId, text, timeoutMs) {
  await waitForCondition(
    () => capturePane(socketPath, paneId).includes(text),
    timeoutMs,
    `tmux pane ${paneId} to contain ${text}`
  );
}

async function waitForFileText(filePath, text, timeoutMs) {
  await waitForCondition(
    () => fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8").includes(text),
    timeoutMs,
    `${filePath} to contain ${text}`
  );
}

async function waitForCondition(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function withDeadline(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    sleep(timeoutMs).then(() => {
      throw new Error(`Timed out waiting for ${label}.`);
    })
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}
