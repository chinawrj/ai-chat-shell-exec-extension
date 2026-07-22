const HELPER_SHELL_START = "ai-helper-shell-start";
const HELPER_SHELL_END = "ai-helper-shell-end";
const HELPER_FILE_START = "ai-helper-file-start";
const HELPER_FILE_END = "ai-helper-file-end";
const HELPER_BOARD_START = "ai-helper-board-start";
const HELPER_BOARD_END = "ai-helper-board-end";
const HELPER_AGENT_MESSAGE_START = "ai-helper-agent-message-start";
const HELPER_AGENT_MESSAGE_END = "ai-helper-agent-message-end";
const HELPER_AGENT_ROSTER_START = "ai-helper-agent-roster-start";
const HELPER_AGENT_ROSTER_END = "ai-helper-agent-roster-end";
const HELPER_AGENT_TASK_STATUS_START = "ai-helper-agent-task-status-start";
const HELPER_AGENT_TASK_STATUS_END = "ai-helper-agent-task-status-end";
const HELPER_FENCE_MARKER = "````";
const UNSUPPORTED_HELPER_MARKERS = new Set(["ai-helper-start-shell", "ai-helper-end-shell"]);
const HELPER_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const BOARD_NAME_SUFFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const STATUS_ID = "ai-chat-shell-exec-status";
const STATUS_TEXT_ID = "ai-chat-shell-exec-status-text";
const DEBUG_BODY_ID = "ai-chat-shell-exec-debug-body";
const PENDING_AGENT_DELIVERY_ID = "ai-chat-shell-exec-agent-pending";
const DEBUG_PROFILE_PREFIX = "panelDebugOpen:";
const CONTENT_SCRIPT_VERSION = "0.9.7";
const SHELL_OUTPUT_COMMAND_DISPLAY_CHARS = 64;
const COMPOSER_PROFILE_PREFIX = "composerProfile:";
const SEND_PROFILE_PREFIX = "sendProfile:";
const ORIGINAL_SEND_ACTUATOR_CANCELLED = Symbol("original-send-actuator-cancelled");
const SHELL_PROFILE_PREFIX = "shellProfile:";
const PANEL_PROFILE_PREFIX = "panelProfile:";
const AGENT_PENDING_DELIVERY_PREFIX = "agentPendingDelivery:";
const HELPER_PENDING_DELIVERY_PREFIX = "helperPendingDelivery:v1:";
const AGENT_SESSION_PROFILE_KEY = "aiChatShellExecAgentProfile";
const AGENT_SESSION_TAB_ID_KEY = "aiChatShellExecAgentTabId";
const DEFAULT_ENABLED_HOSTS = ["chatgpt.com", "m365.cloud.microsoft"];
const DEFAULT_MAX_CHAIN_CALLS = 100;
const LOCAL_MANUAL_TEST_PORT = "17443";
const FORCE_RUN_STATUS_HINT = "click Force run to bypass";
const MANUAL_TMUX_LIST_REQUEST = "ai-chat-shell-exec:tmux-list-request";
const MANUAL_TMUX_LIST_RESPONSE = "ai-chat-shell-exec:tmux-list-response";
const MANUAL_AGENT_REQUEST = "ai-chat-shell-exec:agent-request";
const MANUAL_AGENT_RESPONSE = "ai-chat-shell-exec:agent-response";
const AGENT_POLL_INTERVAL_MS = 2000;
const RUN_STATUS_POLL_INTERVAL_MS = 1000;
const RUN_STATUS_MAX_NOT_FOUND = 5;
const RUN_STATUS_MAX_TRANSPORT_FAILURES = 5;
const PENDING_HELPER_DELIVERY_MAX_ENTRIES = 12;
const PRESENTED_HELPER_EXECUTION_MAX_ENTRIES = 128;
const PENDING_HELPER_DELIVERY_MAX_REPLY_CHARS = 500_000;
const PENDING_HELPER_DELIVERY_MAX_TOTAL_CHARS = 4_000_000;
const PENDING_HELPER_DELIVERY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_HELPER_DELIVERY_RETRY_MS = 2000;
let helperRenderRootSequence = 0;
const helperRenderRootIds = new WeakMap();
const helperRenderRootGenerations = new WeakMap();
const processedRenderedHelpers = new WeakMap();
// Keep per-helper scan metadata in memory only. This prevents the same rendered
// helper block from being submitted repeatedly, but it is not command dedup:
// only the shell server can decide whether a command already ran on a tmux pane.
let scanTimer = 0;
let lastThreadText = "";
let lastThreadTextAt = Date.now();
let activeCallId = "";
let activeCallToken = null;
let pageLifecycleGeneration = 0;
let observedPageIdentity = "";
let routeHandoffPreviousPageIdentity = "";
let composerDeliverySequence = 0;
let composerDeliveryTail = Promise.resolve();
let activeComposerDeliveryToken = null;
let activeOriginalSendActuatorGuard = null;
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
let pendingForceRunRequested = false;
let pendingForceRunTimer = 0;
let extensionVersionWarning = "";
let agentPollTimer = 0;
let agentDeliveryInFlight = false;
let agentDeliveryGeneration = 0;
let activeAgentDeliveryToken = null;
let pendingAgentDeliveryMessageId = "";
let pendingAgentDelivery = null;
let pendingAgentDeliveryLoaded = false;
let consecutiveAgentPollFailures = 0;
let pendingHelperDeliveries = new Map();
let locallyPresentedHelperExecutions = new Map();
let pendingHelperDeliveriesLoadedKey = "";
let pendingHelperDeliveryRetryTimer = 0;
let pendingHelperDeliveryRetryInFlight = false;
let pendingHelperDeliveryStorageTail = Promise.resolve();
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
  beginPageLifecycle();
  initialThreadSettled = false;
  injectStatus();
  await loadLocalProfiles();
  await loadPendingHelperDeliveriesForCurrentPage();
  observeThread();
  installPageEventListeners();
  startAgentPolling();
  schedulePendingHelperDeliveryRetry();
  scheduleScan();
}

function deactivateExtension() {
  const hadActiveLifecycle = Boolean(activeCallToken || threadObserver || document.getElementById(STATUS_ID));
  extensionActive = false;
  if (hadActiveLifecycle) {
    beginPageLifecycle();
  } else {
    activeCallId = "";
    activeCallToken = null;
  }
  bindingMode = "";
  pendingSelfTest = null;
  lastPointerTarget = null;
  clearTimeout(scanTimer);
  clearPendingForceRun();
  stopAgentPolling();
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

  threadObserver = new MutationObserver((records) => {
    invalidateRenderedHelperTracking(records);
    scheduleScan();
  });

  threadObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    characterDataOldValue: true
  });
}

function invalidateRenderedHelperTracking(records) {
  for (const record of Array.from(records || [])) {
    if (!mutationTouchesHelperText(record)) {
      continue;
    }
    let element = record.target instanceof Element ? record.target : record.target?.parentElement;
    while (element instanceof Element) {
      if (processedRenderedHelpers.has(element)) {
        processedRenderedHelpers.delete(element);
        helperRenderRootGenerations.set(element, getHelperRenderRootGeneration(element) + 1);
      }
      element = element.parentElement;
    }
  }
}

