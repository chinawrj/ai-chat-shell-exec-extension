#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const HOST = "127.0.0.1";
const PORT = 17371;
const EXTENSION_ID = "lkmeogidbglhedgekjgbpbfjkpapnhke";
const ALLOWED_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_OUTPUT_CHARS = 20000;
const MAX_COMMAND_CHARS = 8000;
const ROOT_DIR = path.join(__dirname, "..");
const SERVER_PROTOCOL_VERSION = 2;
const HELPER_PROTOCOL_VERSION = 1;
const DEFAULT_STATE_DIR = getDefaultStateDir();
const STATE_DIR = resolveStateDir(process.env.AI_CHAT_SHELL_STATE_DIR || DEFAULT_STATE_DIR);
const TMUX_SCRIPT_DIR = path.join(STATE_DIR, "tmux-runs");
const BOARD_LOG_DIR = path.join(STATE_DIR, "board-panes");
const VISION_TMP_DIR = path.join(STATE_DIR, "vision");
const LEDGER_PATH = path.join(STATE_DIR, "shell-ledger.json");
const STATE_STDOUT_LOG_PATH = path.join(STATE_DIR, "shell-server.out.log");
const STATE_STDERR_LOG_PATH = path.join(STATE_DIR, "shell-server.err.log");
const STATE_REQUIRED_SUBDIRS = ["tmux-runs", "board-panes", "vision", "bin"];
const SERVER_LEDGER_LIMIT = 1000;
const RUNNING_LOCK_GRACE_MS = 15000;
const COMPLETED_DEDUP_TTL_MS = 60_000;
const SERVER_LEDGER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TMUX_FIELD_SEPARATOR = "__AI_CHAT_SHELL_FIELD__";
const TMUX_LIST_FORMAT = [
  "#{pane_id}",
  "#{session_name}",
  "#{window_index}",
  "#{window_name}",
  "#{pane_index}",
  "#{pane_active}",
  "#{pane_current_path}",
  "#{pane_current_command}"
].join(TMUX_FIELD_SEPARATOR);
const TMUX_CAPTURE_HISTORY_LINES = 20000;
const TMUX_POLL_INTERVAL_MS = 250;
const DEFAULT_TMUX_SESSION_NAME = "ForAI";
const DEFAULT_HOST_WINDOW_NAME = "host";
const DEFAULT_BOARD_WINDOW_NAME = "board";
const DEFAULT_BOARD_PROBE_IDLE_MS = 500;
const DEFAULT_BOARD_PROMPT_IDLE_MS = 200;
const DEFAULT_BOARD_POLL_MS = 100;
const HELPER_SHELL_START = "ai-helper-shell-start";
const HELPER_SHELL_END = "ai-helper-shell-end";
const HELPER_FILE_START = "ai-helper-file-start";
const HELPER_FILE_END = "ai-helper-file-end";
const HELPER_BOARD_START = "ai-helper-board-start";
const HELPER_BOARD_END = "ai-helper-board-end";
const UNSUPPORTED_HELPER_MARKERS = new Set(["ai-helper-start-shell", "ai-helper-end-shell"]);
const SHELL_RUNNER = process.env.AI_CHAT_SHELL_RUNNER || (fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh");
const ALLOW_UNTRUSTED_ORIGINS = process.env.AI_CHAT_SHELL_ALLOW_UNTRUSTED_ORIGINS === "1";
const DEFAULT_VISION_HELPER_PATH = path.join(STATE_DIR, "bin", "macos-vision-helper");
const VISION_INPUT_MAX_CHARS = 512;
const VISION_ALLOWED_KEYS = new Set(["enter", "tab", "escape", "backspace", "page-down", "page-up", "ctrl-c"]);
const VISION_TMUX_RUN_PREFIX = "AIVR";
const VISION_TMUX_OCR_RUN_PREFIX = "AIVRRUN";
const VISION_TMUX_OCR_DONE_PREFIX = "AIVRDONE";
let stateLoggingConfigured = false;
let stateLogStreams = null;
let serverLedger = loadServerLedger();

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(buildHealthResponse()));
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.on("upgrade", (req, socket) => {
  const origin = req.headers.origin || "";
  console.log(`[upgrade] url=${req.url} origin=${origin || "(none)"}`);

  if (req.url !== "/shell") {
    console.log("[upgrade] rejected: wrong path");
    socket.destroy();
    return;
  }

  if (origin !== ALLOWED_ORIGIN && !ALLOW_UNTRUSTED_ORIGINS) {
    console.log("[upgrade] rejected: origin not allowed");
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    console.log("[upgrade] rejected: missing websocket key");
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));

  let frameBuffer = Buffer.alloc(0);
  let requestInFlight = false;

  socket.on("data", (chunk) => {
    if (requestInFlight) {
      return;
    }

    try {
      frameBuffer = Buffer.concat([frameBuffer, chunk]);
      const decoded = decodeTextFrames(frameBuffer);
      frameBuffer = decoded.remaining;

      const [message] = decoded.messages;
      if (!message) {
        return;
      }

      requestInFlight = true;
      handleMessageText(message)
        .then((response) => {
          socket.write(encodeTextFrame(JSON.stringify(response)));
          socket.end();
        })
        .catch((error) => {
          console.error(`[error] ${error.message || String(error)}`);
          socket.write(encodeTextFrame(JSON.stringify({
            ok: false,
            error: error.message || String(error)
          })));
          socket.end();
        });
    } catch (error) {
      console.error(`[error] ${error.message || String(error)}`);
      socket.write(encodeTextFrame(JSON.stringify({
        ok: false,
        error: error.message || String(error)
      })));
      socket.end();
    }
  });
});

if (require.main === module) {
  startServer();
}

