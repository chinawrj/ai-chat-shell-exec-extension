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
const SKILL_ACK_PREFIX = "skillCatalogAck:v1:";
const SKILL_SYNC_PREFIX = "skillCatalogSync:v1:";
const SKILL_MEMORY_ENTRY = "AI_CHAT_SHELL_SKILLS_CATALOG";
const SKILL_SYNC_TTL_MS = 10 * 60 * 1000;
const REQUIRED_SERVER_PROTOCOL_VERSION = 11;
const REQUIRED_HELPER_PROTOCOL_VERSION = 4;
const REQUIRED_SKILL_PROTOCOL_VERSION = 1;
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
const BACKGROUND_SKILL_MESSAGE_TYPES = new Set([
  "skill-state-get",
  "skill-sync-begin",
  "skill-sync-list",
  "skill-sync-ack",
  "skill-sync-failed",
  "skill-catalog-list",
  "skill-catalog-rescan",
  "skill-load"
]);
const skillScopeTails = new Map();
const recentlyClosedSkillTabIds = new Set();
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
  recentlyClosedSkillTabIds.add(Number(tabId));
  const cleanupTimer = setTimeout(() => recentlyClosedSkillTabIds.delete(Number(tabId)), 60_000);
  cleanupTimer?.unref?.();
  releaseSkillSyncLocksForTab(tabId).catch(() => {});
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

  if (String(message.type || "").startsWith("skill-")) {
    handleSkillMessage(message, sender)
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

async function handleSkillMessage(message, sender = {}) {
  if (!BACKGROUND_SKILL_MESSAGE_TYPES.has(message.type)) {
    return {
      ok: false,
      errorCode: "unsupported-skill-message",
      error: `Unsupported background Skill message type: ${message.type || ""}`
    };
  }
  const scope = getSkillMemoryScope(sender);
  return withSkillScopeLock(scope, async () => {
    if (message.type === "skill-state-get") {
      return getSkillState(scope, sender);
    }
    if (message.type === "skill-sync-begin") {
      return beginSkillSync(scope, sender, { force: message.force === true });
    }
    if (message.type === "skill-sync-list") {
      return getSkillListForAi(scope, sender, message);
    }
    if (message.type === "skill-sync-ack") {
      return acknowledgeSkillSync(scope, sender, message);
    }
    if (message.type === "skill-sync-failed") {
      return failSkillSync(scope, sender, message);
    }
    await requireShellServerReady();
    if (message.type === "skill-catalog-list") {
      return runShellViaWebSocket({ type: "skill-catalog-list", timeoutMs: 5000 });
    }
    if (message.type === "skill-catalog-rescan") {
      return runShellViaWebSocket({ type: "skill-catalog-rescan", timeoutMs: 5000 });
    }
    return runShellViaWebSocket({
      type: "skill-load",
      skillId: message.skillId,
      catalogSha: message.catalogSha,
      timeoutMs: 5000
    });
  });
}

async function getSkillState(scope, sender = {}) {
  await requireShellServerReady();
  const status = await runShellViaWebSocket({ type: "skill-catalog-status", timeoutMs: 5000 });
  const [ackStore, syncStore] = await Promise.all([
    localGet([skillAckKey(scope)]),
    chrome.storage.session.get([skillSyncKey(scope)])
  ]);
  const ack = normalizeSkillAck(ackStore[skillAckKey(scope)]);
  let sync = normalizeSkillSync(syncStore[skillSyncKey(scope)]);
  if (sync && sync.expiresAt <= Date.now()) {
    await chrome.storage.session.remove([skillSyncKey(scope)]);
    sync = null;
  }
  const updateAvailable = skillCatalogNeedsSync(ack, status);
  return {
    ...status,
    type: "skill-state",
    memoryScope: scope,
    memoryEntry: SKILL_MEMORY_ENTRY,
    acknowledgedCatalogSha: ack.catalogSha,
    acknowledgedVersion: ack.version,
    acknowledgedAt: ack.acknowledgedAt,
    lastSyncError: ack.lastSyncError,
    updateAvailable,
    syncing: Boolean(sync),
    syncOwnerTabId: sync?.ownerTabId ?? null,
    syncOwnedByCurrentTab: Boolean(sync && Number(sender?.tab?.id) === sync.ownerTabId),
    syncCatalogSha: sync?.catalogSha || "",
    syncStartedAt: sync?.startedAt || 0,
    syncExpiresAt: sync?.expiresAt || 0
  };
}

async function beginSkillSync(scope, sender, { force = false } = {}) {
  const tabId = requireSkillTabId(sender);
  await requireShellServerReady();
  const status = await runShellViaWebSocket({ type: "skill-catalog-status", fresh: true, timeoutMs: 5000 });
  if (status?.ok !== true) {
    return {
      ...status,
      ok: false,
      errorCode: "skill-catalog-invalid",
      error: status?.error || firstSkillCatalogError(status) || "The local Skill catalog is invalid."
    };
  }
  const state = await getSkillStateFromStatus(scope, status);
  if (!force && state.updateAvailable !== true) {
    return {
      ...state,
      ok: false,
      errorCode: "skills-already-current",
      error: "The current Skill catalog is already acknowledged for this memory scope."
    };
  }
  const key = skillSyncKey(scope);
  const stored = await chrome.storage.session.get([key]);
  const existing = normalizeSkillSync(stored[key]);
  if (existing && existing.expiresAt > Date.now()) {
    if (!(force && existing.ownerTabId === tabId)) {
      return {
        ok: false,
        errorCode: existing.ownerTabId === tabId ? "skill-sync-already-active" : "skill-sync-owned-by-another-tab",
        error: existing.ownerTabId === tabId
          ? "Skill sync is already active in this tab."
          : "Skill sync is already active in another tab for this AI memory scope.",
        memoryScope: scope,
        memoryEntry: SKILL_MEMORY_ENTRY,
        syncing: true,
        syncOwnerTabId: existing.ownerTabId,
        syncCatalogSha: existing.catalogSha,
        syncStartedAt: existing.startedAt,
        syncExpiresAt: existing.expiresAt
      };
    }
  }
  if (recentlyClosedSkillTabIds.has(tabId)) {
    return skillSyncRejection("skill-sync-tab-closed", "The tab closed before Skill synchronization could start.");
  }
  const now = Date.now();
  const sync = {
    version: 1,
    challenge: createSkillChallenge(),
    catalogSha: String(status.catalogSha || ""),
    catalogVersion: Number(status.version || 0),
    ownerTabId: tabId,
    startedAt: now,
    expiresAt: now + SKILL_SYNC_TTL_MS,
    force
  };
  await chrome.storage.session.set({ [key]: sync });
  if (recentlyClosedSkillTabIds.has(tabId)) {
    await chrome.storage.session.remove([key]);
    return skillSyncRejection("skill-sync-tab-closed", "The tab closed before Skill synchronization could start.");
  }
  return {
    ok: true,
    type: "skill-sync-begin",
    memoryScope: scope,
    memoryEntry: SKILL_MEMORY_ENTRY,
    challenge: sync.challenge,
    catalogSha: sync.catalogSha,
    version: sync.catalogVersion,
    skillCount: Number(status.skillCount || 0),
    forced: force,
    syncing: true,
    syncOwnerTabId: tabId,
    syncStartedAt: sync.startedAt,
    syncExpiresAt: sync.expiresAt
  };
}

async function getSkillListForAi(scope, sender, message) {
  const tabId = requireSkillTabId(sender);
  const challenge = normalizeSkillChallenge(message.challenge);
  let sync = null;
  const key = skillSyncKey(scope);
  if (challenge) {
    const stored = await chrome.storage.session.get([key]);
    sync = normalizeSkillSync(stored[key]);
    const validation = validateSkillSyncOwner(sync, { tabId, challenge });
    if (validation) {
      return validation;
    }
  }
  await requireShellServerReady();
  const list = await runShellViaWebSocket({ type: "skill-catalog-list", timeoutMs: 5000 });
  if (list?.ok !== true) {
    return {
      ...list,
      ok: false,
      errorCode: "skill-catalog-invalid",
      error: list?.error || firstSkillCatalogError(list) || "The local Skill catalog is invalid."
    };
  }
  if (sync) {
    sync.catalogSha = String(list.catalogSha || "");
    sync.catalogVersion = Number(list.version || 0);
    sync.expiresAt = Date.now() + SKILL_SYNC_TTL_MS;
    await chrome.storage.session.set({ [key]: sync });
  }
  return {
    ...list,
    type: "skill-sync-list",
    memoryScope: scope,
    memoryEntry: SKILL_MEMORY_ENTRY,
    challenge,
    syncRequired: Boolean(sync)
  };
}

async function acknowledgeSkillSync(scope, sender, message) {
  const tabId = requireSkillTabId(sender);
  const challenge = normalizeSkillChallenge(message.challenge);
  const catalogSha = String(message.catalogSha || "").trim().toLowerCase();
  const memoryEntry = String(message.memoryEntry || "").trim();
  const key = skillSyncKey(scope);
  const stored = await chrome.storage.session.get([key]);
  const sync = normalizeSkillSync(stored[key]);
  const validation = validateSkillSyncOwner(sync, { tabId, challenge });
  if (validation) {
    return validation;
  }
  if (memoryEntry !== SKILL_MEMORY_ENTRY) {
    return skillSyncRejection("memory-entry-mismatch", `Skill sync ACK must name the fixed memory entry ${SKILL_MEMORY_ENTRY}.`);
  }
  if (!/^[a-f0-9]{64}$/.test(catalogSha) || catalogSha !== sync.catalogSha) {
    return skillSyncRejection("catalog-sha-mismatch", "Skill sync ACK does not match the catalog delivered for this challenge.");
  }
  await requireShellServerReady();
  const latest = await runShellViaWebSocket({ type: "skill-catalog-status", fresh: true, timeoutMs: 5000 });
  if (latest?.ok !== true) {
    return skillSyncRejection("skill-catalog-invalid", firstSkillCatalogError(latest) || "The local Skill catalog is invalid.", latest);
  }
  if (catalogSha !== latest.catalogSha) {
    return skillSyncRejection("stale-skill-sync-ack", "The local Skill catalog changed after it was listed. Request and acknowledge the latest catalog.", {
      catalogSha: latest.catalogSha,
      version: latest.version
    });
  }
  const ack = {
    version: 1,
    catalogSha,
    catalogVersion: Number(latest.version || sync.catalogVersion || 0),
    memoryEntry: SKILL_MEMORY_ENTRY,
    acknowledgedAt: Date.now(),
    lastSyncError: ""
  };
  await localSet({ [skillAckKey(scope)]: ack });
  await chrome.storage.session.remove([key]);
  return {
    ok: true,
    type: "skill-sync-ack",
    memoryScope: scope,
    memoryEntry: SKILL_MEMORY_ENTRY,
    catalogSha,
    version: ack.catalogVersion,
    updateAvailable: false,
    syncing: false
  };
}

async function failSkillSync(scope, sender, message) {
  const tabId = requireSkillTabId(sender);
  const challenge = normalizeSkillChallenge(message.challenge);
  const key = skillSyncKey(scope);
  const stored = await chrome.storage.session.get([key]);
  const sync = normalizeSkillSync(stored[key]);
  const validation = validateSkillSyncOwner(sync, { tabId, challenge });
  if (validation) {
    return validation;
  }
  const catalogSha = String(message.catalogSha || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(catalogSha) || catalogSha !== sync.catalogSha) {
    return skillSyncRejection("catalog-sha-mismatch", "Skill sync failure report does not match the catalog delivered for this challenge.");
  }
  const ackKey = skillAckKey(scope);
  const ackStore = await localGet([ackKey]);
  const ack = normalizeSkillAck(ackStore[ackKey]);
  ack.lastSyncError = String(message.reason || "AI reported that the fixed Skill memory entry could not be updated.").slice(0, 500);
  await localSet({ [ackKey]: ack });
  await chrome.storage.session.remove([key]);
  return {
    ok: true,
    type: "skill-sync-failed",
    memoryScope: scope,
    memoryEntry: SKILL_MEMORY_ENTRY,
    catalogSha,
    version: sync.catalogVersion,
    lastSyncError: ack.lastSyncError,
    updateAvailable: true,
    syncing: false
  };
}

async function getSkillStateFromStatus(scope, status) {
  const [ackStore, syncStore] = await Promise.all([
    localGet([skillAckKey(scope)]),
    chrome.storage.session.get([skillSyncKey(scope)])
  ]);
  const ack = normalizeSkillAck(ackStore[skillAckKey(scope)]);
  let sync = normalizeSkillSync(syncStore[skillSyncKey(scope)]);
  if (sync && sync.expiresAt <= Date.now()) {
    await chrome.storage.session.remove([skillSyncKey(scope)]);
    sync = null;
  }
  return {
    ...status,
    type: "skill-state",
    memoryScope: scope,
    memoryEntry: SKILL_MEMORY_ENTRY,
    acknowledgedCatalogSha: ack.catalogSha,
    acknowledgedVersion: ack.version,
    acknowledgedAt: ack.acknowledgedAt,
    lastSyncError: ack.lastSyncError,
    updateAvailable: skillCatalogNeedsSync(ack, status),
    syncing: Boolean(sync),
    syncOwnerTabId: sync?.ownerTabId ?? null,
    syncCatalogSha: sync?.catalogSha || ""
  };
}

function skillCatalogNeedsSync(ack, status) {
  if (status?.ok !== true) {
    return false;
  }
  return Boolean(ack?.lastSyncError) ||
    !/^[a-f0-9]{64}$/.test(String(ack?.catalogSha || "")) ||
    ack.catalogSha !== status.catalogSha;
}

function getSkillMemoryScope(sender = {}) {
  const value = sender.origin || sender.url || sender.tab?.url || "";
  try {
    const origin = new URL(value).origin;
    if (!origin || origin === "null") {
      throw new Error("invalid origin");
    }
    return origin;
  } catch (_error) {
    throw new Error("Skill messages require a valid AI page origin.");
  }
}

function requireSkillTabId(sender = {}) {
  const tabId = Number(sender?.tab?.id);
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new Error("Skill sync requires a browser tab context.");
  }
  return tabId;
}

