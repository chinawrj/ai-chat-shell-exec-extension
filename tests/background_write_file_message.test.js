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
      if (payload.type === "run-status") {
        const board = payload.kind === "board";
        this.listeners.message?.forEach((callback) => callback({
          data: JSON.stringify({
            ok: true,
            found: true,
            state: "completed",
            completedAt: Date.now(),
            kind: board ? "board" : "shell",
            result: board ? {
              ok: true,
              exitCode: 0,
              stdout: "board-recovered\nBOARD> ",
              durationMs: 60000,
              executed: true,
              executionCompleted: false,
              completionObserved: true,
              target: "%40"
            } : { ok: true, exitCode: 0, stdout: "recovered\n", durationMs: 60000 }
          })
        }));
        return;
      }
      if (payload.type === "run-board") {
        this.listeners.message?.forEach((callback) => callback({
          data: JSON.stringify({
            ok: true,
            id: payload.id,
            callKey: payload.callKey,
            boardName: payload.boardName || "",
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
      if (payload.type === "run-result-presented") {
        this.listeners.message?.forEach((callback) => callback({
          data: JSON.stringify({
            ok: true,
            type: "run-result-presented",
            executionId: payload.executionId,
            found: true,
            matched: 1
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
      getManifest: () => ({ version: "0.6.0" }),
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
  clearInterval,
  console,
  fetch: async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      ok: true,
      allowedOrigin: "chrome-extension://lkmeogidbglhedgekjgbpbfjkpapnhke",
      releaseVersion: "0.6.0",
      serverReleaseVersion: "0.6.0",
      protocolVersion: 6,
      serverProtocolVersion: 6,
      helperProtocolVersion: 2
    })
  }),
  setTimeout,
  setInterval,
  WebSocket: FakeWebSocket
};

vm.createContext(context);
const script = fs.readFileSync(path.join(__dirname, "..", "extension", "src", "background.js"), "utf8");
vm.runInContext(script, context, { filename: "background.js" });

async function main() {
  const uiDelayStartedAt = Date.now();
  const uiDelay = await context.handleContentUiDelayMessage({
    type: "content-ui-delay",
    delayMs: 5
  });
  assert.deepEqual(JSON.parse(JSON.stringify(uiDelay)), {
    ok: true,
    type: "content-ui-delay",
    delayMs: 5
  });
  assert.ok(Date.now() - uiDelayStartedAt >= 4, "The background delay must not resolve synchronously.");

  assert.equal(context.shouldKeepWebSocketAlive({ type: "run" }), true);
  assert.equal(context.shouldKeepWebSocketAlive({ type: "run-board" }), true);
  assert.equal(context.shouldKeepWebSocketAlive({ type: "vision-visual-run-line" }), true);
  assert.equal(context.shouldKeepWebSocketAlive({ type: "vision-tmux-ocr-run-line" }), true);
  assert.equal(context.shouldKeepWebSocketAlive({ type: "write-file" }), false);
  assert.equal(context.getWebSocketWatchdogMs({ type: "run", timeoutMs: 1000 }), 0);
  assert.equal(context.getWebSocketWatchdogMs({ type: "run-board", timeoutMs: 1000 }), 0, "Board delivery keeps its pane lease until the prompt returns, even after crossing the response timeout.");
  assert.equal(context.getWebSocketWatchdogMs({ type: "write-file", timeoutMs: 30000 }), 35000);

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
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.skipped, undefined);
  assert.equal(sentPayloads.length, 2);
  assert.equal(sentPayloads[1].type, "write-file");

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
  assert.equal(recentCompletedClaim.action, "run");

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
  assert.equal(sentPayloads.length, 3);
  assert.equal(sentPayloads[2].type, "run-board");
  assert.equal(sentPayloads[2].cmd, "version");
  assert.equal(sentPayloads[2].boardName, "");
  assert.equal(sentPayloads[2].timeoutMs, 30000);
  assert.equal(sentPayloads[2].maxOutputChars, 20000);
  assert.equal(localStore["shellCallLedger:v1"].calls["board-key-1"].state, "completed");
  assert.equal(localStore["shellCallLedger:v1"].calls["board-key-1"].target, "%40");

  const duplicateBoard = await context.handleRunBoardMessage({
    type: "run-board",
    id: "board-1",
    callKey: "board-key-1",
    cmd: "version"
  });
  assert.equal(duplicateBoard.ok, true);
  assert.equal(duplicateBoard.skipped, undefined);
  assert.equal(sentPayloads.length, 4);

  const forcedBoard = await context.handleRunBoardMessage({
    type: "run-board",
    id: "board-1",
    callKey: "board-key-1",
    cmd: "version",
    callMeta: { force: true }
  });
  assert.equal(forcedBoard.ok, true);
  assert.equal(forcedBoard.skipped, undefined);
  assert.equal(sentPayloads.length, 5);
  assert.equal(sentPayloads[4].force, true);
  assert.equal(sentPayloads[4].callMeta.force, true);
  assert.equal(localStore["shellCallLedger:v1"].calls["board-key-1"].forced, true);

  const namedBoardResponse = await context.handleRunBoardMessage({
    type: "run-board",
    id: "board-r1",
    callKey: "board-key-r1",
    boardName: "board-R1",
    cmd: "status"
  });
  assert.equal(namedBoardResponse.ok, true);
  assert.equal(namedBoardResponse.boardName, "board-R1");
  assert.equal(sentPayloads.length, 6);
  assert.equal(sentPayloads[5].type, "run-board");
  assert.equal(sentPayloads[5].boardName, "board-R1");
  assert.equal(sentPayloads[5].cmd, "status");

  const forcedShell = await context.handleRunShellMessage({
    type: "run-shell",
    id: "shell-force-top-level",
    callKey: "shell-force-top-level",
    cmd: "printf forced-shell",
    force: true
  });
  assert.equal(forcedShell.ok, true);
  assert.equal(forcedShell.skipped, undefined);
  assert.equal(sentPayloads.length, 7);
  assert.equal(sentPayloads[6].type, "run");
  assert.equal(sentPayloads[6].force, true);
  assert.equal(localStore["shellCallLedger:v1"].calls["shell-force-top-level"].forced, true);

  localStore["shellCallLedger:v1"].calls["file-force-top-level"] = {
    state: "completed",
    completedAt: Date.now()
  };
  const forcedFile = await context.handleWriteFileMessage({
    type: "write-file",
    id: "file-force-top-level",
    callKey: "file-force-top-level",
    filename: "forced.txt",
    content: "forced file",
    force: true
  });
  assert.equal(forcedFile.ok, true);
  assert.equal(forcedFile.skipped, undefined);
  assert.equal(sentPayloads.length, 8);
  assert.equal(sentPayloads[7].type, "write-file");
  assert.equal(sentPayloads[7].force, true);
  assert.equal(localStore["shellCallLedger:v1"].calls["file-force-top-level"].forced, true);

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
      helperProtocolVersion: 2
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
  assert.equal(sentPayloads.length, 8);
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
  assert.equal(sentPayloads.length, 8);
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
  assert.equal(sentPayloads.length, 8);
  assert.equal(localStore["shellCallLedger:v1"].calls["board-protocol-mismatch"].state, "failed");
  context.fetch = originalFetch;

  const recoveredStatus = await context.handleRunShellStatusMessage({
    type: "run-shell-status",
    id: "recover-status",
    callKey: "recover-status-key"
  });
  assert.equal(recoveredStatus.state, "completed");
  assert.equal(recoveredStatus.result.stdout, "recovered\n");
  assert.equal(sentPayloads[8].type, "run-status");
  assert.equal(sentPayloads[8].callKey, "recover-status-key");
  assert.equal(localStore["shellCallLedger:v1"].calls["recover-status-key"].state, "completed");
  assert.equal(localStore["shellCallLedger:v1"].calls["recover-status-key"].recovered, true);

  const recoveredBoardStatus = await context.handleRunBoardStatusMessage({
    type: "run-board-status",
    id: "recover-board-status",
    callKey: "recover-board-status-key"
  });
  assert.equal(recoveredBoardStatus.state, "completed");
  assert.equal(recoveredBoardStatus.result.stdout, "board-recovered\nBOARD> ");
  assert.equal(sentPayloads[9].type, "run-status");
  assert.equal(sentPayloads[9].kind, "board");
  assert.equal(sentPayloads[9].callKey, "recover-board-status-key");
  assert.equal(localStore["shellCallLedger:v1"].calls["recover-board-status-key"].state, "completed");
  assert.equal(localStore["shellCallLedger:v1"].calls["recover-board-status-key"].recovered, true);
  assert.equal(localStore["shellCallLedger:v1"].calls["recover-board-status-key"].target, "%40");

  const presented = await context.handleRunResultPresentedMessage({
    type: "run-result-presented",
    executionId: "0123456789abcdef"
  });
  assert.equal(presented.ok, true);
  assert.equal(presented.found, true);
  assert.equal(sentPayloads[10].type, "run-result-presented");
  assert.equal(sentPayloads[10].executionId, "0123456789abcdef");
  await assert.rejects(
    () => context.handleRunResultPresentedMessage({ type: "run-result-presented", executionId: "not-valid" }),
    /invalid executionId/
  );

  await verifyLongCommandWebSocketHeartbeat();

  console.log("background write-file and board message tests passed");
}

async function verifyLongCommandWebSocketHeartbeat() {
  const OriginalWebSocket = context.WebSocket;
  const originalSetInterval = context.setInterval;
  const originalClearInterval = context.clearInterval;
  let intervalCallback = null;
  let intervalMs = 0;
  let clearedTimer = 0;
  let pendingSocket = null;
  let throwOnHeartbeat = false;
  const frames = [];

  class PendingWebSocket {
    constructor() {
      this.listeners = {};
      this.readyState = 1;
      pendingSocket = this;
      setTimeout(() => this.emit("open"), 0);
    }

    addEventListener(event, callback) {
      this.listeners[event] ||= [];
      this.listeners[event].push(callback);
    }

    send(text) {
      const frame = JSON.parse(text);
      if (throwOnHeartbeat && frame.type === "keepalive") {
        throw new Error("socket closed during heartbeat");
      }
      frames.push(frame);
    }

    close() {}

    emit(event, value = {}) {
      this.listeners[event]?.forEach((callback) => callback(value));
    }
  }

  context.WebSocket = PendingWebSocket;
  context.setInterval = (callback, ms) => {
    intervalCallback = callback;
    intervalMs = ms;
    return 91;
  };
  context.clearInterval = (timer) => {
    clearedTimer = timer;
  };

  try {
    const responsePromise = context.runShellViaWebSocket({
      type: "run",
      id: "heartbeat-run",
      cmd: "sleep 60"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].type, "run");
    assert.equal(intervalMs, 20_000);
    assert.equal(typeof intervalCallback, "function");

    intervalCallback();
    assert.deepEqual(frames[1], { type: "keepalive" });

    pendingSocket.emit("message", { data: JSON.stringify({ ok: true, exitCode: 0 }) });
    const response = await responsePromise;
    assert.equal(response.ok, true);
    assert.equal(clearedTimer, 91);

    intervalCallback();
    assert.equal(frames.length, 2, "A settled socket must stop emitting heartbeat frames.");

    throwOnHeartbeat = true;
    const closeRacePromise = context.runShellViaWebSocket({
      type: "run-board",
      id: "heartbeat-close-race",
      cmd: "monitor"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    intervalCallback();
    await assert.rejects(closeRacePromise, /socket closed during heartbeat/);
  } finally {
    context.WebSocket = OriginalWebSocket;
    context.setInterval = originalSetInterval;
    context.clearInterval = originalClearInterval;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