function startServer() {
  let state;
  try {
    state = ensureStateDirReady({ create: true });
  } catch (error) {
    console.error(error.message || String(error));
    process.exit(1);
    return;
  }
  configureStateLogging();

  server.listen(PORT, HOST, () => {
    console.log(`AI Chat Shell Exec server listening on ws://${HOST}:${PORT}/shell`);
    console.log(`Allowed origin: ${ALLOWED_ORIGIN}`);
    console.log(`State dir: ${state.stateDir}`);
    for (const repair of state.repairs || []) {
      console.log(`[state-repair] moved ${repair.path} to ${repair.backupPath}`);
    }
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use. Stop the existing shell server before starting another one.`);
    } else if (error.code === "EACCES" || error.code === "EPERM") {
      console.error(`Cannot listen on ${HOST}:${PORT}: ${error.message}`);
    } else {
      console.error(error);
    }
    process.exit(1);
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function shutdown() {
  console.log("AI Chat Shell Exec server stopping");
  if (stateLogStreams) {
    stateLogStreams.outStream.end();
    stateLogStreams.errStream.end();
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

function configureStateLogging() {
  if (
    stateLoggingConfigured ||
    process.env.AI_CHAT_SHELL_LOG_TO_STATE !== "1" ||
    process.env.AI_CHAT_SHELL_LOG_TO_STATE_REDIRECTED === "1"
  ) {
    return;
  }

  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  try {
    const out = prepareStateLogFile(STATE_STDOUT_LOG_PATH, { truncate: true });
    const err = prepareStateLogFile(STATE_STDERR_LOG_PATH, { truncate: true });
    const outStream = fs.createWriteStream(STATE_STDOUT_LOG_PATH, { flags: "a" });
    const errStream = fs.createWriteStream(STATE_STDERR_LOG_PATH, { flags: "a" });

    outStream.on("error", (error) => {
      originalError(`[state-log] stdout log write failed: ${error.message || String(error)}`);
    });
    errStream.on("error", (error) => {
      originalError(`[state-log] stderr log write failed: ${error.message || String(error)}`);
    });

    console.log = (...args) => {
      originalLog(...args);
      outStream.write(`${formatConsoleArgs(args)}\n`);
    };
    console.error = (...args) => {
      originalError(...args);
      errStream.write(`${formatConsoleArgs(args)}\n`);
    };

    stateLogStreams = { outStream, errStream };
    stateLoggingConfigured = true;

    for (const repair of [...out.repairs, ...err.repairs]) {
      console.error(`[state-repair] moved invalid state log path to ${repair.backupPath}`);
    }
  } catch (error) {
    originalError(`[state-log] could not enable state logs: ${error.message || String(error)}`);
  }
}

function prepareStateLogFile(logPath, { truncate = false } = {}) {
  const repairs = [];
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  if (fs.existsSync(logPath)) {
    const stat = fs.statSync(logPath);
    if (stat.isDirectory()) {
      repairs.push(movePathAside(logPath, "log-file"));
    } else {
      try {
        fs.accessSync(logPath, fs.constants.W_OK);
      } catch (_error) {
        repairs.push(movePathAside(logPath, "log-file"));
      }
    }
  }
  const fd = fs.openSync(logPath, "a");
  fs.closeSync(fd);
  if (truncate) {
    fs.truncateSync(logPath, 0);
  }
  return {
    path: logPath,
    repairs
  };
}

function formatConsoleArgs(args) {
  return args.map((arg) => {
    if (typeof arg === "string") {
      return arg;
    }
    if (arg instanceof Error) {
      return arg.stack || arg.message;
    }
    if (typeof arg === "object" && arg !== null) {
      try {
        return JSON.stringify(arg);
      } catch (_error) {
        return String(arg);
      }
    }
    return String(arg);
  }).join(" ");
}

function getReleaseVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "extension", "manifest.json"), "utf8"));
    return String(manifest.version || "");
  } catch (_error) {
    return "";
  }
}

function getProtocolMetadata() {
  const releaseVersion = getReleaseVersion();
  return {
    releaseVersion,
    serverReleaseVersion: releaseVersion,
    protocolVersion: SERVER_PROTOCOL_VERSION,
    serverProtocolVersion: SERVER_PROTOCOL_VERSION,
    helperProtocolVersion: HELPER_PROTOCOL_VERSION,
    helperProtocol: "ai-helper-plain-text",
    executionBackend: "tmux"
  };
}

function buildHealthResponse() {
  const forAiConfig = getForAiTmuxConfigForHealth();
  const state = getStateStatus({ create: true });
  return {
    ok: state.ok,
    error: state.error || "",
    service: "ai-chat-shell-exec-server",
    ...getProtocolMetadata(),
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    allowedOrigin: ALLOWED_ORIGIN,
    allowUntrustedOrigins: ALLOW_UNTRUSTED_ORIGINS,
    stateDir: state.stateDir,
    stateSource: state.source,
    stateOk: state.ok,
    stateError: state.error || "",
    stateRepaired: state.repaired === true,
    stateRepairs: state.repairs || [],
    tmuxSocket: getTmuxSocketPath() || null,
    tmuxDefaultSession: forAiConfig.sessionName,
    tmuxDefaultHostWindow: forAiConfig.hostWindowName,
    tmuxDefaultBoardWindow: forAiConfig.boardWindowName,
    tmuxDefaultCwd: forAiConfig.cwd,
    tmuxDefaultCwdSource: forAiConfig.cwdSource,
    tmuxDefaultCwdError: forAiConfig.cwdError || "",
    visionHelper: getVisionHelperPath(),
    visionAvailable: getVisionAvailability().available,
    ledgerEntries: Object.keys(serverLedger.calls || {}).length
  };
}

function withProtocolMetadata(response) {
  return {
    ...getProtocolMetadata(),
    ...response
  };
}

async function handleMessageText(text) {
  ensureStateDirReady({ create: true });
  const message = JSON.parse(text);
  if (!message || !message.type) {
    throw new Error("Unsupported message type.");
  }

  if (message.type === "tmux-list") {
    const layout = await ensureForAiTmuxLayout();
    return withProtocolMetadata({
      ok: true,
      ...layout
    });
  }

  if (message.type === "tmux-ensure") {
    return withProtocolMetadata(await ensureForAiTmuxLayout());
  }

  if (message.type === "tmux-reset-forai") {
    return withProtocolMetadata(await resetForAiTmuxLayout());
  }

  if (message.type === "write-file") {
    return handleWriteFileMessage(message);
  }

  if (message.type === "run-board") {
    return handleRunBoardMessage(message);
  }

  if (String(message.type).startsWith("vision-")) {
    return handleVisionMessage(message);
  }

  if (message.type !== "run") {
    throw new Error("Unsupported message type.");
  }

  const cmd = String(message.cmd || "").trim();
  if (!cmd) {
    throw new Error("Missing command.");
  }
  if (cmd.length > MAX_COMMAND_CHARS) {
    throw new Error(`Command is too long (${cmd.length} chars, max ${MAX_COMMAND_CHARS}).`);
  }

  validateCommand(cmd);

  const timeoutMs = clampNumber(message.timeoutMs, 1000, 10 * 60 * 1000, DEFAULT_TIMEOUT_MS);
  const maxOutputChars = clampNumber(message.maxOutputChars, 1000, 200000, DEFAULT_MAX_OUTPUT_CHARS);
  const layout = await ensureForAiTmuxLayout();
  const panes = layout.panes;
  const pane = resolveDefaultShellPane(panes).pane;
  if (!pane) {
    return buildDefaultTargetErrorResponse(message, cmd, panes);
  }

  const cwd = resolveCwd(message.cwd, pane.currentPath);
  const callKey = normalizeCallKey(message.callKey || message.id || hashText([
    pane.id,
    cmd,
    cwd,
    timeoutMs,
    maxOutputChars
  ].join("\n")));
  const started = Date.now();
  const force = message.callMeta?.force === true || message.force === true;
  const claim = claimServerShellCall(callKey, {
    cmd,
    cwd,
    target: pane.id,
    timeoutMs,
    maxOutputChars,
    seq: message.seq,
    callMeta: message.callMeta || {},
    force
  });
  if (claim.action === "skip") {
    console.log(`[skip] reason=${claim.reason} callKey=${callKey} cmd=${JSON.stringify(cmd)}`);
    return {
      ok: true,
      id: message.id,
      callKey,
      duplicate: true,
      skipped: true,
      reason: claim.reason,
      cmd,
      cwd,
      timeoutMs,
      durationMs: 0,
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false
    };
  }

  console.log(`[run] callKey=${callKey} seq=${message.seq || ""} target=${pane.id} cwd=${cwd} cmd=${JSON.stringify(cmd)}`);
  const result = await runTmuxShell({
    cmd,
    cwd,
    pane,
    timeoutMs,
    maxOutputChars
  });
  console.log(`[done] exitCode=${result.exitCode} durationMs=${Date.now() - started} timedOut=${result.timedOut}`);

  const response = {
    ok: true,
    id: message.id,
    callKey,
    cmd,
    cwd,
    target: pane.id,
    targetName: pane.label,
    timeoutMs,
    durationMs: Date.now() - started,
    ...result
  };
  completeServerShellCall(callKey, response);
  return response;
}

async function handleRunBoardMessage(message) {
  const cmd = String(message.cmd || "").trim();
  if (!cmd) {
    throw new Error("Missing board command.");
  }
  if (cmd.length > MAX_COMMAND_CHARS) {
    throw new Error(`Board command is too long (${cmd.length} chars, max ${MAX_COMMAND_CHARS}).`);
  }
  validateBoardCommand(cmd);

  const timeoutMs = clampNumber(message.timeoutMs, 1000, 10 * 60 * 1000, DEFAULT_TIMEOUT_MS);
  const maxOutputChars = clampNumber(message.maxOutputChars, 1000, 200000, DEFAULT_MAX_OUTPUT_CHARS);
  const layout = await ensureForAiTmuxLayout();
  const panes = layout.panes;
  const resolved = resolveBoardPane(panes, process.env.AI_CHAT_SHELL_BOARD_TARGET || "");
  if (!resolved.pane) {
    return buildBoardTargetErrorResponse({
      message,
      cmd,
      panes,
      error: resolved.error
    });
  }

  const pane = resolved.pane;
  const callKey = normalizeCallKey(message.callKey || message.id || hashText([
    "board",
    pane.id,
    cmd,
    timeoutMs,
    maxOutputChars
  ].join("\n")));
  const started = Date.now();
  const force = message.callMeta?.force === true || message.force === true;
  const claim = claimServerShellCall(callKey, {
    cmd,
    cwd: pane.currentPath || "",
    target: pane.id,
    timeoutMs,
    maxOutputChars,
    seq: message.seq,
    callMeta: message.callMeta || {},
    force
  });
  if (claim.action === "skip") {
    console.log(`[skip] reason=${claim.reason} callKey=${callKey} boardCmd=${JSON.stringify(cmd)}`);
    return {
      ok: true,
      id: message.id,
      callKey,
      duplicate: true,
      skipped: true,
      reason: claim.reason,
      cmd,
      target: pane.id,
      targetName: pane.label,
      timeoutMs,
      durationMs: 0,
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false
    };
  }

  console.log(`[run-board] callKey=${callKey} seq=${message.seq || ""} target=${pane.id} cmd=${JSON.stringify(cmd)}`);
  const result = await runTmuxBoard({
    cmd,
    pane,
    timeoutMs,
    maxOutputChars
  });
  console.log(`[done-board] ok=${result.ok !== false} exitCode=${result.exitCode} durationMs=${Date.now() - started} timedOut=${result.timedOut}`);

  const response = {
    ok: result.ok !== false,
    id: message.id,
    callKey,
    cmd,
    target: pane.id,
    targetName: pane.label,
    timeoutMs,
    durationMs: Date.now() - started,
    ...result
  };
  completeServerShellCall(callKey, response);
  return response;
}

function handleWriteFileMessage(message) {
  const started = Date.now();
  const filename = String(message.filename || "");
  const content = String(message.content || "");
  const downloadsDir = path.join(os.homedir(), "Downloads");
  const filePath = resolveDownloadsFilePath(filename, downloadsDir);
  const callKey = normalizeCallKey(message.callKey || message.id || hashText([filename, content].join("\n")));
  const force = message.callMeta?.force === true || message.force === true;
  const claim = claimServerShellCall(callKey, {
    cmd: content,
    cwd: downloadsDir,
    target: filePath,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    seq: message.seq,
    callMeta: message.callMeta || {},
    force
  });
  if (claim.action === "skip") {
    console.log(`[skip] reason=${claim.reason} callKey=${callKey} file=${JSON.stringify(filename)}`);
    return {
      ok: true,
      id: message.id,
      callKey,
      duplicate: true,
      skipped: true,
      reason: claim.reason,
      filename,
      path: filePath,
      bytes: 0,
      durationMs: 0
    };
  }

  const written = writeDownloadsFile(filename, content, downloadsDir);
  const bytes = written.bytes;
  console.log(`[write-file] path=${filePath} bytes=${bytes}`);
  const response = {
    ok: true,
    id: message.id,
    callKey,
    filename: path.basename(filePath),
    path: filePath,
    bytes,
    durationMs: Date.now() - started
  };
  completeServerShellCall(callKey, {
    ...response,
    exitCode: 0,
    timedOut: false,
    truncated: false
  });
  return response;
}

async function handleVisionMessage(message) {
  try {
    return await handleVisionMessageInner(message);
  } catch (error) {
    if (error instanceof VisionValidationError) {
      return visionError(error.errorCode, error.message);
    }
    return visionError("vision-message-failed", error.message || String(error));
  }
}

async function handleVisionMessageInner(message) {
  const type = String(message.type || "");
  if (type === "vision-health") {
    const availability = getVisionAvailability();
    return {
      ok: true,
      platform: os.platform(),
      helperPath: getVisionHelperPath(),
      available: availability.available,
      errorCode: availability.errorCode || "",
      error: availability.error || ""
    };
  }

  if (type === "vision-list-windows") {
    const args = ["list-windows"];
    if (message.all) {
      args.push("--all");
    }
    if (message.appName) {
      args.push("--app", validateVisionAppName(message.appName));
    }
    const response = await runVisionHelper(args);
    return ensureVisionOk(response);
  }

  if (type === "vision-capture") {
    const windowId = parseVisionWindowId(message.windowId);
    const response = await runVisionHelper(["capture", "--window-id", String(windowId)]);
    return ensureVisionWindowResponse(ensureVisionOk(response), { appName: message.appName || "" });
  }

  if (type === "vision-ocr") {
    const imageRef = getVisionImageRef(message);
    const response = await runVisionHelper(["ocr", "--image", imageRef]);
    return ensureVisionOk(response);
  }

  if (type === "vision-type") {
    const windowId = parseVisionWindowId(message.windowId);
    const text = validateVisionTextInput(message.text);
    const response = await runVisionHelper(["type", "--window-id", String(windowId), "--text", text]);
    return ensureVisionOk(response);
  }

  if (type === "vision-key") {
    const windowId = parseVisionWindowId(message.windowId);
    const key = validateVisionKey(message.key);
    const response = await runVisionHelper(["key", "--window-id", String(windowId), "--key", key]);
    return ensureVisionOk(response);
  }

  if (type === "vision-terminal-self-test") {
    return runVisionTerminalSelfTest(message);
  }

  if (type === "vision-tmux-run-line" || type === "vision-tmux-run") {
    return handleVisionTmuxRunLineMessage(message);
  }

  if (type === "vision-tmux-ocr-run-line" || type === "vision-visual-run-line") {
    return handleVisionTmuxOcrRunLineMessage(message);
  }

  return visionError("unsupported-vision-message", `Unsupported vision message type: ${type}`);
}

async function handleVisionTmuxOcrRunLineMessage(message) {
  const cmd = validateVisionTmuxCommand(message.cmd);
  const windowId = parseVisionWindowId(message.windowId);
  const timeoutMs = clampNumber(message.timeoutMs, 5000, 10 * 60 * 1000, DEFAULT_TIMEOUT_MS);
  const maxPages = clampNumber(message.maxPages, 1, 200, 40);
  const pageDelayMs = clampNumber(message.pageDelayMs, 100, 5000, 500);
  const result = await runVisionTmuxOcrLine({
    cmd,
    windowId,
    timeoutMs,
    maxPages,
    pageDelayMs,
    appName: message.appName || "",
    oracleTarget: message.target || message.tmuxTarget || ""
  });
  return {
    ok: result.ok !== false,
    id: message.id,
    cmd,
    windowId,
    timeoutMs,
    maxPages,
    ...result
  };
}

async function handleVisionTmuxRunLineMessage(message) {
  const cmd = validateVisionTmuxCommand(message.cmd);
  const timeoutMs = clampNumber(message.timeoutMs, 1000, 10 * 60 * 1000, DEFAULT_TIMEOUT_MS);
  const maxOutputChars = clampNumber(message.maxOutputChars, 1000, 1000000, DEFAULT_MAX_OUTPUT_CHARS);
  const panes = await listTmuxPanes();
  const target = normalizeTmuxTarget(message.target || message.tmuxTarget || "");
  if (!target) {
    return visionError("missing-target", "Missing tmux target for vision tmux run.", { tmuxPanes: panes });
  }

  const pane = resolveTmuxTarget(target, panes);
  if (!pane) {
    return visionError("invalid-target", `Unknown or ambiguous tmux target: ${target}`, { tmuxPanes: panes });
  }

  const result = await runTmuxVisualLine({
    cmd,
    pane,
    timeoutMs,
    maxOutputChars
  });
  return {
    ok: result.ok !== false,
    id: message.id,
    cmd,
    target: pane.id,
    targetName: pane.label,
    timeoutMs,
    ...result
  };
}

async function runVisionTerminalSelfTest(message) {
  const started = Date.now();
  const availability = getVisionAvailability();
  if (!availability.available) {
    return visionError(availability.errorCode, availability.error);
  }

  const panes = await listTmuxPanes();
  const pane = chooseVisionSelfTestPane(message.target || message.tmuxTarget || "", panes);
  if (!pane) {
    return visionError("missing-tmux-pane", "No tmux pane is available for Terminal vision self-test.");
  }

  await runTmuxCommand(["send-keys", "-t", pane.id, "C-c"], { timeoutMs: 5000 }).catch(() => null);
  await sleep(250);

  const token = `AIVIS_${randomOcrSafeToken(8)}`;
  const titleToken = `${token}_TITLE`;
  const readyToken = `${token}_READY_TERMINAL_OCR`;
  const loopToken = `${token}_LOOP_OK`;
  const timeoutMs = clampNumber(message.timeoutMs, 5000, 60000, 15000);
  const prepCmd = [
    `printf '\\033]0;${titleToken}\\007'`,
    "clear",
    `printf '${readyToken}\\n'`
  ].join("; ");

  const cwd = resolveCwd(message.cwd, pane.currentPath);
  const prep = await runTmuxShell({
    cmd: prepCmd,
    cwd,
    pane,
    timeoutMs,
    maxOutputChars: 20000
  });
  if (prep.ok === false || prep.exitCode !== 0) {
    return visionError("tmux-prep-failed", prep.stderr || "Could not prepare the tmux pane for vision self-test.", { prep });
  }

  const windowInfo = message.windowId
    ? await getVisionTerminalWindowById(parseVisionWindowId(message.windowId))
    : await waitForVisionTerminalWindow(titleToken, timeoutMs);
  if (!windowInfo) {
    return visionError("terminal-window-not-found", `Could not find a visible Terminal window${message.windowId ? ` with id ${message.windowId}` : ` with title token ${titleToken}`}.`, {
      titleToken,
      target: pane.id
    });
  }

  const firstCapture = await ensureVisionWindowResponse(ensureVisionOk(await runVisionHelper([
    "capture",
    "--window-id",
    String(windowInfo.windowId)
  ])));
  const firstOcr = await ocrVisionCapture(firstCapture);
  const firstText = visionOcrText(firstOcr);
  if (!visionTextIncludes(firstText, readyToken)) {
    return visionError("ocr-ready-token-missing", `OCR did not find ${readyToken}.`, {
      target: pane.id,
      window: windowInfo,
      ocrText: firstText
    });
  }

  const typeResponse = ensureVisionOk(await runVisionHelper([
    "type",
    "--window-id",
    String(windowInfo.windowId),
    "--text",
    `echo ${loopToken}`
  ]));
  const keyResponse = ensureVisionOk(await runVisionHelper([
    "key",
    "--window-id",
    String(windowInfo.windowId),
    "--key",
    "enter"
  ]));

  const tmuxText = await waitForTmuxPaneText(pane.id, loopToken, timeoutMs);
  if (!visionTextIncludes(tmuxText, loopToken)) {
    return visionError("tmux-input-token-missing", `tmux did not observe typed token ${loopToken}.`, {
      target: pane.id,
      window: windowInfo,
      typed: typeResponse,
      key: keyResponse,
      tmuxText
    });
  }

  const secondCapture = await ensureVisionWindowResponse(ensureVisionOk(await runVisionHelper([
    "capture",
    "--window-id",
    String(windowInfo.windowId)
  ])));
  const secondOcr = await ocrVisionCapture(secondCapture);
  const secondText = visionOcrText(secondOcr);
  if (!visionTextIncludes(secondText, loopToken)) {
    return visionError("ocr-loop-token-missing", `OCR did not find typed token ${loopToken}.`, {
      target: pane.id,
      window: windowInfo,
      ocrText: secondText,
      tmuxText
    });
  }

  return {
    ok: true,
    target: pane.id,
    targetName: pane.label,
    window: windowInfo,
    tokens: {
      title: titleToken,
      ready: readyToken,
      loop: loopToken
    },
    typed: typeResponse,
    key: keyResponse,
    ocrText: secondText,
    durationMs: Date.now() - started
  };
}

function writeDownloadsFile(filename, content, downloadsDir = path.join(os.homedir(), "Downloads")) {
  const filePath = resolveDownloadsFilePath(filename, downloadsDir);
  fs.mkdirSync(downloadsDir, { recursive: true });
  fs.writeFileSync(filePath, String(content || ""), "utf8");
  return {
    path: filePath,
    filename: path.basename(filePath),
    bytes: Buffer.byteLength(String(content || ""), "utf8")
  };
}

function resolveDownloadsFilePath(filename, downloadsDir = path.join(os.homedir(), "Downloads")) {
  const raw = String(filename || "");
  if (!raw.trim()) {
    throw new Error("Missing filename.");
  }
  if (raw.includes("\0")) {
    throw new Error("Filename contains an invalid null byte.");
  }
  if (raw.includes("/") || raw.includes("\\") || raw === "." || raw === "..") {
    throw new Error("Filename must be a single file name under Downloads.");
  }

  const resolved = path.resolve(downloadsDir, raw);
  const root = path.resolve(downloadsDir);
  if (path.dirname(resolved) !== root) {
    throw new Error("Filename must resolve directly under Downloads.");
  }
  return resolved;
}

function claimServerShellCall(callKey, payload) {
  const now = Date.now();
  const force = payload.callMeta?.force === true || payload.force === true;
  const existing = serverLedger.calls?.[callKey];
  const lockTtl = Math.max(5000, Number(payload.timeoutMs || DEFAULT_TIMEOUT_MS) + RUNNING_LOCK_GRACE_MS);

  if (!force) {
    if (existing?.state === "completed") {
      const completedAt = Number(existing.completedAt || 0);
      if (completedAt && now - completedAt < COMPLETED_DEDUP_TTL_MS) {
        return { action: "skip", reason: "recently-completed" };
      }
    }
    if (existing?.state === "running" && now - Number(existing.startedAt || 0) < lockTtl) {
      return { action: "skip", reason: "running" };
    }
  }

  serverLedger.calls ||= {};
  serverLedger.calls[callKey] = {
    state: "running",
    startedAt: now,
    cmdHash: hashText(payload.cmd),
    cwd: payload.cwd,
    target: payload.target || "",
    seq: payload.seq || "",
    origin: payload.callMeta?.origin || "",
    pathname: payload.callMeta?.pathname || "",
    promptHash: payload.callMeta?.promptHash || "",
    forced: force
  };
  saveServerLedger();
  return { action: "run" };
}

function completeServerShellCall(callKey, response) {
  serverLedger.calls ||= {};
  serverLedger.calls[callKey] = {
    ...(serverLedger.calls[callKey] || {}),
    state: "completed",
    completedAt: Date.now(),
    exitCode: response.exitCode,
    durationMs: response.durationMs,
    timedOut: response.timedOut === true,
    truncated: response.truncated === true
  };
  pruneServerLedger();
  saveServerLedger();
}

function resolveStateDir(value) {
  const raw = String(value || DEFAULT_STATE_DIR).trim();
  const expanded = raw.replace(/^~(?=$|\/)/, os.homedir());
  return path.resolve(ROOT_DIR, expanded);
}

function getDefaultStateDir() {
  return path.join(ROOT_DIR, ".state");
}

function getStateSource() {
  if (process.env.AI_CHAT_SHELL_STATE_DIR) {
    return "AI_CHAT_SHELL_STATE_DIR";
  }
  return "project-root";
}

function getStateDir() {
  return STATE_DIR;
}

function getStateStatus(options = {}) {
  try {
    return ensureStateDirReady(options);
  } catch (error) {
    return {
      ok: false,
      stateDir: STATE_DIR,
      source: getStateSource(),
      error: error.message || String(error)
    };
  }
}

function ensureStateDirReady({ create = false, repair = true } = {}) {
  const source = getStateSource();
  const repairs = [];
  try {
    if (fs.existsSync(STATE_DIR)) {
      const stat = fs.statSync(STATE_DIR);
      if (!stat.isDirectory()) {
        if (!create || !repair) {
          throw new Error(`State path exists but is not a directory: ${STATE_DIR}`);
        }
        repairs.push(movePathAside(STATE_DIR, "state-path"));
        fs.mkdirSync(STATE_DIR, { recursive: true });
      }
    } else if (create) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    } else {
      throw new Error(`State directory is missing: ${STATE_DIR}`);
    }

    for (const subdir of STATE_REQUIRED_SUBDIRS) {
      const subdirPath = path.join(STATE_DIR, subdir);
      if (fs.existsSync(subdirPath)) {
        const stat = fs.statSync(subdirPath);
        if (!stat.isDirectory()) {
          if (!create || !repair) {
            throw new Error(`State subpath exists but is not a directory: ${subdirPath}`);
          }
          repairs.push(movePathAside(subdirPath, `state-subpath-${subdir}`));
          fs.mkdirSync(subdirPath, { recursive: true });
        }
      } else if (create) {
        fs.mkdirSync(subdirPath, { recursive: true });
      }
    }

    const tempBase = path.join(STATE_DIR, `.state-preflight-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
    const tempPath = `${tempBase}.tmp`;
    const finalPath = `${tempBase}.ok`;
    fs.writeFileSync(tempPath, "ok\n", { flag: "wx" });
    fs.renameSync(tempPath, finalPath);
    fs.unlinkSync(finalPath);

    return {
      ok: true,
      stateDir: STATE_DIR,
      source,
      repaired: repairs.length > 0,
      repairs,
      error: ""
    };
  } catch (error) {
    throw new Error(`Shell server state directory is not usable: ${error.message || String(error)}`);
  }
}

function movePathAside(targetPath, reason) {
  const backupPath = nextBackupPath(targetPath, reason);
  fs.renameSync(targetPath, backupPath);
  return {
    path: targetPath,
    backupPath,
    reason
  };
}

function nextBackupPath(targetPath, reason) {
  const safeReason = String(reason || "broken").replace(/[^A-Za-z0-9_.-]/g, "-");
  const stamp = new Date().toISOString().replace(/[^0-9T]/g, "").slice(0, 15);
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? "" : `-${index}`;
    const candidate = `${targetPath}.broken-${safeReason}-${stamp}-${process.pid}${suffix}`;
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not choose backup path for ${targetPath}`);
}

function loadServerLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
    if (parsed && typeof parsed === "object") {
      const ledger = {
        version: 1,
        calls: parsed.calls && typeof parsed.calls === "object" ? parsed.calls : {}
      };
      const beforeCount = Object.keys(ledger.calls).length;
      pruneExpiredCompletedCalls(ledger);
      const afterCount = Object.keys(ledger.calls).length;
      if (afterCount !== beforeCount) {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        const tempPath = `${LEDGER_PATH}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(ledger, null, 2));
        fs.renameSync(tempPath, LEDGER_PATH);
      }
      return ledger;
    }
  } catch (error) {
    if (fs.existsSync(LEDGER_PATH)) {
      try {
        const repair = movePathAside(LEDGER_PATH, "ledger");
        console.error(`[state-repair] moved invalid shell ledger to ${repair.backupPath}: ${error.message || String(error)}`);
      } catch (repairError) {
        console.error(`[state-repair] could not move invalid shell ledger: ${repairError.message || String(repairError)}`);
      }
    }
    // Missing or invalid ledger files are treated as an empty ledger after
    // preserving the invalid file when possible.
  }
  return { version: 1, calls: {} };
}

