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
  command,
  "ai-helper-shell-end"
].join("\n");

assert.equal(context.containsToolLanguageHint(block), true);
const parsed = context.parseCallPayload(block);
assert.equal(parsed.helperIdSource, "payload-hash");
assert.equal(parsed.helperId.length > 0, true);
assert.equal(parsed.target, undefined);
assert.equal(parsed.cmd, command);
const [extracted] = context.parsePlainTextHelperBlocks(`before\n${block}\nafter`);
assert.equal(extracted.helperId, parsed.helperId);
assert.equal(extracted.target, undefined);
assert.equal(extracted.cmd, command);
assert.equal(context.validateHelperCall(parsed).ok, true);
assert.equal(context.validateShellCall({ cmd: block }).ok, false);

const [fencedExtracted] = context.parsePlainTextHelperBlocks(`\`\`\`\`\n${block}\n\`\`\`\``);
assert.equal(fencedExtracted.target, undefined);
assert.equal(fencedExtracted.cmd, command);
assert.equal(context.validateHelperCall(fencedExtracted).ok, true);

const [fencedFallbackShell] = context.parsePlainTextHelperBlocks([
  "````",
  "ai-helper-shell-start",
  "pwd",
  "````"
].join("\n"));
assert.equal(fencedFallbackShell.kind, "shell");
assert.equal(fencedFallbackShell.inferredEndMarker, true);
assert.equal(fencedFallbackShell.cmd, "pwd");
assert.equal(context.validateHelperCall(fencedFallbackShell).ok, true);
assert.equal(
  fencedFallbackShell.helperId,
  context.parseCallPayload("ai-helper-shell-start\npwd\nai-helper-shell-end").helperId
);

const parsedFencedFallbackShell = context.parseCallPayload([
  "````",
  "ai-helper-shell-start",
  "pwd",
  "````"
].join("\n"));
assert.equal(parsedFencedFallbackShell.kind, "shell");
assert.equal(parsedFencedFallbackShell.inferredEndMarker, true);
assert.equal(parsedFencedFallbackShell.cmd, "pwd");

assert.equal(context.parsePlainTextHelperBlocks("ai-helper-shell-start\npwd\n````").length, 0);
assert.equal(context.parsePlainTextHelperBlocks("````\nai-helper-shell-start\npwd").length, 0);

const [fencedFallbackBeforeLaterEnd] = context.parsePlainTextHelperBlocks([
  "````",
  "ai-helper-shell-start",
  "echo FENCE_BOUNDARY",
  "````",
  "later text",
  "ai-helper-shell-end"
].join("\n"));
assert.equal(fencedFallbackBeforeLaterEnd.inferredEndMarker, true);
assert.equal(fencedFallbackBeforeLaterEnd.cmd, "echo FENCE_BOUNDARY");

const commandWithLeadingBlank = [
  "ai-helper-shell-start",
  "",
  "pwd",
  "ai-helper-shell-end"
].join("\n");
const parsedLeadingBlank = context.parseCallPayload(commandWithLeadingBlank);
assert.equal(parsedLeadingBlank.target, undefined);
assert.equal(parsedLeadingBlank.cmd, "pwd");

const defaultTargetShell = context.parseCallPayload("ai-helper-shell-start\npwd\nai-helper-shell-end");
assert.equal(defaultTargetShell.target, undefined);
assert.equal(defaultTargetShell.cmd, "pwd");
assert.equal(context.validateHelperCall(defaultTargetShell).ok, true);

const shellStartAlias = context.parseCallPayload("ai-helper-start-shell\n%24\npwd\nai-helper-end-shell");
assert.equal(shellStartAlias.cmd, "");
assert.equal(shellStartAlias.target, undefined);
assert.equal(context.containsToolLanguageHint("ai-helper-start-shell\n%24\npwd\nai-helper-end-shell"), false);
assert.equal(context.validateShellCall({ cmd: "ai-helper-start-shell\n%24\npwd\nai-helper-end-shell" }).ok, false);

const suffixedShellA = context.parseCallPayload("ai-helper-shell-start:1001\npwd\nai-helper-shell-end");
const suffixedShellB = context.parseCallPayload("ai-helper-shell-start:1002\npwd\nai-helper-shell-end");
assert.equal(suffixedShellA.kind, "shell");
assert.equal(suffixedShellA.helperId, "1001");
assert.equal(suffixedShellA.helperIdSource, "marker");
assert.equal(suffixedShellA.cmd, "pwd");
assert.notEqual(context.buildSemanticCallKey(suffixedShellA), context.buildSemanticCallKey(suffixedShellB));
assert.notEqual(context.buildSemanticCallKey(suffixedShellA), context.buildSemanticCallKey(parsedLeadingBlank));

