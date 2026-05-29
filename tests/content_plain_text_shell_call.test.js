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

const command = [
  "printf '%s\\n' '{\"name\":\"ai-chat-shell-exec\"}'",
  "node -e \"console.log(process.cwd())\""
].join("\n");
const block = [
  "ai-helper-shell-start",
  "%24",
  command,
  "ai-helper-shell-end"
].join("\n");

assert.equal(context.containsToolLanguageHint(block), true);
const parsed = context.parseCallPayload(block);
assert.equal(parsed.target, "%24");
assert.equal(parsed.cmd, command);
const [extracted] = context.parsePlainTextHelperBlocks(`before\n${block}\nafter`);
assert.equal(extracted.target, "%24");
assert.equal(extracted.cmd, command);
assert.equal(context.validateHelperCall(parsed).ok, true);
assert.equal(context.validateShellCall({ cmd: block }).ok, false);

const emptyTarget = [
  "ai-helper-shell-start",
  "",
  "pwd",
  "ai-helper-shell-end"
].join("\n");
const parsedEmptyTarget = context.parseCallPayload(emptyTarget);
assert.equal(parsedEmptyTarget.target, "");
assert.equal(parsedEmptyTarget.cmd, "pwd");

const shellStartAlias = context.parseCallPayload("ai-helper-start-shell\n%24\npwd\nai-helper-end-shell");
assert.equal(shellStartAlias.cmd, "");
assert.equal(shellStartAlias.target, undefined);
assert.equal(context.containsToolLanguageHint("ai-helper-start-shell\n%24\npwd\nai-helper-end-shell"), false);
assert.equal(context.validateShellCall({ cmd: "ai-helper-start-shell\n%24\npwd\nai-helper-end-shell" }).ok, false);

const fileContent = "line one\n{\"json\":\"does not need escaping\"}\nline three";
const fileBlock = [
  "ai-helper-file-start",
  "helper-output.txt",
  fileContent,
  "ai-helper-file-end"
].join("\n");
const parsedFile = context.parseCallPayload(fileBlock);
assert.equal(parsedFile.kind, "file");
assert.equal(parsedFile.filename, "helper-output.txt");
assert.equal(parsedFile.content, fileContent);
assert.equal(context.validateHelperCall(parsedFile).ok, true);

const fileWithTrailingBlankLine = context.parseCallPayload([
  "ai-helper-file-start",
  "blank.txt",
  "line",
  "",
  "ai-helper-file-end"
].join("\n"));
assert.equal(fileWithTrailingBlankLine.content, "line\n");

const legacyJson = context.parseCallPayload("{\"target\":\"%24\",\"cmd\":\"pwd\"}");
assert.equal(legacyJson.cmd, "");
assert.equal(legacyJson.target, undefined);

const oldMarker = context.parseCallPayload("shell-call-start\n%24\npwd\nshell-call-end");
assert.equal(oldMarker.cmd, "");

const indentedMarker = context.parseCallPayload(" ai-helper-shell-start\n%24\npwd\nai-helper-shell-end");
assert.equal(indentedMarker.cmd, "");

console.log("content plain text shell-call tests passed");
