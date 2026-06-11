#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sentPayloads = [];
const localStore = {};
const syncStore = {};

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    setTimeout(() => {
      this.listeners.open?.forEach((callback) => callback());
    }, 0);
  }

  addEventListener(event, callback) {
    this.listeners[event] ||= [];
    this.listeners[event].push(callback);
  }

  send(text) {
    const payload = JSON.parse(text);
    sentPayloads.push(payload);
    setTimeout(() => {
      if (payload.type === "run-board") {
        this.listeners.message?.forEach((callback) => callback({
          data: JSON.stringify({
            ok: true,
            id: payload.id,
            callKey: payload.callKey,
            cmd: payload.cmd,
            target: "%40",
            targetName: "ForAI:0.0 board",
            exitCode: 0,
            stdout: "board-ok\nBOARD> ",
            stderr: "",
            timedOut: false,
            truncated: false,
            durationMs: 4
          })
        }));
        return;
      }

      this.listeners.message?.forEach((callback) => callback({
        data: JSON.stringify({
          ok: true,
          id: payload.id,
          callKey: payload.callKey,
          filename: payload.filename,
          path: `/home/test/Downloads/${payload.filename}`,
          bytes: Buffer.byteLength(payload.content || "", "utf8"),
          durationMs: 3
        })
      }));
    }, 0);
  }

  close() {}
}

const context = {
  AbortController,
  chrome: {
    runtime: {
      id: "lkmeogidbglhedgekjgbpbfjkpapnhke",
      getManifest: () => ({ version: "0.5.2" }),
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener() {} }
    },
    storage: {
      sync: {
        get(keys, callback) {
          callback(Object.fromEntries(keys.map((key) => [key, syncStore[key]])));
        },
        set(value) {
          Object.assign(syncStore, value);
        }
      },
      local: {
        get(key, callback) {
          const value = typeof key === "string" ? { [key]: localStore[key] } : localStore;
          if (callback) {
            callback(value);
          }
          return Promise.resolve(value);
        },
        set(value, callback) {
          Object.assign(localStore, value);
          if (callback) {
            callback();
          }
          return Promise.resolve();
        }
      }
    }
  },
  clearTimeout,
  console,
  fetch: async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      ok: true,
      allowedOrigin: "chrome-extension://lkmeogidbglhedgekjgbpbfjkpapnhke",
      releaseVersion: "0.5.2",
      serverReleaseVersion: "0.5.2",
      protocolVersion: 3,
      serverProtocolVersion: 3,
      helperProtocolVersion: 1
    })
  }),
  setTimeout,
  WebSocket: FakeWebSocket
};

vm.createContext(context);
const script = fs.readFileSync(path.join(__dirname, "..", "extension", "src", "background.js"), "utf8");
vm.runInContext(script, context, { filename: "background.js" });