const repeatedUnsuffixedA = context.parseCallPayload("ai-helper-shell-start\npwd\nai-helper-shell-end");
const repeatedUnsuffixedB = context.parseCallPayload("ai-helper-shell-start\npwd\nai-helper-shell-end");
assert.equal(repeatedUnsuffixedA.helperIdSource, "payload-hash");
assert.equal(repeatedUnsuffixedA.helperId, repeatedUnsuffixedB.helperId);
assert.equal(context.buildSemanticCallKey(repeatedUnsuffixedA), context.buildSemanticCallKey(repeatedUnsuffixedB));

const previousPwdOutput = "Shell call result:\n\n```shell-output\n$ pwd\ntarget: %24\nexitCode: 0\n```";
assert.equal(context.shouldSuppressShellCallEcho(repeatedUnsuffixedA, previousPwdOutput, ""), true);
assert.equal(context.shouldSuppressShellCallEcho(suffixedShellA, previousPwdOutput, ""), false);

const heredocShell = context.parseCallPayload([
  "ai-helper-shell-start",
  "cat > /tmp/ai-helper-heredoc.txt <<'EOF'",
  "hello",
  "EOF",
  "printf done",
  "ai-helper-shell-end"
].join("\n"));
assert.equal(heredocShell.target, undefined);
assert.equal(heredocShell.cmd, "cat > /tmp/ai-helper-heredoc.txt <<'EOF'\nhello\nEOF\nprintf done");
assert.equal(context.validateHelperCall(heredocShell).ok, true);

const legacyTargetLineIsCommand = context.parseCallPayload("ai-helper-shell-start\n%24\npwd\nai-helper-shell-end");
assert.equal(legacyTargetLineIsCommand.target, undefined);
assert.equal(legacyTargetLineIsCommand.cmd, "%24\npwd");

const malformedSuffixedShell = context.parseCallPayload("ai-helper-shell-start:not valid\npwd\nai-helper-shell-end");
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

const [fencedFallbackFile] = context.parsePlainTextHelperBlocks([
  "````",
  "ai-helper-file-start",
  "fallback-file.txt",
  "line one",
  "",
  "````"
].join("\n"));
assert.equal(fencedFallbackFile.kind, "file");
assert.equal(fencedFallbackFile.inferredEndMarker, true);
assert.equal(fencedFallbackFile.filename, "fallback-file.txt");
assert.equal(fencedFallbackFile.content, "line one\n");
assert.equal(context.validateHelperCall(fencedFallbackFile).ok, true);

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

const [fencedFallbackBoard] = context.parsePlainTextHelperBlocks([
  "````",
  "ai-helper-board-start",
  "version",
  "````"
].join("\n"));
assert.equal(fencedFallbackBoard.kind, "board");
assert.equal(fencedFallbackBoard.inferredEndMarker, true);
assert.equal(fencedFallbackBoard.cmd, "version");
assert.equal(context.validateHelperCall(fencedFallbackBoard).ok, true);

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

const agentMessageBlock = [
  "ai-helper-agent-message-start",
  "to: slave-a",
  "task-id: task-001",
  "reply-to: msg-parent-001",
  "",
  "Inspect parser behavior.",
  "Report back with findings.",
  "ai-helper-agent-message-end"
].join("\n");
const parsedAgentMessage = context.parseCallPayload(agentMessageBlock);
assert.equal(context.containsToolLanguageHint(agentMessageBlock), true);
assert.equal(parsedAgentMessage.kind, "agent-message");
assert.equal(parsedAgentMessage.helperIdSource, "payload-hash");
assert.equal(parsedAgentMessage.to, "slave-a");
assert.equal(parsedAgentMessage.taskId, "task-001");
assert.equal(parsedAgentMessage.replyTo, "msg-parent-001");
assert.equal(parsedAgentMessage.body, "Inspect parser behavior.\nReport back with findings.");
assert.equal(context.validateHelperCall(parsedAgentMessage).ok, true);
assert.equal(context.isRunnableHelperCall(parsedAgentMessage), true);

