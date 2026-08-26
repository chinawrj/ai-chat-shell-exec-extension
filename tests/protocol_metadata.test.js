#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.join(__dirname, "..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-shell-protocol-"));
const originalStateDir = process.env.AI_CHAT_SHELL_STATE_DIR;
const originalVisionTmuxApps = process.env.AI_CHAT_SHELL_VISION_TMUX_APPS;

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  process.env.AI_CHAT_SHELL_STATE_DIR = path.join(tmpRoot, "state");
  try {
    const server = require(path.join(repoRoot, "server", "shell_server.js"));
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "extension", "manifest.json"), "utf8"));
    const doctorSource = fs.readFileSync(path.join(repoRoot, "scripts", "doctor.sh"), "utf8");

    assert.equal(server.SERVER_PROTOCOL_VERSION, 11);
    assert.equal(server.HELPER_PROTOCOL_VERSION, 4);
    assert.equal(server.SKILL_PROTOCOL_VERSION, 1);
    assert.match(doctorSource, new RegExp(`EXPECTED_SERVER_PROTOCOL_VERSION=${server.SERVER_PROTOCOL_VERSION}(?:\\n|$)`));
    assert.match(doctorSource, new RegExp(`EXPECTED_HELPER_PROTOCOL_VERSION=${server.HELPER_PROTOCOL_VERSION}(?:\\n|$)`));
    assert.match(doctorSource, new RegExp(`EXPECTED_SKILL_PROTOCOL_VERSION=${server.SKILL_PROTOCOL_VERSION}(?:\\n|$)`));
    assert.deepEqual(server.getVisionTmuxAppNames(), ["Terminal", "Ghostty"]);
    process.env.AI_CHAT_SHELL_VISION_TMUX_APPS = "Ghostty,Google Chrome,bad\napp";
    assert.deepEqual(server.getVisionTmuxAppNames(), ["Ghostty"]);
    process.env.AI_CHAT_SHELL_VISION_TMUX_APPS = "bad\napp";
    assert.deepEqual(server.getVisionTmuxAppNames(), ["Terminal", "Ghostty"]);
    delete process.env.AI_CHAT_SHELL_VISION_TMUX_APPS;

    const metadata = server.getProtocolMetadata();
    assert.equal(metadata.releaseVersion, manifest.version);
    assert.equal(metadata.serverReleaseVersion, manifest.version);
    assert.equal(metadata.protocolVersion, 11);
    assert.equal(metadata.serverProtocolVersion, 11);
    assert.equal(metadata.helperProtocolVersion, 4);
    assert.equal(metadata.skillProtocolVersion, 1);
    assert.equal(metadata.helperProtocol, "ai-helper-plain-text");
    assert.equal(metadata.visualProtocolVersion, 1);
    assert.deepEqual(metadata.visualTmuxApps, ["Terminal", "Ghostty"]);

    const health = server.buildHealthResponse();
    assert.equal(health.ok, true);
    assert.equal(health.service, "ai-chat-shell-exec-server");
    assert.equal(health.serverReleaseVersion, manifest.version);
    assert.equal(health.serverProtocolVersion, 11);
    assert.equal(health.helperProtocolVersion, 4);
    assert.equal(health.skillProtocolVersion, 1);
    assert.equal(health.visualProtocolVersion, 1);
    assert.deepEqual(health.visualTmuxApps, ["Terminal", "Ghostty"]);
    assert.equal(health.executionBackend, "tmux");
    assert.equal(health.tmuxDefaultSession, "ForAI");
    assert.equal(health.maxShellScriptBytes, 1024 * 1024);
    assert.equal(health.maxInteractiveCommandChars, 8000);
    assert.equal(health.maxWebSocketMessageBytes, 2 * 1024 * 1024);

    awaitBackgroundHealthCase({
      name: "current protocol",
      body: {
        ok: true,
        allowedOrigin: "chrome-extension://lkmeogidbglhedgekjgbpbfjkpapnhke",
        releaseVersion: manifest.version,
        serverReleaseVersion: manifest.version,
        protocolVersion: 11,
        serverProtocolVersion: 11,
        helperProtocolVersion: 4,
        skillProtocolVersion: 1
      },
      assertHealth: (result) => {
        assert.equal(result.ok, true);
        assert.equal(result.protocolMatches, true);
        assert.equal(result.helperProtocolMatches, true);
        assert.equal(result.skillProtocolMatches, true);
        assert.equal(result.releaseMatches, true);
        assert.equal(result.requiredServerProtocolVersion, 11);
        assert.equal(result.requiredHelperProtocolVersion, 4);
        assert.equal(result.requiredSkillProtocolVersion, 1);
      }
    });

    awaitBackgroundHealthCase({
      name: "old server without helper protocol",
      body: {
        ok: true,
        allowedOrigin: "chrome-extension://lkmeogidbglhedgekjgbpbfjkpapnhke",
        protocolVersion: 2
      },
      assertHealth: (result) => {
        assert.equal(result.ok, false);
        assert.equal(result.staleServer, true);
        assert.equal(result.protocolMatches, false);
        assert.equal(result.helperProtocolMatches, false);
        assert.match(result.error, /Expected server protocol 11, helper protocol 4, and Skill protocol 1/);
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
        protocolVersion: 11,
        serverProtocolVersion: 11,
        helperProtocolVersion: 0,
        skillProtocolVersion: 1
      },
      assertHealth: (result) => {
        assert.equal(result.ok, false);
        assert.equal(result.protocolMatches, true);
        assert.equal(result.helperProtocolMatches, false);
        assert.match(result.error, /helper protocol 4/);
      }
    });

    awaitBackgroundHealthCase({
      name: "missing helper protocol on current server protocol",
      body: {
        ok: true,
        allowedOrigin: "chrome-extension://lkmeogidbglhedgekjgbpbfjkpapnhke",
        releaseVersion: manifest.version,
        serverReleaseVersion: manifest.version,
        protocolVersion: 11,
        serverProtocolVersion: 11,
        skillProtocolVersion: 1
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
    if (originalVisionTmuxApps === undefined) {
      delete process.env.AI_CHAT_SHELL_VISION_TMUX_APPS;
    } else {
      process.env.AI_CHAT_SHELL_VISION_TMUX_APPS = originalVisionTmuxApps;
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
  const manifestVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "extension", "manifest.json"), "utf8")).version;
  return {
    AbortController,
    chrome: {
      runtime: {
        id: "lkmeogidbglhedgekjgbpbfjkpapnhke",
        getManifest: () => ({ version: manifestVersion }),
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
