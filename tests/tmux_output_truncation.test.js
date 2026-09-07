#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn, spawnSync } = require("node:child_process");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-output-truncation-"));
const socketPath = path.join(tmpDir, "tmux.sock");
const serverModulePath = path.resolve(__dirname, "../server/shell_server.js");
const envNames = ["AI_CHAT_SHELL_TMUX_SOCKET", "AI_CHAT_SHELL_STATE_DIR", "AI_CHAT_SHELL_ENV_FILE", "AI_CHAT_SHELL_RUNNER"];
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
process.env.AI_CHAT_SHELL_TMUX_SOCKET = socketPath;
process.env.AI_CHAT_SHELL_STATE_DIR = path.join(tmpDir, "state");
delete process.env.AI_CHAT_SHELL_ENV_FILE;
delete process.env.AI_CHAT_SHELL_RUNNER;
const server = require(serverModulePath);

function tmux(args) {
  const result = spawnSync("tmux", ["-S", socketPath, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `private tmux ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

async function main() {
  await testRecoveredIdleObservation();
  const start = "__AI_CHAT_SHELL_EXEC_START_test__";
  const done = "__AI_CHAT_SHELL_EXEC_DONE_test__";
  const defaultBoundary = server.extractTmuxRunOutput(`${start}\n${"x".repeat(80000)}\n${done}:0`, start, done);
  assert.equal(defaultBoundary.stdout.length, 80000, "The server default must retain 80000 output characters.");
  assert.equal(defaultBoundary.truncated, false);
  const defaultOverflow = server.extractTmuxRunOutput(`${start}\n${"x".repeat(80001)}\n${done}:0`, start, done);
  assert.equal(defaultOverflow.stdout.length, 80000);
  assert.equal(defaultOverflow.truncated, true, "Exceeding the new default must still warn the AI.");
  const lostStart = server.extractTmuxRunOutput(`OLD_PRIVATE_OUTPUT\ntail\n${done}:7\nprompt`, start, done, 100);
  assert.equal(lostStart.foundStart, false);
  assert.equal(lostStart.foundDone, true, "START loss must not hide the remaining DONE marker.");
  assert.equal(lostStart.exitCode, 7);
  assert.equal(lostStart.stdout, "", "Unowned pane history must never be returned as this command's stdout.");
  assert.equal(lostStart.truncated, true, "A lost START must report incomplete capture, even if stdout is empty.");

  const absent = server.extractTmuxRunOutput("unrelated pane content", start, done, 100);
  assert.equal(absent.foundDone, false, "Arbitrary pane text is not completion proof.");
  assert.equal(absent.stdout, "");
  assert.equal(absent.truncated, true);
  assert.notEqual(absent.outputFingerprint, server.extractTmuxRunOutput("new unrelated content", start, done, 100).outputFingerprint,
    "Observable output changes must remain detectable after START leaves history.");
  for (const malformed of [done, `${done}:oops`, `${done}:0suffix`]) {
    assert.equal(server.extractTmuxRunOutput(malformed, start, done, 100).foundDone, false,
      "A malformed DONE marker must not complete a run after START loss.");
  }
  const completeBeforeCaptureLimit = server.extractTmuxRunOutput(`${start}\ncomplete\n${done}:0\nunrelated tail`, start, done, 100, { truncated: true });
  assert.equal(completeBeforeCaptureLimit.stdout, "complete");
  assert.equal(completeBeforeCaptureLimit.truncated, false,
    "Discarding unrelated content after a complete START/DONE pair must not imply command-output loss.");
  const captureCutBody = server.extractTmuxRunOutput(`${start}\npartial`, start, done, 100, { truncated: true });
  assert.equal(captureCutBody.stdout, "partial");
  assert.equal(captureCutBody.truncated, true, "Capture cut within command output must be flagged below the result bound.");
  const outputAtBound = server.extractTmuxRunOutput(`${start}\n12345678\n${done}:0`, start, done, 8);
  assert.equal(outputAtBound.truncated, false, "Exactly filling the result bound is not truncation.");

  const configPath = path.join(tmpDir, "tmux.conf");
  fs.writeFileSync(configPath, "set -g history-limit 100\n");
  tmux(["-f", configPath, "new-session", "-d", "-s", "output-test", "-x", "160", "-y", "24", "/bin/sh"]);
  const pane = (await server.listTmuxPanes())[0];
  assert.ok(pane && pane.id, "The test must use its private tmux pane.");
  assert.equal(tmux(["show-options", "-gv", "history-limit"]).trim(), "100");

  const run = (cmd, extra = {}) => server.runTmuxShell({
    cmd, pane, cwd: tmpDir, timeoutMs: 5000, maxOutputChars: 20000, ...extra
  });
  const completed = (result) => {
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.executed, true, JSON.stringify(result));
    assert.equal(result.executionCompleted, true, JSON.stringify(result));
    assert.equal(result.timedOut, false, JSON.stringify(result));
  };

  const short = await run("printf 'SHORT_OUTPUT_OK\\n'");
  completed(short);
  assert.equal(short.stdout, "SHORT_OUTPUT_OK");
  assert.equal(short.truncated, false, "Ordinary complete stdout must not receive a truncation warning.");

  const bounded = await run("printf 'abcdefghijklmnopqrstuvwxyz\\n'", { maxOutputChars: 8 });
  completed(bounded);
  assert.equal(bounded.stdout, "abcdefgh");
  assert.equal(bounded.truncated, true, "The configured result bound must also notify the AI.");

  const flood = "awk 'BEGIN { for (i=0;i<30000;i++) printf \"FLOOD_%06d\\n\", i }'";
  const rolled = await run(flood);
  completed(rolled);
  assert.equal(rolled.truncated, true, "Output beyond pane history must not silently look complete.");
  assert.doesNotMatch(rolled.stdout, /SHORT_OUTPUT_OK|abcdefghijklmnopqrstuvwxyz/,
    "Marker loss must not copy the previous command's pane content.");

  const retained = await run(`printf 'VERIFIED_PREFIX\\n'; sleep 1; ${flood}`);
  completed(retained);
  assert.match(retained.stdout, /VERIFIED_PREFIX/, "A prefix captured with START must survive a later history rollover.");
  assert.equal(retained.truncated, true);
  assert.ok(retained.stdout.length <= 20000, "Preserved output must respect the result bound.");

  const progress = [];
  const changing = await run(`${flood}; i=0; while [ "$i" -lt 18 ]; do printf 'LIVE_%s\\n' "$i"; i=$((i+1)); sleep 0.15; done`, {
    timeoutMs: 1000,
    onProgress: (event) => progress.push(event)
  });
  completed(changing);
  assert.equal(changing.truncated, true);
  assert.equal(changing.idleTimeoutReached, false,
    "Changing output after START loss must keep the output-idle clock active.");
  assert.equal(progress.some((event) => event.state === "awaiting-user"), false,
    "The user must not be asked to continue a command that is visibly producing output.");

  const quietProgress = [];
  const quiet = await run("printf 'QUIET_PREFIX\\n'; sleep 1.8", {
    timeoutMs: 1000,
    onProgress: (event) => quietProgress.push(event)
  });
  completed(quiet);
  assert.equal(quiet.truncated, false);
  assert.ok(quietProgress.some((event) => event.state === "awaiting-user"),
    "Fingerprint recovery must not disable genuine output-idle detection.");

  // A wider fresh pane holds more than 1 MB without losing START to history.
  // This isolates capture's internal character limit from the result bound.
  tmux(["set-option", "-g", "history-limit", "3000"]);
  tmux(["new-session", "-d", "-s", "capture-cap", "-x", "2000", "-y", "24", "/bin/sh"]);
  const capPane = (await server.listTmuxPanes()).find((candidate) => candidate.session === "capture-cap");
  assert.ok(capPane, "The capture-cap fixture needs its own wide pane.");
  const capped = await run("awk 'BEGIN { for (i=0;i<1500;i++) printf \"CAP_%06d_%01000d\\n\", i, i }'", {
    pane: capPane,
    maxOutputChars: 2000000
  });
  completed(capped);
  assert.match(capped.stdout, /CAP_000000/);
  assert.ok(capped.stdout.length < 1000000);
  assert.equal(capped.completionMarkerMissing, true, "The cap must actually exclude DONE in this regression.");
  assert.equal(capped.truncated, true, "Capture loss must be reported even below the requested result bound.");

  assert.equal(fs.readdirSync(path.join(tmpDir, "state", "tmux-runs")).length, 0,
    "All transient runner files must still be cleaned after the result is returned.");
  await testRestartRecovery(flood);
}

async function testRecoveredIdleObservation() {
  const source = fs.readFileSync(serverModulePath, "utf8");
  const functionStart = source.indexOf("async function observePersistentTmuxShellIdle(");
  const functionEnd = source.indexOf("\nasync function patchPersistentTmuxPaneOwner(", functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const changes = [];
  let failCapture = true;
  let capturedText = "fresh markerless output";
  const context = {
    Date: { now: () => 10000 },
    DEFAULT_TIMEOUT_MS: 180000,
    DEFAULT_MAX_OUTPUT_CHARS: 20000,
    clampNumber: (value, low, high, fallback) => Math.min(high, Math.max(low, Number(value) || fallback)),
    captureTmuxPane: async () => {
      if (failCapture) throw new Error("capture unavailable");
      return capturedText;
    },
    extractTmuxRunOutput: server.extractTmuxRunOutput,
    patchPersistentTmuxPaneOwner: async (pane, owner, patch) => ({ ...owner, ...patch }),
    markServerShellCallAwaitingUser: (key, patch) => changes.push({ state: "awaiting-user", ...patch }),
    markServerShellCallRunning: (key, patch) => changes.push({ state: "running", ...patch })
  };
  vm.createContext(context);
  vm.runInContext(source.slice(functionStart, functionEnd), context);
  const owner = {
    startMarker: "__START__", doneMarker: "__DONE__", idleTimeoutMs: 1000,
    lastOutputAt: 8000, idleState: "running", idleOutputFingerprint: "previous-fingerprint", ledgerKey: "idle-test"
  };
  const failed = await context.observePersistentTmuxShellIdle(owner, { id: "%test" });
  assert.equal(failed.lastOutputAt, 8000, "A recovery capture failure must not extend the output-idle clock.");
  assert.equal(failed.idleOutputFingerprint, "previous-fingerprint", "A failed capture must preserve the last real fingerprint.");
  assert.equal(failed.idleState, "awaiting-user");
  assert.equal(changes.at(-1).state, "awaiting-user");

  failCapture = false;
  const changed = await context.observePersistentTmuxShellIdle(failed, { id: "%test" });
  assert.equal(changed.lastOutputAt, 10000, "Successful markerless output changes must resume the recovered run.");
  assert.equal(changed.idleState, "running");
  assert.equal(changes.at(-1).idleResumedReason, "output-updated");
  const changeCount = changes.length;
  const same = await context.observePersistentTmuxShellIdle({ ...changed, lastOutputAt: 9500 }, { id: "%test" });
  assert.equal(same.lastOutputAt, 9500, "A repeated markerless snapshot must not refresh the recovered clock.");
  assert.equal(changes.length, changeCount);

  // A successful empty snapshot is still a real terminal change, distinct from
  // an unavailable capture; this matters when the running command clears it.
  capturedText = "";
  const cleared = await context.observePersistentTmuxShellIdle({ ...changed, lastOutputAt: 9500 }, { id: "%test" });
  assert.equal(cleared.lastOutputAt, 10000);
  assert.notEqual(cleared.idleOutputFingerprint, changed.idleOutputFingerprint);
}

async function waitFor(check, description) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function testRestartRecovery(flood) {
  tmux(["set-option", "-g", "history-limit", "100"]);
  const startedPath = path.join(tmpDir, "restart-started");
  const executionCountPath = path.join(tmpDir, "restart-count");
  const callKey = "truncation-restart-recovery";
  const cmd = `printf started > ${shellQuote(startedPath)}; sleep 1; printf 'once\\n' >> ${shellQuote(executionCountPath)}; ${flood}`;
  const request = { type: "run", id: callKey, callKey, cmd, timeoutMs: 5000, maxOutputChars: 20000 };
  const child = spawn(process.execPath, ["-e",
    "require(process.argv[1]).handleMessageText(process.argv[2]).then(() => process.exit(0), () => process.exit(1))",
    serverModulePath, JSON.stringify(request)
  ], {
    env: {
      ...process.env,
      AI_CHAT_SHELL_TMUX_SESSION: "restart-output",
      AI_CHAT_SHELL_HOST_WINDOW: "host",
      AI_CHAT_SHELL_BOARD_WINDOW: "board",
      AI_CHAT_SHELL_FORAI_CWD: tmpDir
    },
    stdio: "ignore"
  });
  const childClosed = new Promise((resolve) => child.once("close", resolve));
  try {
    await waitFor(() => fs.existsSync(startedPath), "the child server's executed command");
    child.kill("SIGKILL");
    await childClosed;
    const runsPath = path.join(tmpDir, "state", "tmux-runs");
    await waitFor(() => fs.readdirSync(runsPath).some((name) => name.endsWith(".status")), "completion after server exit");
    // The restarted server has no retained stdout from the first process.
    delete require.cache[require.resolve(serverModulePath)];
    const restarted = require(serverModulePath);
    const recovered = await restarted.handleMessageText(JSON.stringify({ type: "run-status", callKey, kind: "shell" }));
    assert.equal(recovered.state, "completed", JSON.stringify(recovered));
    assert.equal(recovered.result.exitCode, 0, JSON.stringify(recovered));
    assert.equal(recovered.result.executionCompleted, true);
    assert.equal(recovered.result.truncated, true, "Restart recovery must persist capture loss into run-status replay.");
    assert.equal(recovered.result.stdout, "", "Restart recovery must not adopt an unowned pane tail.");
    const replay = await restarted.handleMessageText(JSON.stringify({ type: "run-status", callKey, kind: "shell" }));
    assert.equal(replay.result.truncated, true, "Subsequent read-only replay must retain truncation metadata.");
    assert.equal(fs.readFileSync(executionCountPath, "utf8"), "once\n", "Status recovery must never re-execute the command.");
    assert.equal(fs.readdirSync(runsPath).length, 0, "Recovered completion must still clean the runner proof files.");
  } finally {
    child.kill("SIGKILL");
    await childClosed;
  }
}

main().then(() => console.log("tmux output truncation tests passed")).catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
}).finally(() => {
  spawnSync("tmux", ["-S", socketPath, "kill-server"], { encoding: "utf8" });
  for (const name of envNames) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
  delete require.cache[require.resolve(serverModulePath)];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
