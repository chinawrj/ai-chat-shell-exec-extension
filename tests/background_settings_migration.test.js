#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const defaultStore = {
  enabled: true,
  enabledHosts: ["chatgpt.com", "m365.cloud.microsoft"],
  requireApproval: false,
  autoSend: true,
  defaultTimeoutMs: 30000,
  maxOutputChars: 20000,
  maxChainCalls: 100
};

function runBackgroundWithStore(syncStore) {
  const writes = [];
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
            writes.push(value);
            Object.assign(syncStore, value);
          }
        },
        local: {
          get: async () => ({}),
          set: async () => {}
        }
      }
    },
    clearTimeout,
    console,
    fetch: async () => ({ ok: true, status: 200, text: async () => "{}" }),
    setTimeout,
    WebSocket: class {}
  };

  vm.createContext(context);
  const script = fs.readFileSync(path.join(__dirname, "..", "extension", "src", "background.js"), "utf8");
  vm.runInContext(script, context, { filename: "background.js" });
  return writes;
}

{
  const store = {
    ...defaultStore,
    enabledHosts: ["m365.cloud.microsoft"],
    maxChainCalls: "5"
  };
  const writes = runBackgroundWithStore(store);
  assert.equal(JSON.stringify(writes), JSON.stringify([{
    enabledHosts: ["chatgpt.com", "m365.cloud.microsoft"],
    maxChainCalls: 100,
    settingsMigrationVersion: 2
  }]));
}

{
  const store = {
    ...defaultStore,
    maxChainCalls: 5,
    settingsMigrationVersion: 2
  };
  const writes = runBackgroundWithStore(store);
  assert.equal(JSON.stringify(writes), "[]");
}

console.log("background settings migration tests passed");
