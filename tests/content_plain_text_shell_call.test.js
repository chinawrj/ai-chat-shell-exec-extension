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
assert.equal(parsed.helperIdSource, "payload-hash");
assert.equal(parsed.helperId.length > 0, true);
assert.equal(parsed.target, "%24");
assert.equal(parsed.cmd, command);
const [extracted] = context.parsePlainTextHelperBlocks(`before\n${block}\nafter`);
assert.equal(extracted.helperId, parsed.helperId);
assert.equal(extracted.target, "%24");
assert.equal(extracted.cmd, command);
assert.equal(context.validateHelperCall(parsed).ok, true);
assert.equal(context.validateShellCall({ cmd: block }).ok, false);

const [fencedExtracted] = context.parsePlainTextHelperBlocks(`\`\`\`text\n${block}\n\`\`\``);
assert.equal(fencedExtracted.target, "%24");
assert.equal(fencedExtracted.cmd, command);
assert.equal(context.validateHelperCall(fencedExtracted).ok, true);

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

const suffixedShellA = context.parseCallPayload("ai-helper-shell-start:1001\n%24\npwd\nai-helper-shell-end");
const suffixedShellB = context.parseCallPayload("ai-helper-shell-start:1002\n%24\npwd\nai-helper-shell-end");
assert.equal(suffixedShellA.kind, "shell");
assert.equal(suffixedShellA.helperId, "1001");
assert.equal(suffixedShellA.helperIdSource, "marker");
assert.equal(suffixedShellA.cmd, "pwd");
assert.notEqual(context.buildSemanticCallKey(suffixedShellA), context.buildSemanticCallKey(suffixedShellB));
assert.notEqual(context.buildSemanticCallKey(suffixedShellA), context.buildSemanticCallKey(parsedEmptyTarget));

const repeatedUnsuffixedA = context.parseCallPayload("ai-helper-shell-start\n%24\npwd\nai-helper-shell-end");
const repeatedUnsuffixedB = context.parseCallPayload("ai-helper-shell-start\n%24\npwd\nai-helper-shell-end");
assert.equal(repeatedUnsuffixedA.helperIdSource, "payload-hash");
assert.equal(repeatedUnsuffixedA.helperId, repeatedUnsuffixedB.helperId);
assert.equal(context.buildSemanticCallKey(repeatedUnsuffixedA), context.buildSemanticCallKey(repeatedUnsuffixedB));

const previousPwdOutput = "Shell call result:\n\n```shell-output\n$ pwd\ntarget: %24\nexitCode: 0\n```";
assert.equal(context.shouldSuppressShellCallEcho(repeatedUnsuffixedA, previousPwdOutput, ""), true);
assert.equal(context.shouldSuppressShellCallEcho(suffixedShellA, previousPwdOutput, ""), false);

const malformedSuffixedShell = context.parseCallPayload("ai-helper-shell-start:not valid\n%24\npwd\nai-helper-shell-end");
assert.equal(malformedSuffixedShell.kind, "shell");
assert.equal(malformedSuffixedShell.helperIdSource, "payload-hash");
assert.match(context.validateHelperCall(malformedSuffixedShell).reason, /Malformed helper identity suffix/);

const fileContent = "line one\n{\"json\":\"does not need escaping\"}\nline three";
const fileBlock = [
  "ai-helper-file-start",
  "helper-output.txt",
  fileContent,
  "ai-helper-file-end"
].join("\n");
const parsedFile = context.parseCallPayload(fileBlock);
assert.equal(parsedFile.kind, "file");
assert.equal(parsedFile.helperIdSource, "payload-hash");
assert.equal(parsedFile.filename, "helper-output.txt");
assert.equal(parsedFile.content, fileContent);
assert.equal(context.validateHelperCall(parsedFile).ok, true);

const suffixedFile = context.parseCallPayload([
  "ai-helper-file-start:file-1001",
  "helper-output.txt",
  fileContent,
  "ai-helper-file-end"
].join("\n"));
assert.equal(suffixedFile.kind, "file");
assert.equal(suffixedFile.helperId, "file-1001");
assert.equal(suffixedFile.helperIdSource, "marker");
assert.equal(suffixedFile.filename, "helper-output.txt");

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

const boardBlock = [
  "ai-helper-board-start",
  "version",
  "ai-helper-board-end"
].join("\n");
const parsedBoard = context.parseCallPayload(boardBlock);
assert.equal(context.containsToolLanguageHint(boardBlock), true);
assert.equal(parsedBoard.kind, "board");
assert.equal(parsedBoard.helperIdSource, "payload-hash");
assert.equal(parsedBoard.cmd, "version");
assert.equal(context.validateHelperCall(parsedBoard).ok, true);
assert.equal(context.isRunnableHelperCall(parsedBoard), true);

const suffixedBoardA = context.parseCallPayload("ai-helper-board-start:board-1001\nversion\nai-helper-board-end");
const suffixedBoardB = context.parseCallPayload("ai-helper-board-start:board-1002\nversion\nai-helper-board-end");
assert.equal(suffixedBoardA.kind, "board");
assert.equal(suffixedBoardA.helperId, "board-1001");
assert.equal(suffixedBoardA.helperIdSource, "marker");
assert.notEqual(context.buildSemanticCallKey(suffixedBoardA), context.buildSemanticCallKey(suffixedBoardB));

const multiLineBoard = context.parseCallPayload("ai-helper-board-start\nversion\nhelp\nai-helper-board-end");
assert.equal(multiLineBoard.kind, "board");
assert.equal(context.validateHelperCall(multiLineBoard).ok, false);
assert.match(context.validateHelperCall(multiLineBoard).reason, /exactly one command line/);

const emptyBoard = context.parseCallPayload("ai-helper-board-start\nai-helper-board-end");
assert.equal(emptyBoard.kind, "board");
assert.equal(context.validateHelperCall(emptyBoard).ok, false);
assert.match(context.validateHelperCall(emptyBoard).reason, /empty/);

const boardWithMarker = context.parseCallPayload("ai-helper-board-start\nai-helper-shell-start\nai-helper-board-end");
assert.equal(context.validateHelperCall(boardWithMarker).ok, false);
assert.match(context.validateHelperCall(boardWithMarker).reason, /copied terminal\/output text/);

const indentedMarker = context.parseCallPayload(" ai-helper-shell-start\n%24\npwd\nai-helper-shell-end");
assert.equal(indentedMarker.cmd, "");

console.log("content plain text shell-call tests passed");
