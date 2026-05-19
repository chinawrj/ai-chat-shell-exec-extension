const SHELL_SERVER_URL = "ws://127.0.0.1:17371/shell";
const SHELL_SERVER_HEALTH_URL = "http://127.0.0.1:17371/health";
const CALL_LEDGER_KEY = "shellCallLedger:v1";
const CALL_LEDGER_LIMIT = 500;
const RUNNING_LOCK_GRACE_MS = 15000;
const DEFAULT_ENABLED_HOSTS = ["chatgpt.com", "m365.cloud.microsoft"];
const LEGACY_DEFAULT_ENABLED_HOSTS = ["m365.cloud.microsoft"];
const DEFAULT_SETTINGS = {
  enabled: true,
  enabledHosts: DEFAULT_ENABLED_HOSTS,
  requireApproval: false,
  autoSend: true,
  defaultTimeoutMs: 30000,
  maxOutputChars: 20000,
  maxChainCalls: 5
};

chrome.runtime.onInstalled.addListener(() => {
  ensureDefaultSettings();
});

chrome.runtime.onStartup.addListener(() => {
  ensureDefaultSettings();
});

ensureDefaultSettings();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === "shell-health") {
    checkShellServerHealth()
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || String(error)
      }));
    return true;
  }

  if (message.type === "tmux-list") {
    listTmuxTargets()
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || String(error),
        panes: []
      }));
    return true;
  }

  if (message.type !== "run-shell") {
    return false;
  }

  handleRunShellMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({
      ok: false,
      error: error.message || String(error)
    }));

  return true;
});

async function handleRunShellMessage(message) {
  const settings = await syncGet(["defaultTimeoutMs", "maxOutputChars"]);
  const timeoutMs = message.timeoutMs || settings.defaultTimeoutMs || 30000;
  const maxOutputChars = message.maxOutputChars || settings.maxOutputChars || 20000;
  const callKey = message.callKey || message.id || "";
  const payload = {
    type: "run",
    id: message.id,
    callKey,
    cmd: message.cmd,
    target: message.target,
    cwd: message.cwd,
    timeoutMs,
    maxOutputChars,
    callMeta: message.callMeta || {}
  };

  const claim = await claimShellCall(callKey, payload);
  if (claim.action === "skip") {
    return {
      ok: true,
      duplicate: true,
      skipped: true,
      callKey,
      reason: claim.reason
    };
  }

  payload.seq = claim.seq;
  try {
    const response = await runShellViaWebSocket(payload);
    await markShellCall(callKey, response?.ok === false ? "failed" : "completed", {
      completedAt: Date.now(),
      exitCode: response?.exitCode,
      durationMs: response?.durationMs,
      duplicate: response?.duplicate === true,
      skipped: response?.skipped === true,
      target: response?.target || payload.target || ""
    });
    return response;
  } catch (error) {
    await markShellCall(callKey, "failed", {
      completedAt: Date.now(),
      error: error.message || String(error)
    });
    throw error;
  }
}

async function checkShellServerHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(SHELL_SERVER_HEALTH_URL, {
      cache: "no-store",
      signal: controller.signal
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }

    const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
    const originMatches = body?.allowUntrustedOrigins === true || body?.allowedOrigin === extensionOrigin;

    return {
      ok: response.ok && body?.ok === true && originMatches,
      status: response.status,
      url: SHELL_SERVER_HEALTH_URL,
      extensionId: chrome.runtime.id,
      extensionOrigin,
      originMatches,
      ...body
    };
  } finally {
    clearTimeout(timer);
  }
}

function ensureDefaultSettings() {
  chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS), (current) => {
    const missing = {};
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (current[key] === undefined) {
        missing[key] = value;
      }
    }

    if (current.enabledHosts !== undefined && isLegacyDefaultEnabledHosts(current.enabledHosts)) {
      missing.enabledHosts = DEFAULT_ENABLED_HOSTS;
    }

    if (Object.keys(missing).length > 0) {
      chrome.storage.sync.set(missing);
    }
  });
}

