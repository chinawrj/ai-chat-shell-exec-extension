#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildBoardHelperExample,
  buildBoardLogPath,
  buildBoardTargetErrorResponse,
  buildDefaultTargetErrorResponse,
  buildTmuxCommandArgs,
  buildTmuxRunScript,
  extractTmuxRunOutput,
  extractBoardPromptSignature,
  getTmuxEnvSocketPath,
  getForAiTmuxConfig,
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

const boardPanes = parseTmuxPanes([
  "%40\tForAI\t0\tboard\t0\t1\t/Users/rjwang\tscreen",
  "%41\tForAI\t1\thost\t0\t1\t/Users/rjwang\tzsh"
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
assert.equal(resolveBoardPane(boardPanes, "%41").pane.id, "%41");
assert.equal(resolveBoardPane(boardPanes, "ForAI:0.0").pane.id, "%40");
assert.equal(resolveBoardPane(boardPanes, "missing").pane, null);
assert.match(resolveBoardPane(parseTmuxPanes("%42\tForAI\t1\thost\t0\t1\t/Users/rjwang\tzsh")).error, /No tmux pane/);
assert.match(resolveBoardPane(parseTmuxPanes([
  "%43\tForAI\t0\tboard\t0\t1\t/Users/rjwang\tscreen",
  "%44\tForAI\t1\tboard\t0\t1\t/Users/rjwang\tscreen"
].join("\n"))).error, /Multiple tmux panes/);
assert.equal(buildBoardHelperExample("version"), "ai-helper-board-start\nversion\nai-helper-board-end");
assert.equal(buildBoardTargetErrorResponse({
  message: { id: "board-call-1", callKey: "board-key-1" },
  cmd: "version",
  panes: boardPanes,
  error: "No board"
}).example, "ai-helper-board-start\nversion\nai-helper-board-end");
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
    statusPath: "/tmp/run.status"
  });
  assert.match(script, /printf '\\n%s\\n' '__START__'/);
  assert.match(script, /\) &/);
  assert.match(script, /__ai_chat_shell_exec_pid=\$!/);
  assert.match(script, /\/tmp\/run\.pid/);
  assert.match(script, /wait "\$__ai_chat_shell_exec_pid"/);
  assert.match(script, /\/tmp\/run\.status/);
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

console.log("tmux helper tests passed");