function saveServerLedger() {
  ensureStateDirReady({ create: true });
  pruneServerLedger();
  if (fs.existsSync(LEDGER_PATH) && fs.statSync(LEDGER_PATH).isDirectory()) {
    const repair = movePathAside(LEDGER_PATH, "ledger");
    console.error(`[state-repair] moved invalid shell ledger path to ${repair.backupPath}`);
  }
  const tempPath = `${LEDGER_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(serverLedger, null, 2));
  fs.renameSync(tempPath, LEDGER_PATH);
}

function pruneServerLedger() {
  pruneExpiredCompletedCalls(serverLedger);
  const entries = Object.entries(serverLedger.calls || {});
  if (entries.length <= SERVER_LEDGER_LIMIT) {
    return;
  }

  entries
    .sort(([, a], [, b]) => Number(b.completedAt || b.startedAt || 0) - Number(a.completedAt || a.startedAt || 0))
    .slice(SERVER_LEDGER_LIMIT)
    .forEach(([key]) => {
      delete serverLedger.calls[key];
    });
}

function pruneExpiredCompletedCalls(ledger) {
  const cutoff = Date.now() - SERVER_LEDGER_MAX_AGE_MS;
  for (const [key, entry] of Object.entries(ledger.calls || {})) {
    if (entry?.state !== "completed") {
      continue;
    }
    const completedAt = Number(entry.completedAt || 0);
    if (completedAt && completedAt < cutoff) {
      delete ledger.calls[key];
    }
  }
}

function normalizeCallKey(value) {
  const raw = String(value || "").trim();
  if (/^[a-zA-Z0-9._:-]{1,128}$/.test(raw)) {
    return raw;
  }
  return hashText(raw || `${Date.now()}:${Math.random()}`);
}

function validateCommand(cmd) {
  const lower = cmd.toLowerCase();
  if (lower.includes("```") || lower.includes("shell call result") || lower.includes("shell call failed")) {
    throw new Error("Refusing to execute markdown/output text. Provide only the shell command.");
  }

  const lines = cmd.split("\n").map((line) => line.trim()).filter(Boolean);
  const suspicious = lines.find((line) =>
    line === "$" ||
    line.startsWith("$ ") ||
    line === "shell-output" ||
    line === HELPER_SHELL_START ||
    line === HELPER_SHELL_END ||
    line === HELPER_FILE_START ||
    line === HELPER_FILE_END ||
    line === HELPER_BOARD_START ||
    line === HELPER_BOARD_END ||
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

  if (suspicious) {
    throw new Error(`Refusing to execute copied shell-output text: ${suspicious}`);
  }
}

