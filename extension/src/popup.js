const DEFAULTS = {
  enabled: true,
  enabledHosts: ["chatgpt.com", "m365.cloud.microsoft"],
  requireApproval: false,
  autoSend: true,
  defaultTimeoutMs: 30000,
  maxOutputChars: 20000,
  maxChainCalls: 100,
  disableAuthorRoleFilter: true
};

const CONFIG_VERSION = 1;
const LOCAL_PROFILE_PREFIXES = [
  "composerProfile:",
  "sendProfile:",
  "shellProfile:",
  "panelProfile:"
];

const fields = {
  enabled: document.getElementById("enabled"),
  enabledHosts: document.getElementById("enabledHosts"),
  autoSend: document.getElementById("autoSend"),
  requireApproval: document.getElementById("requireApproval"),
  defaultTimeoutMs: document.getElementById("defaultTimeoutMs"),
  maxOutputChars: document.getElementById("maxOutputChars"),
  maxChainCalls: document.getElementById("maxChainCalls"),
  disableAuthorRoleFilter: document.getElementById("disableAuthorRoleFilter")
};

const health = document.getElementById("health");
const saveButton = document.getElementById("save");
const refreshHealthButton = document.getElementById("refreshHealth");
const exportConfigButton = document.getElementById("exportConfig");
const importConfigButton = document.getElementById("importConfig");
const addCurrentSiteButton = document.getElementById("addCurrentSite");
const removeCurrentSiteButton = document.getElementById("removeCurrentSite");
const refreshTmuxTargetsButton = document.getElementById("refreshTmuxTargets");
const resetForAiTmuxButton = document.getElementById("resetForAiTmux");
const portableConfig = document.getElementById("portableConfig");
const portableStatus = document.getElementById("portableStatus");
const currentSiteStatus = document.getElementById("currentSiteStatus");
const tmuxTargets = document.getElementById("tmuxTargets");
let currentHost = "";

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  await loadCurrentSite();
  await refreshHealth();
  await refreshTmuxTargets();
});

saveButton.addEventListener("click", saveSettings);
refreshHealthButton.addEventListener("click", refreshHealth);
exportConfigButton.addEventListener("click", exportConfig);
importConfigButton.addEventListener("click", importConfig);
addCurrentSiteButton.addEventListener("click", () => updateCurrentSiteEnabled(true));
removeCurrentSiteButton.addEventListener("click", () => updateCurrentSiteEnabled(false));
refreshTmuxTargetsButton.addEventListener("click", refreshTmuxTargets);
resetForAiTmuxButton.addEventListener("click", resetForAiTmuxTargets);

async function loadSettings() {
  const settings = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  const merged = { ...DEFAULTS, ...settings };
  fields.enabled.checked = merged.enabled !== false;
  fields.enabledHosts.value = normalizeEnabledHosts(merged.enabledHosts).join("\n");
  fields.autoSend.checked = merged.autoSend !== false;
  fields.requireApproval.checked = merged.requireApproval === true;
  fields.defaultTimeoutMs.value = merged.defaultTimeoutMs;
  fields.maxOutputChars.value = merged.maxOutputChars;
  fields.maxChainCalls.value = merged.maxChainCalls;
  fields.disableAuthorRoleFilter.checked = merged.disableAuthorRoleFilter !== false;
}

async function saveSettings() {
  saveButton.disabled = true;
  await chrome.storage.sync.set({
    enabled: fields.enabled.checked,
    enabledHosts: normalizeEnabledHosts(fields.enabledHosts.value.split(/\n|,/)),
    autoSend: fields.autoSend.checked,
    requireApproval: fields.requireApproval.checked,
    defaultTimeoutMs: clampNumber(fields.defaultTimeoutMs.value, 1000, 600000, DEFAULTS.defaultTimeoutMs),
    maxOutputChars: clampNumber(fields.maxOutputChars.value, 1000, 200000, DEFAULTS.maxOutputChars),
    maxChainCalls: clampMinNumber(fields.maxChainCalls.value, 1, DEFAULTS.maxChainCalls),
    disableAuthorRoleFilter: fields.disableAuthorRoleFilter.checked
  });
  saveButton.textContent = "Saved";
  setTimeout(() => {
    saveButton.disabled = false;
    saveButton.textContent = "Save";
  }, 800);
}