function mutationTouchesHelperText(record) {
  if (record?.type === "characterData") {
    return containsToolLanguageHint(record.oldValue || "") || containsToolLanguageHint(record.target?.textContent || "");
  }
  if (record?.type !== "childList") {
    return false;
  }
  const changedNodes = [
    ...Array.from(record?.addedNodes || []),
    ...Array.from(record?.removedNodes || [])
  ];
  return changedNodes.some((node) => containsToolLanguageHint(node?.innerText || node?.textContent || ""));
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
    window.addEventListener("message", handleManualAgentRequest);
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
  window.removeEventListener("message", handleManualAgentRequest);
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

async function handleManualAgentRequest(event) {
  if (!isLocalManualTestPage() || event.source !== window || event.origin !== location.origin) {
    return;
  }

  const data = event.data || {};
  if (!data || data.type !== MANUAL_AGENT_REQUEST) {
    return;
  }

  const payload = data.payload || {};
  try {
    if (!String(payload.type || "").startsWith("agent-")) {
      throw new Error("Manual agent request payload must use an agent-* type.");
    }
    const response = await chrome.runtime.sendMessage(payload);
    if (payload.type === "agent-register" && response?.ok === true) {
      await setCurrentAgentProfile(payload.role || "none", payload.agentId || "");
      startAgentPolling();
    } else if (payload.type === "agent-unregister" && response?.ok === true) {
      await setCurrentAgentProfile("none", "");
      startAgentPolling();
    }
    window.postMessage({
      type: MANUAL_AGENT_RESPONSE,
      requestId: data.requestId || "",
      response
    }, location.origin);
  } catch (error) {
    window.postMessage({
      type: MANUAL_AGENT_RESPONSE,
      requestId: data.requestId || "",
      response: {
        ok: false,
        error: error?.message || String(error)
      }
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
  if (!extensionActive) {
    return;
  }
  refreshPageLifecycle();
  await loadPendingHelperDeliveriesForCurrentPage();
  schedulePendingHelperDeliveryRetry();

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
    if (force) {
      pendingForceRunRequested = true;
      setStatus("Waiting for current helper call, then running latest", "running");
      schedulePendingForceRunScan();
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
      clearPendingForceRun();
    }
    return;
  }

  if (!force && !initialThreadSettled) {
    initialThreadSettled = true;
    setStatus("Shell tool ready; existing history ignored", "idle");
    return;
  }

  if (!force && pendingAgentDelivery &&
      pendingAgentDelivery.sent !== true &&
      pendingAgentDelivery.cancelled !== true) {
    setStatus("Helper detected; waiting for the pending agent message to leave the composer", "running");
    scheduleScan();
    return;
  }

  if (!force) {
    expirePendingSelfTest();
  }

  const call = candidate.call;
  if (force) {
    clearPendingForceRun();
  }
  const semanticCallKey = buildSemanticCallKey(call);
  const callKey = buildCandidateCallKey(candidate, semanticCallKey);
  const repeatableAgentQuery = isRepeatableAgentQueryHelperCall(call);
  if (!force) {
    const handledReason = getHandledHelperReason(candidate, callKey, semanticCallKey, call);
    if (handledReason) {
      setStatus(`Already handled this helper block: ${summarizeCommand(helperPreviewText(call))}`, "ok");
      return;
    }
  }

  if (!force && pendingSelfTest && !isExpectedSelfTestCall(call)) {
    pendingSelfTest = null;
    setStatus("Self-test cancelled; running the latest helper request", "running");
  }

  if (!force && isShellOutputCandidate(candidate)) {
    rememberSuppressedCallStatus("suppressed shell-output helper echo");
    markCallProcessed(candidate, callKey, semanticCallKey);
    setStatus(`Suppressed helper inside shell-output: ${summarizeCommand(helperPreviewText(call))}`, "ok");
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
    if (repeatableAgentQuery) {
      markRepeatableAgentQueryCallProcessed(callKey);
    } else {
      markCallProcessed(candidate, callKey, semanticCallKey);
    }
  }
  const outcome = await runAndReply(executionCallKey, call, { force });
  if (!force && outcome?.retryable === true) {
    unmarkCallProcessed(candidate, semanticCallKey);
  }
}

function schedulePendingForceRunScan() {
  clearTimeout(pendingForceRunTimer);
  pendingForceRunTimer = setTimeout(() => {
    pendingForceRunTimer = 0;
    if (!pendingForceRunRequested || !extensionActive) {
      return;
    }
    scanForShellCall({ force: true }).catch((error) => {
      setStatus(`Force run failed: ${summarizeCommand(error.message || String(error))}`, "error");
      clearPendingForceRun();
    });
  }, 500);
}

function clearPendingForceRun() {
  pendingForceRunRequested = false;
  clearTimeout(pendingForceRunTimer);
  pendingForceRunTimer = 0;
}

function buildSemanticCallKey(call) {
  return stableHash([
    location.origin,
    normalizeCommand(call.kind || "shell"),
    normalizeCommand(call.helperId || ""),
    normalizeCommand(call.boardName || ""),
    normalizeCommand(call.cmd || ""),
    normalizeCommand(call.filename || ""),
    normalizeCommand(call.content || ""),
    normalizeCommand(call.to || ""),
    normalizeCommand(call.taskId || ""),
    normalizeCommand(call.messageId || ""),
    normalizeCommand(call.replyTo || ""),
    normalizeCommand(call.role || ""),
    normalizeCommand(call.surface || ""),
    normalizeCommand(call.body || ""),
    normalizeCommand(call.cwd || ""),
    call.timeoutMs || "",
    call.maxOutputChars || ""
  ].join("\n"));
}

function buildCandidateCallKey(candidate, semanticCallKey) {
  const renderRoot = getCandidateRenderRoot(candidate);
  return stableHash([
    getCurrentPageIdentity(),
    getAgentTabInstanceId(),
    getHelperRenderRootId(renderRoot),
    getHelperRenderRootGeneration(renderRoot),
    candidate.source || "",
    candidate.blockIndex ?? candidate.index ?? "",
    semanticCallKey
  ].join("\n"));
}

function getHandledHelperReason(candidate, _callKey, semanticCallKey, call) {
  if (isRepeatableAgentQueryHelperCall(call)) {
    return "";
  }
  const renderRoot = getCandidateRenderRoot(candidate);
  if (!(renderRoot instanceof Element)) {
    return "";
  }
  const renderedHelperKey = buildRenderedHelperKey(candidate, semanticCallKey);
  if (processedRenderedHelpers.get(renderRoot)?.has(renderedHelperKey)) {
    return "processed rendered helper";
  }
  if (routeHandoffPreviousPageIdentity &&
      processedRenderedHelpers.get(renderRoot)?.has(
        buildRenderedHelperKey(candidate, semanticCallKey, routeHandoffPreviousPageIdentity)
      )) {
    return "processed rendered helper carried across pending route delivery";
  }
  return "";
}

function getCandidateRenderRoot(candidate) {
  if (candidate?.textRoot instanceof Element) {
    return candidate.textRoot;
  }
  return candidate?.node instanceof Element ? candidate.node : null;
}

function getHelperRenderRootId(renderRoot) {
  if (!(renderRoot instanceof Element)) {
    return "no-render-root";
  }
  let id = helperRenderRootIds.get(renderRoot);
  if (!id) {
    helperRenderRootSequence += 1;
    id = `render-${helperRenderRootSequence}`;
    helperRenderRootIds.set(renderRoot, id);
  }
  return id;
}

function getHelperRenderRootGeneration(renderRoot) {
  if (!(renderRoot instanceof Element)) {
    return 0;
  }
  return helperRenderRootGenerations.get(renderRoot) || 0;
}

function getCurrentPageIdentity() {
  return location.href || `${location.origin}${location.pathname || ""}`;
}

function beginPageLifecycle(options = {}) {
  const routeHandoffEntries = Array.isArray(options.routeHandoffEntries)
    ? options.routeHandoffEntries
    : [];
  const routeHandoffPresentedExecutions = Array.isArray(options.routeHandoffPresentedExecutions)
    ? options.routeHandoffPresentedExecutions
    : [];
  const previousStorageKey = String(options.previousStorageKey || "");
  routeHandoffPreviousPageIdentity = options.routeTransition === true && routeHandoffEntries.length > 0
    ? String(options.previousPageIdentity || "")
    : "";
  cancelPendingHelperDeliveryRetry();
  pendingHelperDeliveries = new Map();
  locallyPresentedHelperExecutions = new Map();
  pendingHelperDeliveriesLoadedKey = "";
  pageLifecycleGeneration += 1;
  observedPageIdentity = getCurrentPageIdentity();
  activeCallId = "";
  activeCallToken = null;
  initialThreadSettled = false;
  lastThreadText = "";
  lastThreadTextAt = Date.now();
  chainCallCount = 0;
  lastUserMessageText = "";
  pendingSelfTest = null;
  cancelAgentDeliveryLifecycle();
  migratePendingAgentDeliveryToCurrentPage({
    preserveInsertedOwnership: options.routeTransition === true
  });
  clearPendingForceRun();

  if (routeHandoffEntries.length > 0) {
    const nextPageIdentity = getCurrentPageIdentity();
    for (const entry of routeHandoffEntries) {
      entry.pageIdentity = nextPageIdentity;
      entry.restored = false;
      entry.deliveryInFlight = false;
      entry.updatedAt = Date.now();
      pendingHelperDeliveries.set(entry.callId, entry);
    }
  }
  for (const presented of routeHandoffPresentedExecutions) {
    if (isCanonicalExecutionId(presented?.executionId)) {
      locallyPresentedHelperExecutions.set(
        presented.executionId,
        Number(presented.presentedAt || Date.now())
      );
    }
  }
  if (routeHandoffEntries.length > 0 || routeHandoffPresentedExecutions.length > 0) {
    const nextPageIdentity = getCurrentPageIdentity();
    pendingHelperDeliveriesLoadedKey = pendingHelperDeliveryStorageKey(nextPageIdentity);
    const nextStorageKey = pendingHelperDeliveriesLoadedKey;
    persistPendingHelperDeliveries(nextStorageKey, { propagateErrors: true })
      .then(() => previousStorageKey && previousStorageKey !== nextStorageKey
        ? chrome.storage.local.remove([previousStorageKey])
        : undefined)
      .catch(() => {});
    if (routeHandoffEntries.length > 0) {
      schedulePendingHelperDeliveryRetry(0);
    }
  }
}

function refreshPageLifecycle() {
  const pageIdentity = getCurrentPageIdentity();
  if (!observedPageIdentity) {
    observedPageIdentity = pageIdentity;
    return;
  }
  if (pageIdentity !== observedPageIdentity) {
    const previousPageIdentity = observedPageIdentity;
    const previousStorageKey = pendingHelperDeliveriesLoadedKey ||
      pendingHelperDeliveryStorageKey(previousPageIdentity);
    const routeHandoffEntries = Array.from(pendingHelperDeliveries.values())
      .filter((entry) =>
        ["queued", "inserted", "submitted", "presented"].includes(entry?.phase) &&
        entry?.pageIdentity === previousPageIdentity
      );
    const routeHandoffPresentedExecutions = Array.from(
      locallyPresentedHelperExecutions,
      ([executionId, presentedAt]) => ({ executionId, presentedAt })
    );
    beginPageLifecycle({
      routeTransition: true,
      previousPageIdentity,
      previousStorageKey,
      routeHandoffEntries,
      routeHandoffPresentedExecutions
    });
  }
}

function pendingHelperDeliveryStorageKey(pageIdentity = getCurrentPageIdentity()) {
  return `${HELPER_PENDING_DELIVERY_PREFIX}${getAgentTabInstanceId()}:${pageIdentity}`;
}

async function loadPendingHelperDeliveriesForCurrentPage() {
  const storageKey = pendingHelperDeliveryStorageKey();
  if (pendingHelperDeliveriesLoadedKey === storageKey) {
    return;
  }
  await pendingHelperDeliveryStorageTail.catch(() => {});
  pendingHelperDeliveries = new Map();
  locallyPresentedHelperExecutions = new Map();
  pendingHelperDeliveriesLoadedKey = storageKey;
  try {
    const stored = await chrome.storage.local.get([storageKey]);
    const snapshot = stored?.[storageKey];
    if (snapshot?.pageIdentity !== getCurrentPageIdentity() || !Array.isArray(snapshot.entries)) {
      return;
    }
    const entries = prunePendingHelperDeliveryEntries(snapshot.entries)
      .map((entry) => ({ ...entry, restored: true }));
    for (const entry of entries) {
      pendingHelperDeliveries.set(entry.callId, entry);
    }
    const presentedExecutions = pruneLocallyPresentedHelperExecutions(snapshot.presentedExecutions);
    for (const presented of presentedExecutions) {
      locallyPresentedHelperExecutions.set(presented.executionId, presented.presentedAt);
    }
    for (const entry of entries) {
      if ((entry.phase === "submitted" || entry.phase === "presented") && isCanonicalExecutionId(entry.executionId)) {
        locallyPresentedHelperExecutions.set(entry.executionId, Number(entry.updatedAt || entry.createdAt || Date.now()));
      }
    }
    if (entries.length !== snapshot.entries.length ||
        presentedExecutions.length !== (Array.isArray(snapshot.presentedExecutions) ? snapshot.presentedExecutions.length : 0)) {
      await persistPendingHelperDeliveries(storageKey);
    }
  } catch (_unused) {
    // A storage failure must not turn local result delivery into another run.
  }
}

function isCanonicalExecutionId(value) {
  return /^[a-f0-9]{16}$/i.test(String(value || ""));
}

function pruneLocallyPresentedHelperExecutions(entries, now = Date.now()) {
  const byExecutionId = new Map();
  for (const entry of Array.from(entries || [])) {
    const executionId = String(entry?.executionId || "");
    const presentedAt = Number(entry?.presentedAt || 0);
    if (!isCanonicalExecutionId(executionId) || !Number.isFinite(presentedAt) ||
        presentedAt <= 0 || now - presentedAt > PENDING_HELPER_DELIVERY_MAX_AGE_MS) {
      continue;
    }
    byExecutionId.set(executionId, Math.max(presentedAt, Number(byExecutionId.get(executionId) || 0)));
  }
  return Array.from(byExecutionId, ([executionId, presentedAt]) => ({ executionId, presentedAt }))
    .sort((a, b) => a.presentedAt - b.presentedAt)
    .slice(-PRESENTED_HELPER_EXECUTION_MAX_ENTRIES);
}

function hasLocallyPresentedHelperExecution(executionId) {
  return isCanonicalExecutionId(executionId) && locallyPresentedHelperExecutions.has(String(executionId));
}

async function rememberLocallyPresentedHelperExecution(entry) {
  const executionId = String(entry?.executionId || "");
  if (!isCanonicalExecutionId(executionId)) {
    return;
  }
  locallyPresentedHelperExecutions.set(executionId, Date.now());
  const pruned = pruneLocallyPresentedHelperExecutions(
    Array.from(locallyPresentedHelperExecutions, ([id, presentedAt]) => ({ executionId: id, presentedAt }))
  );
  locallyPresentedHelperExecutions = new Map(pruned.map(({ executionId: id, presentedAt }) => [id, presentedAt]));
  await persistPendingHelperDeliveries();
}

function prunePendingHelperDeliveryEntries(entries, now = Date.now()) {
  const valid = Array.from(entries || [])
    .filter((entry) => isStoredPendingHelperDelivery(entry, now))
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  while (valid.length > PENDING_HELPER_DELIVERY_MAX_ENTRIES) {
    valid.shift();
  }
  let totalChars = valid.reduce((sum, entry) => sum + String(entry.reply || "").length, 0);
  while (valid.length > 1 && totalChars > PENDING_HELPER_DELIVERY_MAX_TOTAL_CHARS) {
    const removed = valid.shift();
    totalChars -= String(removed?.reply || "").length;
  }
  return valid;
}

function isStoredPendingHelperDelivery(entry, now = Date.now()) {
  const supportedKinds = new Set([
    "shell",
    "board",
    "file",
    "agent-message",
    "agent-roster",
    "agent-task-status"
  ]);
  return Boolean(
    entry &&
    typeof entry === "object" &&
    typeof entry.callId === "string" &&
    entry.callId &&
    supportedKinds.has(entry.kind) &&
    entry.call &&
    typeof entry.call === "object" &&
    typeof entry.reply === "string" &&
    entry.reply &&
    entry.pageIdentity === getCurrentPageIdentity() &&
    Number.isFinite(Number(entry.createdAt)) &&
    now - Number(entry.createdAt) <= PENDING_HELPER_DELIVERY_MAX_AGE_MS
  );
}

function boundPendingHelperReply(reply) {
  const text = String(reply || "");
  if (text.length <= PENDING_HELPER_DELIVERY_MAX_REPLY_CHARS) {
    return text;
  }
  const marker = "\n[pending helper reply truncated by local persistence bound]";
  return `${text.slice(0, PENDING_HELPER_DELIVERY_MAX_REPLY_CHARS - marker.length)}${marker}`;
}

function snapshotPendingHelperCall(call) {
  return {
    kind: pendingHelperDeliveryKind(call),
    cmd: String(call?.cmd || ""),
    cwd: String(call?.cwd || ""),
    boardName: String(call?.boardName || ""),
    helperId: String(call?.helperId || ""),
    filename: String(call?.filename || ""),
    to: String(call?.to || ""),
    taskId: String(call?.taskId || ""),
    messageId: String(call?.messageId || ""),
    role: String(call?.role || ""),
    surface: String(call?.surface || "")
  };
}

function pendingHelperDeliveryKind(call) {
  if (isFileHelperCall(call)) {
    return "file";
  }
  if (isBoardHelperCall(call)) {
    return "board";
  }
  if (isAgentMessageHelperCall(call)) {
    return "agent-message";
  }
  if (isAgentRosterHelperCall(call)) {
    return "agent-roster";
  }
  if (isAgentTaskStatusHelperCall(call)) {
    return "agent-task-status";
  }
  return "shell";
}

function pendingHelperDeliveryLabel(entry) {
  return {
    board: "Board helper",
    file: "File helper",
    "agent-message": "Agent message",
    "agent-roster": "Agent roster",
    "agent-task-status": "Agent task status",
    shell: "Shell helper"
  }[entry?.kind] || "Helper";
}

function snapshotPendingHelperResponse(response) {
  const source = response && typeof response === "object" ? response : {};
  return {
    ok: source.ok,
    exitCode: source.exitCode,
    interrupted: source.interrupted === true,
    interruptSignal: String(source.interruptSignal || ""),
    target: String(source.target || ""),
    targetName: String(source.targetName || ""),
    stdout: String(source.stdout || "").slice(0, 4096)
  };
}

async function rememberPendingHelperDelivery(callId, call, response, reply, settings) {
  await loadPendingHelperDeliveriesForCurrentPage();
  const now = Date.now();
  const executionId = String(response?.executionId || response?.receipt?.executionId || "");
  if (isCanonicalExecutionId(executionId)) {
    const existing = Array.from(pendingHelperDeliveries.values())
      .find((pending) => pending.executionId === executionId);
    if (existing) {
      existing.updatedAt = now;
      await persistPendingHelperDeliveries();
      return existing;
    }
  }
  const entry = {
    callId,
    executionId,
    kind: pendingHelperDeliveryKind(call),
    call: snapshotPendingHelperCall(call),
    response: snapshotPendingHelperResponse(response),
    reply: boundPendingHelperReply(reply),
    autoSend: settings?.autoSend !== false,
    pageIdentity: getCurrentPageIdentity(),
    phase: "queued",
    submittedMessageCountBefore: countSubmittedMessagesMatching(reply),
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    lastError: "",
    restored: false
  };
  pendingHelperDeliveries.set(callId, entry);
  const pruned = prunePendingHelperDeliveryEntries(Array.from(pendingHelperDeliveries.values()));
  pendingHelperDeliveries = new Map(pruned.map((pending) => [pending.callId, pending]));
  await persistPendingHelperDeliveries();
  return pendingHelperDeliveries.get(callId) || entry;
}

function persistPendingHelperDeliveries(
  storageKey = pendingHelperDeliveriesLoadedKey || pendingHelperDeliveryStorageKey(),
  options = {}
) {
  const entries = prunePendingHelperDeliveryEntries(Array.from(pendingHelperDeliveries.values()))
    .map(({
      restored: _restored,
      deliveryInFlight: _deliveryInFlight,
      sendActuatorGeneration: _sendActuatorGeneration,
      ...entry
    }) => entry);
  const presentedExecutions = pruneLocallyPresentedHelperExecutions(
    Array.from(locallyPresentedHelperExecutions, ([executionId, presentedAt]) => ({ executionId, presentedAt }))
  );
  const snapshot = {
    version: 1,
    pageIdentity: entries[0]?.pageIdentity || getCurrentPageIdentity(),
    updatedAt: Date.now(),
    entries,
    presentedExecutions
  };
  const operation = pendingHelperDeliveryStorageTail
    .catch(() => {})
    .then(() => entries.length > 0 || presentedExecutions.length > 0
      ? chrome.storage.local.set({ [storageKey]: snapshot })
      : chrome.storage.local.remove([storageKey]));
  pendingHelperDeliveryStorageTail = operation.catch(() => {});
  return options.propagateErrors === true ? operation : pendingHelperDeliveryStorageTail;
}

async function clearPendingHelperDelivery(entry) {
  if (!entry || pendingHelperDeliveries.get(entry.callId) !== entry) {
    return;
  }
  pendingHelperDeliveries.delete(entry.callId);
  await persistPendingHelperDeliveries();
}

async function cancelPendingHelperDeliveryAfterComposerRemoval(entry) {
  if (!entry || pendingHelperDeliveries.get(entry.callId) !== entry) {
    return true;
  }
  // Emptying or replacing the current text is an explicit user cancellation.
  // Do not immediately fill the composer with another result that was already
  // queued behind it. A later new helper may still create a fresh delivery.
  pendingHelperDeliveries.clear();
  await persistPendingHelperDeliveries();
  const label = pendingHelperDeliveryLabel(entry);
  setStatus(`${label} result delivery and the current queued batch were cancelled because composer content was removed or changed; they will not be inserted again.`, "ok");
  return true;
}

async function acknowledgePendingHelperResultPresented(entry) {
  const executionId = String(entry?.executionId || "");
  if (!isCanonicalExecutionId(executionId)) {
    return true;
  }
  try {
    const response = await chrome.runtime.sendMessage({
      type: "run-result-presented",
      executionId
    });
    return response?.ok === true && response?.found !== false;
  } catch (_unused) {
    return false;
  }
}

async function finalizePendingHelperDelivery(entry, phase) {
  entry.phase = phase;
  entry.updatedAt = Date.now();
  await persistPendingHelperDeliveries();
  await rememberLocallyPresentedHelperExecution(entry);
  const receiptAcknowledged = await acknowledgePendingHelperResultPresented(entry);
  if (receiptAcknowledged) {
    await clearPendingHelperDelivery(entry);
  } else {
    entry.lastError = "result presented locally; waiting for server receipt acknowledgement";
    await persistPendingHelperDeliveries();
    schedulePendingHelperDeliveryRetry();
  }
  setHelperCompletionStatus(entry.call, entry.response);
  return true;
}

function setPendingHelperDeliveryStatus(entry) {
  const label = pendingHelperDeliveryLabel(entry);
  setStatus(`${label} result cached locally; waiting for chat composer/send readiness. The backend operation and composer write will not be repeated.`, "running");
}

async function retryInsertedPendingHelperDelivery(entry, deliverySettings) {
  let composer;
  try {
    composer = await findReplyInput();
  } catch (_unused) {
    composer = null;
  }
  if (!composer) {
    entry.lastError = "composer unavailable after the result was inserted; waiting without reinserting";
    entry.updatedAt = Date.now();
    await persistPendingHelperDeliveries();
    setPendingHelperDeliveryStatus(entry);
    schedulePendingHelperDeliveryRetry();
    return false;
  }

  const expectedComposerText = getValidatedComposerOwnershipText(composer, entry.reply);
  if (!expectedComposerText) {
    return cancelPendingHelperDeliveryAfterComposerRemoval(entry);
  }
  if (deliverySettings.autoSend === false) {
    return finalizePendingHelperDelivery(entry, "presented");
  }
  if (entry.sendActuatorGeneration === pageLifecycleGeneration) {
    entry.lastError = "the original v0.8.9 send attempt finished; waiting for manual send without repeating send actions";
    entry.updatedAt = Date.now();
    await persistPendingHelperDeliveries();
    setPendingHelperDeliveryStatus(entry);
    schedulePendingHelperDeliveryRetry();
    return false;
  }

  const callToken = {
    callId: entry.callId,
    pageIdentity: entry.pageIdentity,
    generation: pageLifecycleGeneration,
    phase: "pending-send-only",
    composerWriteAttempted: true
  };
  const sent = await withComposerDeliveryLease({
    kind: "helper-output-send-retry",
    pageIdentity: callToken.pageIdentity,
    generation: callToken.generation
  }, async (deliveryToken) => {
    if (!isComposerDeliveryTokenCurrent(deliveryToken)) {
      return false;
    }
    entry.sendActuatorGeneration = pageLifecycleGeneration;
    entry.updatedAt = Date.now();
    await persistPendingHelperDeliveries();
    return runOriginalSendActuatorForOwnedComposer(
      composer,
      () => isComposerDeliveryTokenCurrent(deliveryToken),
      expectedComposerText
    );
  });
  if (sent) {
    return finalizePendingHelperDelivery(entry, "submitted");
  }
  if (!getValidatedComposerOwnershipText(composer, entry.reply)) {
    return cancelPendingHelperDeliveryAfterComposerRemoval(entry);
  }
  entry.lastError = "the original v0.8.9 send attempt finished; waiting for manual send without repeating send actions";
  entry.updatedAt = Date.now();
  await persistPendingHelperDeliveries();
  setPendingHelperDeliveryStatus(entry);
  schedulePendingHelperDeliveryRetry();
  return false;
}

async function attemptPendingHelperDelivery(entry, settings = null) {
  if (!entry || pendingHelperDeliveries.get(entry.callId) !== entry || entry.pageIdentity !== getCurrentPageIdentity()) {
    return false;
  }
  if (entry.deliveryInFlight === true) {
    return false;
  }
  entry.deliveryInFlight = true;
  try {
    if (entry.phase === "submitted" || entry.phase === "presented" ||
        countSubmittedMessagesMatching(entry.reply) > Number(entry.submittedMessageCountBefore || 0)) {
      return finalizePendingHelperDelivery(
        entry,
        entry.phase === "presented" ? "presented" : "submitted"
      );
    }
    if (entry.restored === true && entry.phase === "inserted" && !initialThreadSettled) {
      setPendingHelperDeliveryStatus(entry);
      schedulePendingHelperDeliveryRetry();
      return false;
    }
    const deliverySettings = settings || await chrome.storage.sync.get(["autoSend"]);
    if (entry.phase === "inserted") {
      return retryInsertedPendingHelperDelivery(entry, deliverySettings);
    }
    const callToken = {
      callId: entry.callId,
      pageIdentity: entry.pageIdentity,
      generation: pageLifecycleGeneration,
      phase: "pending-reply"
    };
    entry.attempts = Number(entry.attempts || 0) + 1;
    entry.updatedAt = Date.now();
    const delivered = await deliverHelperReply(callToken, entry.reply, deliverySettings, async () => {
      if (deliverySettings.autoSend !== false) {
        entry.sendActuatorGeneration = pageLifecycleGeneration;
      }
      setHelperCompletionStatus(entry.call, entry.response);
    }, async () => {
      entry.phase = "inserted";
      entry.updatedAt = Date.now();
      entry.lastError = "";
      await persistPendingHelperDeliveries();
    });
    if (delivered) {
      return finalizePendingHelperDelivery(
        entry,
        deliverySettings.autoSend === false ? "presented" : "submitted"
      );
    }
    entry.lastError = "chat composer insertion or send is not complete";
    entry.updatedAt = Date.now();
    await persistPendingHelperDeliveries();
    setPendingHelperDeliveryStatus(entry);
    schedulePendingHelperDeliveryRetry();
    return false;
  } finally {
    entry.deliveryInFlight = false;
  }
}

async function retryPendingHelperDeliveries() {
  if (pendingHelperDeliveryRetryInFlight || !extensionActive) {
    return;
  }
  // The retry timer does not depend on DOM mutations. Detect a route-only SPA
  // navigation before selecting a per-page storage key, otherwise the old
  // in-memory delivery can be discarded while its exact text remains in the
  // composer.
  refreshPageLifecycle();
  await loadPendingHelperDeliveriesForCurrentPage();
  const entries = Array.from(pendingHelperDeliveries.values())
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  if (entries.length === 0) {
    return;
  }
  pendingHelperDeliveryRetryInFlight = true;
  try {
    const settings = await chrome.storage.sync.get(["autoSend"]);
    for (const entry of entries) {
      const delivered = await attemptPendingHelperDelivery(entry, settings);
      if (!delivered) {
        break;
      }
    }
  } finally {
    pendingHelperDeliveryRetryInFlight = false;
  }
  if (pendingHelperDeliveries.size > 0) {
    schedulePendingHelperDeliveryRetry();
  }
}

function schedulePendingHelperDeliveryRetry(delayMs = PENDING_HELPER_DELIVERY_RETRY_MS) {
  if (!extensionActive || pendingHelperDeliveries.size === 0 || pendingHelperDeliveryRetryTimer) {
    return;
  }
  pendingHelperDeliveryRetryTimer = setTimeout(() => {
    pendingHelperDeliveryRetryTimer = 0;
    retryPendingHelperDeliveries().catch(() => {
      schedulePendingHelperDeliveryRetry();
    });
  }, delayMs);
}

function cancelPendingHelperDeliveryRetry() {
  clearTimeout(pendingHelperDeliveryRetryTimer);
  pendingHelperDeliveryRetryTimer = 0;
}

async function withComposerDeliveryLease(metadata, task) {
  const previous = composerDeliveryTail.catch(() => {});
  let releaseQueue;
  const gate = new Promise((resolve) => {
    releaseQueue = resolve;
  });
  composerDeliveryTail = previous.then(() => gate);
  await previous;

  composerDeliverySequence += 1;
  const token = {
    sequence: composerDeliverySequence,
    kind: metadata.kind || "composer",
    pageIdentity: metadata.pageIdentity || getCurrentPageIdentity(),
    generation: Number.isInteger(metadata.generation) ? metadata.generation : pageLifecycleGeneration,
    agentToken: metadata.agentToken || null
  };
  activeComposerDeliveryToken = token;
  try {
    return await task(token);
  } finally {
    if (activeComposerDeliveryToken === token) {
      activeComposerDeliveryToken = null;
    }
    releaseQueue();
  }
}

function isComposerDeliveryTokenCurrent(token) {
  return activeComposerDeliveryToken === token &&
    pageLifecycleGeneration === token?.generation &&
    getCurrentPageIdentity() === token?.pageIdentity &&
    (!token?.agentToken || isAgentDeliveryTokenCurrent(token.agentToken));
}

function cancelAgentDeliveryLifecycle() {
  agentDeliveryGeneration += 1;
  agentDeliveryInFlight = false;
  activeAgentDeliveryToken = null;
}

function migratePendingAgentDeliveryToCurrentPage(options = {}) {
  pendingAgentDeliveryLoaded = false;
  if (!pendingAgentDelivery) {
    return;
  }
  const previousStorageKey = pendingAgentDelivery.storageKey || agentPendingDeliveryKey();
  const nextStorageKey = agentPendingDeliveryKey();
  pendingAgentDelivery.storageKey = nextStorageKey;
  pendingAgentDelivery.pageIdentity = getCurrentPageIdentity();
  pendingAgentDelivery.pageGeneration = pageLifecycleGeneration;
  if (pendingAgentDelivery.sent !== true) {
    if (pendingAgentDelivery.composerWriteAttempted === true &&
        options.preserveInsertedOwnership === true) {
      // A same-tab SPA route change is not proof of user cancellation. Keep
      // the one-write invariant and let the next attempt validate the entire
      // current composer before it performs any send side effect.
      pendingAgentDelivery.cancelled = false;
      pendingAgentDelivery.lastError = "page route changed; verifying exact composer ownership before resuming send-only delivery";
    } else if (pendingAgentDelivery.composerWriteAttempted === true) {
      pendingAgentDelivery.cancelled = true;
      pendingAgentDelivery.inserted = false;
      pendingAgentDelivery.composerElement = null;
      pendingAgentDelivery.lastError = "page changed after composer delivery began; automatic reinsertion was cancelled";
    } else {
      pendingAgentDelivery.inserted = false;
      pendingAgentDelivery.lastError = "page changed before delivery completed";
    }
  }
  if (previousStorageKey !== nextStorageKey) {
    persistPendingAgentDelivery({ propagateErrors: true })
      .then(() => chrome.storage.local.remove([previousStorageKey]))
      .catch(() => {});
    return;
  }
  persistPendingAgentDelivery();
}

function buildRenderedHelperKey(candidate, semanticCallKey, pageIdentity = getCurrentPageIdentity()) {
  return [
    pageIdentity,
    getHelperRenderRootGeneration(getCandidateRenderRoot(candidate)),
    candidate?.source || "",
    candidate?.blockIndex ?? candidate?.index ?? "",
    semanticCallKey
  ].join("\n");
}

function helperPreviewText(call) {
  if (isFileHelperCall(call)) {
    return call.filename || call.content || "";
  }
  if (isAgentMessageHelperCall(call)) {
    return call.body || call.to || "";
  }
  return call.cmd || "";
}

function buildForceCallKey(semanticCallKey) {
  forceCallSequence = (forceCallSequence + 1) % 1_000_000;
  return `${semanticCallKey}:force:${Date.now()}:${forceCallSequence}`;
}

function markCallProcessed(candidate, callKey, semanticCallKey) {
  const renderRoot = getCandidateRenderRoot(candidate);
  if (renderRoot instanceof Element) {
    const handled = processedRenderedHelpers.get(renderRoot) || new Set();
    handled.add(buildRenderedHelperKey(candidate, semanticCallKey));
    processedRenderedHelpers.set(renderRoot, handled);
  }
}

function unmarkCallProcessed(candidate, semanticCallKey) {
  const renderRoot = getCandidateRenderRoot(candidate);
  if (!(renderRoot instanceof Element)) {
    return;
  }
  const handled = processedRenderedHelpers.get(renderRoot);
  if (!handled) {
    return;
  }
  handled.delete(buildRenderedHelperKey(candidate, semanticCallKey));
  if (handled.size === 0) {
    processedRenderedHelpers.delete(renderRoot);
  }
}

function markRepeatableAgentQueryCallProcessed(_callKey) {
  // Read-only agent queries are intentionally repeatable.
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
  const candidates = Array.from(document.querySelectorAll("button, [role='button']"))
    .filter(isVisibleElement);
  return candidates.some((button) => {
    const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`.trim().toLowerCase();
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
    "pre",
    "code",
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
    node.contains(other) &&
    containsToolLanguageHint(other.innerText || other.textContent || "")
  ));
}

function containsToolLanguageHint(text) {
  const lower = String(text || "").toLowerCase();
  return lower.includes(HELPER_SHELL_START) ||
    lower.includes(HELPER_FILE_START) ||
    lower.includes(HELPER_BOARD_START) ||
    /ai-helper-board-[a-z0-9][a-z0-9._-]{0,63}-start/.test(lower) ||
    lower.includes(HELPER_AGENT_MESSAGE_START) ||
    lower.includes(HELPER_AGENT_ROSTER_START) ||
    lower.includes(HELPER_AGENT_TASK_STATUS_START);
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
  return blocks.map((call, blockIndex) => ({
    call,
    node: closestMessageContainer(root),
    blockIndex,
    insideShellOutput: isRenderedShellOutputRoot(root) || isHelperLineInsideShellOutput(text, call.sourceStartLine)
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

    const fenceEndIndex = findHelperFenceEndIndex(lines, index, start);
    const endIndex = findHelperEndIndex(lines, index, valueLineIndex, start, fenceEndIndex);
    const inferredEndMarker = endIndex < 0 && fenceEndIndex >= 0;
    const blockEndIndex = inferredEndMarker ? fenceEndIndex : endIndex;
    if (blockEndIndex < 0) {
      break;
    }

    const helperId = start.helperId || buildPlainTextHelperPayloadHash({
      kind: start.kind,
      marker,
      value: lines[valueLineIndex],
      bodyLines: lines.slice(valueLineIndex + 1, blockEndIndex),
      endMarker: start.endMarker || expectedHelperEndMarker(start.kind)
    });

    if (start.kind === "file") {
      calls.push({
        kind: start.kind,
        helperId,
        helperIdSource: start.helperId ? "marker" : "payload-hash",
        helperMarkerError: start.error || "",
        inferredEndMarker,
        filename: normalizeCommand(lines[valueLineIndex]),
        content: lines.slice(valueLineIndex + 1, blockEndIndex).join("\n")
      });
    } else if (start.kind === "board") {
      calls.push({
        kind: start.kind,
        helperId,
        helperIdSource: start.helperId ? "marker" : "payload-hash",
        helperMarkerError: start.error || "",
        inferredEndMarker,
        boardName: start.boardName || "",
        cmd: normalizeCommand(lines.slice(valueLineIndex, blockEndIndex).join("\n"))
      });
    } else if (start.kind === "agent-message") {
      calls.push({
        kind: start.kind,
        helperId,
        helperIdSource: start.helperId ? "marker" : "payload-hash",
        helperMarkerError: start.error || "",
        inferredEndMarker,
        ...parseAgentMessageLines(lines.slice(valueLineIndex, blockEndIndex))
      });
    } else if (start.kind === "agent-roster") {
      calls.push({
        kind: start.kind,
        helperId,
        helperIdSource: start.helperId ? "marker" : "payload-hash",
        helperMarkerError: start.error || "",
        inferredEndMarker,
        ...parseAgentRosterLines(lines.slice(valueLineIndex, blockEndIndex))
      });
    } else if (start.kind === "agent-task-status") {
      calls.push({
        kind: start.kind,
        helperId,
        helperIdSource: start.helperId ? "marker" : "payload-hash",
        helperMarkerError: start.error || "",
        inferredEndMarker,
        ...parseAgentTaskStatusLines(lines.slice(valueLineIndex, blockEndIndex))
      });
    } else {
      calls.push({
        kind: start.kind,
        helperId,
        helperIdSource: start.helperId ? "marker" : "payload-hash",
        helperMarkerError: start.error || "",
        inferredEndMarker,
        cmd: normalizeCommand(lines.slice(valueLineIndex, blockEndIndex).join("\n"))
      });
    }
    const addedCall = calls[calls.length - 1];
    if (addedCall) {
      addedCall.sourceStartLine = index;
      addedCall.sourceEndLine = blockEndIndex;
    }
    index = blockEndIndex;
  }

  return calls;
}

function findHelperEndIndex(lines, startIndex, valueLineIndex, start, fenceEndIndex) {
  const kind = start.kind;
  const minEndIndex = kind === "board" || kind === "agent-roster" || kind === "agent-task-status" ? startIndex : valueLineIndex;
  return lines.findIndex((line, lineIndex) =>
    lineIndex > minEndIndex &&
    (fenceEndIndex < 0 || lineIndex < fenceEndIndex) &&
    isHelperEndForStart(start, line)
  );
}

function findHelperFenceEndIndex(lines, startIndex, start) {
  if (startIndex <= 0 || lines[startIndex - 1] !== HELPER_FENCE_MARKER) {
    return -1;
  }

  const kind = start.kind;
  const minEndIndex = kind === "board" || kind === "agent-roster" || kind === "agent-task-status" ? startIndex : startIndex + 1;
  return lines.findIndex((line, lineIndex) =>
    lineIndex > minEndIndex &&
    line === HELPER_FENCE_MARKER
  );
}

function parsePlainTextHelperPayload(text) {
  const blocks = parsePlainTextHelperBlocks(text);
  if (blocks.length !== 1) {
    return null;
  }

  const lines = splitShellCallLines(text);
  const start = parseHelperStartMarker(lines[0]);
  if (!start.kind || !isHelperEndForStart(start, lines[lines.length - 1])) {
    const fencedStart = lines[0] === HELPER_FENCE_MARKER ? parseHelperStartMarker(lines[1]) : { kind: "" };
    if (!fencedStart.kind || lines[lines.length - 1] !== HELPER_FENCE_MARKER) {
      return null;
    }
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
  const board = parseBoardHelperStartMarker(text);
  if (board.kind) {
    return board;
  }
  const agentMessage = parseSpecificHelperStartMarker(text, HELPER_AGENT_MESSAGE_START, "agent-message");
  if (agentMessage.kind) {
    return agentMessage;
  }
  const agentRoster = parseSpecificHelperStartMarker(text, HELPER_AGENT_ROSTER_START, "agent-roster");
  if (agentRoster.kind) {
    return agentRoster;
  }
  const agentTaskStatus = parseSpecificHelperStartMarker(text, HELPER_AGENT_TASK_STATUS_START, "agent-task-status");
  if (agentTaskStatus.kind) {
    return agentTaskStatus;
  }
  return { kind: "", helperId: "", error: "" };
}

function parseBoardHelperStartMarker(text) {
  const defaultBoard = parseSpecificHelperStartMarker(text, HELPER_BOARD_START, "board");
  if (defaultBoard.kind) {
    return {
      ...defaultBoard,
      boardName: "",
      boardSuffix: "",
      endMarker: HELPER_BOARD_END
    };
  }

  const match = String(text || "").match(/^ai-helper-board-([A-Za-z0-9][A-Za-z0-9._-]{0,63})-start(?::(.*))?$/);
  if (!match) {
    return { kind: "", helperId: "", error: "" };
  }

  const boardSuffix = match[1];
  const boardName = `board-${boardSuffix}`;
  const marker = `ai-helper-board-${boardSuffix}-start`;
  const endMarker = `ai-helper-board-${boardSuffix}-end`;
  const helperId = String(match[2] || "").trim();
  if (helperId && !HELPER_ID_PATTERN.test(helperId)) {
    return {
      kind: "board",
      helperId: "",
      boardName,
      boardSuffix,
      endMarker,
      error: `Malformed helper identity suffix on ${marker}. Use ${marker}:<nonce> with 1-128 characters matching ${HELPER_ID_PATTERN.source}.`
    };
  }

  return {
    kind: "board",
    helperId,
    boardName,
    boardSuffix,
    endMarker,
    error: BOARD_NAME_SUFFIX_PATTERN.test(boardSuffix) ? "" : `Board suffix must match ${BOARD_NAME_SUFFIX_PATTERN.source}.`
  };
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
  return line === expectedHelperEndMarker(kind);
}

function isHelperEndForStart(start, line) {
  return line === (start.endMarker || expectedHelperEndMarker(start.kind));
}

function expectedHelperEndMarker(kind) {
  if (kind === "shell") {
    return HELPER_SHELL_END;
  }
  if (kind === "file") {
    return HELPER_FILE_END;
  }
  if (kind === "board") {
    return HELPER_BOARD_END;
  }
  if (kind === "agent-message") {
    return HELPER_AGENT_MESSAGE_END;
  }
  if (kind === "agent-roster") {
    return HELPER_AGENT_ROSTER_END;
  }
  if (kind === "agent-task-status") {
    return HELPER_AGENT_TASK_STATUS_END;
  }
  return "";
}

function parseAgentMessageLines(lines) {
  const headerLines = [];
  let bodyStartIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (String(lines[index] || "").trim() === "") {
      bodyStartIndex = index + 1;
      break;
    }
    headerLines.push(lines[index]);
  }

  const headers = {};
  const malformedHeaders = [];
  for (const line of headerLines) {
    const match = String(line || "").match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) {
      malformedHeaders.push(line);
      continue;
    }
    headers[match[1].toLowerCase()] = match[2].trim();
  }

  const bodyLines = bodyStartIndex >= 0 ? lines.slice(bodyStartIndex) : [];
  return {
    to: headers.to || "",
    taskId: headers["task-id"] || "",
    replyTo: headers["reply-to"] || "",
    body: bodyLines.join("\n"),
    agentHeaderError: malformedHeaders.length > 0
      ? `Malformed agent message header: ${malformedHeaders[0]}`
      : ""
  };
}

function parseSimpleHeaderLines(lines) {
  const headers = {};
  const malformedHeaders = [];
  for (const line of lines) {
    const text = String(line || "");
    if (!text.trim()) {
      continue;
    }
    const match = text.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) {
      malformedHeaders.push(text);
      continue;
    }
    headers[match[1].toLowerCase()] = match[2].trim();
  }
  return {
    headers,
    helperHeaderError: malformedHeaders.length > 0
      ? `Malformed helper header: ${malformedHeaders[0]}`
      : ""
  };
}

function parseAgentRosterLines(lines) {
  const parsed = parseSimpleHeaderLines(lines);
  return {
    role: parsed.headers.role || "",
    surface: parsed.headers.surface || "",
    agentHeaderError: parsed.helperHeaderError
  };
}

function parseAgentTaskStatusLines(lines) {
  const parsed = parseSimpleHeaderLines(lines);
  return {
    messageId: parsed.headers["message-id"] || parsed.headers.messageid || "",
    taskId: parsed.headers["task-id"] || "",
    agentHeaderError: parsed.helperHeaderError
  };
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

function isAgentMessageHelperCall(call) {
  return call?.kind === "agent-message";
}

function isAgentRosterHelperCall(call) {
  return call?.kind === "agent-roster";
}

function isAgentTaskStatusHelperCall(call) {
  return call?.kind === "agent-task-status";
}

function isAgentQueryHelperCall(call) {
  return isAgentRosterHelperCall(call) || isAgentTaskStatusHelperCall(call);
}

function isRepeatableAgentQueryHelperCall(call) {
  return isAgentQueryHelperCall(call);
}

function isRunnableHelperCall(call) {
  if (isFileHelperCall(call)) {
    return call.filename !== undefined;
  }
  if (isAgentMessageHelperCall(call)) {
    return call.to !== undefined || call.body !== undefined;
  }
  if (isAgentRosterHelperCall(call)) {
    return call.role !== undefined || call.surface !== undefined;
  }
  if (isAgentTaskStatusHelperCall(call)) {
    return call.messageId !== undefined || call.taskId !== undefined;
  }
  return Boolean(call?.cmd);
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

function isShellOutputText(text) {
  const lower = String(text || "").toLowerCase();
  return lower.includes("shell call result:") ||
    lower.includes("shell call failed:") ||
    lower.includes("shell call rejected:") ||
    lower.includes("```shell-output") ||
    lower.includes("shell-output");
}

function isShellOutputCandidate(candidate) {
  return candidate?.insideShellOutput === true;
}

function isRenderedShellOutputRoot(root) {
  if (!(root instanceof Element)) {
    return false;
  }
  const selector = [
    "code.language-shell-output",
    'code[class*="language-shell-output"]',
    "pre.language-shell-output",
    'pre[class*="language-shell-output"]',
    '[data-language="shell-output"]',
    '[data-code-language="shell-output"]'
  ].join(",");
  if (root.matches?.(selector) || root.closest?.(selector)) {
    return true;
  }
  const language = [
    root.getAttribute?.("data-language") || "",
    root.getAttribute?.("data-code-language") || "",
    root.getAttribute?.("class") || root.className || ""
  ].join(" ").toLowerCase();
  return language.includes("shell-output");
}

function isHelperLineInsideShellOutput(text, helperStartLine) {
  const lines = splitShellCallLines(text);
  const stopAt = Number.isInteger(helperStartLine) ? helperStartLine : -1;
  if (stopAt < 0) {
    return false;
  }
  let inside = false;
  let shellOutputFence = "";
  for (let index = 0; index <= stopAt && index < lines.length; index += 1) {
    const line = String(lines[index] || "").trim().toLowerCase();
    const opening = line.match(/^(`{3,})shell-output(?:\s.*)?$/);
    if (!inside && opening) {
      inside = true;
      shellOutputFence = opening[1];
      continue;
    }
    if (inside && line === shellOutputFence) {
      inside = false;
      shellOutputFence = "";
    }
  }
  return inside;
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
  if (isAgentMessageHelperCall(call)) {
    return validateAgentMessageCall(call);
  }
  if (isAgentRosterHelperCall(call)) {
    return validateAgentRosterCall(call);
  }
  if (isAgentTaskStatusHelperCall(call)) {
    return validateAgentTaskStatusCall(call);
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
  const boardName = normalizeCommand(call.boardName || "");
  if (boardName && !/^board-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(boardName)) {
    return { ok: false, reason: `Board window name must be board-<suffix>, where suffix matches ${BOARD_NAME_SUFFIX_PATTERN.source}.` };
  }
  if (!cmd) {
    return { ok: false, reason: "Board command is empty." };
  }

  const lines = cmd.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length !== 1) {
    return { ok: false, reason: "Board helper body must contain exactly one command line." };
  }

  return validateShellLikeCommandText(cmd);
}

function validateAgentMessageCall(call) {
  if (call?.agentHeaderError) {
    return { ok: false, reason: call.agentHeaderError };
  }
  const to = normalizeCommand(call.to || "");
  if (!to) {
    return { ok: false, reason: "Agent message is missing a to header." };
  }
  if (!AGENT_MESSAGE_ID_PATTERN.test(to)) {
    return { ok: false, reason: "Agent message to header must be a safe agent id." };
  }
  const taskId = normalizeCommand(call.taskId || "");
  if (taskId && !AGENT_TASK_ID_PATTERN.test(taskId)) {
    return { ok: false, reason: "Agent message task-id must be a safe id without spaces." };
  }
  const replyTo = normalizeCommand(call.replyTo || "");
  if (replyTo && !AGENT_MESSAGE_ID_PATTERN.test(replyTo)) {
    return { ok: false, reason: "Agent message reply-to must be a safe message id." };
  }
  const body = String(call.body || "");
  if (!body.trim()) {
    return { ok: false, reason: "Agent message body is empty." };
  }
  if (body.length > 20000) {
    return { ok: false, reason: "Agent message body is too large." };
  }
  return { ok: true };
}

function validateAgentRosterCall(call) {
  if (call?.agentHeaderError) {
    return { ok: false, reason: call.agentHeaderError };
  }
  const role = normalizeCommand(call.role || "");
  if (role && !["master", "slave"].includes(role)) {
    return { ok: false, reason: "Agent roster role filter must be master or slave." };
  }
  const surface = normalizeCommand(call.surface || "");
  if (surface && !["web", "tmux-ai"].includes(surface)) {
    return { ok: false, reason: "Agent roster surface filter must be web or tmux-ai." };
  }
  return { ok: true };
}

function validateAgentTaskStatusCall(call) {
  if (call?.agentHeaderError) {
    return { ok: false, reason: call.agentHeaderError };
  }
  const messageId = normalizeCommand(call.messageId || "");
  const taskId = normalizeCommand(call.taskId || "");
  if (!messageId && !taskId) {
    return { ok: false, reason: "Agent task status requires message-id or task-id." };
  }
  if (messageId && !AGENT_TASK_ID_PATTERN.test(messageId)) {
    return { ok: false, reason: "Agent task status message-id must be a safe id without spaces." };
  }
  if (taskId && !AGENT_TASK_ID_PATTERN.test(taskId)) {
    return { ok: false, reason: "Agent task status task-id must be a safe id without spaces." };
  }
  return { ok: true };
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
    /^ai-helper-board-[A-Za-z0-9][A-Za-z0-9._-]{0,63}-end$/.test(line) ||
    isHelperEndForKind("agent-message", line) ||
    isHelperEndForKind("agent-roster", line) ||
    isHelperEndForKind("agent-task-status", line) ||
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
  const helperName = isFileHelperCall(call) ? "file helper" : isBoardHelperCall(call) ? "board helper" : isAgentMessageHelperCall(call) ? "agent message" : isAgentRosterHelperCall(call) ? "agent roster query" : isAgentTaskStatusHelperCall(call) ? "agent task status query" : "shell call";
  setStatus(`Rejected ${helperName}: ${reason}`, "error");
  const reply = [
    isFileHelperCall(call) ? "File helper rejected:" : isBoardHelperCall(call) ? "Board command rejected:" : isAgentMessageHelperCall(call) ? "Agent message rejected:" : isAgentRosterHelperCall(call) ? "Agent roster query rejected:" : isAgentTaskStatusHelperCall(call) ? "Agent task status query rejected:" : "Shell call rejected:",
    "",
    "```shell-output",
    formatRejectedCallSubject(call),
    `error: ${reason}`,
    "```"
  ].join("\n");
  const settings = await chrome.storage.sync.get(["autoSend"]);
  const response = {
    ok: false,
    error: String(reason || "Helper rejected")
  };
  const callId = `rejected:${stableHash(`${getCurrentPageIdentity()}\n${reply}`)}`;
  const pending = await rememberPendingHelperDelivery(callId, call, response, reply, settings);
  return attemptPendingHelperDelivery(pending, settings);
}

function formatRejectedCallSubject(call) {
  if (isFileHelperCall(call)) {
    return `file: ${call.filename || ""}`;
  }
  if (isBoardHelperCall(call)) {
    return `${call.boardName || "board"}: ${call.cmd || ""}`;
  }
  if (isAgentMessageHelperCall(call)) {
    return `agent-message: ${call.to || ""}`;
  }
  if (isAgentRosterHelperCall(call)) {
    return "agent-roster";
  }
  if (isAgentTaskStatusHelperCall(call)) {
    return `agent-task-status: ${call.messageId || call.taskId || ""}`;
  }
  return `$ ${call.cmd || ""}`;
}

async function runAndReply(callId, call, options = {}) {
  if (!isRunnableHelperCall(call)) {
    return;
  }

  const force = options.force === true;
  const settings = await chrome.storage.sync.get(["requireApproval", "autoSend"]);
  if (!force && isPersistentResultHelperCall(call)) {
    await loadPendingHelperDeliveriesForCurrentPage();
    const pending = pendingHelperDeliveries.get(callId);
    if (pending) {
      const delivered = await attemptPendingHelperDelivery(pending, settings);
      return {
        retryable: false,
        pendingDelivery: !delivered,
        deliveryFailed: !delivered,
        response: pending.response
      };
    }
  }
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
        `Requested board: ${formatBoardApprovalTarget(call)}`,
        "",
        call.cmd,
        "",
        "Send this command to the requested board and post the output back to this chat?"
      ] : isAgentMessageHelperCall(call) ?
      [
        "AI requested an agent message.",
        "",
        `to: ${call.to || ""}`,
        call.taskId ? `task-id: ${call.taskId}` : "",
        "",
        call.body || "",
        "",
        "Send this message through the local agent hub and post the result back to this chat?"
      ] : isAgentRosterHelperCall(call) ?
      [
        "AI requested the local agent roster.",
        "",
        call.role ? `role: ${call.role}` : "role: all",
        call.surface ? `surface: ${call.surface}` : "surface: all",
        "",
        "Query online agents and post the roster back to this chat?"
      ] : isAgentTaskStatusHelperCall(call) ?
      [
        "AI requested an agent task status.",
        "",
        call.messageId ? `message-id: ${call.messageId}` : "",
        call.taskId ? `task-id: ${call.taskId}` : "",
        "",
        "Query task status and post the result back to this chat?"
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
      return { retryable: false, cancelled: true };
    }
  }

  refreshPageLifecycle();
  const callToken = {
    callId,
    pageIdentity: getCurrentPageIdentity(),
    generation: pageLifecycleGeneration,
    phase: "created"
  };
  activeCallId = callId;
  activeCallToken = callToken;
  chainCallCount += 1;
  setStatus(buildRunningStatus(call, force), "running");
  const startedAt = new Date().toISOString();
  // Remember which semantic call we attempted so the debug panel can correlate
  // the latest helper with the last submission. This is diagnostic only; the
  // shell server is the sole authority for command duplicate decisions.
  lastExecutedSemanticKey = buildSemanticCallKey(call);
  try {
    const response = isFileHelperCall(call) ?
      await sendWriteFileMessage(callId, call, force) :
      isBoardHelperCall(call) ?
      await sendRunBoardMessage(callId, call, force) :
      isAgentMessageHelperCall(call) ?
      await sendAgentMessage(callId, call, force) :
      isAgentRosterHelperCall(call) ?
      await sendAgentRosterQuery(callId, call, force) :
      isAgentTaskStatusHelperCall(call) ?
      await sendAgentTaskStatusQuery(callId, call, force) :
      await sendRunShellMessage(callId, call, force);
    callToken.phase = "response-received";

    if (!isCurrentCallToken(callToken)) {
      return { retryable: false, abandoned: true };
    }

    let effectiveResponse = response;
    let recoveredUnpresentedResult = false;
    // Duplicate metadata is backend execution-control state, never model
    // input. An already-presented result stays local-only. If presentation
    // never happened and bounded replay still exists, recover the original
    // result only after removing every duplicate-control field.
    if (isAuthoritativeDuplicateResponse(response)) {
      if (response.previousResultPresented === true ||
          hasLocallyPresentedHelperExecution(response.executionId) ||
          response.replayedOutput !== true) {
        setHelperCompletionStatus(call, response);
        releaseActiveCall(callToken);
        return {
          retryable: false,
          response,
          deliveryFailed: false,
          suppressedDuplicate: true,
          replayUnavailable: response.replayedOutput !== true
        };
      }
      effectiveResponse = cleanRecoveredDuplicateResponse(response);
      recoveredUnpresentedResult = true;
      setStatus("Recovering an original shell result that was never presented; duplicate diagnostics stay local", "running");
    }

    const reply = isFileHelperCall(call) ?
      formatFileOutput(call, effectiveResponse, startedAt) :
      isBoardHelperCall(call) ?
      formatBoardOutput(call, effectiveResponse, startedAt) :
      isAgentMessageHelperCall(call) ?
      formatAgentMessageOutput(call, effectiveResponse, startedAt) :
      isAgentRosterHelperCall(call) ?
      formatAgentRosterOutput(call, effectiveResponse, startedAt) :
      isAgentTaskStatusHelperCall(call) ?
      formatAgentTaskStatusOutput(call, effectiveResponse, startedAt) :
      formatShellOutput(call, effectiveResponse, startedAt);
    if (isPersistentResultHelperCall(call)) {
      const pending = await rememberPendingHelperDelivery(callId, call, effectiveResponse, reply, settings);
      releaseActiveCall(callToken);
      if (!isCallLifecycleCurrent(callToken)) {
        return { retryable: false, abandoned: true, pendingDelivery: true, response };
      }
      const delivered = await attemptPendingHelperDelivery(pending, settings);
      return {
        retryable: false,
        response: effectiveResponse,
        recoveredUnpresentedResult,
        pendingDelivery: !delivered,
        deliveryFailed: !delivered
      };
    }
    releaseActiveCall(callToken);
    const delivered = await deliverHelperReply(callToken, reply, settings, () => {
      setHelperCompletionStatus(call, response);
    });
    return {
      // A backend response must never be replayed merely because the page did
      // not confirm composer delivery. Side-effecting file/agent helpers would
      // otherwise execute repeatedly and keep rewriting the input.
      retryable: false,
      response,
      deliveryFailed: !delivered
    };
  } catch (error) {
    if (!isCallLifecycleCurrent(callToken)) {
      return { retryable: false, abandoned: true };
    }
    if (!isCurrentCallToken(callToken)) {
      return {
        retryable: false,
        error: error.message || String(error),
        deliveryFailed: true
      };
    }
    setStatus(`${isFileHelperCall(call) ? "File helper" : isBoardHelperCall(call) ? "Board helper" : isAgentMessageHelperCall(call) ? "Agent message" : isAgentRosterHelperCall(call) ? "Agent roster" : isAgentTaskStatusHelperCall(call) ? "Agent task status" : "Shell call"} failed: ${error.message || String(error)}`, "error");
    if (error?.helperSuppressReply === true) {
      releaseActiveCall(callToken);
      return {
        retryable: false,
        error: error.message || String(error),
        deliveryFailed: false,
        suppressedLocalFailure: true
      };
    }
    const failedResponse = {
      ok: false,
      error: error.message || String(error)
    };
    const failedReply = isFileHelperCall(call) ?
      formatFileOutput(call, failedResponse, startedAt) :
      isBoardHelperCall(call) ?
      formatBoardOutput(call, failedResponse, startedAt) :
      isAgentMessageHelperCall(call) ?
      formatAgentMessageOutput(call, failedResponse, startedAt) :
      isAgentRosterHelperCall(call) ?
      formatAgentRosterOutput(call, failedResponse, startedAt) :
      isAgentTaskStatusHelperCall(call) ?
      formatAgentTaskStatusOutput(call, failedResponse, startedAt) :
      formatShellOutput(call, failedResponse, startedAt);
    const pending = await rememberPendingHelperDelivery(
      callId,
      call,
      failedResponse,
      failedReply,
      settings
    );
    releaseActiveCall(callToken);
    const delivered = await attemptPendingHelperDelivery(pending, settings);
    return {
      // Backend errors are also plugin-owned output. Persist their local
      // delivery rather than rerunning the backend because a UI send attempt
      // was lost; a newly rendered helper remains eligible for fresh backend
      // adjudication.
      retryable: false,
      error: error.message || String(error),
      deliveryFailed: !delivered
    };
  } finally {
    releaseActiveCall(callToken);
  }
}

function isAuthoritativeDuplicateResponse(response) {
  return response?.duplicate === true && response?.skipped === true;
}

function cleanRecoveredDuplicateResponse(response) {
  const clean = { ...(response || {}) };
  for (const field of [
    "duplicate",
    "skipped",
    "replayedOutput",
    "reason",
    "previousCallKey",
    "previousCompletedAt",
    "previousInterrupted",
    "previousInterruptSignal",
    "previousResultPresented",
    "resultPresented"
  ]) {
    delete clean[field];
  }
  clean.recovered = true;
  return clean;
}

function isPersistentResultHelperCall(call) {
  return isRunnableHelperCall(call);
}

function isRetryableHelperResponse(call, response) {
  if (!response || typeof response !== "object") {
    return true;
  }
  if (response.executed === true && response.executionCompleted === true) {
    return false;
  }
  if (isBoardHelperCall(call)) {
    // Board prompt evidence is intentionally never duplicate authority, so
    // automatic retry after any dispatched board attempt is unsafe.
    return false;
  }
  if (response.ok === false) {
    return true;
  }
  if (!isFileHelperCall(call) &&
      !isBoardHelperCall(call) &&
      !isAgentMessageHelperCall(call) &&
      !isAgentRosterHelperCall(call) &&
      !isAgentTaskStatusHelperCall(call)) {
    return response.executed === false ||
      response.retryable === true ||
      response.executionCompleted === false;
  }
  return false;
}

async function deliverHelperReply(
  callToken,
  reply,
  settings,
  onInserted = () => {},
  onWriteAttempted = () => {}
) {
  return withComposerDeliveryLease({
    kind: "helper-output",
    pageIdentity: callToken.pageIdentity,
    generation: callToken.generation
  }, async (deliveryToken) => {
    if (!isComposerDeliveryTokenCurrent(deliveryToken)) {
      return false;
    }
    let composer;
    try {
      composer = await insertReply(reply, { preserveExisting: true });
    } catch (_unused) {
      return false;
    }
    callToken.composerWriteAttempted = true;
    callToken.phase = "reply-write-attempted";
    await onWriteAttempted(composer);
    if (!isComposerDeliveryTokenCurrent(deliveryToken)) {
      return false;
    }
    const ownership = await inspectCurrentComposerOwnership(composer, reply);
    if (ownership.state !== "owned") {
      return false;
    }
    composer = ownership.composer;
    const expectedComposerText = ownership.text;
    callToken.phase = "reply-inserted";
    await onInserted();
    if (!isComposerDeliveryTokenCurrent(deliveryToken)) {
      return false;
    }
    if (settings.autoSend !== false) {
      callToken.phase = "auto-send";
      const sent = await runOriginalSendActuatorForOwnedComposer(
        composer,
        () => isComposerDeliveryTokenCurrent(deliveryToken),
        expectedComposerText
      );
      callToken.phase = "auto-send-finished";
      if (!sent) {
        return false;
      }
    }
    return true;
  });
}

function isCurrentCallToken(callToken) {
  return activeCallToken === callToken &&
    activeCallId === callToken?.callId &&
    isCallLifecycleCurrent(callToken);
}

function isCallLifecycleCurrent(callToken) {
  return Boolean(callToken) &&
    pageLifecycleGeneration === callToken?.generation &&
    getCurrentPageIdentity() === callToken?.pageIdentity;
}

function releaseActiveCall(callToken) {
  if (activeCallToken !== callToken) {
    return;
  }
  activeCallId = "";
  activeCallToken = null;
}

function formatBoardApprovalTarget(call) {
  const boardName = normalizeCommand(call?.boardName || "board") || "board";
  return `${boardName} (AI_CHAT_SHELL_BOARD_TARGET may override this on the local server)`;
}

function buildRunningStatus(call, force) {
  if (isFileHelperCall(call)) {
    return `${force ? "Force writing" : "Writing"} file: ${summarizeCommand(call.filename || "")}`;
  }
  if (isBoardHelperCall(call)) {
    return `${force ? "Force sending" : "Sending"} ${call.boardName || "board"} command: ${summarizeCommand(call.cmd)}`;
  }
  if (isAgentMessageHelperCall(call)) {
    return `${force ? "Force sending" : "Sending"} agent message to ${call.to || "(missing)"}`;
  }
  if (isAgentRosterHelperCall(call)) {
    return `${force ? "Force querying" : "Querying"} agent roster`;
  }
  if (isAgentTaskStatusHelperCall(call)) {
    return `${force ? "Force querying" : "Querying"} agent task status`;
  }
  return `${force ? "Force running" : "Running"}: ${summarizeCommand(call.cmd)}`;
}

async function sendRunShellMessage(callId, call, force) {
  const profile = await getCurrentAgentProfile();
  const agentId = profile.agentId && profile.role !== "none" ? profile.agentId : "";
  const recoveryLifecycle = {
    pageIdentity: getCurrentPageIdentity(),
    generation: pageLifecycleGeneration
  };
  const payload = {
    type: "run-shell",
    id: callId,
    callKey: callId,
    agentId,
    cmd: call.cmd,
    cwd: call.cwd || "",
    callMeta: {
      origin: location.origin,
      pathname: location.pathname,
      promptHash: stableHash(getLastUserMessageText()),
      force
    }
  };
  try {
    const response = await chrome.runtime.sendMessage(payload);
    if (response?.ok === false && isRecoverableRuntimeChannelError(response.error)) {
      return recoverRunShellResult(callId, new Error(response.error || "Shell transport failed."), recoveryLifecycle);
    }
    return response;
  } catch (error) {
    if (!isRecoverableRuntimeChannelError(error)) {
      throw error;
    }
    return recoverRunShellResult(callId, error, recoveryLifecycle);
  }
}

function isRecoverableRuntimeChannelError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  const websocketTransportFailure = message.includes("websocket") && (
    message.includes("connect") ||
    message.includes("closed") ||
    message.includes("closing") ||
    message.includes("not open") ||
    message.includes("network") ||
    message.includes("failed to execute 'send'")
  );
  return message.includes("message port closed") ||
    message.includes("message channel closed") ||
    message.includes("extension context invalidated") ||
    message.includes("receiving end does not exist") ||
    message.includes("service worker") ||
    message.includes("shell server timed out") ||
    message.includes("cannot connect to shell server") ||
    message.includes("shell server closed the connection") ||
    websocketTransportFailure;
}

async function recoverRunShellResult(callKey, originalError, lifecycle = {}) {
  let notFoundCount = 0;
  let transportFailureCount = 0;

  while (true) {
    if (
      (lifecycle.pageIdentity && getCurrentPageIdentity() !== lifecycle.pageIdentity) ||
      (Number.isInteger(lifecycle.generation) && pageLifecycleGeneration !== lifecycle.generation)
    ) {
      throw createNonRetryableShellRecoveryError(
        "Shell result recovery stopped because the page lifecycle changed; the command was not resubmitted."
      );
    }
    let status;
    try {
      status = await chrome.runtime.sendMessage({
        type: "run-shell-status",
        id: `${callKey}:status`,
        callKey
      });
      transportFailureCount = 0;
    } catch (error) {
      transportFailureCount += 1;
      if (transportFailureCount >= RUN_STATUS_MAX_TRANSPORT_FAILURES) {
        throw createNonRetryableShellRecoveryError(
          `Shell result recovery failed after the runtime channel closed: ${error.message || String(error)}`
        );
      }
      await sleep(RUN_STATUS_POLL_INTERVAL_MS);
      continue;
    }

    if (!status?.ok) {
      transportFailureCount += 1;
      if (transportFailureCount >= RUN_STATUS_MAX_TRANSPORT_FAILURES) {
        throw createNonRetryableShellRecoveryError(
          `Shell result recovery failed after the runtime channel closed: ${status?.error || originalError?.message || "status unavailable"}`
        );
      }
      await sleep(RUN_STATUS_POLL_INTERVAL_MS);
      continue;
    }

    if (status.found !== true) {
      notFoundCount += 1;
      if (notFoundCount >= RUN_STATUS_MAX_NOT_FOUND) {
        throw createNonRetryableShellRecoveryError(
          `Shell result recovery could not find the original server attempt for ${callKey}; the command was not resubmitted.`
        );
      }
      await sleep(RUN_STATUS_POLL_INTERVAL_MS);
      continue;
    }

    notFoundCount = 0;
    if (status.state === "running") {
      await sleep(RUN_STATUS_POLL_INTERVAL_MS);
      continue;
    }
    if (status.state === "completed" && status.result && typeof status.result === "object") {
      return status.result;
    }

    throw createNonRetryableShellRecoveryError(
      status.error || `Shell server reported ${status.state || "unconfirmed"} for the original attempt; the command was not resubmitted.`
    );
  }
}

function createNonRetryableShellRecoveryError(message) {
  const error = new Error(message);
  error.helperRetryable = false;
  error.helperSuppressReply = true;
  return error;
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

async function sendRunBoardMessage(callId, call, force) {
  const recoveryLifecycle = {
    pageIdentity: getCurrentPageIdentity(),
    generation: pageLifecycleGeneration
  };
  const payload = {
    type: "run-board",
    id: callId,
    callKey: callId,
    boardName: call.boardName || "",
    cmd: call.cmd,
    timeoutMs: call.timeoutMs,
    maxOutputChars: call.maxOutputChars,
    callMeta: {
      origin: location.origin,
      pathname: location.pathname,
      promptHash: stableHash(getLastUserMessageText()),
      force
    }
  };
  try {
    const response = await chrome.runtime.sendMessage(payload);
    if (response?.ok === false && isRecoverableRuntimeChannelError(response.error)) {
      return recoverRunBoardResult(callId, new Error(response.error || "Board transport failed."), recoveryLifecycle);
    }
    return response;
  } catch (error) {
    if (!isRecoverableRuntimeChannelError(error)) {
      throw error;
    }
    return recoverRunBoardResult(callId, error, recoveryLifecycle);
  }
}

async function recoverRunBoardResult(callKey, originalError, lifecycle = {}) {
  let notFoundCount = 0;
  let transportFailureCount = 0;

  while (true) {
    if (
      (lifecycle.pageIdentity && getCurrentPageIdentity() !== lifecycle.pageIdentity) ||
      (Number.isInteger(lifecycle.generation) && pageLifecycleGeneration !== lifecycle.generation)
    ) {
      throw createNonRetryableBoardRecoveryError(
        "Board result recovery stopped because the page lifecycle changed; the board command was not resubmitted."
      );
    }
    let status;
    try {
      status = await chrome.runtime.sendMessage({
        type: "run-board-status",
        id: `${callKey}:status`,
        callKey
      });
      transportFailureCount = 0;
    } catch (error) {
      transportFailureCount += 1;
      if (transportFailureCount >= RUN_STATUS_MAX_TRANSPORT_FAILURES) {
        throw createNonRetryableBoardRecoveryError(
          `Board result recovery failed after the runtime channel closed: ${error.message || String(error)}`
        );
      }
      await sleep(RUN_STATUS_POLL_INTERVAL_MS);
      continue;
    }

    if (!status?.ok) {
      transportFailureCount += 1;
      if (transportFailureCount >= RUN_STATUS_MAX_TRANSPORT_FAILURES) {
        throw createNonRetryableBoardRecoveryError(
          `Board result recovery failed after the runtime channel closed: ${status?.error || originalError?.message || "status unavailable"}`
        );
      }
      await sleep(RUN_STATUS_POLL_INTERVAL_MS);
      continue;
    }

    if (status.found !== true) {
      notFoundCount += 1;
      if (notFoundCount >= RUN_STATUS_MAX_NOT_FOUND) {
        throw createNonRetryableBoardRecoveryError(
          `Board result recovery could not find the original server attempt for ${callKey}; the board command was not resubmitted.`
        );
      }
      await sleep(RUN_STATUS_POLL_INTERVAL_MS);
      continue;
    }

    notFoundCount = 0;
    if (status.state === "running") {
      await sleep(RUN_STATUS_POLL_INTERVAL_MS);
      continue;
    }
    if (status.state === "completed" && status.result && typeof status.result === "object") {
      return status.result;
    }

    throw createNonRetryableBoardRecoveryError(
      status.error || `Board server reported ${status.state || "unconfirmed"} for the original attempt; the board command was not resubmitted.`
    );
  }
}

function createNonRetryableBoardRecoveryError(message) {
  const error = new Error(message);
  error.helperRetryable = false;
  error.helperSuppressReply = true;
  return error;
}

async function sendAgentMessage(callId, call, force) {
  const profile = await getCurrentAgentProfile();
  if (!profile.agentId || !profile.role || profile.role === "none") {
    throw new Error("Current page is not configured as an agent. Set this tab to master or slave before sending agent messages.");
  }
  return chrome.runtime.sendMessage({
    type: "agent-send",
    id: callId,
    messageId: callId,
    from: profile.agentId,
    to: call.to,
    taskId: call.taskId || "",
    replyTo: call.replyTo || "",
    body: call.body || "",
    callMeta: {
      origin: location.origin,
      pathname: location.pathname,
      promptHash: stableHash(getLastUserMessageText()),
      force
    }
  });
}

async function sendAgentRosterQuery(_callId, call, _force) {
  const profile = await getCurrentAgentProfile();
  if (!profile.agentId || !profile.role || profile.role === "none") {
    throw new Error("Current page is not configured as an agent. Set this tab to master or slave before querying the agent roster.");
  }
  const response = await chrome.runtime.sendMessage({ type: "agent-list" });
  if (!response?.ok) {
    return response;
  }
  let agents = Array.isArray(response.agents) ? response.agents : [];
  const role = normalizeCommand(call.role || "");
  const surface = normalizeCommand(call.surface || "");
  if (role) {
    agents = agents.filter((agent) => agent.role === role);
  }
  if (surface) {
    agents = agents.filter((agent) => agent.surface === surface);
  }
  return {
    ...response,
    requester: profile,
    agents,
    filters: { role, surface }
  };
}

async function sendAgentTaskStatusQuery(_callId, call, _force) {
  const profile = await getCurrentAgentProfile();
  if (!profile.agentId || !profile.role || profile.role === "none") {
    throw new Error("Current page is not configured as an agent. Set this tab to master or slave before querying task status.");
  }
  return chrome.runtime.sendMessage({
    type: "agent-task-status",
    agentId: profile.agentId,
    messageId: call.messageId || "",
    taskId: call.taskId || ""
  });
}

async function getCurrentAgentProfile() {
  return readSessionAgentProfile();
}

async function getSavedAgentProfileDefaults() {
  const key = agentProfileKey();
  const profiles = await chrome.storage.local.get([key]);
  const profile = profiles[key] || {};
  return {
    role: normalizeCommand(profile.role || "none"),
    agentId: normalizeCommand(profile.agentId || "")
  };
}

async function setCurrentAgentProfile(role, agentId) {
  const previous = readSessionAgentProfile();
  const profile = {
    role: normalizeCommand(role || "none"),
    agentId: normalizeCommand(agentId || "")
  };
  if (previous.role !== profile.role || previous.agentId !== profile.agentId) {
    cancelAgentDeliveryLifecycle();
    clearPendingAgentDelivery();
    pendingAgentDeliveryLoaded = false;
  }
  try {
    window.sessionStorage.setItem(AGENT_SESSION_PROFILE_KEY, JSON.stringify(profile));
  } catch (_unused) {
    // Session storage is best effort; local storage still preserves a default.
  }
  await chrome.storage.local.set({
    [agentProfileKey()]: profile
  });
}

function getSuggestedAgentIdForRole(role) {
  const normalizedRole = normalizeCommand(role || "none");
  if (normalizedRole === "master") {
    return "master";
  }
  if (normalizedRole === "slave") {
    return `slave-${stableHash(`${location.origin}:${location.pathname}:${getAgentTabInstanceId()}`).slice(0, 8)}`;
  }
  return "";
}

function getAgentTabInstanceId() {
  try {
    const existing = window.sessionStorage.getItem(AGENT_SESSION_TAB_ID_KEY);
    if (existing) {
      return existing;
    }
    const entropy = globalThis.crypto?.randomUUID?.() || `${Date.now()}:${globalThis.performance?.now?.() || 0}`;
    const generated = stableHash(`${entropy}:${location.href || location.origin}`);
    window.sessionStorage.setItem(AGENT_SESSION_TAB_ID_KEY, generated);
    return generated;
  } catch (_unused) {
    return stableHash(`${location.origin}:${location.pathname}`);
  }
}

function readSessionAgentProfile() {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(AGENT_SESSION_PROFILE_KEY) || "{}");
    return {
      role: normalizeCommand(parsed.role || "none"),
      agentId: normalizeCommand(parsed.agentId || "")
    };
  } catch (_unused) {
    return {
      role: "none",
      agentId: ""
    };
  }
}

function agentProfileKey() {
  return `agentProfile:${location.origin}`;
}

function registerAgentProfile(profile) {
  return chrome.runtime.sendMessage({
    type: "agent-register",
    agentId: profile.agentId,
    role: profile.role,
    origin: location.origin,
    pathname: location.pathname
  });
}

function startAgentPolling() {
  stopAgentPolling();
  agentPollTimer = window.setTimeout(runAgentPollLoop, 500);
}

function stopAgentPolling() {
  if (agentPollTimer) {
    window.clearTimeout(agentPollTimer);
    agentPollTimer = 0;
  }
  cancelAgentDeliveryLifecycle();
}

async function runAgentPollLoop() {
  agentPollTimer = 0;
  try {
    await pollAndDeliverAgentMessage();
    consecutiveAgentPollFailures = 0;
  } catch (error) {
    consecutiveAgentPollFailures += 1;
    if (consecutiveAgentPollFailures >= 3) {
      setStatus(`Agent polling failing: ${summarizeCommand(error?.message || String(error))}. Click Agent Check for details.`, "error");
    }
  } finally {
    if (extensionActive) {
      agentPollTimer = window.setTimeout(runAgentPollLoop, AGENT_POLL_INTERVAL_MS);
    }
  }
}

async function pollAndDeliverAgentMessage() {
  // Agent polling can be the only active timer on a quiet SPA page. Refresh
  // the lifecycle before loading its route-scoped pending delivery so a
  // pushState/replaceState navigation cannot strand the one-write send retry.
  refreshPageLifecycle();
  const profile = await getCurrentAgentProfile();
  if (!profile.agentId || profile.role === "none") {
    return;
  }
  await loadPendingAgentDelivery(profile);
  if (agentDeliveryInFlight) {
    return;
  }
  if (activeCallId) {
    await registerAgentProfile(profile);
    return;
  }

  if (pendingAgentDelivery) {
    if (pendingAgentDelivery.profileAgentId === profile.agentId) {
      await deliverAgentMessageToPage(profile, pendingAgentDelivery.message);
      return;
    }
    await clearPendingAgentDelivery();
    setStatus(`Cleared pending agent delivery after profile changed to ${profile.agentId}`, "idle");
  }

  const response = await chrome.runtime.sendMessage({
    type: "agent-poll",
    agentId: profile.agentId,
    limit: 1
  });
  if (response?.registered === false) {
    await registerAgentProfile(profile);
    setStatus(`Re-registered ${profile.role} ${profile.agentId}`, "ok");
    return;
  }
  if (!response?.ok || !Array.isArray(response.messages) || response.messages.length === 0) {
    return;
  }

  const [message] = response.messages;
  if (!message?.messageId) {
    return;
  }

  await deliverAgentMessageToPage(profile, message);
}

async function deliverAgentMessageToPage(profile, message) {
  agentDeliveryGeneration += 1;
  const deliveryToken = {
    generation: agentDeliveryGeneration,
    messageId: message.messageId,
    profileAgentId: profile.agentId,
    pageIdentity: getCurrentPageIdentity(),
    pageGeneration: pageLifecycleGeneration
  };
  activeAgentDeliveryToken = deliveryToken;
  agentDeliveryInFlight = true;
  try {
    const pending = ensurePendingAgentDelivery(profile, message);
    if (pending.sent) {
      await ackSentPendingAgentMessage(profile, message, pending, deliveryToken);
      return;
    }
    if (countSubmittedMessagesMatching(pending.promptText || "") > 0) {
      if (!isAgentDeliveryTokenCurrent(deliveryToken)) {
        return;
      }
      pending.sent = true;
      pending.lastError = "";
      pending.updatedAt = Date.now();
      updatePendingAgentDeliveryPanel();
      persistPendingAgentDelivery();
      await ackSentPendingAgentMessage(profile, message, pending, deliveryToken);
      return;
    }
    if (pending.cancelled === true) {
      await ackCancelledPendingAgentMessage(profile, message, pending, deliveryToken);
      return;
    }
    const sentDuringComposerDelivery = await withComposerDeliveryLease({
      kind: "agent-message",
      pageIdentity: deliveryToken.pageIdentity,
      generation: deliveryToken.pageGeneration,
      agentToken: deliveryToken
    }, async (composerToken) => {
      if (!isComposerDeliveryTokenCurrent(composerToken)) {
        return;
      }
      const text = pending.promptText || formatInboundAgentPrompt(profile, message);
      const currentComposer = lastComposerElement || closestEditable(document.activeElement);
      if (pending.composerWriteAttempted === true) {
        const ownership = await inspectCurrentComposerOwnership(
          pending.composerElement || currentComposer,
          pending.composerText || text
        );
        if (ownership.state === "owned") {
          pending.composerElement = ownership.composer;
          pending.composerText = ownership.text;
        } else if (ownership.state === "unavailable") {
          pending.lastError = "composer temporarily unavailable after insertion; waiting without reinserting";
          pending.updatedAt = Date.now();
          updatePendingAgentDeliveryPanel();
          persistPendingAgentDelivery();
          return;
        } else {
          pending.cancelled = true;
          pending.inserted = false;
          pending.composerElement = null;
          pending.composerConflict = false;
          pending.lastError = "composer content was removed or changed by the user; automatic reinsertion cancelled";
          pending.updatedAt = Date.now();
          updatePendingAgentDeliveryPanel();
          persistPendingAgentDelivery();
          return;
        }
      }
      if (pending.composerConflict === true) {
        if (getComposerText(currentComposer)) {
          pending.lastError = "composer text changed; waiting for it to become empty";
          pending.updatedAt = Date.now();
          updatePendingAgentDeliveryPanel();
          persistPendingAgentDelivery();
          return;
        }
        pending.composerConflict = false;
      }
      if (!pending.inserted) {
        if (pending.composerWriteAttempted === true) {
          pending.cancelled = true;
          pending.lastError = "composer delivery was already attempted; automatic reinsertion cancelled";
          pending.updatedAt = Date.now();
          updatePendingAgentDeliveryPanel();
          persistPendingAgentDelivery();
          return;
        }
        setStatus(`Delivering agent message from ${message.from || "(unknown)"}`, "running");
        try {
          const insertedComposer = await insertReply(text, { preserveExisting: true });
          if (!isComposerDeliveryTokenCurrent(composerToken)) {
            return;
          }
          pending.composerWriteAttempted = true;
          pending.composerElement = insertedComposer;
          pending.updatedAt = Date.now();
          persistPendingAgentDelivery();
          const expectedComposerText = getValidatedComposerOwnershipText(insertedComposer, text);
          if (!expectedComposerText) {
            pending.inserted = false;
            pending.composerText = "";
            pending.composerElement = null;
            pending.composerConflict = false;
            pending.cancelled = true;
            pending.lastError = "composer did not retain the intended agent prompt; automatic delivery cancelled without reinserting or sending";
            pending.updatedAt = Date.now();
            updatePendingAgentDeliveryPanel();
            persistPendingAgentDelivery();
            return;
          }
          pending.inserted = true;
          pending.composerText = expectedComposerText;
          pending.composerConflict = false;
          pending.lastError = "";
          pending.updatedAt = Date.now();
          updatePendingAgentDeliveryPanel();
          persistPendingAgentDelivery();
        } catch (error) {
          if (!isComposerDeliveryTokenCurrent(composerToken)) {
            return;
          }
          if (error?.code === "composer-occupied") {
            pending.inserted = false;
            pending.composerText = "";
            pending.composerConflict = true;
          }
          pending.lastError = error.message || String(error);
          pending.updatedAt = Date.now();
          setStatus(`Agent message ${message.messageId} cached; waiting for chat composer`, "running");
          updatePendingAgentDeliveryPanel();
          persistPendingAgentDelivery();
          return;
        }
      } else {
        setStatus(`Agent message ${message.messageId} is waiting for send button`, "running");
      }
      const expectedComposerText = pending.composerText || normalizeCommand(text);
      const ownership = await inspectCurrentComposerOwnership(
        pending.composerElement || lastComposerElement || closestEditable(document.activeElement),
        expectedComposerText
      );
      if (ownership.state !== "owned") {
        if (ownership.state === "changed") {
          pending.inserted = false;
          pending.composerElement = null;
          pending.composerConflict = false;
          pending.cancelled = true;
          pending.lastError = "composer content was removed or changed by the user; automatic delivery cancelled";
        } else {
          pending.lastError = "composer temporarily unavailable; waiting without reinserting";
        }
        pending.updatedAt = Date.now();
        updatePendingAgentDeliveryPanel();
        persistPendingAgentDelivery();
        return;
      }
      const composer = ownership.composer;
      pending.composerElement = composer;
      pending.composerText = ownership.text;
      if (pending.sendActuatorGeneration === pageLifecycleGeneration) {
        pending.lastError = "the original v0.8.9 send attempt finished; waiting for manual send without repeating send actions";
        pending.updatedAt = Date.now();
        updatePendingAgentDeliveryPanel();
        persistPendingAgentDelivery();
        return;
      }
      pending.sendActuatorGeneration = pageLifecycleGeneration;
      pending.updatedAt = Date.now();
      persistPendingAgentDelivery();
      const sent = await runOriginalSendActuatorForOwnedComposer(
        composer,
        () => isComposerDeliveryTokenCurrent(composerToken),
        expectedComposerText
      );
      if (!isComposerDeliveryTokenCurrent(composerToken)) {
        return;
      }
      if (!sent) {
        if (countSubmittedMessagesMatching(pending.promptText || "") > 0) {
          pending.sent = true;
          pending.lastError = "";
          pending.updatedAt = Date.now();
          updatePendingAgentDeliveryPanel();
          persistPendingAgentDelivery();
          return true;
        }
        const currentText = getComposerText(composer);
        if (currentText !== expectedComposerText) {
          pending.inserted = false;
          pending.composerElement = null;
          pending.composerConflict = false;
          pending.cancelled = true;
          pending.lastError = "composer content was removed or changed by the user; automatic delivery cancelled";
        } else {
          pending.lastError = "send button not ready";
        }
        pending.updatedAt = Date.now();
        setStatus("Agent message cached in panel; waiting for AI page to be ready", "running");
        updatePendingAgentDeliveryPanel();
        persistPendingAgentDelivery();
        return;
      }
      pending.sent = true;
      pending.lastError = "";
      pending.updatedAt = Date.now();
      updatePendingAgentDeliveryPanel();
      persistPendingAgentDelivery();
      return true;
    });
    if (sentDuringComposerDelivery === true && isAgentDeliveryTokenCurrent(deliveryToken)) {
      await ackSentPendingAgentMessage(profile, message, pending, deliveryToken);
    } else if (pending.cancelled === true && isAgentDeliveryTokenCurrent(deliveryToken)) {
      await ackCancelledPendingAgentMessage(profile, message, pending, deliveryToken);
    }
  } finally {
    if (activeAgentDeliveryToken === deliveryToken) {
      activeAgentDeliveryToken = null;
      agentDeliveryInFlight = false;
    }
  }
}

function isAgentDeliveryTokenCurrent(token) {
  return activeAgentDeliveryToken === token &&
    agentDeliveryGeneration === token?.generation &&
    pageLifecycleGeneration === token?.pageGeneration &&
    getCurrentPageIdentity() === token?.pageIdentity;
}

async function ackSentPendingAgentMessage(profile, message, pending, deliveryToken) {
  const ack = await ackDeliveredAgentMessage(profile, message);
  if (!isAgentDeliveryTokenCurrent(deliveryToken) || pendingAgentDelivery !== pending) {
    return;
  }
  if (!ack?.ok) {
    if (pending.sent === true && ack?.errorCode === "message-not-found") {
      clearPendingAgentDelivery(pending);
      setStatus(`Delivered agent message ${message.messageId}; local hub no longer retained its ack record`, "ok");
      return;
    }
    pending.lastError = ack?.error || "ack failed";
    pending.updatedAt = Date.now();
    updatePendingAgentDeliveryPanel();
    persistPendingAgentDelivery();
    setStatus(`Agent message sent; waiting to ack local hub: ${summarizeCommand(ack?.error || "unknown")}`, "running");
    return;
  }
  clearPendingAgentDelivery(pending);
  setStatus(`Delivered agent message ${message.messageId}`, "ok");
}

async function ackCancelledPendingAgentMessage(profile, message, pending, deliveryToken) {
  const ack = await ackDeliveredAgentMessage(profile, message);
  if (!isAgentDeliveryTokenCurrent(deliveryToken) || pendingAgentDelivery !== pending) {
    return;
  }
  if (!ack?.ok && ack?.errorCode !== "message-not-found") {
    pending.lastError = `automatic composer delivery cancelled; waiting to ack local hub: ${ack?.error || "unknown"}`;
    pending.updatedAt = Date.now();
    updatePendingAgentDeliveryPanel();
    persistPendingAgentDelivery();
    setStatus(`Agent message ${message.messageId} composer delivery cancelled; retrying only local hub ack`, "running");
    return;
  }
  clearPendingAgentDelivery(pending);
  setStatus(`Cancelled agent message ${message.messageId} after its composer content was removed; it will not be inserted again.`, "ok");
}

function ensurePendingAgentDelivery(profile, message) {
  if (pendingAgentDelivery?.messageId === message.messageId) {
    pendingAgentDelivery.message = message;
    pendingAgentDelivery.updatedAt = Date.now();
    updatePendingAgentDeliveryPanel();
    persistPendingAgentDelivery();
    return pendingAgentDelivery;
  }

  pendingAgentDelivery = {
    messageId: message.messageId,
    profileAgentId: profile.agentId,
    message,
    promptText: formatInboundAgentPrompt(profile, message),
    composerText: "",
    composerElement: null,
    composerWriteAttempted: false,
    inserted: false,
    sent: false,
    cancelled: false,
    composerConflict: false,
    storageKey: agentPendingDeliveryKey(),
    pageIdentity: getCurrentPageIdentity(),
    pageGeneration: pageLifecycleGeneration,
    lastError: "",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  pendingAgentDeliveryMessageId = message.messageId;
  updatePendingAgentDeliveryPanel();
  persistPendingAgentDelivery();
  return pendingAgentDelivery;
}

function agentDeliveryPromptStillPresent(pending) {
  const composer = lastComposerElement || closestEditable(document.activeElement);
  if (!composer || !composer.isConnected || !isEditableElement(composer)) {
    return false;
  }
  return getComposerText(composer) === (pending.composerText || normalizeCommand(pending.promptText || ""));
}

function clearPendingAgentDelivery(expectedPending = null) {
  if (expectedPending && pendingAgentDelivery !== expectedPending) {
    return;
  }
  const storageKey = pendingAgentDelivery?.storageKey || agentPendingDeliveryKey();
  pendingAgentDelivery = null;
  pendingAgentDeliveryMessageId = "";
  updatePendingAgentDeliveryPanel();
  chrome.storage.local.remove([storageKey]).catch(() => {});
}

async function loadPendingAgentDelivery(profile) {
  if (pendingAgentDeliveryLoaded || pendingAgentDelivery) {
    pendingAgentDeliveryLoaded = true;
    return;
  }
  pendingAgentDeliveryLoaded = true;
  try {
    const stored = await chrome.storage.local.get([agentPendingDeliveryKey()]);
    const pending = stored?.[agentPendingDeliveryKey()];
    if (!isStoredPendingAgentDelivery(pending) || pending.profileAgentId !== profile.agentId) {
      return;
    }
    pendingAgentDelivery = {
      messageId: pending.messageId,
      profileAgentId: pending.profileAgentId,
      message: pending.message,
      promptText: pending.promptText || formatInboundAgentPrompt(profile, pending.message),
      composerText: pending.composerText || "",
      composerWriteAttempted: Boolean(pending.composerWriteAttempted || pending.inserted || pending.sent),
      inserted: Boolean(pending.inserted),
      sent: Boolean(pending.sent),
      cancelled: Boolean(pending.cancelled),
      composerConflict: Boolean(pending.composerConflict),
      storageKey: agentPendingDeliveryKey(),
      pageIdentity: getCurrentPageIdentity(),
      pageGeneration: pageLifecycleGeneration,
      lastError: pending.lastError || "restored after page reload",
      createdAt: Number(pending.createdAt) || Date.now(),
      updatedAt: Date.now()
    };
    pendingAgentDeliveryMessageId = pendingAgentDelivery.messageId;
    updatePendingAgentDeliveryPanel();
  } catch (_unused) {
    // Missing storage should not block live polling.
  }
}

function persistPendingAgentDelivery(options = {}) {
  if (!pendingAgentDelivery) {
    return Promise.resolve();
  }
  const snapshot = {
    messageId: pendingAgentDelivery.messageId,
    profileAgentId: pendingAgentDelivery.profileAgentId,
    message: pendingAgentDelivery.message,
    promptText: pendingAgentDelivery.promptText,
    composerText: pendingAgentDelivery.composerText || "",
    composerWriteAttempted: Boolean(pendingAgentDelivery.composerWriteAttempted),
    inserted: Boolean(pendingAgentDelivery.inserted),
    sent: Boolean(pendingAgentDelivery.sent),
    cancelled: Boolean(pendingAgentDelivery.cancelled),
    composerConflict: Boolean(pendingAgentDelivery.composerConflict),
    lastError: pendingAgentDelivery.lastError || "",
    createdAt: pendingAgentDelivery.createdAt || Date.now(),
    updatedAt: pendingAgentDelivery.updatedAt || Date.now()
  };
  const storageKey = pendingAgentDelivery.storageKey || agentPendingDeliveryKey();
  const operation = chrome.storage.local.set({ [storageKey]: snapshot });
  return options.propagateErrors === true ? operation : operation.catch(() => {});
}

function isStoredPendingAgentDelivery(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.messageId === "string" &&
    typeof value.profileAgentId === "string" &&
    value.message &&
    typeof value.message === "object" &&
    typeof value.message.messageId === "string"
  );
}

function agentPendingDeliveryKey() {
  return `${AGENT_PENDING_DELIVERY_PREFIX}${location.origin}:${location.pathname}`;
}

function updatePendingAgentDeliveryPanel() {
  const element = document.getElementById?.(PENDING_AGENT_DELIVERY_ID);
  if (!element) {
    return;
  }
  if (!pendingAgentDelivery) {
    element.hidden = true;
    element.textContent = "";
    return;
  }

  const message = pendingAgentDelivery.message || {};
  const from = message.from || "(unknown)";
  const task = message.taskId ? ` task ${message.taskId}` : "";
  const phase = pendingAgentDelivery.cancelled
    ? "composer delivery cancelled; waiting to ack local hub"
    : pendingAgentDelivery.sent
    ? "sent to AI page; waiting to ack local hub"
    : pendingAgentDelivery.inserted ? "waiting for AI page send readiness" : "waiting for chat composer";
  const nextAction = pendingAgentDelivery.cancelled
    ? "No reinsertion or send will happen; the extension will retry only the local cancellation ack."
    : pendingAgentDelivery.sent
    ? "No resend will happen; the extension will retry only the local ack."
    : pendingAgentDelivery.inserted
      ? pendingAgentDelivery.lastError === "send button not ready"
        ? "Keep this tab open. If this repeats, click Bind send and select the page send button, or click Clear and bind again."
        : "Keep this tab open until the page send button is ready."
      : "Click/focus the chat composer or wait for the page to finish loading.";
  const preview = summarizeCommand(message.body || "").slice(0, 180);
  const error = pendingAgentDelivery.lastError ? `\nLast issue: ${summarizeCommand(pendingAgentDelivery.lastError)}` : "";
  element.hidden = false;
  element.textContent = [
    `Pending agent message from ${from}${task}: ${phase}`,
    "Status: cached in this extension panel until the AI page is ready.",
    `Next: ${nextAction}`,
    error,
    preview ? `Preview: ${preview}` : ""
  ].filter(Boolean).join("\n");
}

function ackDeliveredAgentMessage(profile, message) {
  return chrome.runtime.sendMessage({
    type: "agent-ack",
    agentId: profile.agentId,
    messageId: message.messageId
  });
}

function formatInboundAgentPrompt(profile, message) {
  const from = message.from || "(unknown)";
  const task = message.taskId ? ` for task ${message.taskId}` : "";
  const body = String(message.body || "");
  if (profile.role === "slave") {
    return [
      `Message from ${from}${task}:`,
      "",
      body,
      "",
      `You are ${profile.agentId}. Complete the task in this chat. If you need local shell output, use the normal ai-helper-shell block. When finished, reply to ${from} with this exact helper format:`,
      "",
      "> ai-helper-agent-message-start",
      `> to: ${from}`,
      message.taskId ? `> task-id: ${message.taskId}` : "",
      `> reply-to: ${message.messageId}`,
      ">",
      "> <your result>",
      "> ai-helper-agent-message-end",
      "",
      "Remove the leading > quote markers when you send the final helper reply."
    ].join("\n");
  }

  return [
    `Message from ${from}${task}:`,
    `Message id: ${message.messageId}`,
    "",
    body
  ].join("\n");
}

function setHelperCompletionStatus(call, response) {
  if (isAuthoritativeDuplicateResponse(response)) {
    rememberSuppressedCallStatus(`server ${response.reason || "already-executed-on-target"}`);
    setStatus(
      isBoardHelperCall(call)
        ? `Server confirmed duplicate board command on ${response.targetName || response.target || "the resolved tmux pane"}`
        : `Server confirmed duplicate shell command on ${response.targetName || response.target || "the resolved tmux pane"}`,
      "ok"
    );
    return;
  }

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

  if (isAgentMessageHelperCall(call)) {
    setStatus(response?.ok === false ? "Agent message failed" : "Agent message sent", response?.ok === false ? "error" : "ok");
    return;
  }

  if (isAgentRosterHelperCall(call)) {
    setStatus(response?.ok === false ? "Agent roster query failed" : "Agent roster query completed", response?.ok === false ? "error" : "ok");
    return;
  }

  if (isAgentTaskStatusHelperCall(call)) {
    setStatus(response?.ok === false ? "Agent task status query failed" : "Agent task status query completed", response?.ok === false ? "error" : "ok");
    return;
  }

  if (response?.interrupted === true) {
    setStatus(
      response.interruptSignal === "INT"
        ? "Shell helper interrupted by Ctrl+C"
        : response.interruptSignal
          ? `Shell helper interrupted by SIG${response.interruptSignal}`
          : "Shell helper interrupted",
      "ok"
    );
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
  if (isAuthoritativeDuplicateResponse(response)) {
    return "";
  }
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
    response.executionId ? `executionId: ${response.executionId}` : "",
    `cwd: ${response.cwd || call.cwd || ""}`,
    `exitCode: ${response.exitCode}`,
    `durationMs: ${response.durationMs}`,
    response.duplicate === true ? "duplicate: true" : "",
    response.skipped === true ? "skipped: true" : "",
    response.replayedOutput === true ? "replayedOutput: true" : "",
    response.recovered === true ? "recovered: true" : "",
    response.reason ? `reason: ${response.reason}` : "",
    response.previousCallKey ? `previousCallKey: ${response.previousCallKey}` : "",
    response.previousInterrupted === true ? "previousInterrupted: true" : "",
    response.previousInterruptSignal ? `previousInterruptSignal: ${response.previousInterruptSignal}` : "",
    response.interrupted === true ? "interrupted: true" : "",
    response.interruptSignal ? `interruptSignal: ${response.interruptSignal}` : "",
    response.cancelledBeforeExecution === true ? "cancelledBeforeExecution: true" : "",
    response.retryable === true ? "retryable: true" : "",
    response.queued === true ? "queued: true" : "",
    Number.isFinite(response.queuedMs) ? `queuedMs: ${response.queuedMs}` : "",
    response.timedOut ? "timedOut: true" : "",
    response.completionMarkerMissing ? "completionMarkerMissing: true" : "",
    response.timeoutReason ? `timeoutReason: ${response.timeoutReason}` : "",
    response.processKnown === true ? "processKnown: true" : "",
    response.processKnown === false ? "processKnown: false" : "",
    response.processAlive === true ? "processAlive: true" : "",
    response.processAlive === false ? "processAlive: false" : "",
    response.continuedAfterTimeout ? "continuedAfterTimeout: true" : "",
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
  if (isAuthoritativeDuplicateResponse(response)) {
    return "";
  }
  const commandDisplay = formatShellOutputCommand(call.cmd);
  const boardName = call.boardName || response?.boardName || "";
  if (!response || response.ok === false) {
    return [
      "Board command failed:",
      "",
      "```shell-output",
      `board: ${commandDisplay.text}`,
      boardName ? `boardName: ${boardName}` : "",
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
    boardName ? `boardName: ${boardName}` : "",
    commandDisplay.truncated ? `cmdHash: ${commandDisplay.hash}` : "",
    `target: ${response.target || ""}`,
    response.targetName ? `targetName: ${response.targetName}` : "",
    response.executionId ? `executionId: ${response.executionId}` : "",
    `exitCode: ${response.exitCode}`,
    `durationMs: ${response.durationMs}`,
    response.duplicate === true ? "duplicate: true" : "",
    response.skipped === true ? "skipped: true" : "",
    response.reason ? `reason: ${response.reason}` : "",
    response.previousCallKey ? `previousCallKey: ${response.previousCallKey}` : "",
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

function formatAgentMessageOutput(call, response, startedAt) {
  if (!response || response.ok === false) {
    const aiNextAction = getAgentMessageAiNextAction(response);
    return [
      "Agent message failed:",
      "",
      "```shell-output",
      `agent-message: ${call.to || ""}`,
      call.taskId ? `task-id: ${call.taskId}` : "",
      `startedAt: ${startedAt}`,
      `error: ${response?.error || "Unknown agent hub error."}`,
      response?.hint ? `hint: ${response.hint}` : "",
      response?.nextAction ? `nextAction: ${response.nextAction}` : "",
      aiNextAction ? `aiNextAction: ${aiNextAction}` : "",
      "```"
    ].filter((line) => line !== "").join("\n");
  }

  const message = response.message || {};
  const delivery = response.delivery || {};
  return [
    "Agent message result:",
    "",
    "```shell-output",
    `from: ${message.from || ""}`,
    `to: ${message.to || call.to || ""}`,
    message.taskId || call.taskId ? `task-id: ${message.taskId || call.taskId}` : "",
    message.replyTo || call.replyTo ? `reply-to: ${message.replyTo || call.replyTo}` : "",
    `messageId: ${message.messageId || response.messageId || ""}`,
    delivery.surface ? `delivery: ${delivery.surface}` : "",
    delivery.replyBodyFile ? `replyBodyFile: ${delivery.replyBodyFile}` : "",
    delivery.replyScriptFile ? `replyScriptFile: ${delivery.replyScriptFile}` : "",
    delivery.replyCommand ? `replyCommand: ${delivery.replyCommand}` : "",
    delivery.nextStep ? `nextStep: ${delivery.nextStep}` : "",
    `statusMessageId: ${message.messageId || response.messageId || ""}`,
    "statusAction: Ask for an agent task-status query with this message id if progress needs checking.",
    `durationMs: ${response.durationMs || 0}`,
    "```"
  ].filter((line) => line !== "").join("\n");
}

function getAgentMessageAiNextAction(response) {
  const code = String(response?.errorCode || "");
  if (code === "recipient-not-registered") {
    return "Run ai-helper-agent-roster-start with role: slave, choose an online slave id, then resend with a new helper identity.";
  }
  if (code === "sender-not-registered") {
    return "Ask the user to save this page as master or slave, then rerun ai-helper-agent-roster-start.";
  }
  if (code === "duplicate-message-id") {
    return "Do not reuse this message. Resend only if needed with a new task-id and helper identity.";
  }
  if (code.includes("reply")) {
    return "Run ai-helper-agent-task-status-start with the original message-id or task-id, then preserve the current reply-to value before retrying.";
  }
  if (code === "tmux-target-unavailable" || code === "tmux-target-not-found") {
    return "Run ai-helper-agent-roster-start with surface: tmux-ai. If no tmux-ai slave is online, ask the user to re-register the pane.";
  }
  return "";
}

function formatAgentRosterOutput(call, response, startedAt) {
  if (!response || response.ok === false) {
    return [
      "Agent roster query failed:",
      "",
      "```shell-output",
      "agent-roster",
      call.role ? `role: ${call.role}` : "",
      call.surface ? `surface: ${call.surface}` : "",
      `startedAt: ${startedAt}`,
      `error: ${response?.error || "Unknown agent hub error."}`,
      response?.hint ? `hint: ${response.hint}` : "",
      response?.nextAction ? `nextAction: ${response.nextAction}` : "",
      `aiNextAction: ${getAgentTaskStatusAiNextAction(response)}`,
      "```"
    ].filter((line) => line !== "").join("\n");
  }

  const agents = Array.isArray(response.agents) ? response.agents : [];
  const receivableSlaves = agents.filter((agent) => agent.role === "slave" && agent.canReceiveTask !== false);
  return [
    "Agent roster result:",
    "",
    "```shell-output",
    "agent-roster",
    response.requester?.agentId ? `requester: ${response.requester.agentId}` : "",
    response.requester?.role ? `requesterRole: ${response.requester.role}` : "",
    call.role || response.filters?.role ? `filterRole: ${call.role || response.filters.role}` : "",
    call.surface || response.filters?.surface ? `filterSurface: ${call.surface || response.filters.surface}` : "",
    `count: ${agents.length}`,
    agents.length ? "\nagents:\n" + formatAgentsForShellOutput(agents) : "\nagents:\n(none)",
    receivableSlaves.length ? "nextAction: Send agent-message helpers to exact slave ids listed above with canReceiveTask=true." : "nextAction: No receivable slave agents are online. Ask the user to open/register a slave tab or refresh and re-register stale tmux-ai panes, then query roster again.",
    "```"
  ].filter((line) => line !== "").join("\n");
}

function getAgentTaskStatusAiNextAction(response) {
  const code = String(response?.errorCode || "");
  if (code === "task-not-found") {
    return "Check the latest agent-message result for messageId. If unavailable, query roster and delegate a new task with a new task-id.";
  }
  if (code === "sender-not-registered") {
    return "Ask the user to save this page as master or slave, then rerun the task-status helper.";
  }
  if (code === "missing-message-id") {
    return "Rerun ai-helper-agent-task-status-start with either message-id or task-id.";
  }
  return "Use the latest message-id from Agent message result, or query the roster and delegate a new task.";
}

function formatAgentsForShellOutput(agents) {
  return (Array.isArray(agents) ? agents : [])
    .map((agent) => {
      const parts = [
        `- ${agent.agentId || ""}`,
        `role=${agent.role || ""}`,
        `surface=${agent.surface || "web"}`,
        `replyMode=${agent.replyMode || ""}`,
        `pending=${Number(agent.pendingCount || 0)}`,
        `canReceiveTask=${agent.canReceiveTask === false ? "false" : agent.role === "slave" ? "true" : "false"}`,
        `lastSeenAgeMs=${Number(agent.lastSeenAgeMs || 0)}`
      ];
      if (agent.stale) {
        parts.push("stale=true");
      }
      if (agent.staleReason) {
        parts.push(`staleReason=${agent.staleReason}`);
      }
      if (Array.isArray(agent.capabilities) && agent.capabilities.length > 0) {
        parts.push(`capabilities=${agent.capabilities.join(",")}`);
      }
      if (agent.displayName && agent.displayName !== agent.agentId) {
        parts.push(`displayName=${agent.displayName}`);
      }
      if (agent.tmuxTargetName || agent.tmuxPaneId || agent.tmuxTarget) {
        parts.push(`tmux=${agent.tmuxTargetName || agent.tmuxPaneId || agent.tmuxTarget}`);
      }
      if (agent.origin) {
        parts.push(`origin=${agent.origin}`);
      }
      return parts.filter(Boolean).join(" ");
    })
    .join("\n");
}

function formatAgentTaskStatusOutput(call, response, startedAt) {
  if (!response || response.ok === false) {
    return [
      "Agent task status query failed:",
      "",
      "```shell-output",
      "agent-task-status",
      call.messageId ? `message-id: ${call.messageId}` : "",
      call.taskId ? `task-id: ${call.taskId}` : "",
      `startedAt: ${startedAt}`,
      `error: ${response?.error || "Unknown agent hub error."}`,
      response?.hint ? `hint: ${response.hint}` : "",
      response?.nextAction ? `nextAction: ${response.nextAction}` : "",
      "```"
    ].filter((line) => line !== "").join("\n");
  }

  const message = response.message || {};
  const replyMessage = response.replyMessage || {};
  return [
    "Agent task status result:",
    "",
    "```shell-output",
    "agent-task-status",
    `agentId: ${response.agentId || ""}`,
    `status: ${response.status || ""}`,
    `ageMs: ${response.ageMs || 0}`,
    `messageId: ${message.messageId || call.messageId || ""}`,
    message.taskId || call.taskId ? `task-id: ${message.taskId || call.taskId}` : "",
    message.from ? `from: ${message.from}` : "",
    message.to ? `to: ${message.to}` : "",
    message.deliverySurface ? `delivery: ${message.deliverySurface}` : "",
    message.replyMode ? `replyMode: ${message.replyMode}` : "",
    replyMessage.messageId ? `replyMessageId: ${replyMessage.messageId}` : "",
    response.nextAction ? `nextAction: ${response.nextAction}` : "",
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

async function insertReply(text, options = {}) {
  const input = await findReplyInput();
  if (!input) {
    throw new Error("Could not find a chat composer. Click the chat input once, then ask the AI for a helper block again.");
  }

  if (options.preserveExisting === true) {
    const currentText = getComposerText(input);
    if (currentText) {
      const reusableText = getValidatedComposerOwnershipText(input, text);
      if (reusableText) {
        return input;
      }
      const error = new Error("Chat composer already contains unsent text; automatic delivery paused without overwriting it.");
      error.code = "composer-occupied";
      throw error;
    }
  }

  rememberComposer(input);
  input.focus();

  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
    setNativeInputValue(input, text);
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertText",
      data: text
    }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return input;
  }

  setContentEditableText(input, text);
  return input;
}

function setNativeInputValue(input, text) {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (typeof nativeSetter === "function") {
    nativeSetter.call(input, text);
  } else {
    input.value = text;
  }
}

function setContentEditableText(input, text) {
  input.focus();
  if (insertContentEditableWithEditingCommand(input, text)) {
    return;
  }

  const selection = document.getSelection();
  selection?.removeAllRanges();
  if (selection) {
    const replacementRange = document.createRange();
    replacementRange.selectNodeContents(input);
    selection.addRange(replacementRange);
  }

  // Controlled editors need to observe the intended replacement while the
  // current selection still describes it. A synthetic beforeinput has no
  // browser default insertion, but editor frameworks may consume it into
  // their own state before the DOM fallback below is needed.
  input.dispatchEvent(new InputEvent("beforeinput", {
    bubbles: true,
    composed: true,
    cancelable: true,
    inputType: "insertText",
    data: text
  }));
  if (contentEditableHasText(input, text)) {
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertText",
      data: text
    }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  input.replaceChildren(...text.split("\n").map((line) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = line || "\u00a0";
    return paragraph;
  }));

  const range = document.createRange();
  range.selectNodeContents(input);
  range.collapse(false);
  selection?.addRange(range);

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

async function findReplyInput(options = {}) {
  if (options.fresh !== true &&
      lastComposerElement &&
      lastComposerElement.isConnected &&
      isEditableElement(lastComposerElement) &&
      isVisibleElement(lastComposerElement)) {
    return lastComposerElement;
  }

  if (options.fresh !== true) {
    const profile = await chrome.storage.local.get(composerProfileKey());
    const selector = profile[composerProfileKey()]?.selector;
    if (selector) {
      const saved = document.querySelector(selector);
      if (saved && isEditableElement(saved) && isVisibleElement(saved)) {
        lastComposerElement = saved;
        return saved;
      }
    }
  }

  const candidate = findCurrentReplyInputSynchronously();
  if (candidate) {
    lastComposerElement = candidate;
  }
  return candidate;
}

function getVisibleReplyInputCandidates() {
  const preferredSelectors = [
    '[contenteditable="true"][role="textbox"]',
    '[role="textbox"][contenteditable="true"]',
    '[role="textbox"]',
    "textarea",
    "input",
    '[contenteditable="true"]'
  ];

  return preferredSelectors
    .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
    .filter((node, index, all) => all.indexOf(node) === index)
    .filter(isEditableElement)
    .filter(isVisibleElement)
    .sort((a, b) => editableScore(b) - editableScore(a));
}

function findCurrentReplyInputSynchronously() {
  const active = closestEditable(document.activeElement);
  if (active && isVisibleElement(active)) {
    return active;
  }
  return getVisibleReplyInputCandidates()[0] || null;
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

function isOriginalSendActuatorGuardCurrent(guard) {
  if (!guard || activeOriginalSendActuatorGuard !== guard) {
    return false;
  }
  if (guard.sawTrustedComposerMutation) {
    return false;
  }
  if (typeof guard.shouldContinue === "function" && guard.shouldContinue() !== true) {
    return false;
  }
  if (guard.composer instanceof Element && (
    guard.composer.isConnected === false ||
    !isEditableElement(guard.composer) ||
    !isVisibleElement(guard.composer)
  )) {
    return false;
  }
  if (guard.composer instanceof Element) {
    if (lastComposerElement instanceof Element &&
        lastComposerElement !== guard.composer &&
        lastComposerElement.isConnected !== false &&
        isEditableElement(lastComposerElement) &&
        isVisibleElement(lastComposerElement)) {
      return false;
    }
    const currentComposer = findCurrentReplyInputSynchronously();
    if (currentComposer && currentComposer !== guard.composer) {
      return false;
    }
    const guardScore = editableScore(guard.composer);
    if (getVisibleReplyInputCandidates().some((candidate) =>
      candidate !== guard.composer &&
      isLikelyReplyComposerCandidate(candidate) &&
      getComposerText(candidate) &&
      (isStrongReplyComposerCandidate(candidate) || editableScore(candidate) >= guardScore)
    )) {
      return false;
    }
  }
  return Boolean(getValidatedComposerOwnershipText(guard.composer, guard.expectedText));
}

function isOriginalSendActuatorEventForComposer(event, composer) {
  const type = String(event?.type || "");
  const target = event?.target;
  if ((type === "keydown" || type === "keyup") && target === composer) {
    return true;
  }
  const form = composer?.closest?.("form") || composer?.form || null;
  if (type === "submit") {
    return target === form;
  }
  if (type !== "click") {
    return false;
  }
  if (event?.isTrusted === false) {
    return true;
  }
  const button = target?.closest?.("button, [role='button']") || target;
  if (!button) {
    return false;
  }
  if (button === findBoundSendButton()) {
    return true;
  }
  return Boolean(form && (button.form === form || form.contains?.(button)));
}

function isLikelyReplyComposerCandidate(node) {
  if (!(node instanceof Element) || isInsideShellToolPanel(node)) {
    return false;
  }
  if (isStrongReplyComposerCandidate(node)) {
    return true;
  }
  const tagName = String(node.tagName || "").toLowerCase();
  if (tagName !== "input" && tagName !== "textarea") {
    return false;
  }
  const hint = [
    node.getAttribute?.("aria-label"),
    node.getAttribute?.("placeholder"),
    node.getAttribute?.("name")
  ].filter(Boolean).join(" ").toLowerCase();
  if (tagName === "textarea") {
    return !["shell", "command", "search", "filter", "query", "code"].some((word) => hint.includes(word));
  }
  return false;
}

function isStrongReplyComposerCandidate(node) {
  if (!(node instanceof Element) || isInsideShellToolPanel(node)) {
    return false;
  }
  const role = String(node.getAttribute?.("role") || "").toLowerCase();
  const contentEditable = String(node.getAttribute?.("contenteditable") || "").toLowerCase();
  if (role === "textbox" || contentEditable === "true") {
    return true;
  }
  const hint = [
    node.getAttribute?.("aria-label"),
    node.getAttribute?.("placeholder"),
    node.getAttribute?.("name")
  ].filter(Boolean).join(" ").toLowerCase();
  return ["message", "ask", "reply", "chat", "prompt"].some((word) => hint.includes(word));
}

async function runOriginalSendActuatorForOwnedComposer(
  composer,
  shouldContinue,
  expectedText
) {
  const guard = {
    composer,
    expectedText: getValidatedComposerOwnershipText(composer, expectedText),
    shouldContinue,
    sawTrustedComposerMutation: false,
    submittedMessageCountBefore: countSubmittedMessagesMatching(expectedText)
  };
  if (!guard.expectedText) {
    return false;
  }
  if (typeof shouldContinue === "function" && shouldContinue() !== true) {
    return false;
  }
  if (activeOriginalSendActuatorGuard) {
    return false;
  }

  activeOriginalSendActuatorGuard = guard;
  const stopStaleSideEffect = (event) => {
    if (!isOriginalSendActuatorEventForComposer(event, guard.composer)) {
      return;
    }
    if (isOriginalSendActuatorGuardCurrent(guard)) {
      return;
    }
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
  };
  const noticeTrustedComposerMutation = (event) => {
    const mutatedComposer = closestEditable(event?.target);
    if (event?.isTrusted === true && (
      event.target === guard.composer ||
      (mutatedComposer && mutatedComposer !== guard.composer && isVisibleElement(mutatedComposer))
    )) {
      guard.sawTrustedComposerMutation = true;
    }
  };
  const captureTargets = new Set();
  const captureTypes = ["click", "submit", "keydown", "keyup"];
  const mutationTypes = ["beforeinput", "input", "change", "cut", "paste"];
  const attachCaptureTargets = (targetComposer) => {
    for (const target of [
      document,
      targetComposer,
      targetComposer?.closest?.("form, footer, main, body")
    ]) {
      if (!target || captureTargets.has(target) || typeof target.addEventListener !== "function") {
        continue;
      }
      captureTargets.add(target);
      for (const type of captureTypes) {
        target.addEventListener(type, stopStaleSideEffect, true);
      }
      for (const type of mutationTypes) {
        target.addEventListener(type, noticeTrustedComposerMutation, true);
      }
    }
  };
  attachCaptureTargets(composer);
  try {
    for (let handoff = 0; handoff < 2; handoff += 1) {
      let sent = false;
      try {
        sent = await clickSendWhenReady(guard.composer);
      } catch (error) {
        if (error !== ORIGINAL_SEND_ACTUATOR_CANCELLED) {
          throw error;
        }
      }
      if (countSubmittedMessagesMatching(guard.expectedText) > guard.submittedMessageCountBefore) {
        return true;
      }
      if (guard.sawTrustedComposerMutation) {
        return false;
      }
      const ownership = await inspectCurrentComposerOwnership(guard.composer, guard.expectedText);
      if (ownership.state === "owned" && ownership.composer !== guard.composer && handoff === 0) {
        guard.composer = ownership.composer;
        guard.expectedText = ownership.text;
        attachCaptureTargets(guard.composer);
        if (!isOriginalSendActuatorGuardCurrent(guard)) {
          return false;
        }
        continue;
      }
      if (ownership.state === "changed" && getComposerText(ownership.composer)) {
        return false;
      }
      return sent;
    }
    return false;
  } finally {
    for (const target of captureTargets) {
      for (const type of captureTypes) {
        target.removeEventListener(type, stopStaleSideEffect, true);
      }
      for (const type of mutationTypes) {
        target.removeEventListener(type, noticeTrustedComposerMutation, true);
      }
    }
    if (activeOriginalSendActuatorGuard === guard) {
      activeOriginalSendActuatorGuard = null;
    }
  }
}

function getComposerText(composer) {
  return normalizeCommand(composer?.innerText || composer?.value || composer?.textContent || "");
}

function getValidatedComposerOwnershipText(composer, intendedText) {
  const actual = getComposerText(composer);
  const intended = normalizeCommand(intendedText);
  if (!actual || !intended) {
    return "";
  }
  // Some contenteditable hosts vary only CRLFs, non-breaking spaces, and the
  // number of empty paragraph lines. Preserve every non-empty line boundary
  // and its internal whitespace: shell output formatting is semantic.
  return normalizeComposerOwnershipText(actual) === normalizeComposerOwnershipText(intended)
    ? actual
    : "";
}

async function inspectCurrentComposerOwnership(preferredComposer, intendedText) {
  const preferredUsable = preferredComposer?.isConnected !== false &&
    (!(preferredComposer instanceof Element) ||
      (isEditableElement(preferredComposer) && isVisibleElement(preferredComposer)));
  // Unit/integration harnesses may provide a non-DOM composer adapter. Real
  // page composers are Elements and always take the fresh-current proof below.
  if (preferredUsable && !(preferredComposer instanceof Element)) {
    const adapterText = getValidatedComposerOwnershipText(preferredComposer, intendedText);
    if (adapterText) {
      return {
        state: "owned",
        composer: preferredComposer,
        text: adapterText
      };
    }
  }
  if (preferredUsable && preferredComposer instanceof Element) {
    const preferredText = getValidatedComposerOwnershipText(preferredComposer, intendedText);
    if (preferredText && await isSavedComposerBindingFor(preferredComposer)) {
      return {
        state: "owned",
        composer: preferredComposer,
        text: preferredText
      };
    }
  }
  let currentComposer = null;
  try {
    // Ignore the cached node so a connected-but-hidden/stale composer cannot
    // remain send authority after a SPA swaps in its current editor.
    currentComposer = await findReplyInput({ fresh: true });
  } catch (_unused) {
    currentComposer = null;
  }
  if (preferredUsable && currentComposer === preferredComposer) {
    const preferredText = getValidatedComposerOwnershipText(preferredComposer, intendedText);
    if (preferredText) {
      return {
        state: "owned",
        composer: preferredComposer,
        text: preferredText
      };
    }
  }
  if (!currentComposer) {
    return {
      state: "unavailable",
      composer: null,
      text: ""
    };
  }
  const currentText = getValidatedComposerOwnershipText(currentComposer, intendedText);
  if (currentText) {
    return {
      state: "owned",
      composer: currentComposer,
      text: currentText
    };
  }
  return {
    state: "changed",
    composer: currentComposer,
    text: ""
  };
}

async function isSavedComposerBindingFor(composer) {
  if (!composer || !(composer instanceof Element)) {
    return false;
  }
  try {
    const profile = await chrome.storage.local.get(composerProfileKey());
    const selector = profile[composerProfileKey()]?.selector;
    if (!selector) {
      return false;
    }
    const saved = document.querySelector(selector);
    return saved === composer &&
      saved.isConnected !== false &&
      isEditableElement(saved) &&
      isVisibleElement(saved);
  } catch (_unused) {
    return false;
  }
}

function normalizeComposerOwnershipText(text) {
  return normalizeCommand(text)
    .replace(/\u00a0/g, " ")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .join("\n");
}

function composerOwnershipTextsMatch(actual, expected) {
  const normalizedActual = normalizeComposerOwnershipText(actual);
  const normalizedExpected = normalizeComposerOwnershipText(expected);
  return Boolean(normalizedActual) && normalizedActual === normalizedExpected;
}

function getComposerSendOwnership(composer, originalText, submittedMessageCountBefore, stillOwnsComposer) {
  if (countSubmittedMessagesMatching(originalText) > submittedMessageCountBefore) {
    return "done";
  }
  const currentText = getComposerText(composer);
  if (!currentText) {
    return "aborted";
  }
  if (!stillOwnsComposer()) {
    return "aborted";
  }
  return composerOwnershipTextsMatch(currentText, originalText) ? "owned" : "aborted";
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

function countSubmittedMessagesMatching(text) {
  const expected = normalizeCommand(text);
  if (!expected || typeof document.querySelectorAll !== "function") {
    return 0;
  }
  const comparableExpected = normalizeComposerOwnershipText(expected);
  return Array.from(document.querySelectorAll('[data-message-author-role="user"], [data-author-role="user"]'))
    .filter((node) => {
      const candidates = [node.innerText, node.textContent]
        .map((value) => normalizeCommand(value || ""))
        .filter(Boolean);
      const roleNode = node.querySelector?.('.role, [data-message-role-label], [class*="role"]');
      const roleText = normalizeCommand(roleNode?.textContent || roleNode?.innerText || "");
      if (roleText) {
        for (const candidate of [...candidates]) {
          if (candidate.startsWith(roleText)) {
            candidates.push(normalizeCommand(candidate.slice(roleText.length)));
          }
        }
      }
      return candidates.some((messageText) => {
        if (messageText === expected) {
          return true;
        }
        // Host renderers commonly collapse blank paragraphs after submission.
        // Compare the complete message after removing only an explicit role
        // label and normalizing CRLF, NBSP, and empty-paragraph count. Preserve
        // every non-empty line boundary and its internal whitespace: stdout is
        // semantic, so `a b` must never prove submission of `a\nb`.
        const lines = messageText.split("\n");
        if (/^(user|you)$/i.test(lines[0]?.trim() || "")) {
          lines.shift();
        }
        return normalizeComposerOwnershipText(lines.join("\n")) === comparableExpected;
      });
    })
    .length;
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
    { mode: "check", label: "Server Check" },
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

  const agentControls = document.createElement("div");
  agentControls.style.cssText = "display:grid;grid-template-columns:auto minmax(72px,1fr) auto auto auto;gap:4px;align-items:center;margin-top:6px";
  agentControls.innerHTML = [
    '<select data-shell-agent-role title="Agent role" style="border:0;border-radius:6px;padding:3px 4px;font:11px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#374151;color:#fff;">',
    '<option value="none">none</option>',
    '<option value="master">master</option>',
    '<option value="slave">slave</option>',
    '</select>',
    '<input data-shell-agent-id title="Agent id" placeholder="agentId" style="min-width:72px;border:0;border-radius:6px;padding:4px 6px;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f9fafb;color:#111827;">',
    '<button type="button" data-shell-tool-action="agent-register" title="Save this page agent role and register it with the local hub" style="border:0;border-radius:6px;padding:4px 6px;font:11px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#374151;color:#fff;cursor:pointer;">Save</button>',
    '<button type="button" data-shell-tool-action="agent-list" title="Show local agent roster and pending message counts" style="border:0;border-radius:6px;padding:4px 6px;font:11px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#374151;color:#fff;cursor:pointer;">Roster</button>',
    '<button type="button" data-shell-tool-action="agent-check" title="Explain whether master/slave/tmux-ai setup is ready" style="border:0;border-radius:6px;padding:4px 6px;font:11px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#374151;color:#fff;cursor:pointer;">Agent Check</button>'
  ].join("");
  panel.appendChild(agentControls);

  const tmuxAiControls = document.createElement("div");
  tmuxAiControls.style.cssText = "display:grid;grid-template-columns:minmax(78px,1fr) minmax(120px,1.5fr) auto auto;gap:4px;align-items:center;margin-top:6px";
  tmuxAiControls.innerHTML = [
    '<input data-shell-tmux-ai-id title="Tmux AI slave agent id" placeholder="slave-tmux" style="min-width:78px;border:0;border-radius:6px;padding:4px 6px;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f9fafb;color:#111827;">',
    '<select data-shell-tmux-ai-target title="Tmux AI target pane" style="min-width:120px;border:0;border-radius:6px;padding:4px 6px;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f9fafb;color:#111827;">',
    '<option value="">tmux target</option>',
    '</select>',
    '<button type="button" data-shell-tool-action="tmux-ai-refresh" title="Refresh available tmux panes for tmux-ai slaves" style="border:0;border-radius:6px;padding:4px 6px;font:11px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#374151;color:#fff;cursor:pointer;">Refresh</button>',
    '<button type="button" data-shell-tool-action="tmux-ai-register" title="Register this tmux pane as a slave managed by the local server" style="border:0;border-radius:6px;padding:4px 6px;font:11px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#374151;color:#fff;cursor:pointer;">Register</button>'
  ].join("");
  panel.appendChild(tmuxAiControls);

  const pendingAgentDeliveryPanel = document.createElement("div");
  pendingAgentDeliveryPanel.id = PENDING_AGENT_DELIVERY_ID;
  pendingAgentDeliveryPanel.hidden = true;
  pendingAgentDeliveryPanel.style.cssText = [
    "margin-top:6px",
    "padding:6px",
    "border-radius:6px",
    "background:#1f2937",
    "color:#dbeafe",
    "font:11px ui-monospace,SFMono-Regular,Menlo,monospace",
    "line-height:1.35",
    "white-space:pre-wrap",
    "word-break:break-word",
    "max-height:120px",
    "overflow:auto"
  ].join(";");
  panel.appendChild(pendingAgentDeliveryPanel);
  updatePendingAgentDeliveryPanel();

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

  panel.addEventListener("change", (event) => {
    if (event.target?.matches?.("[data-shell-agent-role]")) {
      applyAgentRoleSuggestion(event.target.value);
    }
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
  loadAgentControls().catch(() => {});
  refreshTmuxAiTargetOptions({ quiet: true }).catch(() => {});
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
  const activeSummary = `activeCall: ${activeCallId || "(none)"}${activeCallToken?.phase ? ` (${activeCallToken.phase})` : ""}`;

  if (!candidate && total === 0) {
    const lines = [summary, activeSummary, "(no helper block detected)"];
    if (lastSuppressedCallStatus) {
      lines.push(`lastSkippedReason: ${lastSuppressedCallStatus}`);
    }
    if (lastExecutedSemanticKey) {
      lines.push(`lastRunSemanticKey: ${lastExecutedSemanticKey}`);
    }
    body.textContent = lines.join("\n");
    return;
  }

  const lines = [summary, activeSummary];

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
      const cCmd = String(helperPreviewText(cCall) || "")
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
    const cmdPreview = String(helperPreviewText(call) || "").slice(0, 800);
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
  return message.startsWith("Server confirmed duplicate shell command") ||
    message.startsWith("Server confirmed duplicate board command");
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

  if (action === "agent-register") {
    registerCurrentPageAgent().catch((error) => {
      setStatus(`Agent register failed: ${summarizeCommand(error.message || String(error))}`, "error");
    });
    return;
  }

  if (action === "agent-list") {
    listRegisteredAgents().catch((error) => {
      setStatus(`Agent list failed: ${summarizeCommand(error.message || String(error))}`, "error");
    });
    return;
  }

  if (action === "agent-check") {
    runAgentSetupCheck().catch((error) => {
      setStatus(`Agent check failed: ${summarizeCommand(error.message || String(error))}`, "error");
    });
    return;
  }

  if (action === "tmux-ai-refresh") {
    refreshTmuxAiTargetOptions().catch((error) => {
      setStatus(`Tmux AI refresh failed: ${summarizeCommand(error.message || String(error))}`, "error");
    });
    return;
  }

  if (action === "tmux-ai-register") {
    registerTmuxAiSlaveFromPanel().catch((error) => {
      setStatus(`Tmux AI register failed: ${summarizeCommand(error.message || String(error))}`, "error");
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

async function loadAgentControls() {
  const activeProfile = await getCurrentAgentProfile();
  const profile = activeProfile.agentId || activeProfile.role !== "none"
    ? activeProfile
    : await getSavedAgentProfileDefaults();
  const role = document.querySelector(`#${STATUS_ID} [data-shell-agent-role]`);
  const agentId = document.querySelector(`#${STATUS_ID} [data-shell-agent-id]`);
  if (role) {
    role.value = profile.role || "none";
  }
  if (agentId) {
    agentId.value = profile.agentId || "";
  }
}

function applyAgentRoleSuggestion(role) {
  const agentIdElement = document.querySelector(`#${STATUS_ID} [data-shell-agent-id]`);
  if (!agentIdElement) {
    return;
  }
  const current = normalizeCommand(agentIdElement.value || "");
  if (current && !isDefaultSuggestedAgentId(current)) {
    return;
  }
  agentIdElement.value = getSuggestedAgentIdForRole(role);
}

function isDefaultSuggestedAgentId(value) {
  const text = normalizeCommand(value || "");
  return text === "master" || /^slave-[a-f0-9]{8}$/.test(text);
}

async function registerCurrentPageAgent() {
  const roleElement = document.querySelector(`#${STATUS_ID} [data-shell-agent-role]`);
  const agentIdElement = document.querySelector(`#${STATUS_ID} [data-shell-agent-id]`);
  const role = normalizeCommand(roleElement?.value || "none");
  const agentId = normalizeCommand(agentIdElement?.value || "");
  const currentProfile = await getCurrentAgentProfile();

  if (role === "none") {
    await setCurrentAgentProfile("none", "");
    startAgentPolling();
    const unregisterId = agentId || currentProfile.agentId || "";
    if (unregisterId) {
      await chrome.runtime.sendMessage({ type: "agent-unregister", agentId: unregisterId });
    }
    setStatus(`Agent mode disabled${unregisterId ? `; unregistered ${unregisterId}` : ""}`, "idle");
    return;
  }

  if (!["master", "slave"].includes(role)) {
    throw new Error("Role must be none, master, or slave.");
  }
  if (!AGENT_MESSAGE_ID_PATTERN.test(agentId)) {
    throw new Error("Agent id must be 1-64 safe characters and start with a letter or number.");
  }

  const response = await registerAgentProfile({ role, agentId });
  if (!response?.ok) {
    throw new Error(response?.error || "Agent hub registration failed.");
  }

  await setCurrentAgentProfile(role, agentId);
  startAgentPolling();
  const count = Array.isArray(response.agents) ? response.agents.length : 0;
  setStatus(`Registered ${role} ${agentId}; polling every ${AGENT_POLL_INTERVAL_MS / 1000}s; ${count} agent${count === 1 ? "" : "s"} online`, "ok");
}

async function listRegisteredAgents() {
  const response = await chrome.runtime.sendMessage({ type: "agent-list" });
  if (!response?.ok) {
    throw new Error(response?.error || "Agent list failed.");
  }
  const agents = Array.isArray(response.agents) ? response.agents : [];
  if (agents.length === 0) {
    setStatus("No agents registered", "idle");
    return;
  }
  const summary = formatAgentRosterSummary(agents, response.pending);
  setStatus(`Agents online: ${summary}`, "ok");
}

async function runAgentSetupCheck() {
  const profile = await getCurrentAgentProfile();
  const [agentList, tmuxList] = await Promise.all([
    chrome.runtime.sendMessage({ type: "agent-list" }).catch((error) => ({ ok: false, error: error.message || String(error) })),
    chrome.runtime.sendMessage({ type: "tmux-list" }).catch((error) => ({ ok: false, error: error.message || String(error) }))
  ]);
  const agents = Array.isArray(agentList?.agents) ? agentList.agents : [];
  const panes = Array.isArray(tmuxList?.panes) ? tmuxList.panes : Array.isArray(tmuxList?.tmuxPanes) ? tmuxList.tmuxPanes : [];
  const tmuxAiAgents = agents.filter((agent) => agent.surface === "tmux-ai");
  const webSlaves = agents.filter((agent) => agent.role === "slave" && agent.surface !== "tmux-ai");
  const tmuxAiReadyAgents = tmuxAiAgents.filter((agent) => isTmuxAiAgentPaneAvailable(agent, panes));
  const tmuxAiStaleAgents = tmuxAiAgents.filter((agent) => !isTmuxAiAgentPaneAvailable(agent, panes));
  const readySlaves = [
    ...webSlaves,
    ...tmuxAiReadyAgents
  ].filter((agent) => agent.canReceiveTask !== false);
  const parts = [
    `this tab: ${profile.role && profile.role !== "none" && profile.agentId ? `${profile.role} ${profile.agentId}` : "not saved as an agent"}`,
    `agents: ${agentList?.ok ? agents.length : `unavailable (${summarizeCommand(agentList?.error || "agent-list failed")})`}`,
    `tmux panes: ${tmuxList?.ok ? panes.length : `unavailable (${summarizeCommand(tmuxList?.error || "tmux-list failed")})`}`,
    `web slaves: ${webSlaves.length ? webSlaves.map((agent) => agent.agentId).join(", ") : "none"}`,
    `tmux-ai slaves: ${tmuxAiAgents.length ? tmuxAiAgents.map((agent) => `${agent.agentId}@${agent.tmuxTargetName || agent.tmuxPaneId || agent.tmuxTarget || "tmux"}${isTmuxAiAgentPaneAvailable(agent, panes) ? "" : " (stale)"}`).join(", ") : "none"}`
  ];

  let next = "Ready: use Roster or delegate an agent task to an online slave.";
  let state = "ok";
  if (!profile.agentId || profile.role === "none") {
    next = "Next: choose role master or slave, enter an agent id, then click Save.";
    state = "error";
  } else if (!agentList?.ok) {
    next = "Next: make sure the local shell server is running, then click Agent Check again.";
    state = "error";
  } else if (profile.role === "slave") {
    next = `Ready: ${profile.agentId} is registered and polling for master tasks. Keep this tab open.`;
  } else if (profile.role === "master" && readySlaves.length > 0) {
    next = `Ready: delegate to ${readySlaves.map((agent) => agent.agentId).join(", ")}. Tmux AI is optional.`;
  } else if (profile.role === "master" && tmuxAiStaleAgents.length > 0) {
    next = `Next: stale tmux-ai ${tmuxAiStaleAgents.map((agent) => agent.agentId).join(", ")} needs a live pane. Click Refresh, select the new tmux pane, then Register the same slave id again.`;
    state = "error";
  } else if (profile.role === "master") {
    next = "Next: open/register at least one slave tab, or register a tmux-ai slave from this master page.";
    state = "error";
  }

  setStatus(`Agent setup check: ${parts.join("; ")}. ${next}`, state);
  return {
    ok: state === "ok",
    profile,
    agents,
    panes,
    tmuxAiAgents,
    webSlaves,
    readySlaves,
    tmuxAiStaleAgents,
    next
  };
}

function formatAgentRosterSummary(agents, pending) {
  const pendingCounts = pending && typeof pending === "object" ? pending : {};
  return (Array.isArray(agents) ? agents : [])
    .map((agent) => {
      const count = Number(agent.pendingCount ?? pendingCounts[agent.agentId] ?? 0);
      const surface = agent.surface || "web";
      const receive = agent.canReceiveTask === false ? "no" : agent.role === "slave" ? "yes" : "no";
      const tmux = surface === "tmux-ai" ? ` tmux=${agent.tmuxTargetName || agent.tmuxPaneId || agent.tmuxTarget || "unknown"}` : "";
      return `${agent.agentId}:${agent.role}/${surface} receive=${receive}${count > 0 ? ` pending:${count}` : ""}${tmux}`;
    })
    .join(", ");
}

function isTmuxAiAgentPaneAvailable(agent, panes) {
  if (!agent || agent.surface !== "tmux-ai") {
    return true;
  }
  if (!Array.isArray(panes) || panes.length === 0) {
    return false;
  }
  return panes.some((pane) =>
    [pane.id, pane.address, pane.label, pane.windowName]
      .filter(Boolean)
      .some((value) => value === agent.tmuxPaneId ||
        value === agent.tmuxAddress ||
        value === agent.tmuxTarget ||
        value === agent.tmuxTargetName)
  );
}

async function refreshTmuxAiTargetOptions(options = {}) {
  const quiet = Boolean(options.quiet);
  const targetElement = document.querySelector(`#${STATUS_ID} [data-shell-tmux-ai-target]`);
  if (!targetElement) {
    return null;
  }
  if (!quiet) {
    setStatus("Refreshing tmux AI targets", "running");
  }
  const response = await chrome.runtime.sendMessage({ type: "tmux-list" });
  if (!response?.ok) {
    throw new Error(response?.error || "tmux-list failed.");
  }
  const panes = Array.isArray(response.panes) ? response.panes : Array.isArray(response.tmuxPanes) ? response.tmuxPanes : [];
  populateTmuxAiTargetOptions(targetElement, panes);
  if (!quiet) {
    setStatus(`Tmux AI targets: ${panes.length} pane${panes.length === 1 ? "" : "s"}`, panes.length ? "ok" : "idle");
  }
  return panes;
}

function populateTmuxAiTargetOptions(targetElement, panes) {
  const previousValue = String(targetElement.value || "");
  targetElement.textContent = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "tmux target";
  targetElement.appendChild(placeholder);

  for (const pane of Array.isArray(panes) ? panes : []) {
    const value = pane.address || pane.id || "";
    if (!value) {
      continue;
    }
    const option = document.createElement("option");
    option.value = value;
    option.textContent = `${value} ${pane.windowName || pane.currentCommand || ""}`.trim();
    option.title = [
      pane.id ? `pane ${pane.id}` : "",
      pane.currentCommand ? `command ${pane.currentCommand}` : "",
      pane.currentPath ? `cwd ${pane.currentPath}` : ""
    ].filter(Boolean).join("; ");
    targetElement.appendChild(option);
  }

  if (previousValue && Array.from(targetElement.options).some((option) => option.value === previousValue)) {
    targetElement.value = previousValue;
  }
}

async function registerTmuxAiSlaveFromPanel() {
  const agentIdElement = document.querySelector(`#${STATUS_ID} [data-shell-tmux-ai-id]`);
  const targetElement = document.querySelector(`#${STATUS_ID} [data-shell-tmux-ai-target]`);
  const agentId = normalizeCommand(agentIdElement?.value || "");
  let target = normalizeCommand(targetElement?.value || "");
  const profile = await getCurrentAgentProfile();

  if (profile.role !== "master" || !profile.agentId) {
    throw new Error("Tmux AI setup needs a master page first: choose role master, enter an agent id, then click Save.");
  }
  if (!AGENT_MESSAGE_ID_PATTERN.test(agentId)) {
    throw new Error("Tmux AI slave id is required. Use 1-64 letters, numbers, dots, underscores, or hyphens, starting with a letter or number.");
  }
  if (!target) {
    const panes = await refreshTmuxAiTargetOptions({ quiet: true });
    if (Array.isArray(panes) && panes.length === 1) {
      target = panes[0].address || panes[0].id || "";
      if (targetElement) {
        targetElement.value = target;
      }
    }
  }
  if (!target) {
    throw new Error("Choose a tmux target pane first. Click Refresh, then select the tmux window where the AI slave is already running.");
  }

  const response = await chrome.runtime.sendMessage({
    type: "agent-register-tmux-ai",
    agentId,
    role: "slave",
    target
  });
  if (!response?.ok) {
    throw new Error(response?.error || "tmux-ai registration failed.");
  }
  setStatus(`Registered tmux-ai slave ${agentId} at ${target}`, "ok");
  return response;
}

async function forceRunLatestShellCall() {
  pendingSelfTest = null;
  pendingForceRunRequested = true;
  setStatus("Checking latest helper block once", "running");
  await scanForShellCall({ force: true });
  lastSuppressedCallStatus = "";
  if (!pendingForceRunRequested) {
    setForceButtonHighlight(false);
  }
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
  const sent = await runOriginalSendActuatorForOwnedComposer(
    composer,
    () => extensionActive && getCurrentPageIdentity() === observedPageIdentity,
    getComposerText(composer)
  );
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
  if (activeOriginalSendActuatorGuard &&
      !isOriginalSendActuatorGuardCurrent(activeOriginalSendActuatorGuard)) {
    return Promise.reject(ORIGINAL_SEND_ACTUATOR_CANCELLED);
  }
  if (activeOriginalSendActuatorGuard) {
    const guard = activeOriginalSendActuatorGuard;
    return chrome.runtime.sendMessage({
      type: "content-ui-delay",
      delayMs: Math.max(0, Number(ms) || 0)
    }).then((response) => {
      if (response?.ok !== true) {
        throw new Error(response?.error || "background UI delay unavailable");
      }
    }).catch(() => new Promise((resolve) => setTimeout(resolve, ms)))
      .then(() => {
        if (!isOriginalSendActuatorGuardCurrent(guard)) {
          throw ORIGINAL_SEND_ACTUATOR_CANCELLED;
        }
      });
  }
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