function normalizeSkillAck(value = {}) {
  return {
    catalogSha: /^[a-f0-9]{64}$/.test(String(value?.catalogSha || "")) ? String(value.catalogSha) : "",
    version: Math.max(0, Number(value?.catalogVersion || value?.version || 0)),
    acknowledgedAt: Math.max(0, Number(value?.acknowledgedAt || 0)),
    lastSyncError: String(value?.lastSyncError || "")
  };
}

function normalizeSkillSync(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const challenge = normalizeSkillChallenge(value.challenge);
  const ownerTabId = Number(value.ownerTabId);
  const expiresAt = Number(value.expiresAt || 0);
  if (!challenge || !Number.isInteger(ownerTabId) || ownerTabId < 0 || !Number.isFinite(expiresAt)) {
    return null;
  }
  return {
    version: 1,
    challenge,
    catalogSha: String(value.catalogSha || "").toLowerCase(),
    catalogVersion: Math.max(0, Number(value.catalogVersion || 0)),
    ownerTabId,
    startedAt: Math.max(0, Number(value.startedAt || 0)),
    expiresAt,
    force: value.force === true
  };
}

function normalizeSkillChallenge(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(text) ? text : "";
}

function validateSkillSyncOwner(sync, { tabId, challenge }) {
  if (!sync || sync.expiresAt <= Date.now()) {
    return skillSyncRejection("skill-sync-not-active", "No active Skill sync challenge is available. Start or force a new sync.");
  }
  if (!challenge || challenge !== sync.challenge) {
    return skillSyncRejection("skill-sync-challenge-mismatch", "The Skill sync challenge is missing, stale, or incorrect.");
  }
  if (sync.ownerTabId !== tabId) {
    return skillSyncRejection("skill-sync-owner-mismatch", "This Skill sync belongs to another tab.");
  }
  return null;
}