function validateBoardCommand(cmd) {
  const normalized = String(cmd || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) {
    throw new Error("Missing board command.");
  }
  if (normalized.includes("\n")) {
    throw new Error("Board helper body must contain exactly one command line.");
  }
  validateCommand(normalized);
}

function validateVisionTmuxCommand(cmd) {
  const normalized = String(cmd || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) {
    throw new VisionValidationError("missing-command", "Missing vision tmux command.");
  }
  if (normalized.includes("\n")) {
    throw new VisionValidationError("multiline-command", "Vision tmux run supports exactly one command line.");
  }
  if (normalized.length > MAX_COMMAND_CHARS) {
    throw new VisionValidationError("command-too-long", `Vision tmux command is too long (${normalized.length} chars, max ${MAX_COMMAND_CHARS}).`);
  }
  validateCommand(normalized);
  return normalized;
}

async function runTmuxShell({ cmd, cwd, pane, timeoutMs, maxOutputChars }) {
  const runId = crypto.randomBytes(8).toString("hex");
  const startMarker = `__AI_CHAT_SHELL_EXEC_START_${runId}__`;
  const doneMarker = `__AI_CHAT_SHELL_EXEC_DONE_${runId}__`;
  const scriptPath = path.join(TMUX_SCRIPT_DIR, `${runId}.zsh`);
  fs.mkdirSync(TMUX_SCRIPT_DIR, { recursive: true });
  fs.writeFileSync(scriptPath, buildTmuxRunScript({ cmd, cwd, startMarker, doneMarker }), { mode: 0o700 });

  const started = Date.now();
  let lastCapture = "";
  try {
    await runTmuxCommand(["send-keys", "-t", pane.id, "-l", `${SHELL_RUNNER} ${shellQuote(scriptPath)}`], { timeoutMs: 5000 });
    await runTmuxCommand(["send-keys", "-t", pane.id, "Enter"], { timeoutMs: 5000 });

    while (Date.now() - started < timeoutMs) {
      await sleep(TMUX_POLL_INTERVAL_MS);
      lastCapture = await captureTmuxPane(pane.id);
      const extracted = extractTmuxRunOutput(lastCapture, startMarker, doneMarker, maxOutputChars);
      if (extracted.foundDone) {
        return {
          exitCode: extracted.exitCode,
          stdout: extracted.stdout,
          stderr: "",
          truncated: extracted.truncated,
          timedOut: false,
          target: pane.id,
          targetName: pane.label
        };
      }
    }

    const partial = extractTmuxRunOutput(lastCapture, startMarker, doneMarker, maxOutputChars);
    return {
      exitCode: 124,
      stdout: partial.stdout,
      stderr: "Timed out waiting for tmux command completion marker. The command may still be running in the target pane.",
      truncated: partial.truncated,
      timedOut: true,
      target: pane.id,
      targetName: pane.label
    };
  } finally {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      // Best-effort cleanup; stale files are harmless and remain under the runtime state directory.
    }
  }
}

async function runTmuxBoard({ cmd, pane, timeoutMs, maxOutputChars }) {
  const timing = getBoardTimingConfig();
  const logPath = buildBoardLogPath(pane);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.closeSync(fs.openSync(logPath, "a"));

  const pipeActive = await isTmuxPanePipeActive(pane.id);
  if (pipeActive) {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "",
      error: "Board pane already has an active tmux pipe-pane; command was not sent.",
      truncated: false,
      timedOut: false,
      target: pane.id,
      targetName: pane.label
    };
  }

  const deadline = Date.now() + timeoutMs;
  let pipeStarted = false;
  try {
    await startTmuxPanePipe(pane.id, logPath);
    pipeStarted = true;
    await sleep(timing.pollMs);

    const probeOffset = getFileSize(logPath);
    await runTmuxCommand(["send-keys", "-t", pane.id, "Enter"], { timeoutMs: 5000 });
    const probe = await waitForBoardIdle({
      logPath,
      offset: probeOffset,
      deadline,
      idleMs: timing.probeIdleMs,
      pollMs: timing.pollMs,
      maxOutputChars
    });
    const prompt = extractBoardPromptSignature(probe.normalized);
    if (!prompt) {
      return {
        ok: false,
        exitCode: 1,
        stdout: probe.stdout,
        stderr: "",
        error: "Board prompt probe failed; command was not sent.",
        truncated: probe.truncated,
        timedOut: probe.timedOut,
        target: pane.id,
        targetName: pane.label
      };
    }

    const commandOffset = getFileSize(logPath);
    await runTmuxCommand(["send-keys", "-t", pane.id, "-l", cmd], { timeoutMs: 5000 });
    await runTmuxCommand(["send-keys", "-t", pane.id, "Enter"], { timeoutMs: 5000 });
    const captured = await waitForBoardPrompt({
      logPath,
      offset: commandOffset,
      prompt,
      deadline,
      idleMs: timing.promptIdleMs,
      pollMs: timing.pollMs,
      maxOutputChars
    });

    return {
      exitCode: captured.timedOut ? 124 : 0,
      stdout: captured.stdout,
      stderr: captured.timedOut ? "Timed out waiting for board prompt after command. The command may still be running in the target pane." : "",
      truncated: captured.truncated,
      timedOut: captured.timedOut,
      target: pane.id,
      targetName: pane.label
    };
  } finally {
    if (pipeStarted) {
      try {
        await stopTmuxPanePipe(pane.id);
      } catch (error) {
        console.error(`[board-pipe] failed to stop pipe for ${pane.id}: ${error.message || String(error)}`);
      }
    }
  }
}

async function runTmuxVisualLine({ cmd, pane, timeoutMs, maxOutputChars }) {
  const started = Date.now();
  const runId = randomOcrSafeToken(8);
  const runWindowName = `${VISION_TMUX_RUN_PREFIX}_RUN_${runId}`;
  const donePrefix = `${VISION_TMUX_RUN_PREFIX}_DONE_${runId}_`;
  const runLine = buildTmuxVisualRunLine({ cmd, runWindowName, donePrefix });

  await runTmuxCommand(["send-keys", "-t", pane.id, "C-c"], { timeoutMs: 5000 }).catch(() => null);
  await sleep(150);
  await runTmuxCommand(["send-keys", "-t", pane.id, "C-l"], { timeoutMs: 5000 });
  await runTmuxCommand(["clear-history", "-t", pane.id], { timeoutMs: 5000 });
  await runTmuxCommand(["rename-window", "-t", pane.id, runWindowName], { timeoutMs: 5000 });
  await runTmuxCommand(["send-keys", "-t", pane.id, "-l", runLine], { timeoutMs: 5000 });
  await runTmuxCommand(["send-keys", "-t", pane.id, "Enter"], { timeoutMs: 5000 });

  const done = await waitForTmuxWindowDone({
    target: pane.id,
    donePrefix,
    timeoutMs
  });
  const terminalText = await captureTmuxPane(pane.id, maxOutputChars);
  const parsed = parseTmuxVisualDoneWindowName(done.windowName, donePrefix);
  const lineCount = terminalText ? terminalText.split("\n").length : 0;
  const charCount = terminalText.length;

  return {
    ok: done.found,
    runId,
    runWindowName,
    doneWindowName: done.windowName,
    exitCode: done.found ? parsed.exitCode : 124,
    terminalText,
    lineCount,
    charCount,
    truncated: done.truncated || charCount >= maxOutputChars,
    timedOut: !done.found,
    stderr: done.found ? "" : "Timed out waiting for tmux window done marker. The command may still be running in the target pane.",
    durationMs: Date.now() - started
  };
}

async function runVisionTmuxOcrLine({ cmd, windowId, timeoutMs, maxPages, pageDelayMs, appName = "", oracleTarget = "" }) {
  const started = Date.now();
  if (appName) {
    const matched = await getVisionWindowById(windowId, { appName });
    if (!matched) {
      return visionError("unexpected-window-app", `Could not find visible target window ${windowId} for app ${validateVisionAppName(appName)}.`, {
        windowId,
        appName
      });
    }
  }
  const runId = randomOcrSafeToken(8);
  const runWindowName = `${VISION_TMUX_OCR_RUN_PREFIX}${runId}`;
  const donePrefix = `${VISION_TMUX_OCR_DONE_PREFIX}${runId}`;
  const runLine = buildTmuxVisualOcrRunLine({ cmd, runWindowName, donePrefix });

  await typeVisionText(windowId, runLine);
  await pressVisionKey(windowId, "enter");

  const done = await waitForVisionDoneMarker({
    windowId,
    donePrefix,
    timeoutMs
  });
  if (!done.found) {
    return visionError("ocr-done-marker-timeout", "Timed out waiting for OCR to observe tmux done window marker.", {
      runId,
      runWindowName,
      donePrefix,
      lastOcrText: done.text,
      lastStatusText: done.statusText || "",
      durationMs: Date.now() - started
    });
  }

  await enterTmuxCopyModeAtHistoryTop(windowId);
  await sleep(pageDelayMs);

  const pages = await readVisionOcrPages({
    windowId,
    maxPages,
    pageDelayMs
  });
  await pressVisionKey(windowId, "escape").catch(() => null);

  const ocrRawText = pages.map((page) => page.text).join("\n");
  const cleanedPageTexts = pages.map((page) => cleanVisionTmuxOcrText(page.text, donePrefix));
  const ocrText = cleanVisionTmuxOcrText(stitchOcrPages(cleanedPageTexts), donePrefix);
  const parsed = parseVisionDoneFromText(done.statusText || done.text, donePrefix);
  const oracleText = oracleTarget ? await captureTmuxPaneText(oracleTarget).catch(() => "") : "";

  return {
    ok: true,
    runId,
    runWindowName,
    donePrefix,
    doneOcrText: done.text,
    doneWindowName: parsed.doneWindowName,
    exitCode: parsed.exitCode,
    ocrText,
    ocrRawText,
    ocrPages: pages,
    ocrLineCount: ocrText ? ocrText.split("\n").length : 0,
    oracleText,
    durationMs: Date.now() - started
  };
}

function buildTmuxVisualOcrRunLine({ cmd, runWindowName, donePrefix }) {
  return [
    `tmux rename-window ${shellQuote(runWindowName)}`,
    "clear",
    "tmux clear-history",
    "printf '\\n'",
    `( ${cmd} )`,
    "__AI_VISION_EXIT_CODE=$?",
    `tmux rename-window \"${donePrefix}\${__AI_VISION_EXIT_CODE}\"`
  ].join("; ");
}

function buildTmuxVisualRunLine({ cmd, runWindowName, donePrefix }) {
  return [
    `tmux rename-window ${shellQuote(runWindowName)}`,
    `/bin/sh -c ${shellQuote(cmd)}`,
    "__AI_VISION_EXIT_CODE=$?",
    `tmux rename-window \"${donePrefix}\${__AI_VISION_EXIT_CODE}\"`
  ].join("; ");
}

async function waitForTmuxWindowDone({ target, donePrefix, timeoutMs }) {
  const started = Date.now();
  let lastWindowName = "";
  while (Date.now() - started < timeoutMs) {
    await sleep(TMUX_POLL_INTERVAL_MS);
    lastWindowName = await getTmuxWindowName(target);
    if (lastWindowName.startsWith(donePrefix)) {
      return {
        found: true,
        windowName: lastWindowName,
        truncated: false
      };
    }
  }
  return {
    found: false,
    windowName: lastWindowName,
    truncated: false
  };
}

