const DEFAULTS = {
  enabled: true,
  requireApproval: false,
  autoSend: true,
  defaultTimeoutMs: 30000,
  maxOutputChars: 20000,
  maxChainCalls: 5
};

const fields = {
  enabled: document.getElementById("enabled"),
  autoSend: document.getElementById("autoSend"),
  requireApproval: document.getElementById("requireApproval"),
  defaultTimeoutMs: document.getElementById("defaultTimeoutMs"),
  maxOutputChars: document.getElementById("maxOutputChars"),
  maxChainCalls: document.getElementById("maxChainCalls")
};

const health = document.getElementById("health");
const saveButton = document.getElementById("save");
const refreshHealthButton = document.getElementById("refreshHealth");

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  await refreshHealth();
});

saveButton.addEventListener("click", saveSettings);
refreshHealthButton.addEventListener("click", refreshHealth);

async function loadSettings() {
  const settings = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  const merged = { ...DEFAULTS, ...settings };
  fields.enabled.checked = merged.enabled !== false;
  fields.autoSend.checked = merged.autoSend !== false;
  fields.requireApproval.checked = merged.requireApproval === true;
  fields.defaultTimeoutMs.value = merged.defaultTimeoutMs;
  fields.maxOutputChars.value = merged.maxOutputChars;
  fields.maxChainCalls.value = merged.maxChainCalls;
}

async function saveSettings() {
  saveButton.disabled = true;
  await chrome.storage.sync.set({
    enabled: fields.enabled.checked,
    autoSend: fields.autoSend.checked,
    requireApproval: fields.requireApproval.checked,
    defaultTimeoutMs: clampNumber(fields.defaultTimeoutMs.value, 1000, 600000, DEFAULTS.defaultTimeoutMs),
    maxOutputChars: clampNumber(fields.maxOutputChars.value, 1000, 200000, DEFAULTS.maxOutputChars),
    maxChainCalls: clampNumber(fields.maxChainCalls.value, 1, 20, DEFAULTS.maxChainCalls)
  });
  saveButton.textContent = "Saved";
  setTimeout(() => {
    saveButton.disabled = false;
    saveButton.textContent = "Save";
  }, 800);
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
    health.textContent = response?.error || "Server not reachable";
  } catch (error) {
    health.dataset.state = "error";
    health.textContent = error.message || String(error);
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(number)));
}
