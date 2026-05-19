const TOOL_LANGS = new Set([
  "shell-call",
  "shell_call",
  "tool:shell",
  "tool-shell",
  "local-shell"
]);
const SHELL_LIKE_LANGS = new Set(["shell", "bash", "sh", "zsh"]);

const STATUS_ID = "ai-chat-shell-exec-status";
const STATUS_TEXT_ID = "ai-chat-shell-exec-status-text";
const CONTENT_SCRIPT_VERSION = "0.6.24";
const COMPOSER_PROFILE_PREFIX = "composerProfile:";
const SEND_PROFILE_PREFIX = "sendProfile:";
const SHELL_PROFILE_PREFIX = "shellProfile:";
const PANEL_PROFILE_PREFIX = "panelProfile:";
const DEFAULT_ENABLED_HOSTS = ["chatgpt.com", "m365.cloud.microsoft"];
const DEFAULT_MAX_CHAIN_CALLS = 100;
const LOCAL_MANUAL_TEST_PORT = "17443";
const MANUAL_TMUX_LIST_REQUEST = "ai-chat-shell-exec:tmux-list-request";
const MANUAL_TMUX_LIST_RESPONSE = "ai-chat-shell-exec:tmux-list-response";
const processedCalls = new Set();
const processedSemanticCalls = new Set();
let scanTimer = 0;
let lastThreadText = "";
let lastThreadTextAt = Date.now();
let activeCallId = "";
let chainCallCount = 0;
let lastUserMessageText = "";
let lastDisabledStatusAt = 0;
let lastComposerElement = null;
let lastComposerSelector = "";
let bindingMode = "";
let lastPointerTarget = null;
let savedSendSelector = "";
let savedShellSelector = "";
let pendingSelfTest = null;
let initialThreadSettled = false;
let extensionActive = false;
let threadObserver = null;
let pageEventListenersInstalled = false;

bootstrapActivation().catch(() => {});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync" && (changes.enabled || changes.enabledHosts)) {
    refreshActivation().catch(() => {});
  }
});

async function bootstrapActivation() {
  await refreshActivation();
}

async function refreshActivation() {
  const settings = await chrome.storage.sync.get(["enabled", "enabledHosts"]);
  if (!isSupportedPage() || settings.enabled === false || !isCurrentHostEnabled(settings.enabledHosts)) {
    deactivateExtension();
    return;
  }

  await activateExtension();
}

async function activateExtension() {
  if (extensionActive) {
    return;
  }

  extensionActive = true;
  initialThreadSettled = false;
  injectStatus();
  await loadLocalProfiles();
  observeThread();
  installPageEventListeners();
  scheduleScan();
}

function deactivateExtension() {
  extensionActive = false;
  activeCallId = "";
  bindingMode = "";
  pendingSelfTest = null;
  lastPointerTarget = null;
  clearTimeout(scanTimer);
  threadObserver?.disconnect();
  threadObserver = null;
  removePageEventListeners();
  document.getElementById(STATUS_ID)?.remove();
}

async function loadLocalProfiles() {
  const profiles = await chrome.storage.local.get([
    sendProfileKey(),
    shellProfileKey()
  ]);
  savedSendSelector = profiles[sendProfileKey()]?.selector || "";
  savedShellSelector = profiles[shellProfileKey()]?.selector || "";
}

function observeThread() {
  if (threadObserver) {
    return;
  }

  threadObserver = new MutationObserver(() => {
    scheduleScan();
  });

  threadObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function installPageEventListeners() {
  if (pageEventListenersInstalled) {
    return;
  }

  document.addEventListener("focusin", handleComposerFocus, true);
  document.addEventListener("click", handleComposerClick, true);
  document.addEventListener("input", handleComposerInput, true);
  document.addEventListener("pointerdown", handleBindingPointerDown, true);
  document.addEventListener("click", handleBindingClick, true);
  document.addEventListener("dragstart", handleBindingDragStart, true);
  if (isLocalManualTestPage()) {
    window.addEventListener("message", handleManualTmuxListRequest);
  }
  pageEventListenersInstalled = true;
}

function removePageEventListeners() {
  if (!pageEventListenersInstalled) {
    return;
  }

  document.removeEventListener("focusin", handleComposerFocus, true);
  document.removeEventListener("click", handleComposerClick, true);
  document.removeEventListener("input", handleComposerInput, true);
  document.removeEventListener("pointerdown", handleBindingPointerDown, true);
  document.removeEventListener("click", handleBindingClick, true);
  document.removeEventListener("dragstart", handleBindingDragStart, true);
  window.removeEventListener("message", handleManualTmuxListRequest);
  pageEventListenersInstalled = false;
}

async function handleManualTmuxListRequest(event) {
  if (!isLocalManualTestPage() || event.source !== window || event.origin !== location.origin) {
    return;
  }

  const data = event.data || {};
  if (!data || data.type !== MANUAL_TMUX_LIST_REQUEST) {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: "tmux-list" });
    window.postMessage({
      type: MANUAL_TMUX_LIST_RESPONSE,
      requestId: data.requestId || "",
      ok: Boolean(response?.ok),
      panes: Array.isArray(response?.panes) ? response.panes : [],
      error: response?.error || ""
    }, location.origin);
  } catch (error) {
    window.postMessage({
      type: MANUAL_TMUX_LIST_RESPONSE,
      requestId: data.requestId || "",
      ok: false,
      panes: [],
      error: error?.message || String(error)
    }, location.origin);
  }
}

function handleComposerFocus(event) {
  if (extensionActive) {
    rememberComposer(event.target);
  }
}

function handleComposerClick(event) {
  if (extensionActive) {
    rememberComposer(event.target);
  }
}

function handleComposerInput(event) {
  if (extensionActive) {
    rememberComposer(event.target);
  }
}

function handleBindingPointerDown(event) {
  if (extensionActive) {
    lastPointerTarget = event.target;
  }
}

function handleBindingClick(event) {
  if (!extensionActive || !bindingMode || isInsideShellToolPanel(event.target)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  bindElement(bindingMode, event.target);
  bindingMode = "";
}

function handleBindingDragStart(event) {
  if (extensionActive) {
    lastPointerTarget = event.target;
  }
}

function rememberComposer(target) {
  const editable = closestEditable(target);
  if (!editable || !isVisibleElement(editable)) {
    return;
  }

  lastComposerElement = editable;
  const selector = buildStableSelector(editable);
  if (!selector || selector === lastComposerSelector) {
    return;
  }

  lastComposerSelector = selector;
  chrome.storage.local.set({
    [composerProfileKey()]: {
      selector,
      host: location.host,
      savedAt: new Date().toISOString()
    }
  });
}

function bindElement(mode, target) {
  if (!target || !(target instanceof Element) || isInsideShellToolPanel(target)) {
    setStatus("Binding skipped: no page element selected", "error");
    return;
  }

  if (mode === "input") {
    const editable = closestEditable(target);
    if (!editable || !isVisibleElement(editable)) {
      setStatus("Binding failed: selected element is not editable", "error");
      return;
    }
    rememberComposer(editable);
    setStatus("Bound chat input for this origin", "ok");
    return;
  }

  const selector = buildStableSelector(target);
  if (!selector) {
    setStatus("Binding failed: could not build selector", "error");
    return;
  }

  if (mode === "send") {
    savedSendSelector = selector;
    chrome.storage.local.set({
      [sendProfileKey()]: {
        selector,
        host: location.host,
        savedAt: new Date().toISOString()
      }
    });
    setStatus("Bound send control for this origin", "ok");
    return;
  }

  if (mode === "shell") {
    savedShellSelector = selector;
    chrome.storage.local.set({
      [shellProfileKey()]: {
        selector,
        host: location.host,
        savedAt: new Date().toISOString()
      }
    });
    setStatus("Bound shell-call display area for this origin", "ok");
  }
}

function scheduleScan() {
  if (!extensionActive) {
    return;
  }

  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    scanForShellCall().catch((error) => {
      setStatus(`Shell scanner error: ${summarizeCommand(error.message || String(error))}`, "error");
      scheduleScan();
    });
  }, 900);
}

