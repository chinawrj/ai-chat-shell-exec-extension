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
const longOutput = context.formatShellOutput({ cmd: longCommand, target: "%24" }, response, "2026-05-22T00:00:00.000Z");
const longCommandLine = longOutput.split("\n").find((line) => line.startsWith("$ "));
assert.ok(longCommandLine.length <= 66, longCommandLine);
assert.match(longOutput, /^cmdHash: [a-f0-9]+$/m);
assert.equal(context.isSameCommandAsShellOutput(longCommand, longOutput), true);
assert.equal(context.isSameCommandAsShellOutput(`${longCommand}x`, longOutput), false);
assert.match(longOutput, /stdout:\nok/);

const shortCommand = "pwd";
const shortOutput = context.formatShellOutput({ cmd: shortCommand, target: "%24" }, response, "2026-05-22T00:00:00.000Z");
assert.match(shortOutput, /^\$ pwd$/m);
assert.doesNotMatch(shortOutput, /^cmdHash:/m);
assert.equal(context.isSameCommandAsShellOutput(shortCommand, shortOutput), true);

const multilineCommand = "printf one\nprintf two";
const multilineOutput = context.formatShellOutput({ cmd: multilineCommand, target: "%24" }, response, "2026-05-22T00:00:00.000Z");
assert.match(multilineOutput, /^\$ printf one printf two$/m);
assert.match(multilineOutput, /^cmdHash: [a-f0-9]+$/m);
assert.equal(context.isSameCommandAsShellOutput(multilineCommand, multilineOutput), true);

console.log("content shell-output format tests passed");
