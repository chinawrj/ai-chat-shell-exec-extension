const HELPER_SHELL_START = "ai-helper-shell-start";
const HELPER_SHELL_END = "ai-helper-shell-end";
const HELPER_FILE_START = "ai-helper-file-start";
const HELPER_FILE_END = "ai-helper-file-end";
const HELPER_BOARD_START = "ai-helper-board-start";
const HELPER_BOARD_END = "ai-helper-board-end";
const UNSUPPORTED_HELPER_MARKERS = new Set(["ai-helper-start-shell", "ai-helper-end-shell"]);
const HELPER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const STATUS_ID = "ai-chat-shell-exec-status";
const STATUS_TEXT_ID = "ai-chat-shell-exec-status-text";
const DEBUG_BODY_ID = "ai-chat-shell-exec-debug-body";
const DEBUG_PROFILE_PREFIX = "panelDebugOpen:";
const CONTENT_SCRIPT_VERSION = "0.5.0";
const SHELL_OUTPUT_COMMAND_DISPLAY_CHARS = 64;
const COMPOSER_PROFILE_PREFIX = "composerProfile:";
const SEND_PROFILE_PREFIX = "sendProfile:";
const SHELL_PROFILE_PREFIX = "shellProfile:";
const PANEL_PROFILE_PREFIX = "panelProfile:";
const DEFAULT_ENABLED_HOSTS = ["chatgpt.com", "m365.cloud.microsoft"];
const DEFAULT_MAX_CHAIN_CALLS = 100;
const LOCAL_MANUAL_TEST_PORT = "17443";
const FORCE_RUN_STATUS_HINT = "click Force run to bypass";
const MANUAL_TMUX_LIST_REQUEST = "ai-chat-shell-exec:tmux-list-request";
const MANUAL_TMUX_LIST_RESPONSE = "ai-chat-shell-exec:tmux-list-response";
const processedCalls = new Set();
const processedSemanticCalls = new Set();
// Keep dedup metadata in memory only; unlike dataset persistence this resets on content-script reinjection.
// That can re-evaluate existing helpers, but initialThreadSettled already ignores existing history on first scan.
const processedNodeSemanticKeys = new WeakMap();
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
let lastSuppressedCallStatus = "";
let lastExecutedSemanticKey = "";
let forceCallSequence = 0;
let extensionVersionWarning = "";
// The author-role filter is opt-in. The legacy heuristic that decided whether a
// helper block came from the assistant or the user produced false positives on
// hosts that don't expose `data-message-author-role` (or whose nearest
// recognized container wraps multiple turns), which made the most recent helper
// block silently skipped. Default to off so the latest helper block always
// runs; the popup / panel toggle can re-enable strict filtering when needed.
let authorRoleFilterEnabled = false;

bootstrapActivation().catch(() => {});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "sync" && (changes.enabled || changes.enabledHosts)) {
    refreshActivation().catch(() => {});
  }
  if (areaName === "sync" && changes.disableAuthorRoleFilter) {
    authorRoleFilterEnabled = changes.disableAuthorRoleFilter.newValue === false;
    updateRoleFilterButton();
    scheduleScan();
  }
});

async function bootstrapActivation() {
  await refreshActivation();
}

