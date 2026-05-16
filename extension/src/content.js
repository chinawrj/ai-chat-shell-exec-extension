const TOOL_LANGS = new Set([
  "shell-call",
  "shell_call",
  "tool:shell",
  "tool-shell",
  "local-shell"
]);
const SHELL_LIKE_LANGS = new Set(["shell", "bash", "sh", "zsh"]);

const STATUS_ID = "chatgpt-shell-tool-status";
const CONTENT_SCRIPT_VERSION = "0.4.4";
const COMPOSER_PROFILE_PREFIX = "composerProfile:";
const processedCalls = new Set();
let scanTimer = 0;
let lastThreadText = "";
let lastThreadTextAt = Date.now();
let activeCallId = "";
let chainCallCount = 0;
let lastUserMessageText = "";
let lastDisabledStatusAt = 0;
let lastComposerElement = null;
let lastComposerSelector = "";

injectStatus();
observeThread();
observeComposerFocus();
scheduleScan();

function observeThread() {
  const observer = new MutationObserver(() => {
    scheduleScan();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function observeComposerFocus() {
  document.addEventListener("focusin", (event) => {
    rememberComposer(event.target);
  }, true);

  document.addEventListener("click", (event) => {
    rememberComposer(event.target);
  }, true);

  document.addEventListener("input", (event) => {
    rememberComposer(event.target);
  }, true);
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

function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    scanForShellCall().catch((error) => {
      setStatus(`Shell scanner error: ${summarizeCommand(error.message || String(error))}`, "error");
      scheduleScan();
    });
  }, 900);
}

async function scanForShellCall() {
  if (!isSupportedPage() || activeCallId || isAssistantGenerating()) {
    scheduleScan();
    return;
  }

  const settings = await chrome.storage.sync.get(["enabled", "maxChainCalls"]);
  if (settings.enabled === false) {
    const now = Date.now();
    if (now - lastDisabledStatusAt > 5000) {
      setStatus("Shell tool paused", "idle");
      lastDisabledStatusAt = now;
    }
    scheduleScan();
    return;
  }

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
    return;
  }

  const call = candidate.call;
  const callId = stableHash([
    location.origin,
    location.pathname,
    candidate.index,
    call.cmd,
    call.cwd || "",
    call.timeoutMs || ""
  ].join("\n"));
  if (processedCalls.has(callId)) {
    return;
  }

  const lastOutputText = getLastUserMessageText() || getLastShellOutputText();
  if (isShellOutputText(lastOutputText) && isSameCommandAsShellOutput(call.cmd, lastOutputText)) {
    processedCalls.add(callId);
    setStatus(`Ignored repeated shell call: ${summarizeCommand(call.cmd)}`, "error");
    return;
  }

  const validation = validateShellCall(call);
  if (!validation.ok) {
    processedCalls.add(callId);
    await replyWithRejectedCall(call, validation.reason);
    return;
  }

  const maxChainCalls = Number(settings.maxChainCalls || 5);
  if (chainCallCount >= maxChainCalls) {
    processedCalls.add(callId);
    await replyWithRejectedCall(call, `Chain limit reached (${maxChainCalls}). Ask the user before running more shell calls.`);
    return;
  }

  processedCalls.add(callId);
  await runAndReply(callId, call);
}

function isSupportedPage() {
  return location.protocol === "https:" && !location.hostname.endsWith(".google.com");
}

