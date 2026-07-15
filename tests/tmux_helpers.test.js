#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildBoardHelperExample,
  buildBoardLogPath,
  buildBoardTargetErrorResponse,
  buildTmuxPaneExecutionTarget,
  buildTmuxShellQueueKey,
  buildDefaultTargetErrorResponse,
  buildTmuxCommandArgs,
  buildTmuxRunScript,
  extractTmuxRunOutput,
  extractBoardPromptSignature,
  getTmuxEnvSocketPath,
  getForAiTmuxConfig,
  handleMessageText,
  isConfirmedTmuxExecution,
  normalizeBoardOutput,
  outputEndsWithBoardPrompt,
  parseTmuxPanes,
  readBoardLogFromOffset,
  readTmuxShellRunState,
  resolveBoardPane,
  resolveDefaultShellPane,
  resolveDownloadsFilePath,
  resolveTmuxTarget,
  validateBoardCommand,
  writeDownloadsFile
} = require("../server/shell_server.js");

const panes = parseTmuxPanes([
  "%24\tespcam\t0\tbuild\t0\t1\t/Users/rjwang/work/project\tzsh",
  "%25\tespcam\t1\tmonitor\t0\t0\t/Users/rjwang/work/project\tPython"
].join("\n"));

assert.equal(panes.length, 2);
assert.deepEqual(panes[0], {
  id: "%24",
  session: "espcam",
  windowIndex: "0",
  windowName: "build",
  paneIndex: "0",
  active: true,
  currentPath: "/Users/rjwang/work/project",
  currentCommand: "zsh",
  sessionCreated: "",
  serverPid: "",
  address: "espcam:0.0",
  label: "espcam:0.0 build"
});
assert.equal(resolveTmuxTarget("%24", panes).address, "espcam:0.0");
assert.equal(resolveTmuxTarget("espcam:1.0", panes).id, "%25");
assert.equal(resolveTmuxTarget("build", panes).id, "%24");
assert.equal(resolveTmuxTarget("monitor", panes).id, "%25");
assert.equal(resolveTmuxTarget("missing:0.0", panes), null);
assert.equal(resolveTmuxTarget("build", parseTmuxPanes([
  "%31\tmain\t0\tbuild\t0\t1\t/tmp\tzsh",
  "%32\tmain\t1\tbuild\t0\t1\t/tmp\tzsh"
].join("\n"))), null);
assert.equal(parseTmuxPanes([
  "%30",
  "main",
  "2",
  "dev",
  "1",
  "0",
  "/tmp",
  "zsh"
].join("__AI_CHAT_SHELL_FIELD__"))[0].address, "main:2.1");
const paneWithInstance = parseTmuxPanes([
  "%30",
  "main",
  "2",
  "dev",
  "1",
  "0",
  "/tmp",
  "zsh",
  "1784112000",
  "43210"
].join("__AI_CHAT_SHELL_FIELD__"))[0];
assert.equal(paneWithInstance.sessionCreated, "1784112000");
assert.equal(paneWithInstance.serverPid, "43210");
assert.equal(buildTmuxPaneExecutionTarget(panes[0]), "", "Missing pane-instance metadata must disable dedup rather than reuse an ambiguous identity.");
assert.equal(buildTmuxPaneExecutionTarget({ ...paneWithInstance, sessionCreated: "" }), "");
assert.equal(buildTmuxPaneExecutionTarget({ ...paneWithInstance, serverPid: "" }), "");
assert.notEqual(
  buildTmuxPaneExecutionTarget(paneWithInstance),
  buildTmuxPaneExecutionTarget({ ...paneWithInstance, serverPid: "43211" }),
  "A recreated tmux server/pane instance must not inherit completed executions."
);
assert.equal(buildTmuxShellQueueKey(paneWithInstance), buildTmuxShellQueueKey({ ...paneWithInstance }));
assert.notEqual(
  buildTmuxShellQueueKey(paneWithInstance),
  buildTmuxShellQueueKey({ ...paneWithInstance, id: "%31", address: "main:2.2" }),
  "Different tmux panes must not share the shell execution queue."
);
assert.equal(
  buildTmuxShellQueueKey(paneWithInstance),
  buildTmuxShellQueueKey({
    ...paneWithInstance,
    sessionCreated: "1784112001",
    windowIndex: "9",
    address: "main:9.1",
    label: "main:9.1 dev"
  }),
  "Moving the same immutable tmux pane must not let it bypass its execution queue."
);
assert.notEqual(
  buildTmuxShellQueueKey(paneWithInstance),
  buildTmuxShellQueueKey({ ...paneWithInstance, serverPid: "43211" }),
  "A pane id reused by a new tmux server must not inherit an old execution queue."
);
assert.equal(
  buildTmuxShellQueueKey({ ...paneWithInstance, serverPid: "", address: "main:2.1" }),
  buildTmuxShellQueueKey({ ...paneWithInstance, serverPid: "", address: "main:9.1" }),
  "Missing server metadata must conservatively keep the same pane id serialized across address changes."
);
assert.equal(isConfirmedTmuxExecution({ executed: true, executionCompleted: true, exitCode: 7 }), true);
assert.equal(isConfirmedTmuxExecution({ executed: true, executionCompleted: false, timedOut: true }), false);
assert.equal(isConfirmedTmuxExecution({ executed: false, executionCompleted: true }), false);