async function getTmuxWindowName(target) {
  const result = await runTmuxCommand(["display-message", "-p", "-t", target, "#{window_name}"], { timeoutMs: 5000 });
  return String(result.stdout || "").trim();
}

function parseTmuxVisualDoneWindowName(windowName, donePrefix) {
  const raw = String(windowName || "");
  if (!raw.startsWith(donePrefix)) {
    return {
      exitCode: 124
    };
  }
  const suffix = raw.slice(donePrefix.length);
  const exitCode = Number(suffix);
  return {
    exitCode: Number.isInteger(exitCode) ? exitCode : 124
  };
}

async function typeVisionText(windowId, text) {
  const value = String(text || "");
  if (!value) {
    return;
  }
  const chunkSize = VISION_INPUT_MAX_CHARS;
  for (let index = 0; index < value.length; index += chunkSize) {
    const chunk = value.slice(index, index + chunkSize);
    validateVisionTextInput(chunk);
    const response = await runVisionHelper(["type", "--window-id", String(windowId), "--text", chunk]);
    const checked = ensureVisionOk(response);
    if (checked.ok === false) {
      throw new VisionValidationError(checked.errorCode || "vision-type-failed", checked.error || "Vision typing failed.");
    }
  }
}

async function pressVisionKey(windowId, key) {
  const normalized = validateVisionKey(key);
  const response = await runVisionHelper(["key", "--window-id", String(windowId), "--key", normalized]);
  const checked = ensureVisionOk(response);
  if (checked.ok === false) {
    throw new VisionValidationError(checked.errorCode || "vision-key-failed", checked.error || "Vision key input failed.");
  }
  return checked;
}

async function enterTmuxCopyModeAtHistoryTop(windowId) {
  await typeVisionText(windowId, "tmux copy-mode \\; send-keys -X history-top");
  await pressVisionKey(windowId, "enter");
}

async function captureVisionOcrText(windowId) {
  const capture = ensureVisionWindowResponse(ensureVisionOk(await runVisionHelper([
    "capture",
    "--window-id",
    String(windowId)
  ])));
  if (capture.ok === false) {
    return capture;
  }
  const ocr = await ocrVisionCapture(capture);
  if (ocr.ok === false) {
    return ocr;
  }
  return {
    ok: true,
    capture,
    ocr,
    text: visionOcrText(ocr),
    outputText: visionOcrOutputText(ocr),
    statusText: visionOcrStatusText(ocr),
    rows: visionOcrRows(ocr)
  };
}

async function waitForVisionDoneMarker({ windowId, donePrefix, timeoutMs }) {
  const started = Date.now();
  let lastText = "";
  let lastStatusText = "";
  while (Date.now() - started < timeoutMs) {
    await sleep(500);
    const captured = await captureVisionOcrText(windowId);
    if (captured.ok === false) {
      lastText = captured.error || "";
      lastStatusText = "";
      continue;
    }
    lastText = captured.text;
    lastStatusText = captured.statusText || "";
    if (visionTextIncludes(captured.statusText, donePrefix)) {
      return {
        found: true,
        text: lastText,
        statusText: captured.statusText,
        ocr: captured.ocr
      };
    }
  }
  return {
    found: false,
    text: lastText,
    statusText: lastStatusText
  };
}

async function readVisionOcrPages({ windowId, maxPages, pageDelayMs }) {
  const pages = [];
  let previousSignature = "";
  for (let index = 0; index < maxPages; index += 1) {
    const captured = await captureVisionOcrText(windowId);
    if (captured.ok === false) {
      pages.push({
        page: index + 1,
        ok: false,
        errorCode: captured.errorCode || "ocr-page-failed",
        error: captured.error || "Could not OCR page."
      });
      break;
    }
    const pageText = captured.outputText || captured.text;
    const signature = normalizeOcrPageSignature(pageText);
    if (index > 0 && signature && signature === previousSignature) {
      break;
    }
    pages.push({
      page: index + 1,
      ok: true,
      text: pageText,
      rawText: captured.text,
      statusText: captured.statusText,
      signature,
      results: captured.ocr.results || []
    });
    previousSignature = signature;
    await pressVisionKey(windowId, "page-down");
    await sleep(pageDelayMs);
  }
  return pages;
}

function normalizeOcrPageSignature(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

function stitchOcrPages(pageTexts) {
  const stitched = [];
  for (const pageText of pageTexts) {
    const lines = String(pageText || "")
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim());
    const overlap = findLineOverlap(stitched, lines, 120);
    stitched.push(...lines.slice(overlap));
  }
  return stitched.join("\n");
}

function cleanVisionTmuxOcrText(text, donePrefix = "") {
  const doneToken = normalizeOcrTokenText(donePrefix);
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => {
      return String(line || "")
        .replace(/\s+$/, "")
        .replace(/(?:\s{2,}\[\d+\/\d+\]|\[\d+\/\d+\])$/, "")
        .trimEnd();
    })
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return false;
      }
      const normalized = normalizeOcrTokenText(trimmed);
      if (doneToken && normalized.includes(doneToken)) {
        return false;
      }
      if (normalized.includes(VISION_TMUX_OCR_RUN_PREFIX) || normalized.includes(VISION_TMUX_OCR_DONE_PREFIX)) {
        return false;
      }
      if (/tmux\s+copy-mode/i.test(trimmed) || /^\s*-X\s+history-top\b/i.test(trimmed)) {
        return false;
      }
      if (/tmux attach-session/.test(trimmed) && /—|-/.test(trimmed)) {
        return false;
      }
      return true;
    })
    .join("\n");
}

function findLineOverlap(existing, next, maxLines) {
  const limit = Math.min(maxLines, existing.length, next.length);
  for (let count = limit; count > 0; count -= 1) {
    let matches = true;
    for (let index = 0; index < count; index += 1) {
      if (normalizeOcrComparableLine(existing[existing.length - count + index]) !== normalizeOcrComparableLine(next[index])) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return count;
    }
  }
  return 0;
}

function normalizeOcrComparableLine(line) {
  return String(line || "").replace(/\s+/g, " ").trim();
}

function parseVisionDoneFromText(text, donePrefix) {
  const compact = normalizeOcrTokenText(text);
  const compactPrefix = normalizeOcrTokenText(donePrefix);
  const index = compact.indexOf(compactPrefix);
  if (index < 0) {
    return {
      doneWindowName: "",
      exitCode: 124
    };
  }
  const after = compact.slice(index + compactPrefix.length);
  const match = after.match(/^(\d{1,3})/);
  const exitCode = match ? Number(match[1]) : 0;
  return {
    doneWindowName: `${donePrefix}${Number.isInteger(exitCode) ? exitCode : ""}`,
    exitCode: Number.isInteger(exitCode) ? exitCode : 0
  };
}

function buildTmuxRunScript({ cmd, cwd, startMarker, doneMarker }) {
  return [
    `#!${SHELL_RUNNER}`,
    "set +e",
    `printf '\\n%s\\n' ${shellQuote(startMarker)}`,
    "(",
    cwd ? `  cd -- ${shellQuote(cwd)} || exit $?` : "",
    cmd,
    ")",
    "__ai_chat_shell_exec_status=$?",
    `printf '\\n%s:%s\\n' ${shellQuote(doneMarker)} \"$__ai_chat_shell_exec_status\"`,
    "exit \"$__ai_chat_shell_exec_status\"",
    ""
  ].filter((line) => line !== "").join("\n");
}

async function listTmuxPanes() {
  const result = await runTmuxCommand(["list-panes", "-a", "-F", TMUX_LIST_FORMAT], { timeoutMs: 5000 });
  const panes = parseTmuxPanes(result.stdout);
  console.log(`[tmux-list] socket=${getTmuxSocketPath() || "(default)"} panes=${panes.length} stdoutChars=${result.stdout.length}`);
  return panes;
}

async function ensureForAiTmuxLayout() {
  const config = getForAiTmuxConfig();
  const createdWindows = [];
  let createdSession = false;

  const sessionCheck = await runTmuxCommandRaw(["has-session", "-t", config.sessionName], { timeoutMs: 5000 });
  if (!sessionCheck.ok) {
    await runTmuxCommand([
      "new-session",
      "-d",
      "-s",
      config.sessionName,
      "-n",
      config.hostWindowName,
      "-c",
      config.cwd
    ], { timeoutMs: 5000 });
    createdSession = true;
    createdWindows.push(config.hostWindowName);
  }

  let windows = await listTmuxWindows(config.sessionName);
  if (!windows.includes(config.hostWindowName)) {
    await runTmuxCommand([
      "new-window",
      "-d",
      "-t",
      `${config.sessionName}:`,
      "-n",
      config.hostWindowName,
      "-c",
      config.cwd
    ], { timeoutMs: 5000 });
    createdWindows.push(config.hostWindowName);
    windows = await listTmuxWindows(config.sessionName);
  }

  if (!windows.includes(config.boardWindowName)) {
    await runTmuxCommand([
      "new-window",
      "-d",
      "-t",
      `${config.sessionName}:`,
      "-n",
      config.boardWindowName,
      "-c",
      config.cwd
    ], { timeoutMs: 5000 });
    createdWindows.push(config.boardWindowName);
  }

  const panes = await listTmuxPanes();
  const defaultHost = resolveDefaultShellPane(panes, config).pane;
  const defaultBoard = resolveDefaultBoardPane(panes, config).pane;
  return {
    ok: true,
    sessionName: config.sessionName,
    hostWindowName: config.hostWindowName,
    boardWindowName: config.boardWindowName,
    cwd: config.cwd,
    cwdSource: config.cwdSource,
    createdSession,
    createdWindows,
    defaultTarget: defaultHost?.id || "",
    defaultTargetName: defaultHost?.label || "",
    defaultTargetCwd: defaultHost?.currentPath || "",
    boardTarget: defaultBoard?.id || "",
    boardTargetName: defaultBoard?.label || "",
    boardTargetCwd: defaultBoard?.currentPath || "",
    panes
  };
}

async function resetForAiTmuxLayout() {
  const config = getForAiTmuxConfig();
  const sessionCheck = await runTmuxCommandRaw(["has-session", "-t", config.sessionName], { timeoutMs: 5000 });
  if (sessionCheck.ok) {
    await runTmuxCommand(["kill-session", "-t", config.sessionName], { timeoutMs: 5000 });
  }
  const layout = await ensureForAiTmuxLayout();
  return {
    ...layout,
    reset: true,
    killedExistingSession: sessionCheck.ok
  };
}

async function listTmuxWindows(sessionName) {
  const result = await runTmuxCommand([
    "list-windows",
    "-t",
    sessionName,
    "-F",
    "#{window_name}"
  ], { timeoutMs: 5000 });
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseTmuxPanes(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const parts = line.includes(TMUX_FIELD_SEPARATOR)
        ? line.split(TMUX_FIELD_SEPARATOR)
        : line.split("\t");
      const [
        id,
        session,
        windowIndex,
        windowName,
        paneIndex,
        active,
        currentPath,
        currentCommand
      ] = parts;
      const address = `${session}:${windowIndex}.${paneIndex}`;
      return {
        id,
        session,
        windowIndex,
        windowName,
        paneIndex,
        active: active === "1",
        currentPath: currentPath || "",
        currentCommand: currentCommand || "",
        address,
        label: `${address} ${windowName || "(unnamed)"}`
      };
    })
    .filter((pane) => pane.id && pane.session && pane.windowIndex !== undefined && pane.paneIndex !== undefined);
}

function normalizeTmuxTarget(value) {
  return String(value || "").trim();
}

function resolveTmuxTarget(target, panes) {
  const normalized = normalizeTmuxTarget(target);
  if (!normalized) {
    return null;
  }

  const exact = panes.find((pane) => pane.id === normalized || pane.address === normalized);
  if (exact) {
    return exact;
  }

  const config = getForAiTmuxConfig();
  const byDefaultSessionWindowName = panes.filter((pane) =>
    pane.session === config.sessionName &&
    pane.windowName === normalized
  );
  if (byDefaultSessionWindowName.length === 1) {
    return byDefaultSessionWindowName[0];
  }

  const byWindowName = panes.filter((pane) => pane.windowName === normalized);
  return byWindowName.length === 1 ? byWindowName[0] : null;
}