function getConversationRoot() {
  return document.querySelector("#thread") ||
    document.querySelector("main") ||
    document.querySelector('[role="main"]') ||
    document.body;
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
    .filter((candidate) => candidate.node === root || isVisibleElement(candidate.node));

  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

function extractShellCallCandidates(root) {
  let index = 0;
  const candidates = [];

  for (const pre of Array.from(root.querySelectorAll("pre"))) {
    if (closestEditable(pre) || !isVisibleElement(pre)) {
      continue;
    }

    const code = pre.querySelector("code") || pre;
    const cmdText = normalizeCommand(code.innerText || code.textContent || "");
    if (!cmdText) {
      continue;
    }

    const language = detectCodeLanguage(pre, code);
    if (TOOL_LANGS.has(language) || shouldTreatShellLikeCodeAsTool(language, pre)) {
      candidates.push({
        call: parseCallPayload(cmdText),
        node: closestMessageContainer(pre),
        index: index += 1,
        source: "rendered-code"
      });
    }
  }

  for (const block of extractLabeledCodeBlockCalls(root)) {
    candidates.push({
      ...block,
      index: index += 1,
      source: "labeled-code"
    });
  }

  for (const block of extractLanguageLabelSiblingCalls(root)) {
    candidates.push({
      ...block,
      index: index += 1,
      source: "language-label"
    });
  }

  for (const block of extractPlainTextLanguageSections(root)) {
    candidates.push({
      ...block,
      index: index += 1,
      source: "plain-text-language"
    });
  }

  for (const textRoot of getTextScanRoots(root)) {
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

  candidates.sort((a, b) => compareNodeOrder(a.node, b.node) || a.index - b.index);
  return candidates;
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
      if (!TOOL_LANGS.has(language) && !shouldTreatShellLikeCodeAsTool(language, label)) {
        return null;
      }

      const container = findLanguageLabelContainer(label, language);
      const command = extractCommandAfterLanguage(container, language);
      if (!command || command.length > 8000 || command.toLowerCase().includes("claude is ai and can make mistakes")) {
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
      if (lines.length < 2 || lines.length > 80) {
        return null;
      }

      let languageIndex = lines.findIndex((line, index) =>
        index < 4 &&
        (TOOL_LANGS.has(line.toLowerCase()) || SHELL_LIKE_LANGS.has(line.toLowerCase()))
      );
      let language = languageIndex >= 0 ? lines[languageIndex].toLowerCase() : inferCodeBlockLanguage(node);
      if (!language) {
        return null;
      }

      if (!TOOL_LANGS.has(language) && !shouldTreatShellLikeCodeAsTool(language, node)) {
        return null;
      }

      if (languageIndex < 0) {
        languageIndex = -1;
      }
      const command = trimCommandLines(lines.slice(languageIndex + 1)).join("\n");
      if (!command || command.toLowerCase().includes("claude is ai and can make mistakes")) {
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
    "write a message",
    "claude works directly with your codebase"
  ]);
  const commandLines = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (stopWords.has(lower) ||
      lower.startsWith("claude is ai") ||
      lower.startsWith("let claude edit files") ||
      lower.startsWith("model:") ||
      lower === "adaptive") {
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
    if (TOOL_LANGS.has(lang) || shouldTreatShellLikeCodeAsTool(lang, root)) {
      calls.push(parseCallPayload(match[2]));
    }
  }

  return calls;
}

function shouldTreatShellLikeCodeAsTool(language, node) {
  if (!SHELL_LIKE_LANGS.has(String(language || "").toLowerCase())) {
    return false;
  }

  const lastUserText = getLastUserMessageText().toLowerCase();
  const nearbyText = normalizeText(
    [
      node.previousElementSibling?.textContent || "",
      node.parentElement?.textContent?.slice(0, 400) || ""
    ].join(" ")
  ).toLowerCase();

  return containsToolLanguageHint(lastUserText) || containsToolLanguageHint(nearbyText);
}

function parseCallPayload(text) {
  const payload = normalizeCommand(text);
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === "object") {
      return {
        cmd: normalizeCommand(parsed.cmd || parsed.command || ""),
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

  const headings = Array.from(document.querySelectorAll("h1, h2, h3, [role='heading']"))
    .filter(isVisibleElement);
  const userHeading = headings.reverse().find((node) => normalizeText(node.textContent || "").toLowerCase().includes("you said"));
  if (userHeading) {
    const container = userHeading.closest("article, [role='article'], [data-testid], section, main > div, div");
    const text = normalizeCommand(container?.innerText || container?.textContent || "");
    if (text) {
      return text;
    }
  }

  const userish = Array.from(document.querySelectorAll("article, [role='article'], [data-testid], main > div"))
    .filter(isVisibleElement)
    .map((node) => normalizeCommand(node.innerText || node.textContent || ""))
    .filter((text) => text && (text.includes("Shell call result:") || text.includes("Shell call failed:") || text.includes("Shell call rejected:")));

  return userish.length > 0 ? userish[userish.length - 1] : "";
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
  const lines = normalizeCommand(text).split("\n");
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
      ...call
    });

    const reply = formatShellOutput(call, response, startedAt);
    await insertReply(reply);
    setStatus(response?.ok === false ? "Shell call failed" : "Shell call completed", response?.ok === false ? "error" : "ok");

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

function formatShellOutput(call, response, startedAt) {
  if (!response || response.ok === false) {
    return [
      "Shell call failed:",
      "",
      "```shell-output",
      `$ ${call.cmd}`,
      `startedAt: ${startedAt}`,
      `error: ${response?.error || "Unknown shell server error."}`,
      "```"
    ].join("\n");
  }

  const stdout = response.stdout || "";
  const stderr = response.stderr || "";
  const meta = [
    `$ ${call.cmd}`,
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
    return;
  }

  setContentEditableText(input, text);
}

function setContentEditableText(input, text) {
  input.focus();
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
    "#prompt-textarea",
    '[contenteditable="true"][role="textbox"]',
    '[role="textbox"][contenteditable="true"]',
    'textarea[placeholder*="Ask"]',
    'textarea[placeholder*="Message"]',
    'textarea[placeholder*="Reply"]',
    "textarea",
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

async function clickSendWhenReady() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const sendButton = findSendButton();
    if (sendButton && !sendButton.disabled && sendButton.getAttribute("aria-disabled") !== "true") {
      sendButton.click();
      return true;
    }
    await sleep(150);
  }

  setStatus("Shell output inserted; send button was not ready", "error");
  return false;
}

function findSendButton() {
  const composer = lastComposerElement || closestEditable(document.activeElement);
  const nearbyRoot = composer?.closest("form, footer, main, body") || document;
  const composerRect = composer?.getBoundingClientRect();
  const buttons = Array.from(nearbyRoot.querySelectorAll("button, [role='button']"))
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

function injectStatus() {
  if (document.getElementById(STATUS_ID)) {
    return;
  }

  const status = document.createElement("div");
  status.id = STATUS_ID;
  status.textContent = `Shell tool ready v${CONTENT_SCRIPT_VERSION}`;
  status.dataset.state = "idle";
  status.style.cssText = [
    "position:fixed",
    "right:16px",
    "bottom:16px",
    "z-index:2147483647",
    "max-width:360px",
    "padding:8px 10px",
    "border-radius:8px",
    "font:12px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
    "background:#111827",
    "color:#fff",
    "box-shadow:0 6px 24px rgba(0,0,0,.18)",
    "opacity:.88",
    "pointer-events:none"
  ].join(";");
  document.documentElement.appendChild(status);
}

function setStatus(text, state = "idle") {
  const status = document.getElementById(STATUS_ID);
  if (!status) {
    return;
  }

  status.textContent = text;
  status.dataset.state = state;
  const colors = {
    idle: "#111827",
    running: "#1d4ed8",
    ok: "#047857",
    error: "#b91c1c"
  };
  status.style.background = colors[state] || colors.idle;
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