async function refreshActivation() {
  const settings = await chrome.storage.sync.get(["enabled", "enabledHosts", "disableAuthorRoleFilter"]);
  authorRoleFilterEnabled = settings.disableAuthorRoleFilter === false;
  if (!isSupportedPage() || settings.enabled === false || !isCurrentHostEnabled(settings.enabledHosts)) {
    deactivateExtension();
    return;
  }

  await activateExtension();
  updateRoleFilterButton();
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
    setStatus("Bound helper block display area for this origin", "ok");
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

async function scanForShellCall(options = {}) {
  const force = options.force === true;
  const forceAttempts = Number(options.forceAttempts || 0);
  if (!extensionActive) {
    return;
  }

  if (!force) {
    expirePendingSelfTest();
  }

  // Refresh the floating panel's detected-helper view on every scan attempt
  // before any of the guards below can early-return. The debug body is
  // independent of whether we will actually run the helper this tick: it
  // should always reflect the latest fully-terminated helper block in the
  // current DOM, even while a previous call is still running, while the AI
  // is streaming a follow-up turn, or while the thread text is still
  // changing. Otherwise the panel can remain stuck on the first helper
  // block forever.
  try {
    const conversationRoot = getConversationRoot();
    const allCandidates = extractShellCallCandidates(conversationRoot);
    updateDetectedHelperDebug(getLastShellCallCandidate(conversationRoot), allCandidates);
  } catch (_unused) {
    // Detection runs on a partially-rendered DOM during streaming; never
    // let a transient scan failure block the rest of the scanner.
  }

  if (activeCallId) {
    if (force && forceAttempts < 20) {
      setStatus("Waiting for current helper call, then running latest", "running");
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => {
        scanForShellCall({ force: true, forceAttempts: forceAttempts + 1 }).catch((error) => {
          setStatus(`Force run failed: ${summarizeCommand(error.message || String(error))}`, "error");
        });
      }, 500);
      return;
    }

    scheduleScan();
    return;
  }

  if (!force && isAssistantGenerating()) {
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

  const candidate = getLastShellCallCandidate(thread);

  if (!force && threadText !== lastThreadText) {
    lastThreadText = threadText;
    lastThreadTextAt = now;
    scheduleScan();
    return;
  }

  if (!force && now - lastThreadTextAt < 1200) {
    scheduleScan();
    return;
  }

  resetChainForNewHumanPrompt();

  if (!candidate) {
    initialThreadSettled = true;
    expirePendingSelfTest();
    if (force) {
      setStatus("No helper block found on this page", "idle");
    }
    return;
  }

  if (!force && !initialThreadSettled) {
    initialThreadSettled = true;
    setStatus("Shell tool ready; existing history ignored", "idle");
    return;
  }

  if (!force) {
    expirePendingSelfTest();
  }

  const call = candidate.call;
  const semanticCallKey = buildSemanticCallKey(call);
  const callKey = buildCandidateCallKey(candidate, semanticCallKey);
  if (!force) {
    let dedupReason = "";
    if (processedCalls.has(callKey)) {
      dedupReason = "processed callKey";
    } else if (processedSemanticCalls.has(semanticCallKey)) {
      dedupReason = "processed semantic key";
    } else if (candidate.node instanceof Element &&
      processedNodeSemanticKeys.get(candidate.node) === semanticCallKey) {
      dedupReason = "processed node semantic key";
    }
    if (dedupReason) {
      rememberSuppressedCallStatus(dedupReason);
      setStatus(`Suppressed duplicate helper call: ${summarizeCommand(call.cmd)}`, "ok");
      return;
    }
  }

  if (!force && pendingSelfTest && !isExpectedSelfTestCall(call)) {
    markCallProcessed(candidate, callKey, semanticCallKey);
    const expected = pendingSelfTest.command;
    setStatus(`Self-test ignored unexpected shell call; waiting for ${summarizeCommand(expected)}`, "running");
    return;
  }

  const lastShellOutputText = getLastShellOutputText();
  const lastPromptOrOutputText = getLastUserMessageText();
  if (!force && shouldSuppressShellCallEcho(call, lastShellOutputText, lastPromptOrOutputText)) {
    rememberSuppressedCallStatus("suppressed shell-output echo");
    markCallProcessed(candidate, callKey, semanticCallKey);
    setStatus(`Suppressed duplicate shell call: ${summarizeCommand(call.cmd)}`, "ok");
    return;
  }

  const validation = validateHelperCall(call);
  if (!validation.ok) {
    markCallProcessed(candidate, callKey, semanticCallKey);
    if (isCopiedOutputRejectionReason(validation.reason)) {
      setStatus(`Suppressed copied shell output: ${summarizeCommand(call.cmd)}`, "ok");
      return;
    }
    await replyWithRejectedCall(call, validation.reason);
    return;
  }

  const maxChainCalls = Math.max(1, Number(settings.maxChainCalls || DEFAULT_MAX_CHAIN_CALLS));
  if (!force && chainCallCount >= maxChainCalls) {
    markCallProcessed(candidate, callKey, semanticCallKey);
    await replyWithRejectedCall(call, `Chain limit reached (${maxChainCalls}). Ask the user before running more shell calls.`);
    return;
  }

  const executionCallKey = force ? buildForceCallKey(semanticCallKey) : callKey;
  if (!force) {
    markCallProcessed(candidate, callKey, semanticCallKey);
  }
  await runAndReply(executionCallKey, call, { force });
}

function buildSemanticCallKey(call) {
  return stableHash([
    location.origin,
    normalizeCommand(call.kind || "shell"),
    normalizeCommand(call.helperId || ""),
    normalizeCommand(call.cmd || ""),
    normalizeCommand(call.filename || ""),
    normalizeCommand(call.content || ""),
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

function buildForceCallKey(semanticCallKey) {
  forceCallSequence = (forceCallSequence + 1) % 1_000_000;
  return `${semanticCallKey}:force:${Date.now()}:${forceCallSequence}`;
}

function markCallProcessed(candidate, callKey, semanticCallKey) {
  processedCalls.add(callKey);
  processedSemanticCalls.add(semanticCallKey);
  if (candidate.node instanceof Element) {
    processedNodeSemanticKeys.set(candidate.node, semanticCallKey);
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
    .filter((candidate) => isRunnableHelperCall(candidate.call))
    .filter((candidate) => candidate.node === root || isVisibleElement(candidate.node));

  // The author-role filter has historically caused the latest helper block to
  // be skipped whenever the host page didn't expose `data-message-author-role`
  // (or when a single recognized container wraps several turns). It is now
  // opt-in via the `disableAuthorRoleFilter` setting; when disabled (the
  // default) we just trust the DOM order returned by extractShellCallCandidates
  // and execute the newest visible helper block.
  const filtered = authorRoleFilterEnabled
    ? candidates.filter(isRunnableAuthoredCandidate)
    : candidates;
  return filtered.length > 0 ? filtered[filtered.length - 1] : null;
}

function extractShellCallCandidates(root) {
  let index = 0;
  const candidates = [];
  const roots = [root, ...getBoundShellRoots(root)]
    .filter((node, nodeIndex, all) => all.indexOf(node) === nodeIndex);

  for (const scanRoot of roots) {
    const textRoots = [
      scanRoot !== root ? scanRoot : null,
      ...getTextScanRoots(scanRoot)
    ]
      .filter(Boolean)
      .filter((node, nodeIndex, all) => all.indexOf(node) === nodeIndex)
      .filter((node) => containsToolLanguageHint(node.innerText || node.textContent || ""));

    for (const textRoot of textRoots) {
      if (closestEditable(textRoot) || !isVisibleElement(textRoot)) {
        continue;
      }

      for (const block of extractPlainTextShellCallBlocks(textRoot)) {
        candidates.push({
          ...block,
          textRoot,
          index: index += 1,
          source: "plain-text-block"
        });
      }
    }
  }

  // Sort by the textRoot's document position so that helper blocks discovered in the
  // newest message come last — even when closestMessageContainer walks up to a shared
  // ancestor for messages whose role/container attributes aren't yet recognizable.
  candidates.sort((a, b) =>
    compareNodeOrder(a.textRoot || a.node, b.textRoot || b.node) || a.index - b.index
  );
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
  return lower.includes(HELPER_SHELL_START) ||
    lower.includes(HELPER_FILE_START) ||
    lower.includes(HELPER_BOARD_START);
}

function closestMessageContainer(node) {
  return node.closest('[data-message-author-role], article, [role="article"], [data-testid], section, main > div') || node;
}

function isRunnableAuthoredCandidate(candidate) {
  return getMessageAuthorRole(candidate.node) !== "user";
}

function getMessageAuthorRole(node) {
  // Only trust an explicit attribute. The previous text-prefix heuristic
  // (e.g. matching "user:" / "you said:" at the start of the container's text)
  // produced false positives when:
  //   - closest('article') climbed past the actual message and matched a
  //     wrapper that contained multiple turns,
  //   - the host page rendered participant labels as plain text inside the
  //     message body, or
  //   - the assistant quoted prior conversation that started with "User:".
  // Those false positives caused the latest helper block to be silently
  // skipped, so the heuristic has been removed. When `data-message-author-role`
  // / `data-author-role` are absent we report an unknown role and let the
  // caller decide.
  const explicit = node?.closest?.('[data-message-author-role]')?.getAttribute?.("data-message-author-role") ||
    node?.closest?.('[data-author-role]')?.getAttribute?.("data-author-role") ||
    "";
  const normalized = String(explicit || "").toLowerCase();
  if (normalized === "assistant" || normalized === "user") {
    return normalized;
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

function extractPlainTextShellCallBlocks(root) {
  const text = root.innerText || root.textContent || "";
  const blocks = parsePlainTextHelperBlocks(text);
  return blocks.map((call) => ({
    call,
    node: closestMessageContainer(root)
  }));
}

function parsePlainTextHelperBlocks(text) {
  const lines = splitShellCallLines(text);
  const calls = [];

  for (let index = 0; index < lines.length; index += 1) {
    const marker = lines[index];
    const start = parseHelperStartMarker(marker);
    if (!start.kind) {
      continue;
    }

    const valueLineIndex = index + 1;
    if (valueLineIndex >= lines.length) {
      break;
    }

    const endIndex = lines.findIndex((line, lineIndex) =>
      lineIndex > (start.kind === "board" ? index : valueLineIndex) &&
      isHelperEndForKind(start.kind, line)
    );
    if (endIndex < 0) {
      break;
    }

    const helperId = start.helperId || buildPlainTextHelperPayloadHash({
      kind: start.kind,
      marker,
      value: lines[valueLineIndex],
      bodyLines: lines.slice(valueLineIndex + 1, endIndex),
      endMarker: lines[endIndex]
    });

    if (start.kind === "file") {
      calls.push({
        kind: start.kind,
        helperId,
        helperIdSource: start.helperId ? "marker" : "payload-hash",
        helperMarkerError: start.error || "",
        filename: normalizeCommand(lines[valueLineIndex]),
        content: lines.slice(valueLineIndex + 1, endIndex).join("\n")
      });
    } else if (start.kind === "board") {
      calls.push({
        kind: start.kind,
        helperId,
        helperIdSource: start.helperId ? "marker" : "payload-hash",
        helperMarkerError: start.error || "",
        cmd: normalizeCommand(lines.slice(valueLineIndex, endIndex).join("\n"))
      });
    } else {
      calls.push({
        kind: start.kind,
        helperId,
        helperIdSource: start.helperId ? "marker" : "payload-hash",
        helperMarkerError: start.error || "",
        cmd: normalizeCommand(lines.slice(valueLineIndex, endIndex).join("\n"))
      });
    }
    index = endIndex;
  }

  return calls;
}

function parsePlainTextHelperPayload(text) {
  const blocks = parsePlainTextHelperBlocks(text);
  if (blocks.length !== 1) {
    return null;
  }

  const lines = splitShellCallLines(text);
  const start = parseHelperStartMarker(lines[0]);
  if (!start.kind || !isHelperEndForKind(start.kind, lines[lines.length - 1])) {
    return null;
  }

  return blocks[0];
}

function getHelperStartKind(line) {
  return parseHelperStartMarker(line).kind;
}

function parseHelperStartMarker(line) {
  const text = String(line || "");
  const shell = parseSpecificHelperStartMarker(text, HELPER_SHELL_START, "shell");
  if (shell.kind) {
    return shell;
  }
  const file = parseSpecificHelperStartMarker(text, HELPER_FILE_START, "file");
  if (file.kind) {
    return file;
  }
  const board = parseSpecificHelperStartMarker(text, HELPER_BOARD_START, "board");
  if (board.kind) {
    return board;
  }
  return { kind: "", helperId: "", error: "" };
}

function parseSpecificHelperStartMarker(text, marker, kind) {
  if (text === marker) {
    return { kind, helperId: "", error: "" };
  }
  if (!text.startsWith(`${marker}:`)) {
    return { kind: "", helperId: "", error: "" };
  }

  const helperId = text.slice(marker.length + 1).trim();
  if (HELPER_ID_PATTERN.test(helperId)) {
    return { kind, helperId, error: "" };
  }
  return {
    kind,
    helperId: "",
    error: `Malformed helper identity suffix on ${marker}. Use ${marker}:<nonce> with 1-128 characters matching ${HELPER_ID_PATTERN.source}.`
  };
}

function buildPlainTextHelperPayloadHash({ kind, marker, value, bodyLines, endMarker }) {
  return stableHash([
    kind || "",
    marker || "",
    value || "",
    ...(Array.isArray(bodyLines) ? bodyLines : []),
    endMarker || ""
  ].join("\n"));
}

function isHelperEndForKind(kind, line) {
  if (kind === "shell") {
    return line === HELPER_SHELL_END;
  }
  if (kind === "file") {
    return line === HELPER_FILE_END;
  }
  if (kind === "board") {
    return line === HELPER_BOARD_END;
  }
  return false;
}

function splitShellCallLines(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function parseCallPayload(text) {
  const plainTextHelper = parsePlainTextHelperPayload(text);
  if (plainTextHelper) {
    return plainTextHelper;
  }
  return { cmd: "" };
}

function isShellHelperCall(call) {
  return !call?.kind || call.kind === "shell";
}

function isFileHelperCall(call) {
  return call?.kind === "file";
}

function isBoardHelperCall(call) {
  return call?.kind === "board";
}

function isRunnableHelperCall(call) {
  return isFileHelperCall(call) ? call.filename !== undefined : Boolean(call?.cmd);
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

function hasExplicitHelperIdentity(call) {
  return normalizeCommand(call?.helperIdSource || "") === "marker" &&
    Boolean(normalizeCommand(call?.helperId || ""));
}

function shouldSuppressShellCallEcho(call, lastShellOutputText, lastPromptOrOutputText) {
  if (!isShellHelperCall(call) || hasExplicitHelperIdentity(call)) {
    return false;
  }

  return (isShellOutputText(lastShellOutputText) && isSameCommandAsShellOutput(call.cmd, lastShellOutputText)) ||
    (isShellOutputText(lastPromptOrOutputText) && isSameCommandAsShellOutput(call.cmd, lastPromptOrOutputText));
}

function isSameCommandAsShellOutput(command, shellOutputText) {
  const previousCommandHash = extractCommandHashFromShellOutput(shellOutputText);
  if (previousCommandHash) {
    return stableHash(normalizeCommand(command)) === previousCommandHash;
  }

  const previousCommand = extractCommandFromShellOutput(shellOutputText);
  return previousCommand && normalizeCommand(command) === previousCommand;
}

function extractCommandHashFromShellOutput(text) {
  const normalized = normalizeCommand(text);
  const match = normalized.match(/^cmdHash:\s*([a-f0-9]+)\s*$/im);
  return match?.[1] || "";
}

function extractCommandFromShellOutput(text) {
  const normalized = normalizeCommand(text);
  const compactMatch = normalized.match(/\$\s+([\s\S]*?)(?:\s*cmdHash:|\s*target:|\s*cwd:|\s*exitCode:|\s*durationMs:|```|$)/);
  if (compactMatch?.[1]) {
    return compactMatch[1].trim();
  }

  const lines = normalized.split("\n");
  const commandLine = lines.find((line) => line.trim().startsWith("$ "));
  return commandLine ? commandLine.trim().slice(2).trim() : "";
}

function validateHelperCall(call) {
  if (call?.helperMarkerError) {
    return { ok: false, reason: call.helperMarkerError };
  }
  if (isFileHelperCall(call)) {
    return validateFileHelperCall(call);
  }
  if (isBoardHelperCall(call)) {
    return validateBoardCall(call);
  }
  return validateShellCall(call);
}

function validateFileHelperCall(call) {
  const filename = normalizeCommand(call.filename || "");
  if (!filename) {
    return { ok: false, reason: "Filename is empty." };
  }
  if (filename.includes("/") || filename.includes("\\") || filename === "." || filename === "..") {
    return { ok: false, reason: "Filename must be a single file name under Downloads." };
  }
  if (filename.includes("\0")) {
    return { ok: false, reason: "Filename contains an invalid null byte." };
  }
  return { ok: true };
}

function validateBoardCall(call) {
  const cmd = normalizeCommand(call.cmd);
  if (!cmd) {
    return { ok: false, reason: "Board command is empty." };
  }

  const lines = cmd.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length !== 1) {
    return { ok: false, reason: "Board helper body must contain exactly one command line." };
  }

  return validateShellLikeCommandText(cmd);
}

function validateShellCall(call) {
  const cmd = normalizeCommand(call.cmd);
  if (!cmd) {
    return { ok: false, reason: "Command is empty." };
  }

  return validateShellLikeCommandText(cmd);
}

function validateShellLikeCommandText(cmd) {
  const lower = cmd.toLowerCase();
  const lines = cmd.split("\n").map((line) => line.trim()).filter(Boolean);
  const suspiciousLine = lines.find((line) =>
    line === "$" ||
    line.startsWith("$ ") ||
    line === "shell-output" ||
    getHelperStartKind(line) ||
    isHelperEndForKind("shell", line) ||
    isHelperEndForKind("file", line) ||
    isHelperEndForKind("board", line) ||
    UNSUPPORTED_HELPER_MARKERS.has(line) ||
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
  const helperName = isFileHelperCall(call) ? "file helper" : isBoardHelperCall(call) ? "board helper" : "shell call";
  setStatus(`Rejected ${helperName}: ${reason}`, "error");
  await insertReply([
    isFileHelperCall(call) ? "File helper rejected:" : isBoardHelperCall(call) ? "Board command rejected:" : "Shell call rejected:",
    "",
    "```shell-output",
    formatRejectedCallSubject(call),
    `error: ${reason}`,
    "```"
  ].join("\n"));
  await clickSendWhenReady();
}

function formatRejectedCallSubject(call) {
  if (isFileHelperCall(call)) {
    return `file: ${call.filename || ""}`;
  }
  if (isBoardHelperCall(call)) {
    return `board: ${call.cmd || ""}`;
  }
  return `$ ${call.cmd || ""}`;
}

async function runAndReply(callId, call, options = {}) {
  if (!isRunnableHelperCall(call)) {
    return;
  }

  const force = options.force === true;
  const settings = await chrome.storage.sync.get(["requireApproval", "autoSend"]);
  if (!force && settings.requireApproval === true) {
    const prompt = isFileHelperCall(call) ?
      [
        "AI requested a local file write.",
        "",
        `Downloads file: ${call.filename || ""}`,
        "",
        summarizeCommand(call.content || ""),
        "",
        "Write this file and post the result back to this chat?"
      ] : isBoardHelperCall(call) ?
      [
        "AI requested a board command.",
        "",
        call.cmd,
        "",
        "Send this command to the board and post the output back to this chat?"
      ] :
      [
        "AI requested a local shell command.",
        "",
        "tmux target: default ForAI:host",
        call.cwd ? `cwd: ${call.cwd}` : "cwd: shell server default",
        "",
        call.cmd,
        "",
        "Run this command and post the output back to this chat?"
      ];
    const approved = window.confirm(
      prompt.join("\n")
    );

    if (!approved) {
      return;
    }
  }

  activeCallId = callId;
  chainCallCount += 1;
  setStatus(buildRunningStatus(call, force), "running");
  const startedAt = new Date().toISOString();
  // Remember which semantic call we actually attempted to run, so the debug
  // panel can show whether the next detected candidate matches it (i.e. the
  // ledger/dedup will treat the next scan as a duplicate of this one).
  lastExecutedSemanticKey = buildSemanticCallKey(call);
  try {
    const response = isFileHelperCall(call) ?
      await sendWriteFileMessage(callId, call, force) :
      isBoardHelperCall(call) ?
      await sendRunBoardMessage(callId, call, force) :
      await sendRunShellMessage(callId, call, force);

    if (response?.duplicate === true && response?.skipped === true) {
      rememberSuppressedCallStatus(`server ${response?.reason || "duplicate"}`);
      setStatus(force ? "Force run skipped by server" : "Skipped duplicate helper call", "ok");
      return;
    }

    const reply = isFileHelperCall(call) ?
      formatFileOutput(call, response, startedAt) :
      isBoardHelperCall(call) ?
      formatBoardOutput(call, response, startedAt) :
      formatShellOutput(call, response, startedAt);
    await insertReply(reply);
    setHelperCompletionStatus(call, response);
    activeCallId = "";

    if (settings.autoSend !== false) {
      await clickSendWhenReady();
    }
  } catch (error) {
    setStatus(`${isFileHelperCall(call) ? "File helper" : isBoardHelperCall(call) ? "Board helper" : "Shell call"} failed: ${error.message || String(error)}`, "error");
    const failedResponse = {
      ok: false,
      error: error.message || String(error)
    };
    await insertReply(isFileHelperCall(call) ?
      formatFileOutput(call, failedResponse, startedAt) :
      isBoardHelperCall(call) ?
      formatBoardOutput(call, failedResponse, startedAt) :
      formatShellOutput(call, failedResponse, startedAt));
    activeCallId = "";
    if (settings.autoSend !== false) {
      await clickSendWhenReady();
    }
  } finally {
    activeCallId = "";
  }
}

function buildRunningStatus(call, force) {
  if (isFileHelperCall(call)) {
    return `${force ? "Force writing" : "Writing"} file: ${summarizeCommand(call.filename || "")}`;
  }
  if (isBoardHelperCall(call)) {
    return `${force ? "Force sending" : "Sending"} board command: ${summarizeCommand(call.cmd)}`;
  }
  return `${force ? "Force running" : "Running"}: ${summarizeCommand(call.cmd)}`;
}

function sendRunShellMessage(callId, call, force) {
  return chrome.runtime.sendMessage({
    type: "run-shell",
    id: callId,
    callKey: callId,
    cmd: call.cmd,
    cwd: call.cwd || "",
    callMeta: {
      origin: location.origin,
      pathname: location.pathname,
      promptHash: stableHash(getLastUserMessageText()),
      force
    }
  });
}

function sendWriteFileMessage(callId, call, force) {
  return chrome.runtime.sendMessage({
    type: "write-file",
    id: callId,
    callKey: callId,
    filename: call.filename,
    content: call.content || "",
    callMeta: {
      origin: location.origin,
      pathname: location.pathname,
      promptHash: stableHash(getLastUserMessageText()),
      force
    }
  });
}

function sendRunBoardMessage(callId, call, force) {
  return chrome.runtime.sendMessage({
    type: "run-board",
    id: callId,
    callKey: callId,
    cmd: call.cmd,
    timeoutMs: call.timeoutMs,
    maxOutputChars: call.maxOutputChars,
    callMeta: {
      origin: location.origin,
      pathname: location.pathname,
      promptHash: stableHash(getLastUserMessageText()),
      force
    }
  });
}

function setHelperCompletionStatus(call, response) {
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

  if (isFileHelperCall(call)) {
    setStatus(response?.ok === false ? "File write failed" : "File write completed", response?.ok === false ? "error" : "ok");
    return;
  }

  if (isBoardHelperCall(call)) {
    setStatus(response?.ok === false ? "Board helper failed" : "Board helper completed", response?.ok === false ? "error" : "ok");
    return;
  }

  setStatus(response?.ok === false ? "Shell helper failed" : "Shell helper completed", response?.ok === false ? "error" : "ok");
}

function isExpectedSelfTestCall(call) {
  return !!pendingSelfTest &&
    normalizeCommand(call?.cmd || "") === pendingSelfTest.command &&
    (!call?.cwd || normalizeCommand(call.cwd) === normalizeCommand(pendingSelfTest.cwd || ""));
}

function expirePendingSelfTest() {
  if (pendingSelfTest && Date.now() - pendingSelfTest.startedAt > 120000) {
    pendingSelfTest = null;
    setStatus("Self-test expired before a matching helper block appeared", "error");
  }
}

function formatShellOutput(call, response, startedAt) {
  const commandDisplay = formatShellOutputCommand(call.cmd);
  if (!response || response.ok === false) {
    return [
      "Shell call failed:",
      "",
      "```shell-output",
      `$ ${commandDisplay.text}`,
      commandDisplay.truncated ? `cmdHash: ${commandDisplay.hash}` : "",
      `startedAt: ${startedAt}`,
      `error: ${response?.error || "Unknown shell server error."}`,
      response?.example ? "\nexample:\n" + response.example : "",
      response?.tmuxPanes ? "\ntmux targets:\n" + formatTmuxPanesForShellOutput(response.tmuxPanes) : "",
      "```"
    ].filter((line) => line !== "").join("\n");
  }

  const stdout = response.stdout || "";
  const stderr = response.stderr || "";
  const meta = [
    `$ ${commandDisplay.text}`,
    commandDisplay.truncated ? `cmdHash: ${commandDisplay.hash}` : "",
    `target: ${response.target || ""}`,
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

function formatBoardOutput(call, response, startedAt) {
  const commandDisplay = formatShellOutputCommand(call.cmd);
  if (!response || response.ok === false) {
    return [
      "Board command failed:",
      "",
      "```shell-output",
      `board: ${commandDisplay.text}`,
      commandDisplay.truncated ? `cmdHash: ${commandDisplay.hash}` : "",
      response?.target ? `target: ${response.target}` : "",
      response?.targetName ? `targetName: ${response.targetName}` : "",
      `startedAt: ${startedAt}`,
      `error: ${response?.error || "Unknown board helper error."}`,
      response?.stdout ? "\nstdout:\n" + response.stdout : "",
      response?.tmuxPanes ? "\ntmux targets:\n" + formatTmuxPanesForShellOutput(response.tmuxPanes) : "",
      response?.example ? "\nexample:\n" + response.example : "",
      "```"
    ].filter((line) => line !== "").join("\n");
  }

  const stdout = response.stdout || "";
  const stderr = response.stderr || "";
  const meta = [
    `board: ${commandDisplay.text}`,
    commandDisplay.truncated ? `cmdHash: ${commandDisplay.hash}` : "",
    `target: ${response.target || ""}`,
    response.targetName ? `targetName: ${response.targetName}` : "",
    `exitCode: ${response.exitCode}`,
    `durationMs: ${response.durationMs}`,
    response.timedOut ? "timedOut: true" : "",
    response.truncated ? "truncated: true" : ""
  ].filter(Boolean);

  return [
    "Board command result:",
    "",
    "```shell-output",
    ...meta,
    stdout ? "\nstdout:\n" + stdout : "",
    stderr ? "\nstderr:\n" + stderr : "",
    "```"
  ].join("\n");
}

function formatFileOutput(call, response, startedAt) {
  if (!response || response.ok === false) {
    return [
      "File write failed:",
      "",
      "```shell-output",
      `file: ${call.filename || ""}`,
      `startedAt: ${startedAt}`,
      `error: ${response?.error || "Unknown file write error."}`,
      "```"
    ].join("\n");
  }

  return [
    "File write result:",
    "",
    "```shell-output",
    `file: ${response.filename || call.filename || ""}`,
    response.path ? `path: ${response.path}` : "",
    `bytes: ${response.bytes}`,
    `durationMs: ${response.durationMs}`,
    "```"
  ].filter((line) => line !== "").join("\n");
}

function formatShellOutputCommand(command) {
  const normalized = normalizeCommand(command);
  const displaySource = normalizeText(normalized);
  if (displaySource.length <= SHELL_OUTPUT_COMMAND_DISPLAY_CHARS && displaySource === normalized) {
    return {
      text: displaySource,
      truncated: false,
      hash: ""
    };
  }

  const displayText = displaySource.length <= SHELL_OUTPUT_COMMAND_DISPLAY_CHARS ?
    displaySource :
    `${displaySource.slice(0, SHELL_OUTPUT_COMMAND_DISPLAY_CHARS - 3)}...`;
  return {
    text: displayText,
    truncated: true,
    hash: stableHash(normalized)
  };
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
    throw new Error("Could not find a chat composer. Click the chat input once, then ask the AI for a helper block again.");
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

function debugProfileKey() {
  return `${DEBUG_PROFILE_PREFIX}${location.origin}`;
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
  statusText.textContent = `Shell tool ready v${getDisplayVersion()}`;
  statusText.style.cssText = "margin-bottom:6px;line-height:1.3;cursor:move";
  statusText.title = "Drag to move";
  panel.appendChild(statusText);

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:4px;flex-wrap:wrap";
  for (const action of [
    { mode: "test", label: "Test" },
    { mode: "check", label: "Check" },
    {
      mode: "reset-tmux",
      label: "Reset tmux",
      title: "Recreate the default ForAI tmux session with host and board windows"
    },
    {
      mode: "force",
      label: "Force run",
      title: "Force run latest helper block (bypass dedup ledger)"
    },
    { mode: "site", label: "Enable site" },
    {
      mode: "role-filter",
      label: "Role filter",
      title: "Toggle author-role filter (when off, the newest visible helper block is always executed)"
    },
    { mode: "input", label: "Bind input" },
    { mode: "send", label: "Bind send" },
    { mode: "shell", label: "Bind shell" },
    { mode: "clear", label: "Clear" }
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.dataset.shellToolAction = action.mode;
    if (action.title) {
      button.title = action.title;
    }
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

  const debugPanel = document.createElement("details");
  debugPanel.id = "ai-chat-shell-exec-debug";
  debugPanel.style.cssText = "margin-top:6px;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;";
  const debugSummary = document.createElement("summary");
  debugSummary.textContent = "Detected helper block (debug)";
  debugSummary.style.cssText = "cursor:pointer;opacity:.85;user-select:none;";
  const debugBody = document.createElement("pre");
  debugBody.id = DEBUG_BODY_ID;
  debugBody.style.cssText = "margin:4px 0 0;padding:6px;background:#0b1220;border-radius:6px;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;color:#d1d5db;";
  debugBody.textContent = "(no helper block detected yet)";
  debugPanel.append(debugSummary, debugBody);
  panel.appendChild(debugPanel);

  chrome.storage.local.get([debugProfileKey()]).then((stored) => {
    if (stored[debugProfileKey()]) {
      debugPanel.open = true;
    }
  }).catch(() => {});
  debugPanel.addEventListener("toggle", () => {
    chrome.storage.local.set({ [debugProfileKey()]: debugPanel.open }).catch(() => {});
  });

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
  chrome.storage.sync.get(["enabledHosts", "disableAuthorRoleFilter"]).then((settings) => {
    updateSiteActionButton(isCurrentHostEnabled(settings.enabledHosts));
    authorRoleFilterEnabled = settings.disableAuthorRoleFilter === false;
    updateRoleFilterButton();
  });
  restorePanelPosition(panel);
  installPanelDrag(panel, statusText);
  checkStartupTmux().catch((error) => {
    setStatus(`ForAI tmux startup check failed: ${summarizeCommand(error.message || String(error))}`, "error");
  });
}

function setStatus(text, state = "idle") {
  const panel = document.getElementById(STATUS_ID);
  const statusText = document.getElementById(STATUS_TEXT_ID);
  if (!panel || !statusText) {
    return;
  }

  const requestedText = String(text || "");
  const effectiveText = extensionVersionWarning && requestedText !== extensionVersionWarning
    ? `${requestedText} (${extensionVersionWarning})`
    : requestedText;
  const effectiveState = extensionVersionWarning ? "error" : state;
  const suppressed = isSuppressionStatusText(text);
  if (!suppressed && lastSuppressedCallStatus) {
    lastSuppressedCallStatus = "";
    setForceButtonHighlight(false);
  }
  statusText.textContent = lastSuppressedCallStatus ? `${effectiveText} (${FORCE_RUN_STATUS_HINT})` : effectiveText;
  panel.dataset.state = effectiveState;
  const colors = {
    idle: "#111827",
    running: "#1d4ed8",
    ok: "#047857",
    error: "#b91c1c"
  };
  panel.style.background = colors[effectiveState] || colors.idle;
}

function getDisplayVersion() {
  return getManifestVersion() || CONTENT_SCRIPT_VERSION;
}

function getManifestVersion() {
  try {
    return String(chrome.runtime.getManifest?.().version || "");
  } catch (_unused) {
    return "";
  }
}

async function getBackgroundVersionInfo() {
  try {
    return await chrome.runtime.sendMessage({
      type: "extension-version",
      contentVersion: CONTENT_SCRIPT_VERSION,
      manifestVersion: getManifestVersion()
    });
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error)
    };
  }
}

async function checkExtensionVersionMatch() {
  const background = await getBackgroundVersionInfo();
  updateVersionTooltip(background);
  const mismatch = getExtensionVersionMismatch(background);
  if (mismatch) {
    extensionVersionWarning = mismatch;
    setStatus(mismatch, "error");
    return false;
  }
  extensionVersionWarning = "";
  return true;
}

async function checkStartupTmux() {
  const versionOk = await checkExtensionVersionMatch();
  if (!versionOk) {
    return;
  }
  setStatus("Checking shell server and ForAI tmux session", "running");
  const health = await chrome.runtime.sendMessage({ type: "shell-health" });
  const healthError = getShellHealthStatusError(health);
  if (healthError) {
    setStatus(healthError, "error");
    return;
  }
  const tmux = await chrome.runtime.sendMessage({ type: "tmux-ensure" });
  if (!tmux?.ok) {
    setStatus(`ForAI tmux unavailable: ${summarizeCommand(tmux?.error || "run install/start script")}`, "error");
    return;
  }
  setStatus(`Shell tool ready v${getDisplayVersion()}; ${formatServerProtocolStatus(health)}; ${formatForAiStatus(tmux)}`, "ok");
}

function formatForAiStatus(tmux) {
  const host = tmux?.defaultTarget ? `host ${tmux.defaultTarget}` : "host missing";
  const board = tmux?.boardTarget ? `board ${tmux.boardTarget}` : "board missing";
  const cwd = tmux?.cwd ? `cwd ${summarizeCommand(tmux.cwd)}` : "";
  return ["ForAI ready", host, board, cwd].filter(Boolean).join("; ");
}

function getShellHealthStatusError(health) {
  if (health && health.originMatches === false) {
    return `Server origin mismatch: ${health.extensionId || "current extension"}`;
  }
  if (health && (health.protocolMatches === false || health.helperProtocolMatches === false)) {
    return health.error || `Server protocol mismatch: restart local shell server for v${getDisplayVersion()}`;
  }
  if (!health?.ok) {
    return `Server offline: ${summarizeCommand(health?.error || "run install/start script")}`;
  }
  return "";
}

function formatServerProtocolStatus(health) {
  const release = health?.serverReleaseVersion || health?.releaseVersion || "";
  const serverProtocol = health?.serverProtocolVersion ?? health?.protocolVersion;
  const helperProtocol = health?.helperProtocolVersion;
  const visionEnabled = health?.visionAvailable === true;
  const visualApps = visionEnabled && Array.isArray(health?.visualTmuxApps) ? health.visualTmuxApps.join("/") : "";
  const parts = [
    release ? `server v${release}` : "server version unknown",
    serverProtocol !== undefined && serverProtocol !== null && serverProtocol !== "" ? `protocol ${serverProtocol}` : "protocol unknown",
    helperProtocol !== undefined && helperProtocol !== null && helperProtocol !== "" ? `helper ${helperProtocol}` : "helper unknown",
    visualApps ? `apps ${visualApps}` : "",
    visionEnabled ? "vision ok" : ""
  ];
  return parts.filter(Boolean).join(" ");
}

function getExtensionVersionMismatch(background) {
  if (!background?.ok) {
    return `Extension background unavailable; refresh this tab: ${summarizeCommand(background?.error || "no response")}`;
  }

  const expected = CONTENT_SCRIPT_VERSION;
  const manifestVersion = getManifestVersion();
  const backgroundVersion = String(background.version || background.backgroundVersion || "");
  if (backgroundVersion && backgroundVersion !== expected) {
    return `Extension version mismatch: page v${expected}, background v${backgroundVersion}; refresh this tab`;
  }
  if (manifestVersion && manifestVersion !== expected) {
    return `Extension version mismatch: page v${expected}, manifest v${manifestVersion}; reload extension and refresh this tab`;
  }
  return "";
}

function updateVersionTooltip(background) {
  const statusText = document.getElementById(STATUS_TEXT_ID);
  if (!statusText) {
    return;
  }
  const manifestVersion = getManifestVersion() || "(unknown)";
  const backgroundVersion = background?.version || background?.backgroundVersion || "(unknown)";
  const requiredServerProtocol = background?.requiredServerProtocolVersion || "(unknown)";
  const helperProtocol = background?.helperProtocolVersion || background?.requiredHelperProtocolVersion || "(unknown)";
  statusText.title = [
    "Drag to move",
    `content v${CONTENT_SCRIPT_VERSION}`,
    `manifest v${manifestVersion}`,
    `background v${backgroundVersion}`,
    `requires server protocol ${requiredServerProtocol}`,
    `helper protocol ${helperProtocol}`
  ].join("\n");
}

function setForceButtonHighlight(highlight) {
  const button = document.querySelector(`#${STATUS_ID} [data-shell-tool-action="force"]`);
  if (!(button instanceof HTMLElement)) {
    return;
  }
  button.style.background = highlight ? "#b45309" : "#374151";
}

function rememberSuppressedCallStatus(status) {
  lastSuppressedCallStatus = String(status || "");
  setForceButtonHighlight(true);
}

function updateDetectedHelperDebug(candidate, allCandidates) {
  const body = document.getElementById(DEBUG_BODY_ID);
  if (!body) {
    return;
  }
  const list = Array.isArray(allCandidates) ? allCandidates : [];
  const total = list.length;
  let selectedIdx = -1;
  if (candidate) {
    selectedIdx = list.findIndex((c) =>
      c === candidate ||
      (c.node === candidate.node && c.index === candidate.index)
    );
  }
  const summary = total === 0
    ? "candidates: 0/0"
    : `candidates: ${selectedIdx >= 0 ? selectedIdx + 1 : "?"}/${total}`;

  if (!candidate && total === 0) {
    const lines = [summary, "(no helper block detected)"];
    if (lastSuppressedCallStatus) {
      lines.push(`lastSkippedReason: ${lastSuppressedCallStatus}`);
    }
    if (lastExecutedSemanticKey) {
      lines.push(`lastRunSemanticKey: ${lastExecutedSemanticKey}`);
    }
    body.textContent = lines.join("\n");
    return;
  }

  const lines = [summary];

  if (total > 0) {
    const MAX_LISTED = 8;
    const listed = list.slice(0, MAX_LISTED);
    for (let i = 0; i < listed.length; i += 1) {
      const c = listed[i];
      const cCall = c.call || {};
      const isSelected = i === selectedIdx;
      const marker = isSelected ? "[*]" : "[ ]";
      const cKind = cCall.kind || "shell";
      const cRole = getMessageAuthorRole(c.node) || "?";
      const cRunnable = isRunnableHelperCall(cCall) ? "yes" : "no";
      const cVisible = (() => {
        try {
          return isVisibleElement(c.node) ? "yes" : "no";
        } catch (_unused) {
          return "?";
        }
      })();
      const cCmd = String(cCall.cmd || cCall.content || "")
        .replace(/\s+/g, " ")
        .slice(0, 80);
      lines.push(
        `${marker} #${i + 1}  kind=${cKind}  role=${cRole}  runnable=${cRunnable}  visible=${cVisible}  cmd: ${cCmd}`
      );
    }
    if (total > MAX_LISTED) {
      lines.push(`… (+${total - MAX_LISTED} more)`);
    }
  }

  if (candidate) {
    const call = candidate.call || {};
    const role = getMessageAuthorRole(candidate.node) || "(unknown)";
    const cmdPreview = String(call.cmd || call.content || "").slice(0, 800);
    lines.push(
      `kind:        ${call.kind || "shell"}`,
      `helperId:    ${call.helperId || "(none)"} (${call.helperIdSource || "n/a"})`,
      `filename:    ${call.filename || ""}`,
      `cwd:         ${call.cwd || ""}`,
      `authorRole:  ${role}`,
      `source:      ${candidate.source || ""}  index:${candidate.index || ""}`,
      `semanticKey: ${buildSemanticCallKey(call)}`,
      `detectedAt:  ${new Date().toISOString()}`,
      `--- cmd / content (first 800 chars) ---`,
      cmdPreview || "(empty)"
    );
  } else {
    lines.push("(no helper block selected)");
  }

  if (lastSuppressedCallStatus) {
    lines.push(`lastSkippedReason: ${lastSuppressedCallStatus}`);
  }
  if (lastExecutedSemanticKey) {
    lines.push(`lastRunSemanticKey: ${lastExecutedSemanticKey}`);
  }
  body.textContent = lines.join("\n");
}

function isSuppressionStatusText(text) {
  const message = String(text || "");
  return message.startsWith("Suppressed duplicate helper call") ||
    message.startsWith("Suppressed duplicate shell call") ||
    message === "Skipped duplicate helper call" ||
    message === "Force run skipped by server";
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

  if (action === "role-filter") {
    toggleAuthorRoleFilter().catch((error) => {
      setStatus(`Role filter update failed: ${summarizeCommand(error.message || String(error))}`, "error");
    });
    return;
  }

  if (action === "check") {
    runHealthCheck().catch((error) => {
      setStatus(`Check failed: ${summarizeCommand(error.message || String(error))}`, "error");
    });
    return;
  }

  if (action === "reset-tmux") {
    resetForAiTmux().catch((error) => {
      setStatus(`Reset tmux failed: ${summarizeCommand(error.message || String(error))}`, "error");
    });
    return;
  }

  if (action === "force") {
    forceRunLatestShellCall().catch((error) => {
      setStatus(`Force run failed: ${summarizeCommand(error.message || String(error))}`, "error");
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

async function forceRunLatestShellCall() {
  pendingSelfTest = null;
  setStatus("Checking latest helper block once", "running");
  await scanForShellCall({ force: true });
  lastSuppressedCallStatus = "";
  setForceButtonHighlight(false);
}

async function resetForAiTmux() {
  if (!window.confirm("Reset the ForAI tmux session? This kills the current ForAI host and board windows.")) {
    setStatus("Reset tmux cancelled", "idle");
    return;
  }

  setStatus("Resetting ForAI tmux session", "running");
  const tmux = await chrome.runtime.sendMessage({ type: "tmux-reset-forai" });
  if (!tmux?.ok) {
    setStatus(`Reset tmux failed: ${summarizeCommand(tmux?.error || "run install/start script")}`, "error");
    return;
  }
  setStatus(`Reset ForAI tmux; ${formatForAiStatus(tmux)}`, "ok");
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

async function toggleAuthorRoleFilter() {
  const settings = await chrome.storage.sync.get(["disableAuthorRoleFilter"]);
  const currentlyEnabled = settings.disableAuthorRoleFilter === false;
  const nextEnabled = !currentlyEnabled;
  await chrome.storage.sync.set({ disableAuthorRoleFilter: !nextEnabled });
  authorRoleFilterEnabled = nextEnabled;
  updateRoleFilterButton();
  setStatus(
    nextEnabled
      ? "Role filter enabled: helper blocks in user-authored messages will be skipped"
      : "Role filter disabled: newest visible helper block will always run",
    "ok"
  );
  scheduleScan();
}

function updateRoleFilterButton() {
  const button = document.querySelector(`#${STATUS_ID} [data-shell-tool-action="role-filter"]`);
  if (!button) {
    return;
  }
  button.textContent = authorRoleFilterEnabled ? "Role filter: on" : "Role filter: off";
  button.style.background = authorRoleFilterEnabled ? "#374151" : "#6b21a8";
}

async function runHealthCheck() {
  setStatus("Checking shell server and bindings", "running");
  const [version, health, tmux, profiles] = await Promise.all([
    getBackgroundVersionInfo(),
    chrome.runtime.sendMessage({ type: "shell-health" }),
    chrome.runtime.sendMessage({ type: "tmux-ensure" }),
    chrome.storage.local.get([composerProfileKey(), sendProfileKey(), shellProfileKey()])
  ]);
  updateVersionTooltip(version);
  const versionMismatch = getExtensionVersionMismatch(version);
  if (versionMismatch) {
    setStatus(versionMismatch, "error");
    return;
  }

  const bindings = [
    profiles[composerProfileKey()]?.selector ? "input" : "",
    savedSendSelector || profiles[sendProfileKey()]?.selector ? "send" : "",
    savedShellSelector || profiles[shellProfileKey()]?.selector ? "shell" : ""
  ].filter(Boolean);

  const healthError = getShellHealthStatusError(health);
  if (healthError) {
    setStatus(healthError, "error");
    return;
  }

  const boundText = bindings.length > 0 ? bindings.join("/") : "auto";
  const pidText = health.pid ? ` pid ${health.pid}` : "";
  const paneText = tmux?.ok
    ? `; ${formatForAiStatus(tmux)}; tmux panes ${tmux.panes?.length || 0}`
    : "; tmux unavailable";
  setStatus(`Extension v${getDisplayVersion()}; ${formatServerProtocolStatus(health)}${pidText}; bindings ${boundText}${paneText}`, tmux?.ok === false ? "error" : "ok");
}

async function runFullChainTest() {
  const settings = await chrome.storage.sync.get(["enabledHosts"]);
  if (!isCurrentHostEnabled(settings.enabledHosts)) {
    setStatus(`Enable this site first: ${location.hostname}`, "error");
    return;
  }

  const tmux = await chrome.runtime.sendMessage({ type: "tmux-ensure" });
  if (!tmux?.ok || !tmux.defaultTarget) {
    setStatus(`Test failed: ${summarizeCommand(tmux?.error || "default ForAI host target unavailable")}`, "error");
    return;
  }

  const token = `shell-tool-self-test-${Date.now().toString(36)}`;
  const command = `printf ${token}`;
  const prompt = [
    "This is a compatibility self-test. Reply with exactly these lines and no prose:",
    "",
    "````",
    HELPER_SHELL_START,
    command,
    HELPER_SHELL_END,
    "````"
  ].join("\n");

  setStatus(`Starting full test on default ForAI:host ${tmux.defaultTarget}: ${token}`, "running");
  const composer = await insertReply(prompt);
  const sent = await clickSendWhenReady(composer);
  if (sent) {
    pendingSelfTest = {
      token,
      command,
      cwd: "",
      startedAt: Date.now()
    };
    setStatus(`Waiting for helper block test: ${token}`, "running");
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
