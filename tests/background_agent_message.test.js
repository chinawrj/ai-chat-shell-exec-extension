#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sentPayloads = [];

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
          type: payload.type,
          agentId: payload.agentId,
          messageId: payload.messageId,
          messages: payload.type === "agent-poll" ? [] : undefined
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
          callback(Object.fromEntries(keys.map((key) => [key, undefined])));
        },
        set() {}
      },
      local: {
        get(key, callback) {
          const value = typeof key === "string" ? { [key]: undefined } : {};
          if (callback) {
            callback(value);
          }
          return Promise.resolve(value);
        },
        set(_value, callback) {
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
      releaseVersion: "0.6.0",
      serverProtocolVersion: 3,
      helperProtocolVersion: 1,
      allowedOrigin: "chrome-extension://lkmeogidbglhedgekjgbpbfjkpapnhke",
      pid: 123
    })
  }),
  setTimeout,
  WebSocket: FakeWebSocket
};

vm.createContext(context);
const script = fs.readFileSync(path.join(__dirname, "..", "extension", "src", "background.js"), "utf8");
vm.runInContext(script, context, { filename: "background.js" });

(async () => {
  let response = await context.handleAgentMessage({
    type: "agent-register",
    agentId: "master",
    role: "master"
  });
  assert.equal(response.ok, true);
  assert.equal(sentPayloads[0].type, "agent-register");
  assert.equal(sentPayloads[0].agentId, "master");

  response = await context.handleAgentMessage({
    type: "agent-send",
    from: "master",
    to: "slave-a",
    body: "hello"
  });
  assert.equal(response.ok, true);
  assert.equal(sentPayloads[1].type, "agent-send");

  response = await context.handleAgentMessage({
    type: "agent-poll",
    agentId: "slave-a"
  });
  assert.equal(response.ok, true);
  assert.equal(Array.isArray(response.messages), true);
  assert.equal(response.messages.length, 0);
  assert.equal(sentPayloads[2].type, "agent-poll");

  response = await context.handleAgentMessage({
    type: "agent-ack",
    agentId: "slave-a",
    messageId: "msg-1"
  });
  assert.equal(response.ok, true);
  assert.equal(sentPayloads[3].type, "agent-ack");

  response = await context.handleAgentMessage({
    type: "agent-delete-everything",
    agentId: "master"
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /Unsupported background agent message type/);
  assert.equal(sentPayloads.length, 4);

  console.log("background agent message tests passed");
})();
