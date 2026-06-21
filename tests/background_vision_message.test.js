#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sentPayloads = [];
let healthBody = currentHealthBody();

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
      this.listeners.message?.forEach((callback) => callback({
        data: JSON.stringify({
          ok: true,
          id: payload.id,
          type: payload.type,
          callKey: payload.callKey,
          exitCode: payload.type === "vision-visual-run-line" ? 0 : undefined,
          durationMs: payload.type === "vision-visual-run-line" ? 5 : undefined,
          windows: payload.type === "vision-list-tmux-windows"
            ? [{ windowId: 44, appName: "Ghostty", visualAdapter: "tmux-ocr" }]
            : undefined
        })
      }));
    }, 0);
  }

  close() {}
}

const localStore = {};
const syncStore = {};
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
  console,
  fetch: async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(healthBody)
  }),
  setTimeout,
  WebSocket: FakeWebSocket
};

vm.createContext(context);
const script = fs.readFileSync(path.join(__dirname, "..", "extension", "src", "background.js"), "utf8");
vm.runInContext(script, context, { filename: "background.js" });

(async () => {
  const response = await context.handleVisionMessage({
    type: "vision-list-tmux-windows",
    id: "vision-1"
  });
  assert.equal(response.ok, true);
  assert.equal(response.type, "vision-list-tmux-windows");
  assert.equal(response.windows[0].appName, "Ghostty");
  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0].type, "vision-list-tmux-windows");

  const commandResponse = await context.handleVisionMessage({
    type: "vision-visual-run-line",
    id: "vision-run-1",
    callKey: "vision-run-key-1",
    windowId: 44,
    appName: "Ghostty",
    cmd: "printf ok"
  });
  assert.equal(commandResponse.ok, true);
  assert.equal(commandResponse.callKey, "vision-run-key-1");
  assert.equal(sentPayloads.length, 2);
  assert.equal(sentPayloads[1].type, "vision-visual-run-line");
  assert.equal(sentPayloads[1].seq, 1);
  assert.equal(localStore["shellCallLedger:v1"].calls["vision-run-key-1"].state, "completed");
  assert.equal(localStore["shellCallLedger:v1"].calls["vision-run-key-1"].target, "vision-window:44");

  const duplicateCommand = await context.handleVisionMessage({
    type: "vision-visual-run-line",
    id: "vision-run-1",
    callKey: "vision-run-key-1",
    windowId: 44,
    appName: "Ghostty",
    cmd: "printf ok"
  });
  assert.equal(duplicateCommand.skipped, true);
  assert.equal(sentPayloads.length, 2);

  const listWindows = await context.handleVisionMessage({
    type: "vision-list-windows",
    id: "vision-list-windows-blocked"
  });
  assert.equal(listWindows.ok, false);
  assert.match(listWindows.error, /Unsupported background vision message type/);
  assert.equal(sentPayloads.length, 2);

  const lowLevelType = await context.handleVisionMessage({
    type: "vision-type",
    id: "vision-type-blocked",
    windowId: 44,
    text: "printf blocked"
  });
  assert.equal(lowLevelType.ok, false);
  assert.match(lowLevelType.error, /Unsupported background vision message type/);
  assert.equal(sentPayloads.length, 2);

  const directTmuxRun = await context.handleVisionMessage({
    type: "vision-tmux-run-line",
    id: "vision-tmux-run-blocked",
    target: "%1",
    cmd: "printf blocked"
  });
  assert.equal(directTmuxRun.ok, false);
  assert.match(directTmuxRun.error, /Unsupported background vision message type/);
  assert.equal(sentPayloads.length, 2);

  healthBody = {
    ...currentHealthBody(),
    releaseVersion: "0.4.0",
    serverReleaseVersion: "0.4.0",
    protocolVersion: 2,
    serverProtocolVersion: 2
  };
  await assert.rejects(
    () => context.handleVisionMessage({
      type: "vision-list-tmux-windows",
      id: "vision-stale"
    }),
    /protocol mismatch/
  );
  assert.equal(sentPayloads.length, 2);

  console.log("background vision message tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function currentHealthBody() {
  return {
    ok: true,
    allowedOrigin: "chrome-extension://lkmeogidbglhedgekjgbpbfjkpapnhke",
    releaseVersion: "0.6.0",
    serverReleaseVersion: "0.6.0",
    protocolVersion: 4,
    serverProtocolVersion: 4,
    helperProtocolVersion: 1
  };
}
