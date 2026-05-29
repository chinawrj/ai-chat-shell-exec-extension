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
  chrome: {
    runtime: {
      id: "lkmeogidbglhedgekjgbpbfjkpapnhke",
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
  fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }),
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

  console.log("background write-file message tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
