const SHELL_SERVER_URL = "ws://127.0.0.1:17371/shell";
const SHELL_SERVER_HEALTH_URL = "http://127.0.0.1:17371/health";
const CALL_LEDGER_KEY = "shellCallLedger:v1";
const CALL_LEDGER_LIMIT = 500;
const DEFAULT_ENABLED_HOSTS = ["chatgpt.com", "m365.cloud.microsoft"];
const LEGACY_DEFAULT_ENABLED_HOSTS = ["m365.cloud.microsoft"];
const DEFAULT_MAX_CHAIN_CALLS = 100;
const LEGACY_DEFAULT_MAX_CHAIN_CALLS = 5;
const LEGACY_DEFAULT_TIMEOUT_MS = 30000;
const SETTINGS_MIGRATION_VERSION_KEY = "settingsMigrationVersion";
const SETTINGS_MIGRATION_VERSION = 3;
const TAB_AGENT_PROFILE_PREFIX = "tabAgentProfile:v1:";
const REQUIRED_SERVER_PROTOCOL_VERSION = 9;
const REQUIRED_HELPER_PROTOCOL_VERSION = 2;
const WEBSOCKET_HEARTBEAT_INTERVAL_MS = 20_000;
const CONTENT_UI_DELAY_MAX_MS = 2_000;
const BACKGROUND_VISION_MESSAGE_TYPES = new Set([
  "vision-health",
  "vision-list-tmux-windows",
  "vision-list-visual-surfaces",
  "vision-visual-run-line",
  "vision-tmux-ocr-run-line"
]);
const VISION_COMMAND_MESSAGE_TYPES = new Set([
  "vision-visual-run-line",
  "vision-tmux-ocr-run-line"
]);
const BACKGROUND_AGENT_MESSAGE_TYPES = new Set([
  "agent-register",
  "agent-register-tmux-ai",
  "agent-unregister",
  "agent-list",
  "agent-send",
  "agent-task-status",
  "agent-poll",
  "agent-ack",
  "agent-reply"
]);
const DEFAULT_SETTINGS = {
  enabled: true,
  enabledHosts: DEFAULT_ENABLED_HOSTS,
  requireApproval: false,
  autoSend: true,
  defaultTimeoutMs: 180000,
  maxOutputChars: 20000,
  maxChainCalls: DEFAULT_MAX_CHAIN_CALLS,
  disableAuthorRoleFilter: true
};

chrome.runtime.onInstalled.addListener(() => {
  ensureDefaultSettings();
});

chrome.runtime.onStartup.addListener(() => {
  ensureDefaultSettings();
});

chrome.tabs?.onRemoved?.addListener((tabId) => {
  chrome.storage.session.remove([`${TAB_AGENT_PROFILE_PREFIX}${tabId}`]).catch(() => {});
});

ensureDefaultSettings();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === "extension-version") {
    sendResponse(getExtensionVersionInfo());
    return false;
  }

  if (message.type === "content-ui-delay") {
    handleContentUiDelayMessage(message)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || String(error)
      }));
    return true;
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

  if (message.type === "agent-page-profile-get" || message.type === "agent-page-profile-set") {
    handlePageAgentProfileMessage(message, sender)
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

  if (message.type === "tmux-ensure") {
    ensureTmuxTargets(message)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || String(error),
        panes: []
      }));
    return true;
  }

  if (message.type === "tmux-reset-forai") {
    resetForAiTmuxTargets(message)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || String(error),
        panes: []
      }));
    return true;
  }

  if (message.type === "write-file") {
    handleWriteFileMessage(message)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || String(error)
      }));
    return true;
  }

  if (message.type === "run-board") {
    handleRunBoardMessage(message)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || String(error)
      }));
    return true;
  }

  if (message.type === "run-shell-status") {
    handleRunShellStatusMessage(message)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || String(error)
      }));
    return true;
  }

  if (message.type === "shell-run-control") {
    handleShellRunControlMessage(message)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || String(error)
      }));
    return true;
  }

  if (message.type === "run-board-status") {
    handleRunBoardStatusMessage(message)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || String(error)
      }));
    return true;
  }

  if (message.type === "run-result-presented") {
    handleRunResultPresentedMessage(message)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || String(error)
      }));
    return true;
  }

  if (String(message.type || "").startsWith("agent-")) {
    handleAgentMessage(message)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || String(error)
      }));
    return true;
  }

  if (String(message.type || "").startsWith("vision-")) {
    handleVisionMessage(message)
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || String(error)
      }));
    return true;
  }

  if (message.type !== "run-shell") {
    return false;
  }

  handleRunShellMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({
      ok: false,
      error: error.message || String(error)
    }));

  return true;
});

