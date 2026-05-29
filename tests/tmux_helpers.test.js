#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildTmuxCommandArgs,
  buildMissingTargetResponse,
  extractTmuxRunOutput,
  getTmuxEnvSocketPath,
  parseTmuxPanes,
  resolveDownloadsFilePath,
  resolveTmuxTarget,
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
  const response = buildMissingTargetResponse({ id: "call-1", callKey: "key-1" }, "pwd", panes);
  assert.equal(response.ok, false);
  assert.equal(response.targetRequired, true);
  assert.equal(response.error.includes("Missing tmux target"), true);
  assert.equal(response.tmuxPanes.length, 2);
  assert.equal(response.example, "ai-helper-shell-start\n%24\npwd\nai-helper-shell-end");
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