async function loadCurrentSite() {
  currentHost = await getCurrentTabHost();
  if (!currentHost) {
    addCurrentSiteButton.disabled = true;
    removeCurrentSiteButton.disabled = true;
    setCurrentSiteStatus("No supported current site", "error");
    return;
  }

  refreshCurrentSiteStatus();
}

async function getCurrentTabHost() {
  if (!chrome.tabs?.query) {
    return "";
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return normalizeHost(tab?.url || "");
}

function refreshCurrentSiteStatus() {
  if (!currentHost) {
    return;
  }

  const hosts = normalizeEnabledHosts(fields.enabledHosts.value.split(/\n|,/));
  const enabled = hosts.includes(currentHost);
  addCurrentSiteButton.disabled = enabled;
  removeCurrentSiteButton.disabled = !enabled;
  setCurrentSiteStatus(`${currentHost}: ${enabled ? "enabled" : "disabled"}`, enabled ? "ok" : "idle");
}

async function updateCurrentSiteEnabled(enabled) {
  if (!currentHost) {
    return;
  }

  const hosts = normalizeEnabledHosts(fields.enabledHosts.value.split(/\n|,/));
  const nextHosts = enabled ? [...hosts, currentHost] : hosts.filter((host) => host !== currentHost);
  fields.enabledHosts.value = normalizeEnabledHosts(nextHosts).join("\n");
  await saveSettings();
  refreshCurrentSiteStatus();
}

async function refreshHealth() {
  health.dataset.state = "checking";
  health.textContent = "Checking server...";
  try {
    const response = await chrome.runtime.sendMessage({ type: "shell-health" });
    if (response?.ok) {
      health.dataset.state = "ok";
      health.textContent = `Server OK, pid ${response.pid}`;
      return;
    }

    health.dataset.state = "error";
    if (response?.originMatches === false) {
      health.textContent = `Extension ID mismatch. Expected ${response.allowedOrigin || "server origin"}`;
      return;
    }
    if (response?.protocolMatches === false) {
      health.textContent = "Server protocol mismatch. Restart the local shell server from this release.";
      return;
    }
    health.textContent = response?.error || "Server not reachable";
  } catch (error) {
    health.dataset.state = "error";
    health.textContent = error.message || String(error);
  }
}

async function refreshTmuxTargets() {
  tmuxTargets.dataset.state = "checking";
  tmuxTargets.textContent = "Checking tmux...";
  try {
    const response = await chrome.runtime.sendMessage({ type: "tmux-list" });
    if (!response?.ok) {
      tmuxTargets.dataset.state = "error";
      tmuxTargets.textContent = response?.error || "tmux is not reachable";
      return;
    }

    tmuxTargets.dataset.state = "ok";
    tmuxTargets.textContent = formatTmuxTargets(response.panes, response);
  } catch (error) {
    tmuxTargets.dataset.state = "error";
    tmuxTargets.textContent = error.message || String(error);
  }
}

async function resetForAiTmuxTargets() {
  if (globalThis.confirm && !globalThis.confirm("Reset the ForAI tmux session? This kills the current ForAI host and board windows.")) {
    return;
  }

  tmuxTargets.dataset.state = "checking";
  tmuxTargets.textContent = "Resetting ForAI tmux...";
  try {
    const response = await chrome.runtime.sendMessage({ type: "tmux-reset-forai" });
    if (!response?.ok) {
      tmuxTargets.dataset.state = "error";
      tmuxTargets.textContent = response?.error || "ForAI tmux reset failed";
      return;
    }

    tmuxTargets.dataset.state = "ok";
    tmuxTargets.textContent = formatTmuxTargets(response.panes, response);
  } catch (error) {
    tmuxTargets.dataset.state = "error";
    tmuxTargets.textContent = error.message || String(error);
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function clampMinNumber(value, min, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.floor(number));
}

async function exportConfig() {
  setPortableStatus("Exporting config...", "checking");
  const [syncSettings, localStore] = await Promise.all([
    chrome.storage.sync.get(Object.keys(DEFAULTS)),
    chrome.storage.local.get(null)
  ]);
  const localProfiles = {};
  for (const [key, value] of Object.entries(localStore || {})) {
    if (isAllowedLocalProfileKey(key)) {
      localProfiles[key] = value;
    }
  }

  const payload = {
    schema: "ai-chat-shell-exec-config",
    version: CONFIG_VERSION,
    exportedAt: new Date().toISOString(),
    extensionId: chrome.runtime.id,
    settings: sanitizeSettings(syncSettings),
    localProfiles
  };

  portableConfig.value = JSON.stringify(payload, null, 2);
  portableConfig.focus();
  portableConfig.select();
  setPortableStatus(`Exported ${Object.keys(localProfiles).length} binding records`, "ok");
}

async function importConfig() {
  setPortableStatus("Importing config...", "checking");
  let parsed;
  try {
    parsed = JSON.parse(portableConfig.value);
  } catch {
    setPortableStatus("Import failed: invalid JSON", "error");
    return;
  }

  if (!parsed || parsed.schema !== "ai-chat-shell-exec-config" || parsed.version !== CONFIG_VERSION) {
    setPortableStatus("Import failed: unsupported config schema", "error");
    return;
  }

  const settings = sanitizeSettings(parsed.settings || {});
  const localProfiles = sanitizeLocalProfiles(parsed.localProfiles || {});
  await Promise.all([
    chrome.storage.sync.set(settings),
    Object.keys(localProfiles).length > 0 ? chrome.storage.local.set(localProfiles) : Promise.resolve()
  ]);
  await loadSettings();
  setPortableStatus(`Imported ${Object.keys(localProfiles).length} binding records`, "ok");
}

function sanitizeSettings(input) {
  return {
    enabled: input.enabled !== false,
    enabledHosts: normalizeEnabledHosts(input.enabledHosts),
    autoSend: input.autoSend !== false,
    requireApproval: input.requireApproval === true,
    defaultTimeoutMs: clampNumber(input.defaultTimeoutMs, 1000, 600000, DEFAULTS.defaultTimeoutMs),
    maxOutputChars: clampNumber(input.maxOutputChars, 1000, 200000, DEFAULTS.maxOutputChars),
    maxChainCalls: clampMinNumber(input.maxChainCalls, 1, DEFAULTS.maxChainCalls)
  };
}

function formatTmuxTargets(panes, layout = {}) {
  if (!Array.isArray(panes) || panes.length === 0) {
    return "No tmux panes found.";
  }

  const summary = layout.sessionName ? [
    `defaultSession=${layout.sessionName}`,
    `host=${layout.defaultTarget || layout.hostWindowName || "missing"}`,
    `board=${layout.boardTarget || layout.boardWindowName || "missing"}`,
    layout.cwd ? `cwd=${layout.cwd}` : ""
  ].filter(Boolean).join(" ") : "";
  const paneLines = panes.map((pane) => [
    `target=${pane.id}`,
    `address=${pane.address}`,
    `window=${pane.windowName || "(unnamed)"}`,
    `command=${pane.currentCommand || "unknown"}`,
    pane.currentPath ? `cwd=${pane.currentPath}` : "",
    pane.active ? "active=true" : "active=false"
  ].filter(Boolean).join(" "));
  return [summary, ...paneLines].filter(Boolean).join("\n");
}

function normalizeEnabledHosts(input) {
  const source = Array.isArray(input) ? input : DEFAULTS.enabledHosts;
  const hosts = source
    .map(normalizeHost)
    .filter(Boolean);
  return Array.from(new Set(hosts));
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

function sanitizeLocalProfiles(input) {
  const output = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return output;
  }

  for (const [key, value] of Object.entries(input)) {
    if (!isAllowedLocalProfileKey(key) || !value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    const profile = {};
    if (typeof value.selector === "string" && value.selector.length <= 2000) {
      profile.selector = value.selector;
    }
    if (typeof value.host === "string" && value.host.length <= 300) {
      profile.host = value.host;
    }
    if (typeof value.savedAt === "string" && value.savedAt.length <= 80) {
      profile.savedAt = value.savedAt;
    }
    if (Number.isFinite(value.left)) {
      profile.left = Math.max(0, Math.min(10000, Number(value.left)));
    }
    if (Number.isFinite(value.top)) {
      profile.top = Math.max(0, Math.min(10000, Number(value.top)));
    }

    if (Object.keys(profile).length > 0) {
      output[key] = profile;
    }
  }

  return output;
}

function isAllowedLocalProfileKey(key) {
  return LOCAL_PROFILE_PREFIXES.some((prefix) => String(key || "").startsWith(prefix));
}

function setPortableStatus(message, state = "idle") {
  portableStatus.textContent = message;
  portableStatus.dataset.state = state;
}

function setCurrentSiteStatus(message, state = "idle") {
  currentSiteStatus.textContent = message;
  currentSiteStatus.dataset.state = state;
}