async function scanForShellCall() {
  if (!extensionActive) {
    return;
  }

  expirePendingSelfTest();

  if (activeCallId || isAssistantGenerating()) {
    scheduleScan();
    return;
  }

  const settings = await chrome.storage.sync.get(["enabled", "enabledHosts", "maxChainCalls"]);
  if (settings.enabled === false || !isCurrentHostEnabled(settings.enabledHosts)) {
    deactivateExtension();
    return;
  }
  updateSiteActionButton(true);

  const thread = getConversationRoot();
  const threadText = normalizeText(thread.innerText || thread.textContent || "");
  const now = Date.now();

  if (threadText !== lastThreadText) {
    lastThreadText = threadText;
    lastThreadTextAt = now;
    scheduleScan();
    return;
  }

  if (now - lastThreadTextAt < 1200) {
    scheduleScan();
    return;
  }

  resetChainForNewHumanPrompt();

  const candidate = getLastShellCallCandidate(thread);
  if (!candidate) {
    initialThreadSettled = true;
    expirePendingSelfTest();
    return;
  }

  if (!initialThreadSettled) {
    initialThreadSettled = true;
    setStatus("Shell tool ready; existing history ignored", "idle");
    return;
  }

  expirePendingSelfTest();

  const call = candidate.call;
  const semanticCallKey = buildSemanticCallKey(call);
  const callKey = buildCandidateCallKey(candidate, semanticCallKey);
  if (processedCalls.has(callKey) ||
    processedSemanticCalls.has(semanticCallKey) ||
    candidate.node?.dataset?.aiChatShellSemanticKey === semanticCallKey) {
    return;
  }

  if (pendingSelfTest && !isExpectedSelfTestCall(call)) {
    markCallProcessed(candidate, callKey, semanticCallKey);
    const expected = pendingSelfTest.command;
    setStatus(`Self-test ignored unexpected shell call; waiting for ${summarizeCommand(expected)}`, "running");
    return;
  }

  const lastShellOutputText = getLastShellOutputText();
  const lastPromptOrOutputText = getLastUserMessageText();
  if ((isShellOutputText(lastShellOutputText) && isSameCommandAsShellOutput(call.cmd, lastShellOutputText)) ||
    (isShellOutputText(lastPromptOrOutputText) && isSameCommandAsShellOutput(call.cmd, lastPromptOrOutputText))) {
    markCallProcessed(candidate, callKey, semanticCallKey);
    setStatus(`Suppressed duplicate shell call: ${summarizeCommand(call.cmd)}`, "ok");
    return;
  }

  const validation = validateShellCall(call);
  if (!validation.ok) {
    markCallProcessed(candidate, callKey, semanticCallKey);
    if (isCopiedOutputRejectionReason(validation.reason)) {
      setStatus(`Suppressed copied shell output: ${summarizeCommand(call.cmd)}`, "ok");
      return;
    }
    await replyWithRejectedCall(call, validation.reason);
    return;
  }

  if (!call.target) {
    markCallProcessed(candidate, callKey, semanticCallKey);
    await replyWithMissingTmuxTarget(call);
    return;
  }

  const maxChainCalls = Math.max(1, Number(settings.maxChainCalls || DEFAULT_MAX_CHAIN_CALLS));
  if (chainCallCount >= maxChainCalls) {
    markCallProcessed(candidate, callKey, semanticCallKey);
    await replyWithRejectedCall(call, `Chain limit reached (${maxChainCalls}). Ask the user before running more shell calls.`);
    return;
  }

  markCallProcessed(candidate, callKey, semanticCallKey);
  await runAndReply(callKey, call);
}

function buildSemanticCallKey(call) {
  return stableHash([
    location.origin,
    normalizeCommand(call.target || ""),
    normalizeCommand(call.cmd || ""),
    normalizeCommand(call.cwd || ""),
    call.timeoutMs || "",
    call.maxOutputChars || ""
  ].join("\n"));
}

function buildCandidateCallKey(candidate, semanticCallKey) {
  return stableHash([
    location.origin,
    candidate.source || "",
    candidate.index || "",
    semanticCallKey
  ].join("\n"));
}

function markCallProcessed(candidate, callKey, semanticCallKey) {
  processedCalls.add(callKey);
  processedSemanticCalls.add(semanticCallKey);
  if (candidate.node?.dataset) {
    candidate.node.dataset.aiChatShellCallKey = callKey;
    candidate.node.dataset.aiChatShellSemanticKey = semanticCallKey;
  }
}

function isSupportedPage() {
  return location.protocol === "https:" && !location.hostname.endsWith(".google.com");
}

function isCurrentHostEnabled(enabledHosts) {
  return isLocalManualTestPage() || normalizeEnabledHosts(enabledHosts).includes(location.hostname.toLowerCase());
}

function isLocalManualTestPage() {
  return ["localhost", "127.0.0.1"].includes(location.hostname.toLowerCase()) &&
    location.port === LOCAL_MANUAL_TEST_PORT;
}