function resolveBoardPane(panes, configuredTarget = "") {
  const target = normalizeTmuxTarget(configuredTarget);
  if (target) {
    const pane = resolveTmuxTarget(target, panes);
    return pane ? {
      pane,
      error: ""
    } : {
      pane: null,
      error: `Unknown or ambiguous board target from AI_CHAT_SHELL_BOARD_TARGET: ${target}`
    };
  }

  return resolveDefaultBoardPane(panes);
}

function resolveDefaultShellPane(panes, config = getForAiTmuxConfig()) {
  const matches = panes.filter((pane) =>
    pane.session === config.sessionName &&
    pane.windowName === config.hostWindowName
  );
  if (matches.length > 0) {
    return {
      pane: matches.find((pane) => pane.active) || matches[0],
      error: ""
    };
  }
  return {
    pane: null,
    error: `No tmux pane found in ${config.sessionName}:${config.hostWindowName}.`
  };
}

function resolveDefaultBoardPane(panes, config = getForAiTmuxConfig()) {
  const matches = panes.filter((pane) =>
    pane.session === config.sessionName &&
    pane.windowName === config.boardWindowName
  );
  if (matches.length === 1) {
    return {
      pane: matches[0],
      error: ""
    };
  }
  if (matches.length > 1) {
    return {
      pane: null,
      error: `Multiple tmux panes match ${config.sessionName}:${config.boardWindowName}. Set AI_CHAT_SHELL_BOARD_TARGET to a pane id or session:window.pane.`
    };
  }
  return {
    pane: null,
    error: `No tmux pane found in ${config.sessionName}:${config.boardWindowName}. Run tmux setup or set AI_CHAT_SHELL_BOARD_TARGET.`
  };
}

function buildMissingTargetResponse(message, cmd, panes) {
  const config = getForAiTmuxConfig();
  return buildTargetErrorResponse({
    message,
    cmd,
    panes,
    error: `Shell helper targets are not supported. Expected default target ${config.sessionName}:${config.hostWindowName}.`,
    targetRequired: false
  });
}

function buildInvalidTargetResponse(message, cmd, target, panes) {
  const config = getForAiTmuxConfig();
  return buildTargetErrorResponse({
    message,
    cmd,
    panes,
    error: `Shell helper target is not supported: ${target}. Expected default target ${config.sessionName}:${config.hostWindowName}.`,
    targetRequired: false
  });
}

function buildDefaultTargetErrorResponse(message, cmd, panes) {
  const config = getForAiTmuxConfig();
  return buildTargetErrorResponse({
    message,
    cmd,
    panes,
    error: `Default tmux target is unavailable. Expected ${config.sessionName}:${config.hostWindowName}.`,
    targetRequired: false
  });
}

function buildBoardTargetErrorResponse({ message, cmd, panes, error }) {
  return {
    ok: false,
    id: message.id,
    callKey: message.callKey || message.id || "",
    cmd,
    targetRequired: false,
    error,
    tmuxPanes: panes,
    example: buildBoardHelperExample(cmd)
  };
}

function buildTargetErrorResponse({ message, cmd, panes, error, targetRequired }) {
  return {
    ok: false,
    id: message.id,
    callKey: message.callKey || message.id || "",
    cmd,
    targetRequired,
    error,
    tmuxPanes: panes,
    example: buildTmuxTargetExample(panes, cmd)
  };
}

function buildBoardHelperExample(cmd = "version") {
  return [
    HELPER_BOARD_START,
    cmd || "version",
    HELPER_BOARD_END
  ].join("\n");
}

function buildTmuxTargetExample(panes, cmd = "pwd") {
  return [
    HELPER_SHELL_START,
    cmd || "pwd",
    HELPER_SHELL_END
  ].join("\n");
}

async function captureTmuxPane(target, maxOutputChars = 1000000) {
  const result = await runTmuxCommand([
    "capture-pane",
    "-p",
    "-J",
    "-S",
    `-${TMUX_CAPTURE_HISTORY_LINES}`,
    "-t",
    target
  ], { timeoutMs: 5000 });
  return appendLimited("", result.stdout, maxOutputChars);
}

function getBoardTimingConfig() {
  return {
    probeIdleMs: getEnvClampedNumber("AI_CHAT_SHELL_BOARD_PROBE_IDLE_MS", 100, 60000, DEFAULT_BOARD_PROBE_IDLE_MS),
    promptIdleMs: getEnvClampedNumber("AI_CHAT_SHELL_BOARD_PROMPT_IDLE_MS", 50, 10000, DEFAULT_BOARD_PROMPT_IDLE_MS),
    pollMs: getEnvClampedNumber("AI_CHAT_SHELL_BOARD_POLL_MS", 50, 5000, DEFAULT_BOARD_POLL_MS)
  };
}

function getForAiTmuxConfig() {
  const cwdRaw = process.env.AI_CHAT_SHELL_FORAI_CWD || ROOT_DIR;
  return {
    sessionName: normalizeTmuxName(process.env.AI_CHAT_SHELL_TMUX_SESSION, DEFAULT_TMUX_SESSION_NAME),
    hostWindowName: normalizeTmuxName(process.env.AI_CHAT_SHELL_HOST_WINDOW, DEFAULT_HOST_WINDOW_NAME),
    boardWindowName: normalizeTmuxName(process.env.AI_CHAT_SHELL_BOARD_WINDOW, DEFAULT_BOARD_WINDOW_NAME),
    cwd: resolveForAiCwd(cwdRaw),
    cwdSource: process.env.AI_CHAT_SHELL_FORAI_CWD ? "AI_CHAT_SHELL_FORAI_CWD" : "project-root"
  };
}

function getForAiTmuxConfigForHealth() {
  try {
    return getForAiTmuxConfig();
  } catch (error) {
    return {
      sessionName: normalizeTmuxName(process.env.AI_CHAT_SHELL_TMUX_SESSION, DEFAULT_TMUX_SESSION_NAME),
      hostWindowName: normalizeTmuxName(process.env.AI_CHAT_SHELL_HOST_WINDOW, DEFAULT_HOST_WINDOW_NAME),
      boardWindowName: normalizeTmuxName(process.env.AI_CHAT_SHELL_BOARD_WINDOW, DEFAULT_BOARD_WINDOW_NAME),
      cwd: String(process.env.AI_CHAT_SHELL_FORAI_CWD || ROOT_DIR),
      cwdSource: process.env.AI_CHAT_SHELL_FORAI_CWD ? "AI_CHAT_SHELL_FORAI_CWD" : "project-root",
      cwdError: error.message || String(error)
    };
  }
}

function resolveForAiCwd(value) {
  return fs.realpathSync(resolveCwd(value || ROOT_DIR, ROOT_DIR));
}

function normalizeTmuxName(value, fallback) {
  const text = String(value || "").trim();
  if (!text || /[\0\r\n]/.test(text)) {
    return fallback;
  }
  return text;
}

async function isTmuxPanePipeActive(target) {
  const result = await runTmuxCommand(["display-message", "-p", "-t", target, "#{pane_pipe}"], { timeoutMs: 5000 });
  return result.stdout.trim() === "1";
}

async function startTmuxPanePipe(target, logPath) {
  await runTmuxCommand(["pipe-pane", "-o", "-t", target, `cat >> ${shellQuote(logPath)}`], { timeoutMs: 5000 });
}

async function stopTmuxPanePipe(target) {
  await runTmuxCommand(["pipe-pane", "-t", target], { timeoutMs: 5000 });
}

async function waitForBoardIdle({ logPath, offset, deadline, idleMs, pollMs, maxOutputChars }) {
  let lastSize = getFileSize(logPath);
  let lastChangeAt = Date.now();
  let latest = readBoardLogFromOffset(logPath, offset, maxOutputChars);

  while (Date.now() < deadline) {
    await sleep(pollMs);
    latest = readBoardLogFromOffset(logPath, offset, maxOutputChars);
    if (latest.size !== lastSize) {
      lastSize = latest.size;
      lastChangeAt = Date.now();
    }
    if (latest.bytesRead > 0 && Date.now() - lastChangeAt >= idleMs) {
      return {
        ...latest,
        timedOut: false
      };
    }
  }

  return {
    ...latest,
    timedOut: true
  };
}

async function waitForBoardPrompt({ logPath, offset, prompt, deadline, idleMs, pollMs, maxOutputChars }) {
  let lastSize = getFileSize(logPath);
  let lastChangeAt = Date.now();
  let latest = readBoardLogFromOffset(logPath, offset, maxOutputChars);

  while (Date.now() < deadline) {
    await sleep(pollMs);
    latest = readBoardLogFromOffset(logPath, offset, maxOutputChars);
    if (latest.size !== lastSize) {
      lastSize = latest.size;
      lastChangeAt = Date.now();
    }
    if (latest.bytesRead > 0 &&
      outputEndsWithBoardPrompt(latest.normalized, prompt) &&
      Date.now() - lastChangeAt >= idleMs) {
      return {
        ...latest,
        timedOut: false
      };
    }
  }

  return {
    ...latest,
    timedOut: true
  };
}

function readBoardLogFromOffset(logPath, offset, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS) {
  const size = getFileSize(logPath);
  const safeOffset = Math.max(0, Math.min(Number(offset) || 0, size));
  const bytesToRead = Math.max(0, size - safeOffset);
  if (bytesToRead === 0) {
    return {
      size,
      bytesRead: 0,
      normalized: "",
      stdout: "",
      truncated: false
    };
  }

  const fd = fs.openSync(logPath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, safeOffset);
    const normalized = normalizeBoardOutput(buffer.subarray(0, bytesRead).toString("utf8"));
    const stdout = appendLimited("", normalized, maxOutputChars);
    return {
      size,
      bytesRead,
      normalized,
      stdout,
      truncated: normalized.length > stdout.length
    };
  } finally {
    fs.closeSync(fd);
  }
}

function normalizeBoardOutput(value) {
  return renderTerminalText(String(value || ""));
}

function renderTerminalText(input) {
  const lines = [[]];
  let row = 0;
  let col = 0;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const code = char.charCodeAt(0);

    if (char === "\x1b") {
      index = consumeEscapeSequence(input, index, {
        cursorForward(count) {
          col += count;
        },
        cursorBackward(count) {
          col = Math.max(0, col - count);
        },
        cursorUp(count) {
          row = Math.max(0, row - count);
        },
        cursorDown(count) {
          row += count;
          ensureLine(lines, row);
        },
        cursorPosition(nextRow, nextCol) {
          row = Math.max(0, nextRow);
          col = Math.max(0, nextCol);
          ensureLine(lines, row);
        },
        cursorColumn(nextCol) {
          col = Math.max(0, nextCol);
        },
        eraseLine(mode) {
          const line = ensureLine(lines, row);
          if (mode === 2) {
            lines[row] = [];
          } else if (mode === 1) {
            for (let i = 0; i <= col; i += 1) {
              line[i] = " ";
            }
          } else {
            line.length = Math.min(line.length, col);
          }
        },
        eraseDisplay(mode) {
          if (mode === 2) {
            lines.length = 1;
            lines[0] = [];
            row = 0;
            col = 0;
          }
        }
      });
      continue;
    }

    if (char === "\r") {
      if (input[index + 1] === "\n") {
        index += 1;
        row += 1;
        col = 0;
        ensureLine(lines, row);
      } else {
        col = 0;
      }
      continue;
    }

    if (char === "\n") {
      row += 1;
      col = 0;
      ensureLine(lines, row);
      continue;
    }

    if (char === "\b") {
      col = Math.max(0, col - 1);
      continue;
    }

    if (char === "\t") {
      const nextTabStop = col + (8 - (col % 8 || 0));
      while (col < nextTabStop) {
        writeTerminalChar(lines, row, col, " ");
        col += 1;
      }
      continue;
    }

    if ((code >= 0 && code < 32) || code === 127) {
      continue;
    }

    writeTerminalChar(lines, row, col, char);
    col += 1;
  }

  return lines.map(lineToString).join("\n");
}