const suffixedAgentMessageA = context.parseCallPayload([
  "ai-helper-agent-message-start:agent-1001",
  "to: slave-a",
  "",
  "hello",
  "ai-helper-agent-message-end"
].join("\n"));
const suffixedAgentMessageB = context.parseCallPayload([
  "ai-helper-agent-message-start:agent-1002",
  "to: slave-a",
  "",
  "hello",
  "ai-helper-agent-message-end"
].join("\n"));
assert.equal(suffixedAgentMessageA.kind, "agent-message");
assert.equal(suffixedAgentMessageA.helperId, "agent-1001");
assert.notEqual(context.buildSemanticCallKey(suffixedAgentMessageA), context.buildSemanticCallKey(suffixedAgentMessageB));

const [fencedFallbackAgentMessage] = context.parsePlainTextHelperBlocks([
  "````",
  "ai-helper-agent-message-start",
  "to: master",
  "task-id: task-002",
  "",
  "done",
  "````"
].join("\n"));
assert.equal(fencedFallbackAgentMessage.kind, "agent-message");
assert.equal(fencedFallbackAgentMessage.inferredEndMarker, true);
assert.equal(fencedFallbackAgentMessage.to, "master");
assert.equal(fencedFallbackAgentMessage.taskId, "task-002");
assert.equal(fencedFallbackAgentMessage.body, "done");
assert.equal(context.validateHelperCall(fencedFallbackAgentMessage).ok, true);

const missingAgentRecipient = context.parseCallPayload([
  "ai-helper-agent-message-start",
  "task-id: task-003",
  "",
  "hello",
  "ai-helper-agent-message-end"
].join("\n"));
assert.equal(missingAgentRecipient.kind, "agent-message");
assert.equal(context.validateHelperCall(missingAgentRecipient).ok, false);
assert.match(context.validateHelperCall(missingAgentRecipient).reason, /missing a to header/);

const unsafeAgentRecipient = context.parseCallPayload([
  "ai-helper-agent-message-start",
  "to: ../slave",
  "",
  "hello",
  "ai-helper-agent-message-end"
].join("\n"));
assert.equal(context.validateHelperCall(unsafeAgentRecipient).ok, false);
assert.match(context.validateHelperCall(unsafeAgentRecipient).reason, /safe agent id/);

const unsafeAgentReplyTo = context.parseCallPayload([
  "ai-helper-agent-message-start",
  "to: master",
  "reply-to: ../msg",
  "",
  "hello",
  "ai-helper-agent-message-end"
].join("\n"));
assert.equal(context.validateHelperCall(unsafeAgentReplyTo).ok, false);
assert.match(context.validateHelperCall(unsafeAgentReplyTo).reason, /reply-to must be a safe message id/);

const emptyAgentBody = context.parseCallPayload([
  "ai-helper-agent-message-start",
  "to: slave-a",
  "",
  "ai-helper-agent-message-end"
].join("\n"));
assert.equal(context.validateHelperCall(emptyAgentBody).ok, false);
assert.match(context.validateHelperCall(emptyAgentBody).reason, /body is empty/);

const slaveInboundPrompt = context.formatInboundAgentPrompt({
  role: "slave",
  agentId: "slave-a"
}, {
  from: "master",
  messageId: "msg-001",
  taskId: "task-001",
  body: "Inspect parser behavior."
});
assert.match(slaveInboundPrompt, /You are slave-a/);
assert.match(slaveInboundPrompt, /ai-helper-agent-message-start/);
assert.match(slaveInboundPrompt, /to: master/);
assert.match(slaveInboundPrompt, /task-id: task-001/);
assert.match(slaveInboundPrompt, /reply-to: msg-001/);
assert.match(slaveInboundPrompt, /ai-helper-agent-message-end/);

const masterInboundPrompt = context.formatInboundAgentPrompt({
  role: "master",
  agentId: "master"
}, {
  from: "slave-a",
  taskId: "task-001",
  body: "Done."
});
assert.match(masterInboundPrompt, /Message from slave-a for task task-001:/);
assert.match(masterInboundPrompt, /Done\./);
assert.equal(masterInboundPrompt.includes("<your result>"), false);

assert.equal(context.getSuggestedAgentIdForRole("master"), "master");
assert.equal(context.getSuggestedAgentIdForRole("none"), "");
assert.equal(context.formatAgentRosterSummary([
  { agentId: "master", role: "master", pendingCount: 0 },
  { agentId: "slave-a", role: "slave", pendingCount: 2 },
  { agentId: "slave-b", role: "slave" }
], { "slave-b": 1 }), "master:master, slave-a:slave pending:2, slave-b:slave pending:1");

const indentedMarker = context.parseCallPayload(" ai-helper-shell-start\n%24\npwd\nai-helper-shell-end");
assert.equal(indentedMarker.cmd, "");

console.log("content plain text shell-call tests passed");
