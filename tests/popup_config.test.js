#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeElement() {
  return {
    checked: false,
    dataset: {},
    disabled: false,
    textContent: "",
    value: "",
    addEventListener() {},
    focus() {},
    select() {}
  };
}

function makeContext() {
  const elements = new Map();
  const ids = [
    "enabled",
    "enabledHosts",
    "autoSend",
    "requireApproval",
    "defaultTimeoutMs",
    "maxOutputChars",
    "maxChainCalls",
    "health",
    "save",
    "refreshHealth",
    "exportConfig",
    "importConfig",
    "portableConfig",
    "portableStatus"
  ];
  for (const id of ids) {
    elements.set(id, makeElement());
  }

  const syncStore = {
    enabled: true,
    enabledHosts: ["m365.cloud.microsoft", "https://chatgpt.com/"],
    autoSend: false,
    requireApproval: true,
    defaultTimeoutMs: 45000,
    maxOutputChars: 9000,
    maxChainCalls: 3
  };
  const localStore = {
    "composerProfile:https://chatgpt.com": {
      selector: "[role=\"textbox\"]",
      host: "chatgpt.com",
      savedAt: "2026-05-16T00:00:00.000Z"
    },
    "panelProfile:https://claude.ai": {
      left: 120,
      top: 240
    },
    "shellCallLedger:v1": {
      calls: {
        secret: {
          cmdHash: "should-not-export"
        }
      }
    }
  };
  const writes = {
    sync: null,
    local: null
  };

  const context = {
    chrome: {
      runtime: {
        id: "lkmeogidbglhedgekjgbpbfjkpapnhke",
        sendMessage: async () => ({ ok: true, pid: 123 })
      },
      storage: {
        sync: {
          get: async (keys) => Object.fromEntries(keys.map((key) => [key, syncStore[key]])),
          set: async (value) => {
            writes.sync = value;
          }
        },
        local: {
          get: async (keys) => {
            if (keys === null) {
              return localStore;
            }
            return {};
          },
          set: async (value) => {
            writes.local = value;
          }
        }
      }
    },
    document: {
      addEventListener(_event, callback) {
        callback();
      },
      getElementById(id) {
        return elements.get(id);
      }
    },
    setTimeout,
    console
  };

  vm.createContext(context);
  const script = fs.readFileSync(path.join(__dirname, "..", "extension", "src", "popup.js"), "utf8");
  vm.runInContext(script, context, { filename: "popup.js" });
  return { context, elements, writes };
}

(async () => {
  const { context, elements, writes } = makeContext();

  await context.exportConfig();
  const exported = JSON.parse(elements.get("portableConfig").value);
  assert.equal(exported.schema, "ai-chat-shell-exec-config");
  assert.equal(exported.version, 1);
  assert.deepEqual(exported.settings.enabledHosts, ["m365.cloud.microsoft", "chatgpt.com"]);
  assert.equal(exported.settings.autoSend, false);
  assert.equal(exported.localProfiles["composerProfile:https://chatgpt.com"].host, "chatgpt.com");
  assert.equal(exported.localProfiles["panelProfile:https://claude.ai"].left, 120);
  assert.equal(exported.localProfiles["shellCallLedger:v1"], undefined);

  elements.get("portableConfig").value = JSON.stringify({
    schema: "ai-chat-shell-exec-config",
    version: 1,
    settings: {
      enabled: false,
      enabledHosts: ["m365.cloud.microsoft", "https://claude.ai/chat", "", "CLAUDE.AI"],
      autoSend: true,
      requireApproval: true,
      defaultTimeoutMs: 9999999,
      maxOutputChars: "bad",
      maxChainCalls: 0
    },
    localProfiles: {
      "sendProfile:https://copilot.microsoft.com": {
        selector: "button[aria-label=\"Send\"]",
        host: "copilot.microsoft.com",
        savedAt: "2026-05-16T00:00:00.000Z",
        extra: "ignored"
      },
      "shellCallLedger:v1": {
        calls: {
          bad: true
        }
      }
    }
  });

  await context.importConfig();
  assert.equal(JSON.stringify(writes.sync), JSON.stringify({
    enabled: false,
    enabledHosts: ["m365.cloud.microsoft", "claude.ai"],
    autoSend: true,
    requireApproval: true,
    defaultTimeoutMs: 600000,
    maxOutputChars: 20000,
    maxChainCalls: 1
  }));
  assert.equal(JSON.stringify(writes.local), JSON.stringify({
    "sendProfile:https://copilot.microsoft.com": {
      selector: "button[aria-label=\"Send\"]",
      host: "copilot.microsoft.com",
      savedAt: "2026-05-16T00:00:00.000Z"
    }
  }));

  console.log("popup config tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