function normalizeEnabledHosts(value) {
  const source = Array.isArray(value) ? value : DEFAULT_ENABLED_HOSTS;
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

function getConversationRoot() {
  const chatFeed = getCurrentChatFeed();
  if (chatFeed) {
    return chatFeed;
  }

  return document.querySelector("#thread") ||
    document.querySelector("main") ||
    document.querySelector('[role="main"]') ||
    document.body;
}

function getCurrentChatFeed() {
  const feeds = Array.from(document.querySelectorAll('[role="feed"]'))
    .filter(isVisibleElement);
  return feeds.find((feed) =>
    /chat conversation|conversation|messages/i.test(feed.getAttribute("aria-label") || "")
  ) || feeds.find((feed) => {
    const text = normalizeText(feed.innerText || feed.textContent || "");
    return text.includes("You said:") || text.includes("Copilot said:") || text.includes("ChatGPT");
  }) || null;
}

function isAssistantGenerating() {
  const candidates = Array.from(document.querySelectorAll("button, [role='button']"));
  return candidates.some((button) => {
    const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`.toLowerCase();
    return label.includes("stop streaming") ||
      label.includes("stop generating") ||
      label.includes("stop response") ||
      label.includes("stop answering") ||
      label === "stop";
  });
}

function getLastShellCallCandidate(root) {
  const candidates = extractShellCallCandidates(root)
    .filter((candidate) => candidate.call?.cmd)
    .filter((candidate) => !isShellOutputText(candidate.node?.innerText || candidate.node?.textContent || ""))
    .filter((candidate) => candidate.node === root || isVisibleElement(candidate.node));

  const runnableCandidates = candidates.filter(isRunnableAuthoredCandidate);
  const assistantCandidates = runnableCandidates.filter(isAssistantAuthoredCandidate);
  const scopedCandidates = assistantCandidates.length > 0 ? assistantCandidates : runnableCandidates;
  return scopedCandidates.length > 0 ? scopedCandidates[scopedCandidates.length - 1] : null;
}

function extractShellCallCandidates(root) {
  let index = 0;
  const candidates = [];
  const roots = [root, ...getBoundShellRoots(root)]
    .filter((node, nodeIndex, all) => all.indexOf(node) === nodeIndex);

  for (const scanRoot of roots) {
    for (const pre of Array.from(scanRoot.querySelectorAll("pre"))) {
      if (closestEditable(pre) || !isVisibleElement(pre)) {
        continue;
      }

      const code = pre.querySelector("code") || pre;
      const cmdText = normalizeCommand(code.innerText || code.textContent || "");
      if (!cmdText) {
        continue;
      }

      const language = detectCodeLanguage(pre, code);
      if (TOOL_LANGS.has(language) || shouldTreatShellLikeCodeAsTool(language, pre, cmdText)) {
        candidates.push({
          call: parseCallPayload(cmdText),
          node: closestMessageContainer(pre),
          index: index += 1,
          source: "rendered-code"
        });
      }
    }

    for (const block of extractLabeledCodeBlockCalls(scanRoot)) {
      candidates.push({
        ...block,
        index: index += 1,
        source: "labeled-code"
      });
    }

    for (const block of extractDowngradedLanguageCodeEditorCalls(scanRoot)) {
      candidates.push({
        ...block,
        index: index += 1,
        source: "downgraded-code-editor"
      });
    }

    for (const block of extractLanguageLabelSiblingCalls(scanRoot)) {
      candidates.push({
        ...block,
        index: index += 1,
        source: "language-label"
      });
    }

    for (const block of extractPlainTextLanguageSections(scanRoot)) {
      candidates.push({
        ...block,
        index: index += 1,
        source: "plain-text-language"
      });
    }

    for (const textRoot of getTextScanRoots(scanRoot)) {
      if (closestEditable(textRoot) || !isVisibleElement(textRoot)) {
        continue;
      }

      for (const call of extractMarkdownFenceCalls(textRoot)) {
        candidates.push({
          call,
          node: closestMessageContainer(textRoot),
          index: index += 1,
          source: "markdown-text"
        });
      }
    }
  }

  candidates.sort((a, b) => compareNodeOrder(a.node, b.node) || a.index - b.index);
  return candidates;
}

function getBoundShellRoots(root) {
  if (!savedShellSelector) {
    return [];
  }

  return Array.from(document.querySelectorAll(savedShellSelector))
    .filter((node) => root === node || root.contains(node))
    .filter(isVisibleElement);
}

function extractPlainTextLanguageSections(root) {
  const lastUserText = getLastUserMessageText().toLowerCase();
  if (!containsToolLanguageHint(lastUserText)) {
    return [];
  }

  const lines = normalizeCommand(root.innerText || root.textContent || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const results = [];

  for (let i = 0; i < lines.length; i += 1) {
    const language = lines[i].toLowerCase();
    if (!SHELL_LIKE_LANGS.has(language)) {
      continue;
    }

    const commandLines = trimCommandLines(lines.slice(i + 1, Math.min(lines.length, i + 12)));

    const command = commandLines.join("\n");
    if (command && command.length <= 8000) {
      results.push({
        call: parseCallPayload(command),
        node: root
      });
    }
  }

  return results;
}

function extractLanguageLabelSiblingCalls(root) {
  const labels = Array.from(root.querySelectorAll("span, div, p, code"))
    .filter((node) => !closestEditable(node))
    .filter(isVisibleElement)
    .filter((node) => {
      const text = normalizeText(node.innerText || node.textContent || "").toLowerCase();
      return TOOL_LANGS.has(text) || SHELL_LIKE_LANGS.has(text);
    });

  return labels
    .map((label) => {
      const language = normalizeText(label.innerText || label.textContent || "").toLowerCase();
      const container = findLanguageLabelContainer(label, language);
      const command = extractCommandAfterLanguage(container, language);
      if (!command || command.length > 8000) {
        return null;
      }
      if (!TOOL_LANGS.has(language) && !shouldTreatShellLikeCodeAsTool(language, label, command)) {
        return null;
      }

      return {
        call: parseCallPayload(command),
        node: closestMessageContainer(container || label)
      };
    })
    .filter(Boolean);
}

function findLanguageLabelContainer(label, language) {
  let current = label.parentElement;
  for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
    const command = extractCommandAfterLanguage(current, language);
    if (command) {
      return current;
    }
  }
  return label.parentElement;
}

function extractCommandAfterLanguage(container, language) {
  const lines = normalizeCommand(container?.innerText || container?.textContent || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.toLowerCase() !== "copy to clipboard");
  const languageIndex = lines.findIndex((line) => line.toLowerCase() === language);
  if (languageIndex < 0) {
    return "";
  }
  return trimCommandLines(lines.slice(languageIndex + 1)).join("\n");
}

function extractLabeledCodeBlockCalls(root) {
  const selector = [
    '[class*="code" i]',
    '[data-testid*="code" i]',
    '[aria-label*="code" i]'
  ].join(",");

  return Array.from(root.querySelectorAll(selector))
    .filter((node) => !node.querySelector("pre"))
    .filter((node) => !closestEditable(node))
    .filter(isVisibleElement)
    .map((node) => {
      const lines = normalizeCommand(node.innerText || node.textContent || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => line.toLowerCase() !== "copy to clipboard");
      if (lines.length < 1 || lines.length > 80) {
        return null;
      }

      const languageMatch = findRenderedCodeLanguageLine(lines);
      let languageIndex = languageMatch?.index ?? -1;
      let language = languageMatch?.language || inferCodeBlockLanguage(node);
      if (!language) {
        return null;
      }

      if (languageIndex < 0) {
        languageIndex = -1;
      }
      const command = trimCommandLines(lines.slice(languageIndex + 1)).join("\n");
      if (!command) {
        return null;
      }
      if (!TOOL_LANGS.has(language) && !shouldTreatShellLikeCodeAsTool(language, node, command)) {
        return null;
      }

      return {
        call: parseCallPayload(command),
        node: closestMessageContainer(node)
      };
    })
    .filter(Boolean)
    .filter((candidate, index, all) => !all.some((other, otherIndex) =>
      otherIndex > index &&
      other.node !== candidate.node &&
      other.node.contains(candidate.node)
    ));
}

function extractDowngradedLanguageCodeEditorCalls(root) {
  const selector = [
    '[class*="code" i]',
    '[data-testid*="code" i]',
    '[aria-label*="code" i]'
  ].join(",");

  return Array.from(root.querySelectorAll(selector))
    .filter((node) => !closestEditable(node))
    .filter(isVisibleElement)
    .map((node) => {
      const markerText = normalizeCommand(node.innerText || node.textContent || "");
      const language = detectDowngradedToolLanguage(markerText);
      if (!language) {
        return null;
      }

      const command = findNearbyDowngradedCodeCommand(node);
      if (!command || command.length > 8000) {
        return null;
      }

      return {
        call: parseCallPayload(command),
        node: closestMessageContainer(node)
      };
    })
    .filter(Boolean);
}

function findNearbyDowngradedCodeCommand(markerNode) {
  const message = closestMessageContainer(markerNode);
  const selector = [
    '[class*="code" i]',
    '[data-testid*="code" i]',
    '[aria-label*="code" i]',
    '[aria-label*="editor" i]',
    '[role="document"]'
  ].join(",");

  const codeNodes = Array.from(message.querySelectorAll(selector))
    .filter((node) => node !== markerNode && !node.contains(markerNode))
    .filter((node) => !closestEditable(node))
    .filter(isVisibleElement)
    .filter((node) => {
      const position = markerNode.compareDocumentPosition(node);
      return position & Node.DOCUMENT_POSITION_FOLLOWING;
    });

  for (const node of codeNodes) {
    const command = cleanedRenderedCodeText(node);
    if (command) {
      return command;
    }
  }

  return "";
}

function cleanedRenderedCodeText(node) {
  const lines = normalizeCommand(node.innerText || node.textContent || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const lower = line.toLowerCase();
      return lower !== "copy code" &&
        lower !== "copy to clipboard" &&
        lower !== "display options" &&
        lower !== "plain text" &&
        !lower.startsWith("go to line") &&
        !detectDowngradedToolLanguage(lower);
    });

  return trimCommandLines(lines).join("\n");
}

function findRenderedCodeLanguageLine(lines) {
  for (let index = 0; index < Math.min(6, lines.length); index += 1) {
    const line = lines[index].toLowerCase();
    if (TOOL_LANGS.has(line) || SHELL_LIKE_LANGS.has(line)) {
      return { index, language: line };
    }

    const downgradedLanguage = detectDowngradedToolLanguage(line);
    if (downgradedLanguage) {
      return { index, language: downgradedLanguage };
    }
  }

  return null;
}

function detectDowngradedToolLanguage(line) {
  const lower = String(line || "").toLowerCase();
  const hasDowngradeSignal = lower.includes("not supported") ||
    lower.includes("isn't fully supported") ||
    lower.includes("unsupported") ||
    lower.includes("plain text");
  if (!hasDowngradeSignal) {
    return "";
  }

  return Array.from(TOOL_LANGS).find((lang) => hasLanguageToken(lower, lang)) || "";
}

function inferCodeBlockLanguage(node) {
  const attrText = normalizeText([
    node.getAttribute("aria-label") || "",
    node.getAttribute("data-language") || "",
    node.className || "",
    node.previousElementSibling?.textContent || "",
    node.parentElement?.getAttribute("aria-label") || "",
    node.parentElement?.getAttribute("data-language") || "",
    node.parentElement?.className || ""
  ].join(" ")).toLowerCase();

  for (const lang of [...TOOL_LANGS, ...SHELL_LIKE_LANGS]) {
    if (hasLanguageToken(attrText, lang)) {
      return lang;
    }
  }
  return "";
}

function hasLanguageToken(text, language) {
  const escaped = escapeRegExp(language);
  return new RegExp(`(^|[^a-z0-9_:-])(?:language-|lang-|code-)?${escaped}(?:\\s+code)?($|[^a-z0-9_:-])`, "i").test(text);
}

function trimCommandLines(lines) {
  const stopWords = new Set([
    "copy",
    "retry",
    "edit",
    "message actions",
    "write a message...",
    "write a message"
  ]);
  const commandLines = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (stopWords.has(lower) ||
      lower.startsWith("model:") ||
      lower === "adaptive" ||
      lower.startsWith("message copilot") ||
      lower.startsWith("ai-generated content may be incorrect")) {
      break;
    }
    commandLines.push(line);
  }

  return commandLines;
}

function getTextScanRoots(root) {
  const selector = [
    '[data-message-author-role="assistant"]',
    "article",
    '[role="article"]',
    ".markdown",
    "[data-testid]",
    "main > div",
    '[role="main"] > div'
  ].join(",");

  const nodes = Array.from(root.querySelectorAll(selector))
    .filter((node) => {
      const text = node.innerText || node.textContent || "";
      return text.length > 0 &&
        text.length <= 30000 &&
        containsToolLanguageHint(text);
    });

  return nodes.filter((node) => !nodes.some((other) =>
    other !== node &&
    other.contains(node) &&
    containsToolLanguageHint(other.innerText || other.textContent || "")
  ));
}

function containsToolLanguageHint(text) {
  const lower = String(text || "").toLowerCase();
  return Array.from(TOOL_LANGS).some((lang) => lower.includes(lang));
}

function closestMessageContainer(node) {
  return node.closest('[data-message-author-role], article, [role="article"], [data-testid], section, main > div') || node;
}

function isAssistantAuthoredCandidate(candidate) {
  const role = getMessageAuthorRole(candidate.node);
  return role === "assistant";
}

function isRunnableAuthoredCandidate(candidate) {
  return getMessageAuthorRole(candidate.node) !== "user";
}

function getMessageAuthorRole(node) {
  const container = node?.closest?.('[data-message-author-role], article, [role="article"]');
  const explicit = container?.getAttribute?.("data-message-author-role") ||
    node?.closest?.('[data-author-role]')?.getAttribute?.("data-author-role") ||
    "";
  const normalizedExplicit = explicit.toLowerCase();
  if (normalizedExplicit === "assistant" || normalizedExplicit === "user") {
    return normalizedExplicit;
  }

  const text = normalizeText(container?.innerText || container?.textContent || node?.innerText || node?.textContent || "")
    .toLowerCase();
  if (text.startsWith("you said:") || text.startsWith("user:")) {
    return "user";
  }
  if (text.startsWith("copilot said:") ||
    text.startsWith("assistant:") ||
    text.startsWith("chatgpt said:") ||
    text.startsWith("claude said:")) {
    return "assistant";
  }
  return "";
}

function compareNodeOrder(a, b) {
  if (a === b) {
    return 0;
  }
  const position = a.compareDocumentPosition(b);
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
    return -1;
  }
  if (position & Node.DOCUMENT_POSITION_PRECEDING) {
    return 1;
  }
  return 0;
}

function detectCodeLanguage(pre, code) {
  const className = `${pre.className || ""} ${code.className || ""}`.toLowerCase();
  for (const lang of [...TOOL_LANGS, ...SHELL_LIKE_LANGS]) {
    if (hasLanguageToken(className, lang)) {
      return lang;
    }
  }

  const headerText = normalizeText(
    [
      pre.previousElementSibling?.textContent || "",
      pre.parentElement?.querySelector("[data-language]")?.getAttribute("data-language") || "",
      pre.parentElement?.textContent?.slice(0, 100) || ""
    ].join(" ")
  ).toLowerCase();

  for (const lang of [...TOOL_LANGS, ...SHELL_LIKE_LANGS]) {
    if (hasLanguageToken(headerText, lang)) {
      return lang;
    }
  }

  return "";
}

function extractMarkdownFenceCalls(root) {
  const text = root.innerText || root.textContent || "";
  const calls = [];
  const fence = /```([a-zA-Z0-9_:-]+)\s*\n([\s\S]*?)```/g;
  let match;

  while ((match = fence.exec(text))) {
    const lang = String(match[1] || "").trim().toLowerCase();
    if (TOOL_LANGS.has(lang) || shouldTreatShellLikeCodeAsTool(lang, root, match[2])) {
      calls.push(parseCallPayload(match[2]));
    }
  }

  return calls;
}

function shouldTreatShellLikeCodeAsTool(language, node, commandText = "") {
  if (!SHELL_LIKE_LANGS.has(String(language || "").toLowerCase())) {
    return false;
  }

  if (hasShellToolDirective(commandText)) {
    return true;
  }

  const lastUserText = getLastUserMessageText().toLowerCase();
  const nearbyText = normalizeText(
    [
      node?.previousElementSibling?.textContent || "",
      node?.parentElement?.textContent?.slice(0, 400) || ""
    ].join(" ")
  ).toLowerCase();

  return containsToolLanguageHint(lastUserText) || containsToolLanguageHint(nearbyText);
}

function parseCallPayload(text) {
  const payload = stripShellToolDirective(normalizeCommand(text));
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === "object") {
      return {
        cmd: normalizeCommand(parsed.cmd || parsed.command || ""),
        target: normalizeCommand(parsed.target || parsed.tmuxTarget || parsed.pane || ""),
        cwd: normalizeCommand(parsed.cwd || ""),
        timeoutMs: Number(parsed.timeoutMs || parsed.timeout || 0) || undefined,
        maxOutputChars: Number(parsed.maxOutputChars || 0) || undefined
      };
    }
  } catch {
    // Plain command payloads are intentionally supported.
  }

  return { cmd: payload };
}

function hasShellToolDirective(text) {
  return getShellToolDirectiveIndex(normalizeCommand(text).split("\n")) >= 0;
}

function stripShellToolDirective(text) {
  const lines = normalizeCommand(text).split("\n");
  const directiveIndex = getShellToolDirectiveIndex(lines);
  if (directiveIndex < 0) {
    return normalizeCommand(text);
  }

  const directiveCommand = extractShellToolDirectiveCommand(lines[directiveIndex]);
  const remaining = lines.filter((_, index) => index !== directiveIndex).join("\n");
  return normalizeCommand([directiveCommand, remaining].filter(Boolean).join("\n"));
}

function getShellToolDirectiveIndex(lines) {
  const firstContentIndex = lines.findIndex((line) => line.trim());
  if (firstContentIndex < 0) {
    return -1;
  }

  const line = lines[firstContentIndex];
  return isShellToolDirectiveLine(line) ? firstContentIndex : -1;
}

function isShellToolDirectiveLine(line) {
  const normalized = line.trim().toLowerCase();
  return /^(#|\/\/|;)\s*(shell-call|shell_call|tool:shell|tool-shell|local-shell|ai-chat-shell-exec)(?:\s*:\s*.+)?$/.test(normalized);
}

function extractShellToolDirectiveCommand(line) {
  const match = String(line || "").trim().match(/^(?:#|\/\/|;)\s*(?:shell-call|shell_call|tool:shell|tool-shell|local-shell|ai-chat-shell-exec)\s*:\s*([\s\S]+)$/i);
  return match ? normalizeCommand(match[1]) : "";
}

function resetChainForNewHumanPrompt() {
  const text = getLastUserMessageText();
  if (!text || text === lastUserMessageText) {
    return;
  }

  lastUserMessageText = text;
  if (!isShellOutputText(text)) {
    chainCallCount = 0;
  }
}

function getLastUserMessageText() {
  const explicit = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
  if (explicit.length > 0) {
    const last = explicit[explicit.length - 1];
    return normalizeCommand(last.innerText || last.textContent || "");
  }

  const promptLike = Array.from(document.querySelectorAll("article, [role='article'], [data-testid], section, main > div, h1, h2, h3, [role='heading']"))
    .filter(isVisibleElement)
    .map((node) => normalizeCommand(node.innerText || node.textContent || ""))
    .filter((text) => text && text.length <= 5000)
    .filter((text) => !isShellOutputText(text))
    .filter(containsToolLanguageHint);

  if (promptLike.length > 0) {
    return promptLike[promptLike.length - 1];
  }

  const toolOutputLike = Array.from(document.querySelectorAll("article, [role='article'], [data-testid], main > div"))
    .filter(isVisibleElement)
    .map((node) => normalizeCommand(node.innerText || node.textContent || ""))
    .filter(isShellOutputText);

  return toolOutputLike.length > 0 ? toolOutputLike[toolOutputLike.length - 1] : "";
}

function getLastShellOutputText() {
  const nodes = Array.from(document.querySelectorAll("article, [role='article'], [data-testid], main > div, body *"))
    .filter(isVisibleElement)
    .map((node) => normalizeCommand(node.innerText || node.textContent || ""))
    .filter(isShellOutputText);

  return nodes.length > 0 ? nodes[nodes.length - 1] : "";
}

function isShellOutputText(text) {
  const lower = String(text || "").toLowerCase();
  return lower.includes("shell call result:") ||
    lower.includes("shell call failed:") ||
    lower.includes("shell call rejected:") ||
    lower.includes("```shell-output") ||
    lower.includes("shell-output");
}

function isSameCommandAsShellOutput(command, shellOutputText) {
  const previousCommand = extractCommandFromShellOutput(shellOutputText);
  return previousCommand && normalizeCommand(command) === previousCommand;
}

function extractCommandFromShellOutput(text) {
  const normalized = normalizeCommand(text);
  const compactMatch = normalized.match(/\$\s+([\s\S]*?)(?:\s*cwd:|\s*exitCode:|\s*durationMs:|```|$)/);
  if (compactMatch?.[1]) {
    return compactMatch[1].trim();
  }

  const lines = normalized.split("\n");
  const commandLine = lines.find((line) => line.trim().startsWith("$ "));
  return commandLine ? commandLine.trim().slice(2).trim() : "";
}

function validateShellCall(call) {
  const cmd = normalizeCommand(call.cmd);
  if (!cmd) {
    return { ok: false, reason: "Command is empty." };
  }

  const lower = cmd.toLowerCase();
  const lines = cmd.split("\n").map((line) => line.trim()).filter(Boolean);
  const suspiciousLine = lines.find((line) =>
    line === "$" ||
    line.startsWith("$ ") ||
    line === "shell-output" ||
    line === "stdout:" ||
    line === "stderr:" ||
    line === "native messaging" ||
    line === "shell-call" ||
    line.startsWith("startedat:") ||
    line.startsWith("exitcode:") ||
    line.startsWith("durationms:") ||
    line.startsWith("cwd:")
  );

  if (suspiciousLine) {
    return {
      ok: false,
      reason: `Looks like copied terminal/output text instead of a command: ${suspiciousLine}`
    };
  }

  if (lower.includes("```") || lower.includes("shell call result") || lower.includes("shell call failed")) {
    return {
      ok: false,
      reason: "Looks like a shell-output reply or markdown wrapper, not a runnable command."
    };
  }

  return { ok: true };
}

function isCopiedOutputRejectionReason(reason) {
  const lower = String(reason || "").toLowerCase();
  return lower.includes("copied terminal/output text") ||
    lower.includes("shell-output reply") ||
    lower.includes("markdown wrapper");
}

async function replyWithRejectedCall(call, reason) {
  chainCallCount += 1;
  setStatus(`Rejected shell call: ${reason}`, "error");
  await insertReply([
    "Shell call rejected:",
    "",
    "```shell-output",
    `$ ${call.cmd}`,
    `error: ${reason}`,
    "```"
  ].join("\n"));
  await clickSendWhenReady();
}

async function replyWithMissingTmuxTarget(call) {
  chainCallCount += 1;
  setStatus("Rejected shell call: missing tmux target", "error");
  const response = await chrome.runtime.sendMessage({ type: "tmux-list" });
  const panes = response?.panes || [];
  const exampleTarget = panes[0]?.id || "%pane_id";
  await insertReply([
    "Shell call rejected:",
    "",
    "```shell-output",
    `$ ${call.cmd}`,
    "error: Missing tmux target. Use a JSON shell-call with target and cmd.",
    "",
    "tmux targets:",
    formatTmuxPanesForShellOutput(panes, response?.error),
    "",
    `example: ${JSON.stringify({ target: exampleTarget, cmd: call.cmd || "pwd" })}`,
    "```"
  ].join("\n"));
  await clickSendWhenReady();
}

async function runAndReply(callId, call) {
  if (!call.cmd) {
    return;
  }

  const settings = await chrome.storage.sync.get(["requireApproval", "autoSend"]);
  if (settings.requireApproval === true) {
    const approved = window.confirm(
      [
        "AI requested a local shell command.",
        "",
        call.target ? `tmux target: ${call.target}` : "tmux target: missing",
        call.cwd ? `cwd: ${call.cwd}` : "cwd: shell server default",
        "",
        call.cmd,
        "",
        "Run this command and post the output back to this chat?"
      ].join("\n")
    );

    if (!approved) {
      return;
    }
  }

  activeCallId = callId;
  chainCallCount += 1;
  setStatus(`Running: ${summarizeCommand(call.cmd)}`, "running");
  const startedAt = new Date().toISOString();
  try {
    const response = await chrome.runtime.sendMessage({
      type: "run-shell",
      id: callId,
      callKey: callId,
      callMeta: {
        origin: location.origin,
        pathname: location.pathname,
        promptHash: stableHash(getLastUserMessageText())
      },
      ...call
    });

    if (response?.duplicate === true && response?.skipped === true) {
      setStatus("Skipped duplicate shell call", "ok");
      return;
    }

    const reply = formatShellOutput(call, response, startedAt);
    await insertReply(reply);
    setShellCompletionStatus(call, response);

    if (settings.autoSend !== false) {
      await clickSendWhenReady();
    }
  } catch (error) {
    setStatus(`Shell call failed: ${error.message || String(error)}`, "error");
    await insertReply(formatShellOutput(call, {
      ok: false,
      error: error.message || String(error)
    }, startedAt));
    if (settings.autoSend !== false) {
      await clickSendWhenReady();
    }
  } finally {
    activeCallId = "";
  }
}

function setShellCompletionStatus(call, response) {
  if (pendingSelfTest && isExpectedSelfTestCall(call)) {
    const token = pendingSelfTest.token;
    pendingSelfTest = null;
    const stdout = String(response?.stdout || "");
    const passed = response?.ok !== false && response?.exitCode === 0 && stdout.includes(token);
    setStatus(
      passed ? `Self-test passed: ${token}` : `Self-test failed: ${token}`,
      passed ? "ok" : "error"
    );
    return;
  }

  setStatus(response?.ok === false ? "Shell call failed" : "Shell call completed", response?.ok === false ? "error" : "ok");
}

function isExpectedSelfTestCall(call) {
  return !!pendingSelfTest &&
    normalizeCommand(call?.cmd || "") === pendingSelfTest.command &&
    normalizeCommand(call?.target || "") === normalizeCommand(pendingSelfTest.target || "") &&
    (!call?.cwd || normalizeCommand(call.cwd) === normalizeCommand(pendingSelfTest.cwd || ""));
}

function expirePendingSelfTest() {
  if (pendingSelfTest && Date.now() - pendingSelfTest.startedAt > 120000) {
    pendingSelfTest = null;
    setStatus("Self-test expired before a matching shell-call appeared", "error");
  }
}

function formatShellOutput(call, response, startedAt) {
  if (!response || response.ok === false) {
    return [
      "Shell call failed:",
      "",
      "```shell-output",
      `$ ${call.cmd}`,
      call.target ? `target: ${call.target}` : "",
      `startedAt: ${startedAt}`,
      `error: ${response?.error || "Unknown shell server error."}`,
      response?.example ? `example: ${response.example}` : "",
      response?.tmuxPanes ? "\ntmux targets:\n" + formatTmuxPanesForShellOutput(response.tmuxPanes) : "",
      "```"
    ].filter((line) => line !== "").join("\n");
  }

  const stdout = response.stdout || "";
  const stderr = response.stderr || "";
  const meta = [
    `$ ${call.cmd}`,
    `target: ${response.target || call.target || ""}`,
    response.targetName ? `targetName: ${response.targetName}` : "",
    `cwd: ${response.cwd || call.cwd || ""}`,
    `exitCode: ${response.exitCode}`,
    `durationMs: ${response.durationMs}`,
    response.truncated ? "truncated: true" : ""
  ].filter(Boolean);

  return [
    "Shell call result:",
    "",
    "```shell-output",
    ...meta,
    stdout ? "\nstdout:\n" + stdout : "",
    stderr ? "\nstderr:\n" + stderr : "",
    "```"
  ].join("\n");
}

function formatTmuxPanesForShellOutput(panes, error = "") {
  if (error) {
    return `tmux list failed: ${error}`;
  }
  if (!Array.isArray(panes) || panes.length === 0) {
    return "No tmux panes found. Start tmux and open a shell pane first.";
  }

  return panes.map((pane) => [
    `target=${pane.id}`,
    `address=${pane.address}`,
    `window=${pane.windowName || "(unnamed)"}`,
    `command=${pane.currentCommand || "unknown"}`,
    pane.currentPath ? `cwd=${pane.currentPath}` : "",
    pane.active ? "active=true" : "active=false"
  ].filter(Boolean).join(" ")).join("\n");
}

async function insertReply(text) {
  const input = await findReplyInput();
  if (!input) {
    throw new Error("Could not find a chat composer. Click the chat input once, then ask the AI for a shell-call again.");
  }

  rememberComposer(input);
  input.focus();

  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
    input.value = text;
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text
    }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input;
  }

  setContentEditableText(input, text);
  return input;
}

function setContentEditableText(input, text) {
  input.focus();
  if (insertContentEditableWithEditingCommand(input, text)) {
    return;
  }

  const selection = document.getSelection();
  selection?.removeAllRanges();

  input.replaceChildren(...text.split("\n").map((line) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = line || "\u00a0";
    return paragraph;
  }));

  const range = document.createRange();
  range.selectNodeContents(input);
  range.collapse(false);
  selection?.addRange(range);

  input.dispatchEvent(new InputEvent("beforeinput", {
    bubbles: true,
    composed: true,
    cancelable: true,
    inputType: "insertText",
    data: text
  }));
  input.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    composed: true,
    inputType: "insertText",
    data: text
  }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function insertContentEditableWithEditingCommand(input, text) {
  if (typeof document.execCommand !== "function") {
    return false;
  }

  input.focus();
  const selection = document.getSelection();
  if (!selection) {
    return false;
  }

  const range = document.createRange();
  range.selectNodeContents(input);
  selection.removeAllRanges();
  selection.addRange(range);

  let inserted = false;
  try {
    inserted = document.execCommand("insertText", false, text);
  } catch {
    inserted = false;
  }

  if (!inserted) {
    return contentEditableHasText(input, text);
  }

  input.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    composed: true,
    inputType: "insertText",
    data: null
  }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function contentEditableHasText(input, expected) {
  const actual = normalizeCommand(input.innerText || input.textContent || "");
  const normalizedExpected = normalizeCommand(expected);
  const compactActual = actual.replace(/\s+/g, "");
  const compactExpected = normalizedExpected.replace(/\s+/g, "");
  return actual === normalizedExpected ||
    actual.includes(normalizedExpected.slice(0, 80)) ||
    (compactExpected.length > 0 && compactActual.includes(compactExpected.slice(0, Math.min(120, compactExpected.length))));
}

async function findReplyInput() {
  if (lastComposerElement && lastComposerElement.isConnected && isEditableElement(lastComposerElement)) {
    return lastComposerElement;
  }

  const profile = await chrome.storage.local.get(composerProfileKey());
  const selector = profile[composerProfileKey()]?.selector;
  if (selector) {
    const saved = document.querySelector(selector);
    if (saved && isEditableElement(saved) && isVisibleElement(saved)) {
      lastComposerElement = saved;
      return saved;
    }
  }

  const active = closestEditable(document.activeElement);
  if (active && isVisibleElement(active)) {
    lastComposerElement = active;
    return active;
  }

  const preferredSelectors = [
    '[contenteditable="true"][role="textbox"]',
    '[role="textbox"][contenteditable="true"]',
    '[role="textbox"]',
    "textarea",
    "input",
    '[contenteditable="true"]'
  ];

  const candidates = preferredSelectors
    .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
    .filter((node, index, all) => all.indexOf(node) === index)
    .filter(isEditableElement)
    .filter(isVisibleElement)
    .sort((a, b) => editableScore(b) - editableScore(a));

  const candidate = candidates[0] || null;
  if (candidate) {
    lastComposerElement = candidate;
  }
  return candidate;
}

function editableScore(node) {
  const rect = node.getBoundingClientRect();
  const label = `${node.getAttribute("aria-label") || ""} ${node.getAttribute("placeholder") || ""}`.toLowerCase();
  let score = 0;
  if (label.includes("message") || label.includes("ask") || label.includes("reply") || label.includes("chat")) {
    score += 50;
  }
  if (rect.bottom > window.innerHeight * 0.5) {
    score += 20;
  }
  score += Math.min(20, rect.width / 40);
  return score;
}

async function clickSendWhenReady(composer = lastComposerElement || closestEditable(document.activeElement)) {
  const originalText = normalizeCommand(composer?.innerText || composer?.value || composer?.textContent || "");

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const sendButton = findSendButton(composer, attempt < 20);
    if (sendButton && !sendButton.disabled && sendButton.getAttribute("aria-disabled") !== "true") {
      sendButton.click();
      if (await waitForSubmitted(composer, originalText)) {
        return true;
      }
    }

    if (attempt === 20 && trySubmitForm(composer)) {
      if (await waitForSubmitted(composer, originalText)) {
        return true;
      }
    }

    if (attempt === 21 && tryKeyboardSubmit(composer)) {
      if (await waitForSubmitted(composer, originalText)) {
        return true;
      }
    }
    await sleep(150);
  }

  setStatus("Shell output inserted; send button was not ready", "error");
  return false;
}