const boardPanes = parseTmuxPanes([
  "%40\tForAI\t0\tboard\t0\t1\t/Users/rjwang\tscreen",
  "%41\tForAI\t1\thost\t0\t1\t/Users/rjwang\tzsh",
  "%45\tForAI\t2\tboard-R1\t0\t1\t/Users/rjwang\tscreen"
].join("\n"));
assert.deepEqual(getForAiTmuxConfig(), {
  sessionName: "ForAI",
  hostWindowName: "host",
  boardWindowName: "board",
  cwd: fs.realpathSync(path.join(__dirname, "..")),
  cwdSource: "project-root"
});
assert.equal(resolveDefaultShellPane(boardPanes).pane.id, "%41");
assert.equal(resolveTmuxTarget("host", boardPanes).id, "%41");
assert.equal(resolveBoardPane(boardPanes).pane.id, "%40");
assert.equal(resolveBoardPane(boardPanes, "", "board-R1").pane.id, "%45");
assert.equal(resolveBoardPane(boardPanes, "%41").pane.id, "%41");
assert.equal(resolveBoardPane(boardPanes, "ForAI:0.0").pane.id, "%40");
assert.equal(resolveBoardPane(boardPanes, "missing").pane, null);
assert.match(resolveBoardPane(boardPanes, "", "board-SAT2").error, /No tmux pane found in ForAI:board-SAT2/);
assert.match(resolveBoardPane(parseTmuxPanes("%42\tForAI\t1\thost\t0\t1\t/Users/rjwang\tzsh")).error, /No tmux pane/);
assert.match(resolveBoardPane(parseTmuxPanes([
  "%43\tForAI\t0\tboard\t0\t1\t/Users/rjwang\tscreen",
  "%44\tForAI\t1\tboard\t0\t1\t/Users/rjwang\tscreen"
].join("\n"))).error, /Multiple tmux panes/);
assert.equal(buildBoardHelperExample("version"), "ai-helper-board-start\nversion\nai-helper-board-end");
assert.equal(buildBoardHelperExample("status", "board-R1"), "ai-helper-board-R1-start\nstatus\nai-helper-board-R1-end");
assert.equal(buildBoardTargetErrorResponse({
  message: { id: "board-call-1", callKey: "board-key-1" },
  cmd: "version",
  panes: boardPanes,
  error: "No board"
}).example, "ai-helper-board-start\nversion\nai-helper-board-end");
assert.equal(buildBoardTargetErrorResponse({
  message: { id: "board-call-2", callKey: "board-key-2" },
  cmd: "status",
  boardName: "board-R1",
  panes: boardPanes,
  error: "No board-R1"
}).example, "ai-helper-board-R1-start\nstatus\nai-helper-board-R1-end");
assert.match(buildBoardLogPath(boardPanes[0]), /ForAI_0_0__40\.log$/);
assert.deepEqual(buildTmuxCommandArgs(["list-panes"], "/private/tmp/tmux-501/default"), [
  "-S",
  "/private/tmp/tmux-501/default",
  "list-panes"
]);
assert.deepEqual(buildTmuxCommandArgs(["list-panes"], ""), ["list-panes"]);
const fakeSocketDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-helper-test-"));
const fakeSocketPath = path.join(fakeSocketDir, "default");
fs.writeFileSync(fakeSocketPath, "");
assert.equal(getTmuxEnvSocketPath(`${fakeSocketPath},123,0`), fakeSocketPath);
assert.equal(getTmuxEnvSocketPath(`${fakeSocketPath}-missing,123,0`), "");
fs.rmSync(fakeSocketDir, { recursive: true, force: true });