function isLegacyDefaultEnabledHosts(value) {
  if (!Array.isArray(value)) {
    return false;
  }

  const hosts = normalizeHosts(value);
  const legacyHosts = normalizeHosts(LEGACY_DEFAULT_ENABLED_HOSTS);
  return hosts.length === legacyHosts.length && hosts.every((host, index) => host === legacyHosts[index]);
}

function normalizeHosts(value) {
  return Array.from(new Set(value.map(normalizeHost).filter(Boolean))).sort();
}

function normalizeHost(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) {
    return "";
  }

  try {
    return new URL(text.includes("://") ? text : `https://${text}`).hostname;
  } catch {
    return text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/:?#]/)[0];
  }
}

async function claimShellCall(callKey, payload) {
  if (!callKey) {
    return { action: "run", seq: Date.now() };
  }

  const now = Date.now();
  const store = await localGet(CALL_LEDGER_KEY);
  const ledger = store[CALL_LEDGER_KEY] || { nextSeq: 1, calls: {} };
  ledger.calls ||= {};
  const existing = ledger.calls[callKey];
  const lockTtl = Math.max(5000, Number(payload.timeoutMs || 30000) + RUNNING_LOCK_GRACE_MS);

  if (existing?.state === "completed") {
    return { action: "skip", reason: "completed" };
  }
  if (existing?.state === "running" && now - Number(existing.claimedAt || 0) < lockTtl) {
    return { action: "skip", reason: "running" };
  }

  const seq = Number(ledger.nextSeq || 1);
  ledger.nextSeq = seq + 1;
  ledger.calls[callKey] = {
    state: "running",
    seq,
    claimedAt: now,
    cmdHash: hashText(payload.cmd || ""),
    target: payload.target || "",
    origin: payload.callMeta?.origin || "",
    pathname: payload.callMeta?.pathname || "",
    promptHash: payload.callMeta?.promptHash || ""
  };
  pruneCallLedger(ledger);
  await localSet({ [CALL_LEDGER_KEY]: ledger });
  return { action: "run", seq };
}

async function markShellCall(callKey, state, extra = {}) {
  if (!callKey) {
    return;
  }

  const store = await localGet(CALL_LEDGER_KEY);
  const ledger = store[CALL_LEDGER_KEY] || { nextSeq: 1, calls: {} };
  ledger.calls ||= {};
  ledger.calls[callKey] = {
    ...(ledger.calls[callKey] || {}),
    state,
    ...extra
  };
  pruneCallLedger(ledger);
  await localSet({ [CALL_LEDGER_KEY]: ledger });
}

function pruneCallLedger(ledger) {
  const entries = Object.entries(ledger.calls || {});
  if (entries.length <= CALL_LEDGER_LIMIT) {
    return;
  }

  entries
    .sort(([, a], [, b]) => Number(b.completedAt || b.claimedAt || 0) - Number(a.completedAt || a.claimedAt || 0))
    .slice(CALL_LEDGER_LIMIT)
    .forEach(([key]) => {
      delete ledger.calls[key];
    });
}

function syncGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(keys, resolve);
  });
}

function localGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });
}

function localSet(values) {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, resolve);
  });
}

function hashText(input) {
  let hash = 2166136261;
  const text = String(input || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function listTmuxTargets() {
  return runShellViaWebSocket({ type: "tmux-list", timeoutMs: 5000 });
}

function runShellViaWebSocket(payload) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(SHELL_SERVER_URL);
    const timeout = setTimeout(() => {
      finish(reject, new Error("Shell server timed out."));
      tryClose(socket);
    }, Math.max(5000, Number(payload.timeoutMs || 30000) + 5000));

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(payload));
    });

    socket.addEventListener("message", (event) => {
      try {
        finish(resolve, JSON.parse(event.data));
      } catch (error) {
        finish(reject, error);
      } finally {
        clearTimeout(timeout);
        tryClose(socket);
      }
    });

    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      finish(reject, new Error("Cannot connect to shell server at ws://127.0.0.1:17371/shell."));
    });

    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      if (!settled) {
        finish(reject, new Error("Shell server closed the connection before returning a response."));
      }
    });

    function finish(callback, value) {
      if (settled) {
        return;
      }
      settled = true;
      callback(value);
    }
  });
}

function tryClose(socket) {
  try {
    socket.close();
  } catch {
    // Ignore close races.
  }
}