function trySubmitForm(composer) {
  const form = composer?.closest?.("form");
  if (!form) {
    return false;
  }

  try {
    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else {
      form.dispatchEvent(new SubmitEvent("submit", {
        bubbles: true,
        cancelable: true
      }));
    }
    return true;
  } catch {
    return false;
  }
}

function tryKeyboardSubmit(composer) {
  if (!composer) {
    return false;
  }

  composer.focus();
  const events = [
    new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, composed: true }),
    new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, composed: true }),
    new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, composed: true, metaKey: true }),
    new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, composed: true, metaKey: true }),
    new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, composed: true, ctrlKey: true }),
    new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, cancelable: true, composed: true, ctrlKey: true })
  ];
  for (const event of events) {
    composer.dispatchEvent(event);
  }
  return true;
}

async function waitForSubmitted(composer, originalText) {
  if (!originalText) {
    return false;
  }

  for (let i = 0; i < 8; i += 1) {
    await sleep(125);
    const currentText = normalizeCommand(composer?.innerText || composer?.value || composer?.textContent || "");
    if (!currentText || (currentText !== originalText && !currentText.includes("Shell call"))) {
      return true;
    }
  }
  return false;
}

function findSendButton(composer = lastComposerElement || closestEditable(document.activeElement), preferBoundOnly = false) {
  const bound = findBoundSendButton();
  if (bound) {
    return bound;
  }
  if (preferBoundOnly) {
    return null;
  }

  const nearbyRoot = composer?.closest("form, footer, main, body") || document;
  const composerRect = composer?.getBoundingClientRect();
  const buttons = Array.from(nearbyRoot.querySelectorAll("button, [role='button']"))
    .filter((button) => !isInsideShellToolPanel(button))
    .filter(isVisibleElement)
    .map((button) => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${button.textContent || ""}`.toLowerCase();
      if (label.includes("stop") || label.includes("voice") || label.includes("model:")) {
        return null;
      }

      let score = 0;
      if (button.matches('[data-testid="send-button"], [data-testid="composer-send-button"]')) {
        score += 100;
      }
      if (label.includes("send message") || label.includes("send prompt")) {
        score += 80;
      } else if (label.includes("send") || label.includes("submit") || label.trim() === "send") {
        score += 50;
      }
      if (button.getAttribute("type") === "submit") {
        score += 20;
      }
      if (composerRect) {
        const rect = button.getBoundingClientRect();
        const dx = Math.abs((rect.left + rect.right) / 2 - (composerRect.left + composerRect.right) / 2);
        const dy = Math.abs((rect.top + rect.bottom) / 2 - (composerRect.top + composerRect.bottom) / 2);
        score += Math.max(0, 60 - (dx + dy) / 20);
      }

      return score > 0 ? { button, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return buttons[0]?.button || null;
}

function findBoundSendButton() {
  if (!savedSendSelector) {
    return null;
  }

  return Array.from(document.querySelectorAll(savedSendSelector))
    .filter((node) => !isInsideShellToolPanel(node))
    .filter(isVisibleElement)
    .find((node) => node instanceof HTMLButtonElement || node.getAttribute("role") === "button" || typeof node.click === "function") ||
    null;
}

function closestEditable(target) {
  if (!target || !(target instanceof Element)) {
    return null;
  }
  return isEditableElement(target) ? target : target.closest('textarea, input, [contenteditable="true"], [role="textbox"]');
}

function isEditableElement(node) {
  if (!node || !(node instanceof Element)) {
    return false;
  }
  if (node instanceof HTMLTextAreaElement) {
    return !node.disabled && !node.readOnly;
  }
  if (node instanceof HTMLInputElement) {
    const type = (node.type || "text").toLowerCase();
    return ["text", "search", "url"].includes(type) && !node.disabled && !node.readOnly;
  }
  return node.getAttribute("contenteditable") === "true" ||
    (node.getAttribute("role") === "textbox" && node.isContentEditable);
}

function isVisibleElement(node) {
  if (!node || !(node instanceof Element)) {
    return false;
  }
  const rect = node.getBoundingClientRect();
  const style = window.getComputedStyle(node);
  return rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== "hidden" &&
    style.display !== "none";
}

function buildStableSelector(node) {
  if (!(node instanceof Element)) {
    return "";
  }
  if (node.id) {
    return `#${CSS.escape(node.id)}`;
  }

  const parts = [];
  let current = node;
  while (current && current !== document.body && parts.length < 5) {
    const tag = current.tagName.toLowerCase();
    const stableAttr = ["data-testid", "aria-label", "role", "name", "placeholder"]
      .map((attr) => [attr, current.getAttribute(attr)])
      .find(([, value]) => value);
    let part = tag;
    if (stableAttr) {
      part += `[${stableAttr[0]}="${escapeAttributeValue(stableAttr[1])}"]`;
    } else {
      const siblings = Array.from(current.parentElement?.children || []).filter((child) => child.tagName === current.tagName);
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
    }
    parts.unshift(part);
    current = current.parentElement;
  }

  return parts.join(" > ");
}

function escapeAttributeValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function composerProfileKey() {
  return `${COMPOSER_PROFILE_PREFIX}${location.origin}`;
}

function sendProfileKey() {
  return `${SEND_PROFILE_PREFIX}${location.origin}`;
}

function shellProfileKey() {
  return `${SHELL_PROFILE_PREFIX}${location.origin}`;
}

function panelProfileKey() {
  return `${PANEL_PROFILE_PREFIX}${location.origin}`;
}

function injectStatus() {
  if (document.getElementById(STATUS_ID)) {
    return;
  }

  const panel = document.createElement("div");
  panel.id = STATUS_ID;
  panel.dataset.state = "idle";
  panel.style.cssText = [
    "position:fixed",
    "right:16px",
    "bottom:16px",
    "z-index:2147483647",
    "max-width:420px",
    "padding:8px",
    "border-radius:8px",
    "font:12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    "background:#111827",
    "color:#fff",
    "box-shadow:0 6px 24px rgba(0,0,0,.18)",
    "opacity:.88",
    "pointer-events:auto",
    "user-select:none"
  ].join(";");

  const statusText = document.createElement("div");
  statusText.id = STATUS_TEXT_ID;
  statusText.textContent = `Shell tool ready v${CONTENT_SCRIPT_VERSION}`;
  statusText.style.cssText = "margin-bottom:6px;line-height:1.3;cursor:move";
  statusText.title = "Drag to move";
  panel.appendChild(statusText);

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:4px;flex-wrap:wrap";
  for (const [mode, label] of [
    ["test", "Test"],
    ["check", "Check"],
    ["site", "Enable site"],
    ["input", "Bind input"],
    ["send", "Bind send"],
    ["shell", "Bind shell"],
    ["clear", "Clear"]
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.shellToolAction = mode;
    button.style.cssText = [
      "border:0",
      "border-radius:6px",
      "padding:4px 6px",
      "font:11px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "background:#374151",
      "color:#fff",
      "cursor:pointer"
    ].join(";");
    actions.appendChild(button);
  }
  panel.appendChild(actions);

  panel.addEventListener("click", (event) => {
    const button = event.target.closest("[data-shell-tool-action]");
    if (!button) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    handlePanelAction(button.dataset.shellToolAction);
  }, true);

  panel.addEventListener("dragover", (event) => {
    event.preventDefault();
    panel.style.outline = "2px solid #93c5fd";
  });
  panel.addEventListener("dragleave", () => {
    panel.style.outline = "";
  });
  panel.addEventListener("drop", (event) => {
    event.preventDefault();
    panel.style.outline = "";
    const mode = event.dataTransfer?.getData("text/x-shell-tool-mode") || bindingMode || "shell";
    bindElement(mode, lastPointerTarget);
    bindingMode = "";
  });

  document.documentElement.appendChild(panel);
  chrome.storage.sync.get(["enabledHosts"]).then((settings) => {
    updateSiteActionButton(isCurrentHostEnabled(settings.enabledHosts));
  });
  restorePanelPosition(panel);
  installPanelDrag(panel, statusText);
}

function setStatus(text, state = "idle") {
  const panel = document.getElementById(STATUS_ID);
  const statusText = document.getElementById(STATUS_TEXT_ID);
  if (!panel || !statusText) {
    return;
  }

  statusText.textContent = text;
  panel.dataset.state = state;
  const colors = {
    idle: "#111827",
    running: "#1d4ed8",
    ok: "#047857",
    error: "#b91c1c"
  };
  panel.style.background = colors[state] || colors.idle;
}

function handlePanelAction(action) {
  if (action === "test") {
    runFullChainTest().catch((error) => {
      setStatus(`Test failed: ${summarizeCommand(error.message || String(error))}`, "error");
    });
    return;
  }

  if (action === "site") {
    toggleCurrentSiteEnabled().catch((error) => {
      setStatus(`Site update failed: ${summarizeCommand(error.message || String(error))}`, "error");
    });
    return;
  }

  if (action === "check") {
    runHealthCheck().catch((error) => {
      setStatus(`Check failed: ${summarizeCommand(error.message || String(error))}`, "error");
    });
    return;
  }

  if (action === "clear") {
    savedSendSelector = "";
    savedShellSelector = "";
    lastComposerSelector = "";
    chrome.storage.local.remove([composerProfileKey(), sendProfileKey(), shellProfileKey()]);
    setStatus("Cleared bindings for this origin", "ok");
    return;
  }

  bindingMode = action;
  setStatus(`Click a page element, or drag it onto this panel, to bind ${action}`, "running");
}

async function toggleCurrentSiteEnabled() {
  const settings = await chrome.storage.sync.get(["enabledHosts"]);
  const host = location.hostname.toLowerCase();
  const hosts = normalizeEnabledHosts(settings.enabledHosts);
  const enabled = hosts.includes(host);
  const nextHosts = enabled ? hosts.filter((item) => item !== host) : [...hosts, host].sort();
  await chrome.storage.sync.set({ enabledHosts: nextHosts });
  updateSiteActionButton(!enabled);
  setStatus(`${enabled ? "Disabled" : "Enabled"} this site: ${host}`, enabled ? "idle" : "ok");
  scheduleScan();
}

function updateSiteActionButton(enabled) {
  const button = document.querySelector(`#${STATUS_ID} [data-shell-tool-action="site"]`);
  if (button) {
    button.textContent = enabled ? "Disable site" : "Enable site";
  }
}

async function runHealthCheck() {
  setStatus("Checking shell server and bindings", "running");
  const [health, tmux, profiles] = await Promise.all([
    chrome.runtime.sendMessage({ type: "shell-health" }),
    chrome.runtime.sendMessage({ type: "tmux-list" }),
    chrome.storage.local.get([composerProfileKey(), sendProfileKey(), shellProfileKey()])
  ]);
  const bindings = [
    profiles[composerProfileKey()]?.selector ? "input" : "",
    savedSendSelector || profiles[sendProfileKey()]?.selector ? "send" : "",
    savedShellSelector || profiles[shellProfileKey()]?.selector ? "shell" : ""
  ].filter(Boolean);

  if (health && health.originMatches === false) {
    setStatus(`Server origin mismatch: ${health.extensionId || "current extension"}`, "error");
    return;
  }

  if (!health?.ok) {
    setStatus(`Server offline: ${summarizeCommand(health?.error || "run install/start script")}`, "error");
    return;
  }

  const boundText = bindings.length > 0 ? bindings.join("/") : "auto";
  const pidText = health.pid ? ` pid ${health.pid}` : "";
  const paneText = tmux?.ok ? `; tmux panes ${tmux.panes?.length || 0}` : "; tmux unavailable";
  setStatus(`Server ok${pidText}; bindings ${boundText}${paneText}`, tmux?.ok === false ? "error" : "ok");
}

async function runFullChainTest() {
  const settings = await chrome.storage.sync.get(["enabledHosts"]);
  if (!isCurrentHostEnabled(settings.enabledHosts)) {
    setStatus(`Enable this site first: ${location.hostname}`, "error");
    return;
  }

  const tmux = await chrome.runtime.sendMessage({ type: "tmux-list" });
  if (!tmux?.ok || !Array.isArray(tmux.panes) || tmux.panes.length === 0) {
    setStatus(`Test failed: ${summarizeCommand(tmux?.error || "no tmux panes found")}`, "error");
    return;
  }

  const pane = chooseSelfTestPane(tmux.panes);
  const token = `shell-tool-self-test-${Date.now().toString(36)}`;
  const command = `printf ${token}`;
  const payload = JSON.stringify({ target: pane.id, cmd: command });
  const prompt = [
    "Compatibility test.",
    "Reply only with one markdown code block labeled shell.",
    "The only line inside must be exactly:",
    `# local-shell: ${payload}`
  ].join("\n");

  setStatus(`Starting full test on ${pane.id}: ${token}`, "running");
  const composer = await insertReply(prompt);
  const sent = await clickSendWhenReady(composer);
  if (sent) {
    pendingSelfTest = {
      token,
      command,
      target: pane.id,
      cwd: "",
      startedAt: Date.now()
    };
    setStatus(`Waiting for shell-call test: ${token}`, "running");
  }
}

function chooseSelfTestPane(panes) {
  const shellNames = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]);
  return panes.find((pane) => pane.active && shellNames.has(String(pane.currentCommand || "").toLowerCase())) ||
    panes.find((pane) => shellNames.has(String(pane.currentCommand || "").toLowerCase())) ||
    panes[0];
}

