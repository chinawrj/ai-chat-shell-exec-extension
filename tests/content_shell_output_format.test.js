#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const context = {
  CSS: { escape: (value) => String(value) },
  Element: class Element {},
  InputEvent: class InputEvent {},
  MutationObserver: class MutationObserver {},
  Node: {
    DOCUMENT_POSITION_FOLLOWING: 4,
    DOCUMENT_POSITION_PRECEDING: 2
  },
  chrome: {
    runtime: { id: "lkmeogidbglhedgekjgbpbfjkpapnhke" },
    storage: {
      onChanged: { addListener() {} },
      sync: { get: async () => ({ enabled: false }) },
      local: { get: async () => ({}) }
    }
  },
  clearTimeout,
  console,
  document: {
    getElementById: () => null,
    removeEventListener() {}
  },
  location: {
    hostname: "chatgpt.com",
    origin: "https://chatgpt.com",
    pathname: "/",
    protocol: "https:"
  },
  setTimeout,
  window: {
    confirm: () => true,
    removeEventListener() {}
  }
};

vm.createContext(context);
const source = fs.readFileSync(path.join(__dirname, "..", "extension", "src", "content.js"), "utf8");
vm.runInContext(source, context, { filename: "content.js" });

const response = {
  cwd: "/tmp/project",
  durationMs: 12,
  exitCode: 0,
  stdout: "ok\n",
  target: "%24",
  targetName: "session:0.0 build"
};

const longCommand = `printf ${"x".repeat(160)}`;
const longOutput = context.formatShellOutput({ cmd: longCommand }, response, "2026-05-22T00:00:00.000Z");
const longCommandLine = longOutput.split("\n").find((line) => line.startsWith("$ "));
assert.ok(longCommandLine.length <= 66, longCommandLine);
assert.match(longOutput, /^cmdHash: [a-f0-9]+$/m);
assert.equal(context.isSameCommandAsShellOutput(longCommand, longOutput), true);
assert.equal(context.isSameCommandAsShellOutput(`${longCommand}x`, longOutput), false);
assert.match(longOutput, /stdout:\nok/);

const shortCommand = "pwd";
const shortOutput = context.formatShellOutput({ cmd: shortCommand }, response, "2026-05-22T00:00:00.000Z");
assert.match(shortOutput, /^\$ pwd$/m);
assert.doesNotMatch(shortOutput, /^cmdHash:/m);
assert.equal(context.isSameCommandAsShellOutput(shortCommand, shortOutput), true);

const multilineCommand = "printf one\nprintf two";
const multilineOutput = context.formatShellOutput({ cmd: multilineCommand }, response, "2026-05-22T00:00:00.000Z");
assert.match(multilineOutput, /^\$ printf one printf two$/m);
assert.match(multilineOutput, /^cmdHash: [a-f0-9]+$/m);
assert.equal(context.isSameCommandAsShellOutput(multilineCommand, multilineOutput), true);

const timeoutOutput = context.formatShellOutput({ cmd: "sleep 10" }, {
  ...response,
  exitCode: 124,
  processAlive: false,
  processKnown: false,
  stderr: "Timed out waiting for tmux command completion marker and could not confirm a running shell process.",
  timedOut: true,
  timeoutReason: "process-state-unknown"
}, "2026-05-22T00:00:00.000Z");
assert.match(timeoutOutput, /^timedOut: true$/m);
assert.match(timeoutOutput, /^timeoutReason: process-state-unknown$/m);
assert.match(timeoutOutput, /^processKnown: false$/m);
assert.match(timeoutOutput, /^processAlive: false$/m);
assert.match(timeoutOutput, /stderr:\nTimed out waiting/);

const continuedOutput = context.formatShellOutput({ cmd: "sleep 2" }, {
  ...response,
  continuedAfterTimeout: true
}, "2026-05-22T00:00:00.000Z");
assert.match(continuedOutput, /^continuedAfterTimeout: true$/m);

const queuedOutput = context.formatShellOutput({ cmd: "printf queued" }, {
  ...response,
  queued: true,
  queuedMs: 2450
}, "2026-05-22T00:00:00.000Z");
assert.match(queuedOutput, /^queued: true$/m);
assert.match(queuedOutput, /^queuedMs: 2450$/m);

const interruptedOutput = context.formatShellOutput({ cmd: "sleep 60" }, {
  ...response,
  exitCode: 130,
  interrupted: true,
  interruptSignal: "INT",
  stderr: "Command interrupted by Ctrl+C (SIGINT)."
}, "2026-05-22T00:00:00.000Z");
assert.match(interruptedOutput, /^interrupted: true$/m);
assert.match(interruptedOutput, /^interruptSignal: INT$/m);
assert.doesNotMatch(interruptedOutput, /^timedOut: true$/m);
assert.match(interruptedOutput, /stderr:\nCommand interrupted by Ctrl\+C \(SIGINT\)\./);

const duplicateOutput = context.formatShellOutput({ cmd: "pwd" }, {
  ...response,
  duplicate: true,
  skipped: true,
  reason: "already-executed-on-target",
  previousCallKey: "previous-call",
  previousInterrupted: true,
  previousInterruptSignal: "INT"
}, "2026-05-22T00:00:00.000Z");
assert.match(duplicateOutput, /^duplicate: true$/m);
assert.match(duplicateOutput, /^skipped: true$/m);
assert.match(duplicateOutput, /^reason: already-executed-on-target$/m);
assert.match(duplicateOutput, /^previousCallKey: previous-call$/m);
assert.match(duplicateOutput, /^previousInterrupted: true$/m);
assert.match(duplicateOutput, /^previousInterruptSignal: INT$/m);

console.log("content shell-output format tests passed");