function handleContentUiDelayMessage(message) {
  const delayMs = Math.max(0, Math.min(
    CONTENT_UI_DELAY_MAX_MS,
    Number.isFinite(Number(message?.delayMs)) ? Number(message.delayMs) : 0
  ));
  return new Promise((resolve) => {
    setTimeout(() => resolve({
      ok: true,
      type: "content-ui-delay",
      delayMs
    }), delayMs);
  });
}

async function handleAgentMessage(message) {
  if (!BACKGROUND_AGENT_MESSAGE_TYPES.has(message.type)) {
    return {
      ok: false,
      error: `Unsupported background agent message type: ${message.type || ""}`
    };
  }
  await requireShellServerReady();
  return runShellViaWebSocket(message);
}

async function handleWriteFileMessage(message) {
  const callKey = message.callKey || message.id || "";
  const force = isForceMessage(message);
  const payload = {
    type: "write-file",
    id: message.id,
    callKey,
    filename: message.filename,
    content: message.content || "",
    callMeta: message.callMeta || {},
    force
  };

  const claim = await claimShellCall(callKey, {
    ...payload,
    cmd: `${payload.filename || ""}\n${payload.content || ""}`,
    target: "Downloads"
  });

  payload.seq = claim.seq;
  try {
    await requireShellServerReady();
    const response = await runShellViaWebSocket(payload);
    await markShellCall(callKey, response?.ok === false ? "failed" : "completed", {
      completedAt: Date.now(),
      durationMs: response?.durationMs,
      duplicate: response?.duplicate === true,
      skipped: response?.skipped === true,
      target: response?.path || payload.filename || ""
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

async function handleRunShellMessage(message, sender = {}) {
  const settings = await syncGet(["defaultTimeoutMs", "maxOutputChars"]);
  const timeoutMs = message.timeoutMs || settings.defaultTimeoutMs || 180000;
  const maxOutputChars = message.maxOutputChars || settings.maxOutputChars || 20000;
  const callKey = message.callKey || message.id || "";
  const force = isForceMessage(message);
  const payload = {
    type: "run",
    id: message.id,
    callKey,
    agentId: message.agentId || "",
    cmd: message.cmd,
    cwd: message.cwd,
    timeoutMs,
    maxOutputChars,
    callMeta: message.callMeta || {},
    force
  };

  const claim = await claimShellCall(callKey, payload);

  payload.seq = claim.seq;
  try {
    await requireShellServerReady();
    const response = await runShellViaWebSocket(payload, {
      onEvent: (event) => forwardShellRunProgress(event, sender)
    });
    await markShellCall(callKey, response?.ok === false ? "failed" : "completed", {
      completedAt: Date.now(),
      exitCode: response?.exitCode,
      durationMs: response?.durationMs,
      duplicate: response?.duplicate === true,
      skipped: response?.skipped === true,
      target: response?.target || ""
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

async function handleShellRunControlMessage(message) {
  const action = String(message.action || "status").trim().toLowerCase();
  if (!new Set(["status", "continue", "terminate"]).has(action)) {
    throw new Error("Shell run control action must be status, continue, or terminate.");
  }
  await requireShellServerReady();
  return runShellViaWebSocket({
    type: "shell-run-control",
    id: message.id || `shell-run-control:${action}:${Date.now()}`,
    action,
    agentId: message.agentId || "",
    executionId: message.executionId || "",
    timeoutMs: action === "terminate" ? 15000 : 5000
  });
}

function forwardShellRunProgress(event, sender = {}) {
  if (!event || event.type !== "shell-run-progress" || !Number.isInteger(sender?.tab?.id)) {
    return;
  }
  try {
    const pending = chrome.tabs.sendMessage(sender.tab.id, event);
    if (pending && typeof pending.catch === "function") {
      pending.catch(() => {});
    }
  } catch (_error) {
    // The originating tab may have navigated or reloaded. The server ledger
    // keeps the idle state recoverable through shell-run-control/status.
  }
}

async function handleRunShellStatusMessage(message) {
  const callKey = String(message.callKey || "").trim();
  if (!callKey) {
    throw new Error("Missing shell callKey for status recovery.");
  }
  await requireShellServerReady();
  const response = await runShellViaWebSocket({
    type: "run-status",
    id: message.id || callKey,
    callKey,
    timeoutMs: 5000
  });
  if (response?.found === true && response.state === "completed") {
    await markShellCall(callKey, "completed", {
      completedAt: response.completedAt || Date.now(),
      recovered: true,
      exitCode: response.result?.exitCode,
      durationMs: response.result?.durationMs
    });
  } else if (response?.found === true && response.state === "failed") {
    await markShellCall(callKey, "failed", {
      completedAt: response.completedAt || Date.now(),
      recovered: true,
      error: response.error || "Server attempt failed."
    });
  }
  return response;
}

async function handleRunBoardStatusMessage(message) {
  const callKey = String(message.callKey || "").trim();
  if (!callKey) {
    throw new Error("Missing board callKey for status recovery.");
  }
  await requireShellServerReady();
  const response = await runShellViaWebSocket({
    type: "run-status",
    id: message.id || callKey,
    callKey,
    kind: "board",
    timeoutMs: 5000
  });
  if (response?.found === true && response.state === "completed") {
    await markShellCall(callKey, "completed", {
      completedAt: response.completedAt || Date.now(),
      recovered: true,
      exitCode: response.result?.exitCode,
      durationMs: response.result?.durationMs,
      target: response.result?.target || ""
    });
  } else if (response?.found === true && response.state === "failed") {
    await markShellCall(callKey, "failed", {
      completedAt: response.completedAt || Date.now(),
      recovered: true,
      error: response.error || "Server board attempt failed."
    });
  }
  return response;
}

async function handleRunResultPresentedMessage(message) {
  const executionId = String(message.executionId || "").trim();
  if (!/^[a-f0-9]{16}$/i.test(executionId)) {
    throw new Error("Missing or invalid executionId for result presentation receipt.");
  }
  await requireShellServerReady();
  return runShellViaWebSocket({
    type: "run-result-presented",
    id: message.id || `${executionId}:presented`,
    executionId,
    timeoutMs: 5000
  });
}

async function handleRunBoardMessage(message) {
  const settings = await syncGet(["defaultTimeoutMs", "maxOutputChars"]);
  const timeoutMs = message.timeoutMs || settings.defaultTimeoutMs || 180000;
  const maxOutputChars = message.maxOutputChars || settings.maxOutputChars || 20000;
  const callKey = message.callKey || message.id || "";
  const force = isForceMessage(message);
  const payload = {
    type: "run-board",
    id: message.id,
    callKey,
    agentId: message.agentId || "",
    boardName: message.boardName || "",
    cmd: message.cmd,
    timeoutMs,
    maxOutputChars,
    callMeta: message.callMeta || {},
    force
  };

  const claim = await claimShellCall(callKey, {
    ...payload,
    target: payload.boardName || "board"
  });

  payload.seq = claim.seq;
  try {
    await requireShellServerReady();
    const response = await runShellViaWebSocket(payload);
    await markShellCall(callKey, response?.ok === false ? "failed" : "completed", {
      completedAt: Date.now(),
      exitCode: response?.exitCode,
      durationMs: response?.durationMs,
      duplicate: response?.duplicate === true,
      skipped: response?.skipped === true,
      target: response?.target || payload.boardName || "board"
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

async function handleVisionMessage(message) {
  if (!BACKGROUND_VISION_MESSAGE_TYPES.has(message.type)) {
    return {
      ok: false,
      error: `Unsupported background vision message type: ${message.type || ""}`
    };
  }

  if (!VISION_COMMAND_MESSAGE_TYPES.has(message.type)) {
    await requireShellServerReady();
    return runShellViaWebSocket(message);
  }

  const callKey = message.callKey || message.id || hashText([
    message.type,
    message.windowId || message.target || message.tmuxTarget || "",
    message.appName || "",
    message.cmd || ""
  ].join("\n"));
  const target = message.windowId ? `vision-window:${message.windowId}` : `tmux:${message.target || message.tmuxTarget || ""}`;
  const force = isForceMessage(message);
  const payload = {
    ...message,
    callKey,
    force
  };
  const claim = await claimShellCall(callKey, {
    ...payload,
    target,
    timeoutMs: message.timeoutMs || 30000
  });

  payload.seq = claim.seq;
  try {
    await requireShellServerReady();
    const response = await runShellViaWebSocket(payload);
    await markShellCall(callKey, response?.ok === false ? "failed" : "completed", {
      completedAt: Date.now(),
      exitCode: response?.exitCode,
      durationMs: response?.durationMs,
      duplicate: response?.duplicate === true,
      skipped: response?.skipped === true,
      target
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
    const extensionVersion = getExtensionVersionInfo().version;
    const serverProtocolVersion = Number(body?.serverProtocolVersion ?? body?.protocolVersion);
    const helperProtocolVersion = Number(body?.helperProtocolVersion);
    const serverReleaseVersion = String(body?.serverReleaseVersion || body?.releaseVersion || "");
    const originMatches = body?.allowUntrustedOrigins === true || body?.allowedOrigin === extensionOrigin;
    const protocolMatches = serverProtocolVersion === REQUIRED_SERVER_PROTOCOL_VERSION;
    const helperProtocolMatches = helperProtocolVersion === REQUIRED_HELPER_PROTOCOL_VERSION;
    const releaseMatches = Boolean(serverReleaseVersion) && serverReleaseVersion === extensionVersion;
    const error = !response.ok
      ? `Shell server health returned HTTP ${response.status}.`
      : !originMatches
      ? `Shell server origin policy does not match ${extensionOrigin}.`
      : !protocolMatches || !helperProtocolMatches
        ? buildProtocolMismatchMessage({ serverProtocolVersion, helperProtocolVersion, extensionVersion })
        : body?.error || "";

    return {
      ...body,
      ok: response.ok && body?.ok === true && originMatches && protocolMatches && helperProtocolMatches,
      status: response.status,
      url: SHELL_SERVER_HEALTH_URL,
      extensionId: chrome.runtime.id,
      extensionVersion,
      extensionOrigin,
      serverReleaseVersion,
      releaseMatches,
      requiredServerProtocolVersion: REQUIRED_SERVER_PROTOCOL_VERSION,
      requiredHelperProtocolVersion: REQUIRED_HELPER_PROTOCOL_VERSION,
      serverProtocolVersion,
      helperProtocolVersion,
      originMatches,
      protocolMatches,
      helperProtocolMatches,
      staleServer: !protocolMatches || !helperProtocolMatches,
      error
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildProtocolMismatchMessage({ serverProtocolVersion, helperProtocolVersion, extensionVersion }) {
  const serverProtocolText = Number.isFinite(serverProtocolVersion) ? serverProtocolVersion : "(missing)";
  const helperProtocolText = Number.isFinite(helperProtocolVersion) ? helperProtocolVersion : "(missing)";
  return [
    `Shell server protocol mismatch for extension v${extensionVersion || "(unknown)"}.`,
    `Expected server protocol ${REQUIRED_SERVER_PROTOCOL_VERSION} and helper protocol ${REQUIRED_HELPER_PROTOCOL_VERSION};`,
    `found server protocol ${serverProtocolText} and helper protocol ${helperProtocolText}.`,
    "Restart the foreground server from this checkout with ./scripts/start_shell_server.sh."
  ].join(" ");
}

async function requireShellServerReady() {
  let health;
  try {
    health = await checkShellServerHealth();
  } catch (error) {
    throw new Error(`Shell server health check failed: ${error.message || String(error)}`);
  }
  if (!health?.ok) {
    throw new Error(health?.error || "Shell server is not ready.");
  }
  return health;
}

function getExtensionVersionInfo() {
  const manifest = chrome.runtime.getManifest?.() || {};
  const version = String(manifest.version || "");
  return {
    ok: true,
    version,
    backgroundVersion: version,
    extensionId: chrome.runtime.id,
    requiredServerProtocolVersion: REQUIRED_SERVER_PROTOCOL_VERSION,
    requiredHelperProtocolVersion: REQUIRED_HELPER_PROTOCOL_VERSION,
    helperProtocolVersion: REQUIRED_HELPER_PROTOCOL_VERSION
  };
}

function ensureDefaultSettings() {
  chrome.storage.sync.get([...Object.keys(DEFAULT_SETTINGS), SETTINGS_MIGRATION_VERSION_KEY], (current) => {
    const missing = {};
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (current[key] === undefined) {
        missing[key] = value;
      }
    }

    const migrationVersion = Number(current[SETTINGS_MIGRATION_VERSION_KEY] || 0);
    if (migrationVersion < 2) {
      if (current.enabledHosts !== undefined && isLegacyDefaultEnabledHosts(current.enabledHosts)) {
        missing.enabledHosts = DEFAULT_ENABLED_HOSTS;
      }
      if (current.maxChainCalls !== undefined && isLegacyDefaultMaxChainCalls(current.maxChainCalls)) {
        missing.maxChainCalls = DEFAULT_MAX_CHAIN_CALLS;
      }
    }
    if (migrationVersion < 3) {
      if (current.defaultTimeoutMs !== undefined && Number(current.defaultTimeoutMs) === LEGACY_DEFAULT_TIMEOUT_MS) {
        missing.defaultTimeoutMs = DEFAULT_SETTINGS.defaultTimeoutMs;
      }
    }
    if (migrationVersion < SETTINGS_MIGRATION_VERSION) {
      missing[SETTINGS_MIGRATION_VERSION_KEY] = SETTINGS_MIGRATION_VERSION;
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

function isLegacyDefaultMaxChainCalls(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed === LEGACY_DEFAULT_MAX_CHAIN_CALLS;
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
  const force = payload.callMeta?.force === true || payload.force === true;
  const store = await localGet(CALL_LEDGER_KEY);
  const ledger = store[CALL_LEDGER_KEY] || { nextSeq: 1, calls: {} };
  ledger.calls ||= {};

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
    promptHash: payload.callMeta?.promptHash || "",
    forced: force
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

function isForceMessage(message) {
  return message?.callMeta?.force === true || message?.force === true;
}

function listTmuxTargets() {
  return requireShellServerReady()
    .then(() => runShellViaWebSocket({ type: "tmux-list", timeoutMs: 5000 }));
}

function ensureTmuxTargets(message = {}) {
  return requireShellServerReady()
    .then(() => runShellViaWebSocket({
      type: "tmux-ensure",
      agentId: message.agentId || "",
      timeoutMs: 5000
    }));
}

function resetForAiTmuxTargets(message = {}) {
  return requireShellServerReady()
    .then(() => runShellViaWebSocket({
      type: "tmux-reset-forai",
      agentId: message.agentId || "",
      timeoutMs: 10000
    }));
}

async function handlePageAgentProfileMessage(message, sender = {}) {
  const tabId = Number(sender?.tab?.id);
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new Error("Agent page profile requires a browser tab context.");
  }
  const senderOrigin = getPageAgentProfileOrigin(message, sender);
  const key = `${TAB_AGENT_PROFILE_PREFIX}${tabId}`;
  if (message.type === "agent-page-profile-get") {
    const stored = await chrome.storage.session.get([key]);
    const entry = stored[key] || {};
    return {
      ok: true,
      type: message.type,
      profile: entry.origin === senderOrigin
        ? normalizePageAgentProfile(entry.profile)
        : { role: "none", agentId: "" }
    };
  }

  const profile = normalizePageAgentProfile(message.profile);
  if (profile.role === "none") {
    await chrome.storage.session.remove([key]);
  } else {
    await chrome.storage.session.set({
      [key]: {
        origin: senderOrigin,
        profile
      }
    });
  }
  return { ok: true, type: message.type, profile };
}

function getPageAgentProfileOrigin(message, sender = {}) {
  let senderOrigin = "";
  try {
    senderOrigin = new URL(sender.origin || sender.url || "").origin;
  } catch (_unused) {
    // Rejected below with one stable error message.
  }
  const requestedOrigin = String(message.origin || "").trim();
  if (!senderOrigin || requestedOrigin !== senderOrigin) {
    throw new Error("Agent page profile origin does not match the sender.");
  }
  return senderOrigin;
}

function normalizePageAgentProfile(value = {}) {
  const role = String(value?.role || "none").trim();
  const agentId = String(value?.agentId || "").trim();
  if (role === "none" || !agentId) {
    return { role: "none", agentId: "" };
  }
  if (!["master", "slave"].includes(role)) {
    throw new Error("Role must be none, master, or slave.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(agentId)) {
    throw new Error("Agent id must be 1-64 safe characters and start with a letter or number.");
  }
  return { role, agentId };
}

function runShellViaWebSocket(payload, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let heartbeatTimer = 0;
    const socket = new WebSocket(SHELL_SERVER_URL);
    const watchdogMs = getWebSocketWatchdogMs(payload);
    const timeout = watchdogMs > 0
      ? setTimeout(() => {
          finish(reject, new Error("Shell server timed out."));
          tryClose(socket);
        }, watchdogMs)
      : 0;

    socket.addEventListener("open", () => {
      try {
        socket.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timeout);
        finish(reject, error);
        tryClose(socket);
        return;
      }
      if (shouldKeepWebSocketAlive(payload)) {
        heartbeatTimer = setInterval(() => {
          if (!settled && socket.readyState === 1) {
            try {
              socket.send(JSON.stringify({ type: "keepalive" }));
            } catch (error) {
              clearTimeout(timeout);
              finish(reject, error);
              tryClose(socket);
            }
          }
        }, WEBSOCKET_HEARTBEAT_INTERVAL_MS);
      }
    });

    socket.addEventListener("message", (event) => {
      try {
        const response = JSON.parse(event.data);
        if (response?.event === true) {
          if (typeof options.onEvent === "function") {
            options.onEvent(response);
          }
          return;
        }
        finish(resolve, response);
      } catch (error) {
        finish(reject, error);
      }
      if (settled) {
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
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      heartbeatTimer = 0;
      callback(value);
    }
  });
}

function shouldKeepWebSocketAlive(payload) {
  return payload?.type === "run" ||
    payload?.type === "run-board" ||
    VISION_COMMAND_MESSAGE_TYPES.has(payload?.type);
}

function getWebSocketWatchdogMs(payload) {
  if (payload && (payload.type === "run" || payload.type === "run-board")) {
    return 0;
  }
  return Math.max(5000, Number(payload?.timeoutMs || 30000) + 5000);
}

function tryClose(socket) {
  try {
    socket.close();
  } catch {
    // Ignore close races.
  }
}