async function main() {
  const response = await context.handleWriteFileMessage({
    type: "write-file",
    id: "file-1",
    callKey: "file-key-1",
    filename: "helper.txt",
    content: "alpha\nbeta",
    callMeta: { origin: "https://chatgpt.com" }
  });

  assert.equal(response.ok, true);
  assert.equal(response.filename, "helper.txt");
  assert.equal(response.bytes, Buffer.byteLength("alpha\nbeta", "utf8"));
  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0].type, "write-file");
  assert.equal(sentPayloads[0].filename, "helper.txt");
  assert.equal(sentPayloads[0].content, "alpha\nbeta");
  assert.equal(localStore["shellCallLedger:v1"].calls["file-key-1"].state, "completed");

  const duplicate = await context.handleWriteFileMessage({
    type: "write-file",
    id: "file-1",
    callKey: "file-key-1",
    filename: "helper.txt",
    content: "alpha\nbeta"
  });
  assert.equal(duplicate.skipped, true);
  assert.equal(sentPayloads.length, 1);

  const now = Date.now();
  localStore["shellCallLedger:v1"].calls["ttl-key"] = {
    state: "completed",
    completedAt: now - 10_000
  };
  const recentCompletedClaim = await context.claimShellCall("ttl-key", {
    cmd: "echo recent",
    target: "%40",
    timeoutMs: 30000,
    callMeta: {}
  });
  assert.equal(recentCompletedClaim.action, "skip");
  assert.equal(recentCompletedClaim.reason, "recently-completed");

  localStore["shellCallLedger:v1"].calls["ttl-key"] = {
    state: "completed",
    completedAt: now - 61_000
  };
  const expiredCompletedClaim = await context.claimShellCall("ttl-key", {
    cmd: "echo rerun",
    target: "%40",
    timeoutMs: 30000,
    callMeta: {}
  });
  assert.equal(expiredCompletedClaim.action, "run");

  const boardResponse = await context.handleRunBoardMessage({
    type: "run-board",
    id: "board-1",
    callKey: "board-key-1",
    cmd: "version",
    callMeta: { origin: "https://chatgpt.com" }
  });
  assert.equal(boardResponse.ok, true);
  assert.equal(boardResponse.target, "%40");
  assert.equal(boardResponse.stdout, "board-ok\nBOARD> ");
  assert.equal(sentPayloads.length, 2);
  assert.equal(sentPayloads[1].type, "run-board");
  assert.equal(sentPayloads[1].cmd, "version");
  assert.equal(sentPayloads[1].timeoutMs, 30000);
  assert.equal(sentPayloads[1].maxOutputChars, 20000);
  assert.equal(localStore["shellCallLedger:v1"].calls["board-key-1"].state, "completed");
  assert.equal(localStore["shellCallLedger:v1"].calls["board-key-1"].target, "%40");

  const duplicateBoard = await context.handleRunBoardMessage({
    type: "run-board",
    id: "board-1",
    callKey: "board-key-1",
    cmd: "version"
  });
  assert.equal(duplicateBoard.skipped, true);
  assert.equal(sentPayloads.length, 2);

  const forcedBoard = await context.handleRunBoardMessage({
    type: "run-board",
    id: "board-1",
    callKey: "board-key-1",
    cmd: "version",
    callMeta: { force: true }
  });
  assert.equal(forcedBoard.ok, true);
  assert.equal(forcedBoard.skipped, undefined);
  assert.equal(sentPayloads.length, 3);
  assert.equal(sentPayloads[2].force, true);
  assert.equal(sentPayloads[2].callMeta.force, true);
  assert.equal(localStore["shellCallLedger:v1"].calls["board-key-1"].forced, true);

  const originalFetch = context.fetch;
  context.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      ok: true,
      allowedOrigin: "chrome-extension://lkmeogidbglhedgekjgbpbfjkpapnhke",
      releaseVersion: "0.4.0",
      serverReleaseVersion: "0.4.0",
      protocolVersion: 2,
      serverProtocolVersion: 2,
      helperProtocolVersion: 1
    })
  });

  await assert.rejects(
    () => context.handleRunShellMessage({
      type: "run-shell",
      id: "shell-protocol-mismatch",
      callKey: "shell-protocol-mismatch",
      cmd: "printf stale-server"
    }),
    /protocol mismatch/
  );
  assert.equal(sentPayloads.length, 3);
  assert.equal(localStore["shellCallLedger:v1"].calls["shell-protocol-mismatch"].state, "failed");

  await assert.rejects(
    () => context.handleWriteFileMessage({
      type: "write-file",
      id: "file-protocol-mismatch",
      callKey: "file-protocol-mismatch",
      filename: "stale-server.txt",
      content: "must not send"
    }),
    /protocol mismatch/
  );
  assert.equal(sentPayloads.length, 3);
  assert.equal(localStore["shellCallLedger:v1"].calls["file-protocol-mismatch"].state, "failed");

  await assert.rejects(
    () => context.handleRunBoardMessage({
      type: "run-board",
      id: "board-protocol-mismatch",
      callKey: "board-protocol-mismatch",
      cmd: "version"
    }),
    /protocol mismatch/
  );
  assert.equal(sentPayloads.length, 3);
  assert.equal(localStore["shellCallLedger:v1"].calls["board-protocol-mismatch"].state, "failed");
  context.fetch = originalFetch;

  console.log("background write-file and board message tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