{
  const script = buildTmuxRunScript({
    cmd: "printf 'ok\\n'",
    cwd: "/tmp/project",
    startMarker: "__START__",
    doneMarker: "__DONE__",
    pidPath: "/tmp/run.pid",
    statusPath: "/tmp/run.status",
    executedPath: "/tmp/run.executed",
    interruptedPath: "/tmp/run.interrupted"
  });
  assert.match(script, /printf '\\n%s\\n' '__START__'/);
  assert.match(script, /__ai_chat_shell_exec_finish_signal/);
  assert.match(script, /finish_signal INT 130/);
  assert.match(script, /finish_signal TERM 143/);
  assert.match(script, /finish_signal HUP 129/);
  assert.doesNotMatch(script, /\) &/);
  assert.doesNotMatch(script, /__ai_chat_shell_exec_pid=\$!/);
  assert.match(script, /\/tmp\/run\.pid/);
  assert.match(script, /"\$\$" > '\/tmp\/run\.pid'/);
  assert.match(script, /\/tmp\/run\.status/);
  assert.match(script, /\/tmp\/run\.executed/);
  assert.match(script, /\/tmp\/run\.interrupted/);
  assert.ok(script.indexOf("/tmp/run.executed") < script.indexOf("printf 'ok\\n'"));
  assert.match(script, /__DONE__/);
}

{
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-run-state-"));
  const pidPath = path.join(stateDir, "run.pid");
  const statusPath = path.join(stateDir, "run.status");
  assert.deepEqual(readTmuxShellRunState(pidPath, statusPath), {
    completed: false,
    exitCode: 124,
    pid: 0,
    processKnown: false,
    processAlive: false
  });
  fs.writeFileSync(pidPath, String(process.pid));
  assert.deepEqual(readTmuxShellRunState(pidPath, statusPath), {
    completed: false,
    exitCode: 124,
    pid: process.pid,
    processKnown: true,
    processAlive: true
  });
  fs.writeFileSync(statusPath, "7\n");
  assert.deepEqual(readTmuxShellRunState(pidPath, statusPath), {
    completed: true,
    exitCode: 7,
    pid: process.pid,
    processKnown: true,
    processAlive: false
  });
  fs.rmSync(stateDir, { recursive: true, force: true });
}

{
  const result = extractTmuxRunOutput([
    "prompt /bin/zsh /tmp/run.zsh",
    "__AI_CHAT_SHELL_EXEC_START_abc__",
    "hello",
    "world",
    "__AI_CHAT_SHELL_EXEC_DONE_abc__:0",
    "prompt"
  ].join("\n"), "__AI_CHAT_SHELL_EXEC_START_abc__", "__AI_CHAT_SHELL_EXEC_DONE_abc__", 1000);
  assert.equal(result.foundStart, true);
  assert.equal(result.foundDone, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "hello\nworld");
  assert.equal(result.truncated, false);
}

{
  const result = extractTmuxRunOutput([
    "__AI_CHAT_SHELL_EXEC_START_def__",
    "failure",
    "__AI_CHAT_SHELL_EXEC_DONE_def__:2"
  ].join("\n"), "__AI_CHAT_SHELL_EXEC_START_def__", "__AI_CHAT_SHELL_EXEC_DONE_def__", 1000);
  assert.equal(result.exitCode, 2);
  assert.equal(result.stdout, "failure");
}

{
  const result = extractTmuxRunOutput([
    "__AI_CHAT_SHELL_EXEC_START_ghi__",
    "partial output"
  ].join("\n"), "__AI_CHAT_SHELL_EXEC_START_ghi__", "__AI_CHAT_SHELL_EXEC_DONE_ghi__", 7);
  assert.equal(result.foundStart, true);
  assert.equal(result.foundDone, false);
  assert.equal(result.exitCode, 124);
  assert.equal(result.stdout, "partial");
  assert.equal(result.truncated, true);
}