function skillSyncRejection(errorCode, error, extra = {}) {
  return { ok: false, type: "skill-sync-rejected", errorCode, error, ...extra };
}

function firstSkillCatalogError(response) {
  return Array.isArray(response?.errors) && response.errors.length > 0
    ? String(response.errors[0]?.message || response.errors[0] || "")
    : "";
}

function createSkillChallenge() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function skillAckKey(scope) {
  return `${SKILL_ACK_PREFIX}${scope}`;
}

function skillSyncKey(scope) {
  return `${SKILL_SYNC_PREFIX}${scope}`;
}

function withSkillScopeLock(scope, task) {
  const previous = skillScopeTails.get(scope) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  skillScopeTails.set(scope, current);
  return current.finally(() => {
    if (skillScopeTails.get(scope) === current) {
      skillScopeTails.delete(scope);
    }
  });
}

async function releaseSkillSyncLocksForTab(tabId) {
  const store = await chrome.storage.session.get(null);
  const keys = Object.entries(store || {})
    .filter(([key, value]) => key.startsWith(SKILL_SYNC_PREFIX) && Number(value?.ownerTabId) === Number(tabId))
    .map(([key]) => key);
  await Promise.all(keys.map((key) => {
    const scope = key.slice(SKILL_SYNC_PREFIX.length);
    return withSkillScopeLock(scope, async () => {
      const latest = await chrome.storage.session.get([key]);
      if (Number(latest?.[key]?.ownerTabId) === Number(tabId)) {
        await chrome.storage.session.remove([key]);
      }
    });
  }));
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
    const skillProtocolVersion = Number(body?.skillProtocolVersion);
    const serverReleaseVersion = String(body?.serverReleaseVersion || body?.releaseVersion || "");
    const originMatches = body?.allowUntrustedOrigins === true || body?.allowedOrigin === extensionOrigin;
    const protocolMatches = serverProtocolVersion === REQUIRED_SERVER_PROTOCOL_VERSION;
    const helperProtocolMatches = helperProtocolVersion === REQUIRED_HELPER_PROTOCOL_VERSION;
    const skillProtocolMatches = skillProtocolVersion === REQUIRED_SKILL_PROTOCOL_VERSION;
    const releaseMatches = Boolean(serverReleaseVersion) && serverReleaseVersion === extensionVersion;
    const error = !response.ok
      ? `Shell server health returned HTTP ${response.status}.`
      : !originMatches
      ? `Shell server origin policy does not match ${extensionOrigin}.`
      : !protocolMatches || !helperProtocolMatches || !skillProtocolMatches
        ? buildProtocolMismatchMessage({ serverProtocolVersion, helperProtocolVersion, skillProtocolVersion, extensionVersion })
        : body?.error || "";

    return {
      ...body,
      ok: response.ok && body?.ok === true && originMatches && protocolMatches && helperProtocolMatches && skillProtocolMatches,
      status: response.status,
      url: SHELL_SERVER_HEALTH_URL,
      extensionId: chrome.runtime.id,
      extensionVersion,
      extensionOrigin,
      serverReleaseVersion,
      releaseMatches,
      requiredServerProtocolVersion: REQUIRED_SERVER_PROTOCOL_VERSION,
      requiredHelperProtocolVersion: REQUIRED_HELPER_PROTOCOL_VERSION,
      requiredSkillProtocolVersion: REQUIRED_SKILL_PROTOCOL_VERSION,
      serverProtocolVersion,
      helperProtocolVersion,
      skillProtocolVersion,
      originMatches,
      protocolMatches,
      helperProtocolMatches,
      skillProtocolMatches,
      staleServer: !protocolMatches || !helperProtocolMatches || !skillProtocolMatches,
      error
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildProtocolMismatchMessage({ serverProtocolVersion, helperProtocolVersion, skillProtocolVersion, extensionVersion }) {
  const serverProtocolText = Number.isFinite(serverProtocolVersion) ? serverProtocolVersion : "(missing)";
  const helperProtocolText = Number.isFinite(helperProtocolVersion) ? helperProtocolVersion : "(missing)";
  const skillProtocolText = Number.isFinite(skillProtocolVersion) ? skillProtocolVersion : "(missing)";
  return [
    `Shell server protocol mismatch for extension v${extensionVersion || "(unknown)"}.`,
    `Expected server protocol ${REQUIRED_SERVER_PROTOCOL_VERSION}, helper protocol ${REQUIRED_HELPER_PROTOCOL_VERSION}, and Skill protocol ${REQUIRED_SKILL_PROTOCOL_VERSION};`,
    `found server protocol ${serverProtocolText}, helper protocol ${helperProtocolText}, and Skill protocol ${skillProtocolText}.`,
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
    requiredSkillProtocolVersion: REQUIRED_SKILL_PROTOCOL_VERSION,
    helperProtocolVersion: REQUIRED_HELPER_PROTOCOL_VERSION,
    skillProtocolVersion: REQUIRED_SKILL_PROTOCOL_VERSION
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
