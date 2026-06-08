#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.join(__dirname, "..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-shell-protocol-"));
const originalStateDir = process.env.AI_CHAT_SHELL_STATE_DIR;

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  process.env.AI_CHAT_SHELL_STATE_DIR = path.join(tmpRoot, "state");
  try {
    const server = require(path.join(repoRoot, "server", "shell_server.js"));
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "extension", "manifest.json"), "utf8"));

    assert.equal(server.SERVER_PROTOCOL_VERSION, 2);
    assert.equal(server.HELPER_PROTOCOL_VERSION, 1);

    const metadata = server.getProtocolMetadata();
    assert.equal(metadata.releaseVersion, manifest.version);
    assert.equal(metadata.serverReleaseVersion, manifest.version);
    assert.equal(metadata.protocolVersion, 2);
    assert.equal(metadata.serverProtocolVersion, 2);
    assert.equal(metadata.helperProtocolVersion, 1);
    assert.equal(metadata.helperProtocol, "ai-helper-plain-text");

    const health = server.buildHealthResponse();
    assert.equal(health.ok, true);
    assert.equal(health.service, "ai-chat-shell-exec-server");
    assert.equal(health.serverReleaseVersion, manifest.version);
    assert.equal(health.serverProtocolVersion, 2);
    assert.equal(health.helperProtocolVersion, 1);
    assert.equal(health.executionBackend, "tmux");
    assert.equal(health.tmuxDefaultSession, "ForAI");

    awaitBackgroundHealthCase({
      name: "current protocol",
      body: {
        ok: true,
        allowedOrigin: "chrome-extension://lkmeogidbglhedgekjgbpbfjkpapnhke",
        releaseVersion: manifest.version,
        serverReleaseVersion: manifest.version,
        protocolVersion: 2,
        serverProtocolVersion: 2,
        helperProtocolVersion: 1
      },
      assertHealth: (result) => {
        assert.equal(result.ok, true);
        assert.equal(result.protocolMatches, true);
        assert.equal(result.helperProtocolMatches, true);
        assert.equal(result.releaseMatches, true);
        assert.equal(result.requiredServerProtocolVersion, 2);
        assert.equal(result.requiredHelperProtocolVersion, 1);
      }
    });

    awaitBackgroundHealthCase({
      name: "old server without helper protocol",
      body: {
        ok: true,
        allowedOrigin: "chrome-extension://lkmeogidbglhedgekjgbpbfjkpapnhke",
        protocolVersion: 1
      },
      assertHealth: (result) => {
        assert.equal(result.ok, false);
        assert.equal(result.staleServer, true);
        assert.equal(result.protocolMatches, false);
        assert.equal(result.helperProtocolMatches, false);
        assert.match(result.error, /Expected server protocol 2 and helper protocol 1/);
        assert.match(result.error, /start_shell_server\.sh/);
      }
    });

    awaitBackgroundHealthCase({
      name: "helper protocol mismatch",
      body: {
        ok: true,
        allowedOrigin: "chrome-extension://lkmeogidbglhedgekjgbpbfjkpapnhke",
        releaseVersion: manifest.version,
        serverReleaseVersion: manifest.version,
        protocolVersion: 2,
        serverProtocolVersion: 2,
        helperProtocolVersion: 0
      },
      assertHealth: (result) => {
        assert.equal(result.ok, false);
        assert.equal(result.protocolMatches, true);
        assert.equal(result.helperProtocolMatches, false);
        assert.match(result.error, /helper protocol 1/);
      }
    });

    awaitBackgroundHealthCase({
      name: "missing helper protocol on current server protocol",
      body: {
        ok: true,
        allowedOrigin: "chrome-extension://lkmeogidbglhedgekjgbpbfjkpapnhke",
        releaseVersion: manifest.version,
        serverReleaseVersion: manifest.version,
        protocolVersion: 2,
        serverProtocolVersion: 2
      },
      assertHealth: (result) => {
        assert.equal(result.ok, false);
        assert.equal(result.protocolMatches, true);
        assert.equal(result.helperProtocolMatches, false);
        assert.equal(Number.isNaN(result.helperProtocolVersion), true);
        assert.match(result.error, /helper protocol \(missing\)/);
      }
    });

    console.log("protocol metadata tests passed");
  } finally {
    if (originalStateDir === undefined) {
      delete process.env.AI_CHAT_SHELL_STATE_DIR;
    } else {
      process.env.AI_CHAT_SHELL_STATE_DIR = originalStateDir;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function awaitBackgroundHealthCase({ body, assertHealth }) {
  const context = makeBackgroundContext(body);
  const script = fs.readFileSync(path.join(repoRoot, "extension", "src", "background.js"), "utf8");
  vm.createContext(context);
  vm.runInContext(script, context, { filename: "background.js" });
  const result = await context.checkShellServerHealth();
  assertHealth(result);
}

function makeBackgroundContext(healthBody) {
  const syncStore = {};
  const localStore = {};
  return {
    AbortController,
    chrome: {
      runtime: {
        id: "lkmeogidbglhedgekjgbpbfjkpapnhke",
        getManifest: () => ({ version: "0.4.0" }),
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
    WebSocket: class FakeWebSocket {}
  };
}