function consumeEscapeSequence(input, startIndex, actions) {
  const kind = input[startIndex + 1];
  if (!kind) {
    return startIndex;
  }

  if (kind === "]") {
    for (let index = startIndex + 2; index < input.length; index += 1) {
      if (input[index] === "\x07") {
        return index;
      }
      if (input[index] === "\x1b" && input[index + 1] === "\\") {
        return index + 1;
      }
    }
    return input.length - 1;
  }

  if (kind !== "[") {
    return startIndex + 1;
  }

  let endIndex = startIndex + 2;
  while (endIndex < input.length) {
    const code = input.charCodeAt(endIndex);
    if (code >= 0x40 && code <= 0x7e) {
      break;
    }
    endIndex += 1;
  }
  if (endIndex >= input.length) {
    return input.length - 1;
  }

  applyCsiSequence(input.slice(startIndex + 2, endIndex), input[endIndex], actions);
  return endIndex;
}

function applyCsiSequence(rawParams, finalChar, actions) {
  const params = parseCsiParams(rawParams);
  const count = params[0] || 1;
  if (finalChar === "C") {
    actions.cursorForward(count);
  } else if (finalChar === "D") {
    actions.cursorBackward(count);
  } else if (finalChar === "A") {
    actions.cursorUp(count);
  } else if (finalChar === "B") {
    actions.cursorDown(count);
  } else if (finalChar === "G") {
    actions.cursorColumn(Math.max(0, count - 1));
  } else if (finalChar === "H" || finalChar === "f") {
    actions.cursorPosition(Math.max(0, (params[0] || 1) - 1), Math.max(0, (params[1] || 1) - 1));
  } else if (finalChar === "K") {
    actions.eraseLine(params[0] || 0);
  } else if (finalChar === "J") {
    actions.eraseDisplay(params[0] || 0);
  }
}

function parseCsiParams(rawParams) {
  return String(rawParams || "")
    .replace(/[?<>=]/g, "")
    .split(/[;:]/)
    .map((part) => {
      const number = Number(part);
      return Number.isFinite(number) ? number : 0;
    });
}

function ensureLine(lines, row) {
  while (lines.length <= row) {
    lines.push([]);
  }
  return lines[row];
}

function writeTerminalChar(lines, row, col, char) {
  const line = ensureLine(lines, row);
  while (line.length < col) {
    line.push(" ");
  }
  line[col] = char;
}

function lineToString(line) {
  let text = "";
  for (let index = 0; index < line.length; index += 1) {
    text += line[index] || " ";
  }
  return text.replace(/[ \t]+$/g, "");
}

function extractBoardPromptSignature(output) {
  const lines = normalizeBoardOutput(output)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : "";
}

function outputEndsWithBoardPrompt(output, prompt) {
  const expected = String(prompt || "").trim();
  if (!expected) {
    return false;
  }
  return extractBoardPromptSignature(output) === expected;
}

function buildBoardLogPath(pane) {
  const safeName = [
    pane.session || "tmux",
    pane.windowIndex || "window",
    pane.paneIndex || "pane",
    pane.id || ""
  ].join("_").replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(BOARD_LOG_DIR, `${safeName}.log`);
}

function getFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function getEnvClampedNumber(name, min, max, fallback) {
  return clampNumber(process.env[name], min, max, fallback);
}

function getVisionHelperPath() {
  return process.env.AI_CHAT_SHELL_VISION_HELPER || DEFAULT_VISION_HELPER_PATH;
}

function getVisionAvailability() {
  const helperPath = getVisionHelperPath();
  const helperOverride = Boolean(process.env.AI_CHAT_SHELL_VISION_HELPER);
  if (os.platform() !== "darwin" && !helperOverride) {
    return {
      available: false,
      errorCode: "non-macos",
      error: "macOS vision control is only available on macOS."
    };
  }
  if (!fs.existsSync(helperPath)) {
    return {
      available: false,
      errorCode: "helper-missing",
      error: `macOS vision helper is not built at ${helperPath}. Run ./scripts/build_macos_vision_helper.sh.`
    };
  }
  return {
    available: true,
    helperPath
  };
}

function parseVisionWindowId(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new VisionValidationError("invalid-window-id", "Missing or invalid windowId.");
  }
  return number;
}

function validateVisionAppName(value) {
  const appName = String(value || "").trim();
  if (!appName) {
    throw new VisionValidationError("invalid-app-name", "Missing appName.");
  }
  if (appName.length > 128 || /[\x00-\x1f\x7f]/.test(appName)) {
    throw new VisionValidationError("invalid-app-name", "Vision appName is invalid.");
  }
  return appName;
}

function validateVisionTextInput(value) {
  const text = String(value || "");
  if (!text) {
    throw new VisionValidationError("invalid-text", "Missing text.");
  }
  if (text.length > VISION_INPUT_MAX_CHARS) {
    throw new VisionValidationError("input-too-long", `Vision text input is too long (${text.length} chars, max ${VISION_INPUT_MAX_CHARS}).`);
  }
  if (/[\x00-\x1f\x7f]/.test(text)) {
    throw new VisionValidationError("unsafe-control-char", "Vision text input must not contain control characters. Use vision-key for Enter, Tab, Escape, Backspace, PageDown, PageUp, or Ctrl-C.");
  }
  return text;
}

function validateVisionKey(value) {
  const key = String(value || "").toLowerCase();
  if (!VISION_ALLOWED_KEYS.has(key)) {
    throw new VisionValidationError("invalid-key", `Unsupported vision key: ${value || ""}.`);
  }
  return key;
}

function getVisionImageRef(message) {
  if (message.imagePath) {
    return String(message.imagePath);
  }
  const base64 = message.imageBase64 || message.image?.base64 || message.image || "";
  if (!base64) {
    throw new VisionValidationError("invalid-image", "Missing imagePath, imageBase64, or image.base64.");
  }
  fs.mkdirSync(VISION_TMP_DIR, { recursive: true });
  const dir = fs.mkdtempSync(path.join(VISION_TMP_DIR, "ocr-"));
  const imagePath = path.join(dir, "input.png");
  const text = String(base64);
  const stripped = text.includes(",") && text.slice(0, text.indexOf(",")).includes("base64")
    ? text.slice(text.indexOf(",") + 1)
    : text;
  fs.writeFileSync(imagePath, Buffer.from(stripped, "base64"));
  return imagePath;
}

function ensureVisionOk(response) {
  if (!response || response.ok === false) {
    return {
      ok: false,
      errorCode: response?.errorCode || "vision-helper-failed",
      error: response?.error || "macOS vision helper failed.",
      ...response
    };
  }
  return response;
}

function ensureVisionWindowResponse(response, { appName = "" } = {}) {
  if (response.ok === false) {
    return response;
  }
  if (!response.window && !response.windowId && !response.appName) {
    return visionError("invalid-window-response", "macOS vision helper did not return target window metadata.", { response });
  }
  const windowInfo = response.window || response;
  const expectedAppName = appName ? validateVisionAppName(appName) : "";
  if (expectedAppName && windowInfo.appName !== expectedAppName) {
    return visionError("unexpected-window-app", `Target window belongs to ${windowInfo.appName || "(unknown)"}, not ${expectedAppName}.`, { window: windowInfo });
  }
  return response;
}

async function runVisionHelper(args, { timeoutMs = 15000, maxOutputChars = 0 } = {}) {
  const availability = getVisionAvailability();
  if (!availability.available) {
    return visionError(availability.errorCode, availability.error);
  }
  const outputLimit = maxOutputChars || (args[0] === "capture" ? 25 * 1024 * 1024 : 1000000);
  const result = await runCommandRaw(getVisionHelperPath(), args, { timeoutMs, maxOutputChars: outputLimit });
  const stdout = String(result.stdout || "").trim();
  let parsed;
  try {
    parsed = stdout ? JSON.parse(stdout) : {};
  } catch {
    return visionError("invalid-helper-json", "macOS vision helper returned invalid JSON.", {
      stdout: stdout.slice(0, 2000),
      stderr: String(result.stderr || "").slice(0, 2000),
      exitCode: result.exitCode,
      timedOut: result.timedOut
    });
  }
  if (result.timedOut) {
    return visionError("helper-timeout", "macOS vision helper timed out.", parsed);
  }
  if (result.exitCode !== 0 || parsed.ok === false) {
    return {
      ok: false,
      errorCode: parsed.errorCode || "vision-helper-failed",
      error: parsed.error || result.stderr || `macOS vision helper exited with ${result.exitCode}.`,
      exitCode: result.exitCode,
      ...parsed
    };
  }
  return parsed;
}

function visionError(errorCode, error, extra = {}) {
  return {
    ok: false,
    errorCode: errorCode || "vision-error",
    error: error || "Vision control failed.",
    ...extra
  };
}

class VisionValidationError extends Error {
  constructor(errorCode, message) {
    super(message);
    this.errorCode = errorCode;
  }
}

function chooseVisionSelfTestPane(target, panes) {
  if (target) {
    return resolveTmuxTarget(normalizeTmuxTarget(target), panes);
  }
  return panes.find((pane) => pane.active) || panes[0] || null;
}

function randomOcrSafeToken(length) {
  const alphabet = "ACEFHJKLMNPRTUVWXYZ";
  const bytes = crypto.randomBytes(length);
  let token = "";
  for (let index = 0; index < length; index += 1) {
    token += alphabet[bytes[index] % alphabet.length];
  }
  return token;
}

async function waitForVisionTerminalWindow(titleToken, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listed = ensureVisionOk(await runVisionHelper(["list-windows"], { timeoutMs: 5000 }));
    if (listed.ok === false) {
      return null;
    }
    const windows = Array.isArray(listed.windows) ? listed.windows : [];
    const matched = windows.find((windowInfo) => {
      return windowInfo?.appName === "Terminal" && String(windowInfo.title || "").includes(titleToken);
    });
    if (matched) {
      return matched;
    }
    await sleep(250);
  }
  return null;
}

async function getVisionTerminalWindowById(windowId) {
  return getVisionWindowById(windowId, { appName: "Terminal" });
}

async function getVisionWindowById(windowId, { appName = "" } = {}) {
  const args = ["list-windows"];
  if (appName) {
    args.push("--app", validateVisionAppName(appName));
  }
  const listed = ensureVisionOk(await runVisionHelper(args, { timeoutMs: 5000 }));
  if (listed.ok === false) {
    return null;
  }
  const windows = Array.isArray(listed.windows) ? listed.windows : [];
  return windows.find((windowInfo) => {
    return Number(windowInfo?.windowId) === Number(windowId)
      && (!appName || windowInfo?.appName === appName);
  }) || null;
}

async function ocrVisionCapture(captureResponse) {
  const base64 = captureResponse?.image?.base64 || "";
  if (!base64) {
    return visionError("capture-missing-image", "Vision capture did not include an image.");
  }
  return ensureVisionOk(await runVisionHelper(["ocr", "--image", getVisionImageRef({ imageBase64: base64 })]));
}

function visionOcrText(ocrResponse) {
  return visionOcrRows(ocrResponse).map((row) => row.text).join("\n");
}

function visionOcrStatusText(ocrResponse) {
  const rows = visionOcrRows(ocrResponse);
  if (!rows.length) {
    return "";
  }
  const imageHeight = Number(ocrResponse?.image?.height || 0);
  const bottomRows = imageHeight > 0
    ? rows.filter((row) => row.centerY >= imageHeight * 0.82)
    : [];
  const candidates = bottomRows.length ? bottomRows : rows.slice(-3);
  return candidates.map((row) => row.text).join("\n");
}