{
  const result = extractTmuxRunOutput("no markers", "start", "done", 1000);
  assert.equal(result.foundStart, false);
  assert.equal(result.foundDone, false);
  assert.equal(result.stdout, "");
}

{
  assert.equal(normalizeBoardOutput("\u001b[32mESP>\u001b[0m\r\nok\rESP> "), "ESP>\nESP>");
  assert.equal(normalizeBoardOutput("prompt % \u001b[Kp\bps\r\n  PID TTY\r\n\u001b[1m\u001b[7m%\u001b[27m\u001b[0m          \r \b\u001b[Kprompt % \u001b[K"), "prompt % ps\n  PID TTY\nprompt %");
  assert.equal(normalizeBoardOutput("a\tb\r\n\u001b[4Cindented"), "a       b\n    indented");
  assert.equal(extractBoardPromptSignature("\r\nESP32> "), "ESP32>");
  assert.equal(outputEndsWithBoardPrompt("version\n1.2.3\nESP32>   ", "ESP32>"), true);
  assert.equal(outputEndsWithBoardPrompt("version\n1.2.3\nbusy", "ESP32>"), false);
  assert.doesNotThrow(() => validateBoardCommand("version"));
  assert.throws(() => validateBoardCommand("version\nhelp"), /exactly one command line/);
  assert.throws(() => validateBoardCommand("ai-helper-board-start"), /copied shell-output text/);
  assert.throws(() => validateBoardCommand("ai-helper-board-R1-start"), /copied shell-output text/);
  assert.throws(() => validateBoardCommand("ai-helper-board-R1-end"), /copied shell-output text/);
}

{
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-helper-board-log-"));
  const logPath = path.join(logDir, "board.log");
  fs.writeFileSync(logPath, "old output\n", "utf8");
  const offset = fs.statSync(logPath).size;
  fs.appendFileSync(logPath, "\u001b[31mversion\u001b[0m\r\n1.2.3\r\nESP> ", "utf8");
  const captured = readBoardLogFromOffset(logPath, offset, 12);
  assert.equal(captured.normalized, "version\n1.2.3\nESP>");
  assert.equal(captured.stdout, "version\n1.2.");
  assert.equal(captured.truncated, true);
  fs.rmSync(logDir, { recursive: true, force: true });
}

{
  const response = buildDefaultTargetErrorResponse({ id: "call-1", callKey: "key-1" }, "pwd", panes);
  assert.equal(response.ok, false);
  assert.equal(response.targetRequired, false);
  assert.equal(response.error.includes("Default tmux target is unavailable"), true);
  assert.equal(response.tmuxPanes.length, 2);
  assert.equal(response.example, "ai-helper-shell-start\npwd\nai-helper-shell-end");
}

{
  const downloadsDir = path.join(os.tmpdir(), "ai-helper-downloads");
  assert.equal(
    resolveDownloadsFilePath("hello.txt", downloadsDir),
    path.join(downloadsDir, "hello.txt")
  );
  assert.throws(() => resolveDownloadsFilePath("../bad.txt", downloadsDir), /single file name/);
  assert.throws(() => resolveDownloadsFilePath("nested/bad.txt", downloadsDir), /single file name/);
  assert.throws(() => resolveDownloadsFilePath("", downloadsDir), /Missing filename/);

  const written = writeDownloadsFile("hello.txt", "alpha\nbeta", downloadsDir);
  assert.equal(written.path, path.join(downloadsDir, "hello.txt"));
  assert.equal(written.bytes, Buffer.byteLength("alpha\nbeta", "utf8"));
  assert.equal(fs.readFileSync(written.path, "utf8"), "alpha\nbeta");
  fs.rmSync(downloadsDir, { recursive: true, force: true });
}

Promise.all([
  assert.rejects(
    () => handleMessageText(JSON.stringify({
      type: "run-board",
      id: "invalid-board-name-host",
      callKey: "invalid-board-name-host",
      boardName: "host",
      cmd: "version"
    })),
    /Board name must be empty or board-<suffix>/
  ),
  assert.rejects(
    () => handleMessageText(JSON.stringify({
      type: "run-board",
      id: "invalid-board-name-injection",
      callKey: "invalid-board-name-injection",
      boardName: "board-R1;send-keys",
      cmd: "version"
    })),
    /Board name must be empty or board-<suffix>/
  )
]).then(() => {
  console.log("tmux helper tests passed");
}).catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