async function restorePanelPosition(panel) {
  const profile = await chrome.storage.local.get(panelProfileKey());
  const saved = profile[panelProfileKey()];
  if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) {
    return;
  }

  const left = Math.max(8, Math.min(saved.left, window.innerWidth - panel.offsetWidth - 8));
  const top = Math.max(8, Math.min(saved.top, window.innerHeight - panel.offsetHeight - 8));
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.right = "auto";
  panel.style.bottom = "auto";
}

function installPanelDrag(panel, handle) {
  let drag = null;

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }

    const rect = panel.getBoundingClientRect();
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    drag = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  });

  handle.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }

    const left = Math.max(8, Math.min(event.clientX - drag.offsetX, window.innerWidth - panel.offsetWidth - 8));
    const top = Math.max(8, Math.min(event.clientY - drag.offsetY, window.innerHeight - panel.offsetHeight - 8));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    event.preventDefault();
    event.stopPropagation();
  });

  const finishDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    drag = null;
    const rect = panel.getBoundingClientRect();
    chrome.storage.local.set({
      [panelProfileKey()]: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        host: location.host,
        savedAt: new Date().toISOString()
      }
    });
    try {
      handle.releasePointerCapture?.(event.pointerId);
    } catch {
      // Ignore pointer-capture races.
    }
    event.preventDefault();
    event.stopPropagation();
  };

  handle.addEventListener("pointerup", finishDrag);
  handle.addEventListener("pointercancel", finishDrag);

  window.addEventListener("resize", () => {
    const rect = panel.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 8));
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - panel.offsetHeight - 8));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  });
}

function isInsideShellToolPanel(target) {
  return target instanceof Element && Boolean(target.closest(`#${STATUS_ID}`));
}

function summarizeCommand(command) {
  const singleLine = normalizeText(command);
  return singleLine.length > 80 ? `${singleLine.slice(0, 77)}...` : singleLine;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeCommand(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stableHash(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