function visionOcrOutputText(ocrResponse) {
  const rows = visionOcrRows(ocrResponse);
  if (!rows.length) {
    return "";
  }
  const imageWidth = Number(ocrResponse?.image?.width || 0);
  const imageHeight = Number(ocrResponse?.image?.height || 0);
  const topOverlayY = imageHeight > 0 ? Math.max(180, imageHeight * 0.085) : 180;
  const bottomStatusY = imageHeight > 0 ? imageHeight * 0.94 : Number.POSITIVE_INFINITY;

  return rows
    .map((row) => {
      const items = Array.isArray(row.items) && row.items.length ? row.items : [row];
      const keptItems = items.filter((item) => {
        const text = String(item.text || "").trim();
        if (!text) {
          return false;
        }
        if (
          imageHeight > 0
          && item.centerY >= bottomStatusY
          && (/^\[/.test(text) || /\d{1,2}:\d{2}\s+\d{2}-[A-Za-z]{3}-\d{2}/.test(text))
        ) {
          return false;
        }
        if (
          imageHeight > 1000
          && item.centerY <= Math.max(140, imageHeight * 0.07)
          && item.x > 50
          && /^tmux\b/i.test(text)
        ) {
          return false;
        }
        if (
          imageWidth > 0
          && imageHeight > 1000
          && item.centerY <= topOverlayY
          && item.x >= imageWidth * 0.45
          && /^\d{1,2}:\d{2}(?::\d{2})?(?:\s+\[\d+\/\d+\])?$/.test(text)
        ) {
          return false;
        }
        return true;
      });
      return visionOcrRowText(keptItems.sort((a, b) => a.x - b.x));
    })
    .filter((text) => text.trim())
    .join("\n");
}

function visionOcrRows(ocrResponse) {
  if (!ocrResponse || ocrResponse.ok === false || !Array.isArray(ocrResponse.results)) {
    return [];
  }

  const items = ocrResponse.results
    .map(normalizeVisionOcrItem)
    .filter(Boolean)
    .sort((a, b) => a.centerY - b.centerY || a.x - b.x);
  if (!items.length) {
    return [];
  }

  const heights = items.map((item) => item.height).filter((height) => height > 0);
  const medianHeight = medianNumber(heights) || 12;
  const rows = [];
  for (const item of items) {
    const row = rows.find((candidate) => {
      const tolerance = Math.max(4, medianHeight * 0.65, Math.max(candidate.height, item.height) * 0.6);
      return Math.abs(candidate.centerY - item.centerY) <= tolerance;
    });
    if (row) {
      row.items.push(item);
      row.minY = Math.min(row.minY, item.y);
      row.maxY = Math.max(row.maxY, item.y + item.height);
      row.height = Math.max(row.height, item.height);
      row.centerY = row.items.reduce((sum, value) => sum + value.centerY, 0) / row.items.length;
    } else {
      rows.push({
        items: [item],
        minY: item.y,
        maxY: item.y + item.height,
        height: item.height,
        centerY: item.centerY
      });
    }
  }

  return rows
    .sort((a, b) => a.centerY - b.centerY)
    .map((row) => {
      const sortedItems = row.items.sort((a, b) => a.x - b.x);
      return {
        x: sortedItems[0]?.x || 0,
        y: row.minY,
        width: sortedItems.reduce((max, item) => Math.max(max, item.x + item.width), 0) - (sortedItems[0]?.x || 0),
        height: row.maxY - row.minY,
        centerY: row.centerY,
        text: visionOcrRowText(sortedItems),
        items: sortedItems
      };
    })
    .filter((row) => row.text);
}

function normalizeVisionOcrItem(item) {
  const text = String(item?.text || "").replace(/\s+/g, " ").trim();
  const bbox = item?.bbox || {};
  const x = Number(bbox.x);
  const y = Number(bbox.y);
  const width = Number(bbox.width);
  const height = Number(bbox.height);
  if (!text || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  return {
    text,
    x,
    y,
    width: Math.max(0, width),
    height: Math.max(0, height),
    centerY: y + Math.max(0, height) / 2
  };
}

function visionOcrRowText(items) {
  if (!items.length) {
    return "";
  }
  const charWidths = items
    .map((item) => item.width / Math.max(1, item.text.length))
    .filter((width) => Number.isFinite(width) && width > 0);
  const medianCharWidth = medianNumber(charWidths) || 8;
  let text = "";
  let previous = null;
  for (const item of items) {
    if (previous) {
      const gap = item.x - (previous.x + previous.width);
      if (gap > medianCharWidth * 1.5) {
        const spaces = Math.max(1, Math.min(12, Math.round(gap / medianCharWidth)));
        text += " ".repeat(spaces);
      } else if (gap > 1 && text && !text.endsWith(" ")) {
        text += " ";
      }
    }
    text += item.text;
    previous = item;
  }
  return text.trimEnd();
}

function medianNumber(values) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2) {
    return sorted[midpoint];
  }
  return (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function visionTextIncludes(text, token) {
  const compactText = normalizeOcrTokenText(text);
  const compactToken = normalizeOcrTokenText(token);
  return compactText.includes(compactToken);
}

function normalizeOcrTokenText(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function waitForTmuxPaneText(target, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  while (Date.now() < deadline) {
    lastText = await captureTmuxPaneText(target);
    if (visionTextIncludes(lastText, needle)) {
      return lastText;
    }
    await sleep(250);
  }
  return lastText;
}

async function captureTmuxPaneText(target) {
  const result = await runTmuxCommand(["capture-pane", "-p", "-J", "-S", "-200", "-t", target], { timeoutMs: 5000 });
  return result.stdout || "";
}

function runTmuxCommand(args, options) {
  return runCommand("tmux", buildTmuxCommandArgs(args), options);
}

function runTmuxCommandRaw(args, options) {
  return runCommandRaw("tmux", buildTmuxCommandArgs(args), options);
}

function buildTmuxCommandArgs(args, socketPath = getTmuxSocketPath()) {
  return socketPath ? ["-S", socketPath, ...args] : args;
}

function getTmuxSocketPath() {
  const configured = process.env.AI_CHAT_SHELL_TMUX_SOCKET;
  if (configured) {
    return configured;
  }

  const tmuxEnvSocket = getTmuxEnvSocketPath(process.env.TMUX);
  if (tmuxEnvSocket) {
    return tmuxEnvSocket;
  }

  return detectDefaultTmuxSocketPath();
}

function getTmuxEnvSocketPath(tmuxEnv) {
  const socketPath = String(tmuxEnv || "").split(",")[0];
  return socketPath && socketExists(socketPath) ? socketPath : "";
}

function detectDefaultTmuxSocketPath() {
  if (typeof process.getuid !== "function") {
    return "";
  }

  const uid = process.getuid();
  const candidates = [
    `/private/tmp/tmux-${uid}/default`,
    `/tmp/tmux-${uid}/default`,
    path.join(os.tmpdir(), `tmux-${uid}`, "default")
  ];
  return candidates.find(socketExists) || "";
}

function socketExists(socketPath) {
  try {
    return fs.existsSync(socketPath);
  } catch {
    return false;
  }
}

function extractTmuxRunOutput(captured, startMarker, doneMarker, maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS) {
  const lines = String(captured || "").split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.includes(startMarker));
  if (startIndex < 0) {
    return {
      foundStart: false,
      foundDone: false,
      exitCode: 124,
      stdout: "",
      truncated: false
    };
  }

  const doneIndex = lines.findIndex((line, index) => index > startIndex && line.includes(doneMarker));
  const endIndex = doneIndex >= 0 ? doneIndex : lines.length;
  const output = lines.slice(startIndex + 1, endIndex).join("\n").replace(/\n+$/, "");
  const stdout = appendLimited("", output, maxOutputChars);
  const doneLine = doneIndex >= 0 ? lines[doneIndex] : "";
  const exitMatch = doneLine.match(new RegExp(`${escapeRegExp(doneMarker)}:(\\d+)`));

  return {
    foundStart: true,
    foundDone: doneIndex >= 0,
    exitCode: exitMatch ? Number(exitMatch[1]) : 124,
    stdout,
    truncated: output.length > stdout.length
  };
}

function runCommandRaw(command, args, { timeoutMs = 5000, maxOutputChars = 1000000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk.toString("utf8"), maxOutputChars);
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString("utf8"), maxOutputChars);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      const message = `${stderr}${stderr ? "\n" : ""}${error.message}`;
      resolve({ ok: false, stdout, stderr: message, exitCode: 127, timedOut });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const exitCode = Number.isInteger(code) ? code : 128;
      resolve({ ok: exitCode === 0 && !timedOut, stdout, stderr, exitCode, signal, timedOut });
    });
  });
}

function runCommand(command, args, { timeoutMs = 5000 } = {}) {
  return runCommandRaw(command, args, { timeoutMs }).then((result) => {
    if (!result.ok) {
      const detail = result.stderr || `${command} ${args.join(" ")} exited with ${result.exitCode}`;
      throw new Error(detail.trim());
    }
    return result;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeTextFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (buffer.length - offset < 2) {
      break;
    }

    const frameStart = offset;
    const opcode = buffer[offset] & 0x0f;
    offset += 1;

    if (opcode === 0x8) {
      return { messages, remaining: Buffer.alloc(0) };
    }
    if (opcode !== 0x1) {
      throw new Error("Only complete text WebSocket frames are supported.");
    }

    const masked = Boolean(buffer[offset] & 0x80);
    let length = buffer[offset] & 0x7f;
    offset += 1;

    if (length === 126) {
      if (buffer.length - offset < 2) {
        offset = frameStart;
        break;
      }
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length - offset < 8) {
        offset = frameStart;
        break;
      }
      const high = buffer.readUInt32BE(offset);
      const low = buffer.readUInt32BE(offset + 4);
      offset += 8;
      if (high !== 0) {
        throw new Error("WebSocket frame is too large.");
      }
      length = low;
    }

    let mask;
    if (masked) {
      if (buffer.length - offset < 4) {
        offset = frameStart;
        break;
      }
      mask = buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buffer.length - offset < length) {
      offset = frameStart;
      break;
    }

    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    offset += length;

    if (masked) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= mask[i % 4];
      }
    }

    messages.push(payload.toString("utf8"));
  }

  return {
    messages,
    remaining: offset < buffer.length ? buffer.subarray(offset) : Buffer.alloc(0)
  };
}

function encodeTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  let header;

  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(payload.length, 6);
  }

  return Buffer.concat([header, payload]);
}

function appendLimited(current, next, limit) {
  if (current.length >= limit) {
    return current;
  }

  const combined = current + next;
  if (combined.length <= limit) {
    return combined;
  }

  return combined.slice(0, limit);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function hashText(input) {
  return crypto
    .createHash("sha256")
    .update(String(input || ""))
    .digest("hex")
    .slice(0, 32);
}

function resolveCwd(rawCwd, fallbackCwd = "") {
  if (!rawCwd) {
    return fallbackCwd || os.homedir();
  }

  const expanded = String(rawCwd).replace(/^~(?=$|\/)/, os.homedir());
  const resolved = path.resolve(expanded);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`cwd is not a directory: ${resolved}`);
  }
  return resolved;
}

module.exports = {
  HELPER_PROTOCOL_VERSION,
  SERVER_PROTOCOL_VERSION,
  buildBoardHelperExample,
  buildBoardLogPath,
  buildBoardTargetErrorResponse,
  buildHealthResponse,
  buildDefaultTargetErrorResponse,
  buildTmuxCommandArgs,
  buildMissingTargetResponse,
  cleanVisionTmuxOcrText,
  decodeTextFrames,
  detectDefaultTmuxSocketPath,
  encodeTextFrame,
  extractBoardPromptSignature,
  extractTmuxRunOutput,
  getDefaultStateDir,
  getStateDir,
  getStateStatus,
  getTmuxEnvSocketPath,
  getTmuxSocketPath,
  ensureForAiTmuxLayout,
  ensureStateDirReady,
  getForAiTmuxConfig,
  getProtocolMetadata,
  getReleaseVersion,
  getVisionAvailability,
  getVisionHelperPath,
  handleMessageText,
  handleVisionMessage,
  listTmuxPanes,
  normalizeBoardOutput,
  outputEndsWithBoardPrompt,
  parseTmuxPanes,
  prepareStateLogFile,
  readBoardLogFromOffset,
  resolveBoardPane,
  resolveDefaultShellPane,
  resolveDownloadsFilePath,
  resetForAiTmuxLayout,
  resolveTmuxTarget,
  runVisionTmuxOcrLine,
  runTmuxVisualLine,
  runTmuxBoard,
  runTmuxShell,
  startServer,
  stitchOcrPages,
  validateBoardCommand,
  validateVisionAppName,
  validateVisionTmuxCommand,
  validateVisionKey,
  validateVisionTextInput,
  visionOcrOutputText,
  visionOcrRows,
  visionOcrStatusText,
  visionOcrText,
  visionTextIncludes,
  writeDownloadsFile
};
