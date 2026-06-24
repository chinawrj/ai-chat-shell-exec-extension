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
const SERVER_PROTOCOL_VERSION = 4;
const HELPER_PROTOCOL_VERSION = 2;
const DEFAULT_STATE_DIR = getDefaultStateDir();
const STATE_DIR = resolveStateDir(process.env.AI_CHAT_SHELL_STATE_DIR || DEFAULT_STATE_DIR);
const TMUX_SCRIPT_DIR = path.join(STATE_DIR, "tmux-runs");
const BOARD_LOG_DIR = path.join(STATE_DIR, "board-panes");
const VISION_TMP_DIR = path.join(STATE_DIR, "vision");
const AGENT_REPLY_DIR = path.join(STATE_DIR, "agent-replies");
const LEDGER_PATH = path.join(STATE_DIR, "shell-ledger.json");
const STATE_STDOUT_LOG_PATH = path.join(STATE_DIR, "shell-server.out.log");
const STATE_STDERR_LOG_PATH = path.join(STATE_DIR, "shell-server.err.log");
const STATE_REQUIRED_SUBDIRS = ["tmux-runs", "board-panes", "vision", "agent-replies", "bin"];
const SERVER_LEDGER_LIMIT = 1000;
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
const VISION_TMUX_DEFAULT_APPS = ["Terminal", "Ghostty"];
const VISION_TMUX_RUN_PREFIX = "AIVR";
const VISION_TMUX_OCR_RUN_PREFIX = "AIVRRUN";
const VISION_TMUX_OCR_DONE_PREFIX = "AIVRDONE";
const VISION_TMUX_OCR_START_PREFIX = "AIVRSTART";
const VISION_TMUX_HISTORY_LIMIT = 200000;
const AGENT_ROSTER_TTL_MS = 60_000;
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_ROLES = new Set(["master", "slave"]);
const AGENT_SURFACES = new Set(["web", "tmux-ai"]);
const AGENT_REPLY_MODES = new Set(["poll", "cli"]);
const AGENT_MESSAGE_MAX_CHARS = 20000;
const AGENT_MAILBOX_LIMIT = 500;
let stateLoggingConfigured = false;
let stateLogStreams = null;
let serverLedger = loadServerLedger();
let agentHubState = createAgentHubState();

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
    visualProtocolVersion: 1,
    visualTmuxApps: getVisionTmuxAppNames(),
    executionBackend: "tmux"
  };
}

function buildHealthResponse() {
  const forAiConfig = getForAiTmuxConfigForHealth();
  const state = getStateStatus({ create: true });
  const visionAvailability = getVisionAvailability();
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
    visionAvailable: visionAvailability.available,
    visionErrorCode: visionAvailability.errorCode || "",
    visionError: visionAvailability.error || "",
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

  if (String(message.type).startsWith("agent-")) {
    return handleAgentHubMessageAsync(message);
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
  const config = getRunTmuxConfig(message);
  const layout = await ensureForAiTmuxLayout(config);
  const panes = layout.panes;
  const pane = resolveDefaultShellPane(panes, config).pane;
  if (!pane) {
    return buildDefaultTargetErrorResponse(message, cmd, panes, config);
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

  try {
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
      agentId: config.agentId || "",
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
  } catch (error) {
    failServerShellCall(callKey, error, { durationMs: Date.now() - started });
    throw error;
  }
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

  try {
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
  } catch (error) {
    failServerShellCall(callKey, error, { durationMs: Date.now() - started });
    throw error;
  }
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

  try {
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
  } catch (error) {
    failServerShellCall(callKey, error, { durationMs: Date.now() - started });
    throw error;
  }
}

function createAgentHubState() {
  return {
    roster: new Map(),
    mailbox: []
  };
}

function resetAgentHubForTests() {
  agentHubState = createAgentHubState();
}

function handleAgentHubMessage(message, now = Date.now()) {
  const type = String(message.type || "");
  pruneAgentRoster(now);

  if (type === "agent-register") {
    return registerAgent(message, now);
  }
  if (type === "agent-unregister") {
    const agentId = validateAgentId(message.agentId, "agentId");
    agentHubState.roster.delete(agentId);
    return {
      ok: true,
      type,
      agentId,
      agents: listAgents(now)
    };
  }
  if (type === "agent-list") {
    const pending = countPendingAgentMessages();
    return {
      ok: true,
      type,
      agents: listAgents(now, pending),
      pending
    };
  }
  if (type === "agent-send") {
    return sendAgentMessage(message, now);
  }
  if (type === "agent-task-status") {
    return getAgentTaskStatus(message, now);
  }
  if (type === "agent-reply") {
    return replyAgentMessage(message, now);
  }
  if (type === "agent-poll") {
    return pollAgentMessages(message, now);
  }
  if (type === "agent-ack") {
    return ackAgentMessage(message, now);
  }

  throw new Error(`Unsupported agent message type: ${type}`);
}

async function handleAgentHubMessageAsync(message, now = Date.now()) {
  ensureStateDirReady({ create: true });
  const type = String(message.type || "");
  pruneAgentRoster(now);

  if (type === "agent-register-tmux-ai") {
    return registerTmuxAiAgent(message, now);
  }
  if (type === "agent-list") {
    const pending = countPendingAgentMessages();
    return {
      ok: true,
      type,
      agents: await listAgentsWithTmuxStatus(now, pending),
      pending
    };
  }
  if (type === "agent-send") {
    return sendAgentMessageAsync(message, now);
  }
  return handleAgentHubMessage(message, now);
}

function registerAgent(message, now = Date.now()) {
  const agentId = validateAgentId(message.agentId, "agentId");
  const role = validateAgentRole(message.role);
  const agent = {
    agentId,
    role,
    surface: "web",
    replyMode: "poll",
    displayName: normalizeAgentDisplayName(message.displayName || agentId),
    origin: String(message.origin || "").slice(0, 512),
    pathname: String(message.pathname || "").slice(0, 1024),
    tabId: message.tabId === undefined || message.tabId === null ? "" : String(message.tabId).slice(0, 128),
    registeredAt: agentHubState.roster.get(agentId)?.registeredAt || now,
    lastSeenAt: now
  };
  agentHubState.roster.set(agentId, agent);
  return {
    ok: true,
    type: "agent-register",
    agent,
    agents: listAgents(now)
  };
}

async function registerTmuxAiAgent(message, now = Date.now()) {
  const agentId = validateAgentId(message.agentId, "agentId");
  const role = validateAgentRole(message.role);
  const target = normalizeTmuxTarget(message.target || message.tmuxTarget || "");
  if (!target) {
    return agentHubError("missing-tmux-target", "Missing tmux target for tmux-ai agent.", { type: "agent-register-tmux-ai", agentId });
  }
  const panes = await listTmuxPanes();
  const pane = resolveTmuxTarget(target, panes);
  if (!pane) {
    return agentHubError("tmux-target-not-found", `Tmux target not found or ambiguous: ${target}`, {
      type: "agent-register-tmux-ai",
      agentId,
      target,
      tmuxPanes: panes
    });
  }
  const agent = {
    agentId,
    role,
    surface: "tmux-ai",
    replyMode: "cli",
    displayName: normalizeAgentDisplayName(message.displayName || agentId),
    tmuxTarget: target,
    tmuxPaneId: pane.id,
    tmuxTargetName: pane.label,
    tmuxSession: pane.session,
    tmuxWindowName: pane.windowName,
    tmuxAddress: pane.address,
    registeredAt: agentHubState.roster.get(agentId)?.registeredAt || now,
    lastSeenAt: now
  };
  agentHubState.roster.set(agentId, agent);
  return {
    ok: true,
    type: "agent-register-tmux-ai",
    agent,
    agents: listAgents(now)
  };
}

function sendAgentMessage(message, now = Date.now()) {
  const from = validateAgentId(message.from || message.agentId, "from");
  const to = validateAgentId(message.to, "to");
  if (!touchAgent(from, now)) {
    return agentHubError("sender-not-registered", `Agent sender is not registered: ${from}`, { type: "agent-send", from });
  }
  const body = String(message.body || "");
  if (!body.trim()) {
    return agentHubError("missing-body", "Missing agent message body.", { type: "agent-send" });
  }
  if (body.length > AGENT_MESSAGE_MAX_CHARS) {
    return agentHubError("message-too-large", `Agent message body is too large (${body.length} chars, max ${AGENT_MESSAGE_MAX_CHARS}).`, { type: "agent-send" });
  }
  if (!agentHubState.roster.has(to)) {
    return agentHubError("recipient-not-registered", `Agent recipient is not registered: ${to}`, { type: "agent-send", to });
  }
  const recipient = agentHubState.roster.get(to);
  if (recipient?.surface === "tmux-ai") {
    return agentHubError("tmux-ai-send-requires-async", "tmux-ai delivery requires the async agent hub path.", { type: "agent-send", to });
  }

  const taskId = normalizeAgentTaskId(message.taskId || "");
  const messageId = normalizeAgentMessageId(message.messageId || `msg-${now}-${crypto.randomBytes(6).toString("hex")}`);
  if (agentHubState.mailbox.some((item) => item.messageId === messageId)) {
    return agentHubError("duplicate-message-id", `Agent message already exists: ${messageId}`, { type: "agent-send", messageId });
  }
  const replyTo = normalizeAgentMessageId(message.replyTo || "");
  const replyValidation = validatePollAgentReplyTo({ from, to, replyTo, taskId, now });
  if (!replyValidation.ok) {
    return replyValidation;
  }

  const envelope = {
    messageId,
    from,
    to,
    taskId,
    replyTo,
    body,
    createdAt: now,
    ackedAt: 0,
    deliverySurface: "web",
    replyMode: "poll"
  };
  agentHubState.mailbox.push(envelope);
  if (replyValidation.original) {
    replyValidation.original.repliedAt = now;
    replyValidation.original.replyMessageId = messageId;
  }
  pruneAgentMailbox();
  return {
    ok: true,
    type: "agent-send",
    message: envelope
  };
}

function validatePollAgentReplyTo({ from, to, replyTo, taskId, now }) {
  if (!replyTo) {
    return { ok: true, original: null };
  }
  const original = agentHubState.mailbox.find((item) => item.messageId === replyTo && item.deliverySurface !== "tmux-ai");
  if (!original) {
    return agentHubError("reply-target-not-found", `Reply target not found for ${from}: ${replyTo}`, { type: "agent-send", from, replyTo });
  }
  if (original.from !== to || original.to !== from) {
    return agentHubError("reply-recipient-mismatch", `Agent reply route must match original ${original.from}->${original.to}: ${from}->${to}`, {
      type: "agent-send",
      from,
      to,
      replyTo
    });
  }
  if (taskId && original.taskId && taskId !== original.taskId) {
    return agentHubError("reply-task-mismatch", `Agent reply task-id must match original task ${original.taskId}: ${taskId}`, {
      type: "agent-send",
      from,
      replyTo,
      taskId
    });
  }
  if (original.repliedAt) {
    return agentHubError("duplicate-reply", `Agent task already has a reply: ${replyTo}`, {
      type: "agent-send",
      from,
      replyTo,
      replyMessageId: original.replyMessageId || "",
      repliedAt: original.repliedAt || now
    });
  }
  return { ok: true, original };
}

function getAgentTaskStatus(message, now = Date.now()) {
  const agentId = validateAgentId(message.agentId || message.from, "agentId");
  if (!touchAgent(agentId, now)) {
    return agentHubError("sender-not-registered", `Agent is not registered: ${agentId}`, { type: "agent-task-status", agentId });
  }
  const messageId = normalizeAgentMessageId(message.messageId || "");
  const taskId = normalizeAgentTaskId(message.taskId || "");
  if (!messageId && !taskId) {
    return agentHubError("missing-message-id", "Missing messageId or taskId for task status.", { type: "agent-task-status", agentId });
  }
  const task = agentHubState.mailbox.find((item) =>
    (messageId && item.messageId === messageId || taskId && item.taskId === taskId) &&
    canInspectAgentTask(agentId, item)
  );
  if (!task) {
    return agentHubError("task-not-found", `Agent task not found for ${agentId}: ${messageId || taskId}`, { type: "agent-task-status", agentId, messageId, taskId });
  }
  const replyMessage = task.replyMessageId
    ? agentHubState.mailbox.find((item) => item.messageId === task.replyMessageId) || null
    : task.replyTo ? task : null;
  const status = getAgentTaskStatusName(task, replyMessage);
  return {
    ok: true,
    type: "agent-task-status",
    agentId,
    status,
    ageMs: Math.max(0, now - Number(task.createdAt || now)),
    message: task,
    replyMessage,
    nextAction: getAgentTaskStatusNextAction(status, task)
  };
}

function canInspectAgentTask(agentId, item) {
  return item.from === agentId || item.to === agentId ||
    (item.replyTo && agentHubState.mailbox.some((original) =>
      original.messageId === item.replyTo && (original.from === agentId || original.to === agentId)
    ));
}

function getAgentTaskStatusName(task, replyMessage) {
  if (task.replyTo) {
    return task.ackedAt ? "reply-acked" : "reply-waiting-for-master";
  }
  if (replyMessage) {
    return replyMessage.ackedAt ? "replied-and-acked" : "replied-waiting-for-master";
  }
  if (task.deliverySurface === "tmux-ai" && task.replyMode === "cli") {
    return task.repliedAt ? "replied-waiting-for-master" : "waiting-for-tmux-ai-reply";
  }
  if (!task.ackedAt) {
    return "waiting-for-recipient-poll";
  }
  return "delivered-waiting-for-reply";
}

function getAgentTaskStatusNextAction(status, task) {
  if (status === "waiting-for-recipient-poll") {
    return `Wait for ${task.to} to poll, or open that agent page and click Save/Check.`;
  }
  if (status === "delivered-waiting-for-reply") {
    return `Wait for ${task.to} to complete the task and send a reply-to ${task.messageId} result.`;
  }
  if (status === "waiting-for-tmux-ai-reply") {
    return "Keep the tmux-ai pane running. If it is stuck, inspect the pane and rerun the reply command from the task prompt.";
  }
  if (status === "replied-waiting-for-master" || status === "reply-waiting-for-master") {
    return "Open the master page and wait for polling, or click Check to verify the page is still registered.";
  }
  return "No action required unless the master needs another task.";
}

async function sendAgentMessageAsync(message, now = Date.now()) {
  const from = validateAgentId(message.from || message.agentId, "from");
  const to = validateAgentId(message.to, "to");
  const sender = agentHubState.roster.get(from);
  if (!sender) {
    return agentHubError("sender-not-registered", `Agent sender is not registered: ${from}`, { type: "agent-send", from });
  }
  touchAgent(from, now);
  const recipient = agentHubState.roster.get(to);
  if (!recipient) {
    return agentHubError("recipient-not-registered", `Agent recipient is not registered: ${to}`, { type: "agent-send", to });
  }
  if (recipient.surface !== "tmux-ai") {
    return sendAgentMessage(message, now);
  }

  const body = String(message.body || "");
  if (!body.trim()) {
    return agentHubError("missing-body", "Missing agent message body.", { type: "agent-send" });
  }
  if (body.length > AGENT_MESSAGE_MAX_CHARS) {
    return agentHubError("message-too-large", `Agent message body is too large (${body.length} chars, max ${AGENT_MESSAGE_MAX_CHARS}).`, { type: "agent-send" });
  }
  const taskId = normalizeAgentTaskId(message.taskId || "");
  const messageId = normalizeAgentMessageId(message.messageId || `msg-${now}-${crypto.randomBytes(6).toString("hex")}`);
  if (agentHubState.mailbox.some((item) => item.messageId === messageId)) {
    return agentHubError("duplicate-message-id", `Agent message already exists: ${messageId}`, { type: "agent-send", messageId });
  }

  const delivery = await deliverTmuxAiTask({ sender, recipient, body, taskId, messageId, now });
  if (!delivery.ok) {
    return delivery;
  }

  const envelope = {
    messageId,
    from,
    to,
    taskId,
    body,
    createdAt: now,
    ackedAt: now,
    deliveredAt: now,
    deliverySurface: "tmux-ai",
    replyMode: "cli",
    replyBodyFile: delivery.replyBodyFile,
    tmuxPaneId: delivery.tmuxPaneId,
    tmuxTargetName: delivery.tmuxTargetName,
    repliedAt: 0,
    replyMessageId: ""
  };
  agentHubState.mailbox.push(envelope);
  pruneAgentMailbox();
  return {
    ok: true,
    type: "agent-send",
    message: envelope,
    delivery: {
      surface: "tmux-ai",
      status: "delivered",
      replyMode: "cli",
      tmuxPaneId: delivery.tmuxPaneId,
      tmuxTargetName: delivery.tmuxTargetName,
      replyBodyFile: delivery.replyBodyFile,
      replyScriptFile: delivery.replyScriptFile,
      replyCommand: delivery.replyCommand,
      fullReplyCommand: delivery.fullReplyCommand,
      nextStep: delivery.nextStep
    }
  };
}

async function deliverTmuxAiTask({ sender, recipient, body, taskId, messageId, now }) {
  const panes = await listTmuxPanes();
  const pane = resolveTmuxTarget(recipient.tmuxPaneId || recipient.tmuxTarget, panes);
  if (!pane) {
    markTmuxAiAgentStale(recipient, now, "registered tmux pane is no longer available");
    return agentHubError("tmux-target-unavailable", `Tmux target is no longer available for ${recipient.agentId}: ${recipient.tmuxTarget || recipient.tmuxPaneId || ""}`, {
      type: "agent-send",
      to: recipient.agentId,
      tmuxTarget: recipient.tmuxTarget || "",
      tmuxPaneId: recipient.tmuxPaneId || "",
      tmuxPanes: panes
    });
  }
  recipient.tmuxPaneId = pane.id;
  recipient.tmuxTargetName = pane.label;
  recipient.tmuxSession = pane.session;
  recipient.tmuxWindowName = pane.windowName;
  recipient.tmuxAddress = pane.address;
  recipient.stale = false;
  recipient.staleReason = "";
  recipient.lastSeenAt = now;

  const replyBodyFile = path.join(AGENT_REPLY_DIR, `${safeFilePart(messageId)}-${safeFilePart(recipient.agentId)}.md`);
  const fullReplyCommand = buildAgentReplyCommand({
    from: recipient.agentId,
    to: sender.agentId,
    taskId,
    replyTo: messageId,
    bodyFile: replyBodyFile
  });
  const replyScriptFile = path.join(AGENT_REPLY_DIR, `${safeFilePart(messageId)}-${safeFilePart(recipient.agentId)}-reply.sh`);
  writeAgentReplyScript(replyScriptFile, fullReplyCommand);
  const replyCommand = `sh ${shellQuote(replyScriptFile)}`;
  const prompt = buildTmuxAiTaskPrompt({
    from: sender.agentId,
    to: recipient.agentId,
    role: recipient.role,
    taskId,
    messageId,
    body,
    replyBodyFile,
    replyCommand
  });
  await sendTextToTmuxPane(pane.id, prompt);
  return {
    ok: true,
    tmuxPaneId: pane.id,
    tmuxTargetName: pane.label,
    replyBodyFile,
    replyScriptFile,
    replyCommand,
    fullReplyCommand,
    nextStep: `The tmux AI must write its final answer to ${replyBodyFile}, then run the short reply script command ${replyCommand}.`
  };
}

function replyAgentMessage(message, now = Date.now()) {
  const from = validateAgentId(message.from || message.agentId, "from");
  const to = validateAgentId(message.to, "to");
  const sender = agentHubState.roster.get(from);
  if (!sender) {
    return agentHubError("sender-not-registered", `Agent sender is not registered: ${from}`, { type: "agent-reply", from });
  }
  if (sender.surface !== "tmux-ai") {
    return agentHubError("sender-not-tmux-ai", `Agent reply sender must be a tmux-ai agent: ${from}`, { type: "agent-reply", from });
  }
  touchAgent(from, now);
  if (!agentHubState.roster.has(to)) {
    return agentHubError("recipient-not-registered", `Agent recipient is not registered: ${to}`, { type: "agent-reply", to });
  }
  const body = String(message.body || "");
  if (!body.trim()) {
    return agentHubError("missing-body", "Missing agent reply body.", { type: "agent-reply" });
  }
  if (body.length > AGENT_MESSAGE_MAX_CHARS) {
    return agentHubError("message-too-large", `Agent reply body is too large (${body.length} chars, max ${AGENT_MESSAGE_MAX_CHARS}).`, { type: "agent-reply" });
  }
  const replyTo = normalizeAgentMessageId(message.replyTo || "");
  if (!replyTo) {
    return agentHubError("missing-reply-to", "Missing replyTo message id.", { type: "agent-reply", from });
  }
  const original = agentHubState.mailbox.find((item) => item.messageId === replyTo && item.to === from && item.deliverySurface === "tmux-ai");
  if (!original) {
    return agentHubError("reply-target-not-found", `Reply target not found for ${from}: ${replyTo}`, { type: "agent-reply", from, replyTo });
  }
  if (to !== original.from) {
    return agentHubError("reply-recipient-mismatch", `Agent reply recipient must match original sender ${original.from}: ${to}`, {
      type: "agent-reply",
      from,
      to,
      replyTo
    });
  }
  const taskId = normalizeAgentTaskId(message.taskId || original.taskId || "");
  if (message.taskId && original.taskId && taskId !== original.taskId) {
    return agentHubError("reply-task-mismatch", `Agent reply task-id must match original task ${original.taskId}: ${taskId}`, {
      type: "agent-reply",
      from,
      replyTo,
      taskId
    });
  }
  if (original.repliedAt) {
    return agentHubError("duplicate-reply", `Agent task already has a reply: ${replyTo}`, {
      type: "agent-reply",
      from,
      replyTo,
      replyMessageId: original.replyMessageId || ""
    });
  }
  const messageId = normalizeAgentMessageId(message.messageId || `reply-${now}-${crypto.randomBytes(6).toString("hex")}`);
  if (agentHubState.mailbox.some((item) => item.messageId === messageId)) {
    return agentHubError("duplicate-message-id", `Agent message already exists: ${messageId}`, { type: "agent-reply", messageId });
  }
  const envelope = {
    messageId,
    from,
    to,
    taskId,
    replyTo,
    body,
    createdAt: now,
    ackedAt: 0,
    deliverySurface: "web",
    replyMode: "poll"
  };
  agentHubState.mailbox.push(envelope);
  original.repliedAt = now;
  original.replyMessageId = messageId;
  pruneAgentMailbox();
  return {
    ok: true,
    type: "agent-reply",
    message: envelope,
    repliedTo: replyTo,
    repliedAt: now
  };
}

function pollAgentMessages(message, now = Date.now()) {
  const agentId = validateAgentId(message.agentId, "agentId");
  const limit = clampNumber(message.limit, 1, 100, 20);
  const registered = touchAgent(agentId, now);
  const messages = agentHubState.mailbox
    .filter((item) => item.to === agentId && !item.ackedAt)
    .slice(0, limit);
  return {
    ok: true,
    type: "agent-poll",
    agentId,
    registered,
    now,
    messages
  };
}

function ackAgentMessage(message, now = Date.now()) {
  const agentId = validateAgentId(message.agentId, "agentId");
  const messageId = normalizeAgentMessageId(message.messageId || "");
  if (!messageId) {
    return agentHubError("missing-message-id", "Missing agent messageId.", { type: "agent-ack", agentId });
  }
  const item = agentHubState.mailbox.find((candidate) => candidate.messageId === messageId && candidate.to === agentId);
  if (!item) {
    return agentHubError("message-not-found", `Agent message not found for ${agentId}: ${messageId}`, { type: "agent-ack", agentId, messageId });
  }
  item.ackedAt = now;
  return {
    ok: true,
    type: "agent-ack",
    agentId,
    messageId,
    ackedAt: now
  };
}

function listAgents(now = Date.now(), pending = countPendingAgentMessages()) {
  pruneAgentRoster(now);
  return Array.from(agentHubState.roster.values())
    .sort((a, b) => a.agentId.localeCompare(b.agentId))
    .map((agent) => ({
      ...agent,
      pendingCount: pending[agent.agentId] || 0,
      lastSeenAgeMs: Math.max(0, now - Number(agent.lastSeenAt || now)),
      canReceiveTask: agent.role === "slave" && agent.stale !== true,
      capabilities: getAgentCapabilities(agent)
    }));
}

async function listAgentsWithTmuxStatus(now = Date.now(), pending = countPendingAgentMessages()) {
  const tmuxAgents = Array.from(agentHubState.roster.values()).filter((agent) => agent.surface === "tmux-ai");
  if (tmuxAgents.length === 0) {
    return listAgents(now, pending);
  }
  let panes = [];
  try {
    panes = await listTmuxPanes();
  } catch (error) {
    for (const agent of tmuxAgents) {
      markTmuxAiAgentStale(agent, now, `tmux pane list failed: ${error.message || String(error)}`);
    }
    return listAgents(now, pending);
  }
  for (const agent of tmuxAgents) {
    const pane = resolveTmuxTarget(agent.tmuxPaneId || agent.tmuxTarget || agent.tmuxAddress || "", panes);
    if (!pane) {
      markTmuxAiAgentStale(agent, now, "registered tmux pane is no longer available");
      continue;
    }
    agent.stale = false;
    agent.staleReason = "";
    agent.tmuxPaneId = pane.id;
    agent.tmuxTargetName = pane.label;
    agent.tmuxSession = pane.session;
    agent.tmuxWindowName = pane.windowName;
    agent.tmuxAddress = pane.address;
    agent.lastSeenAt = now;
  }
  return listAgents(now, pending);
}

function markTmuxAiAgentStale(agent, now = Date.now(), reason = "tmux pane unavailable") {
  if (!agent || agent.surface !== "tmux-ai") {
    return;
  }
  agent.stale = true;
  agent.staleReason = reason;
  agent.lastTmuxCheckAt = now;
}

function getAgentCapabilities(agent) {
  const capabilities = ["agent-message"];
  if (agent.role === "slave") {
    capabilities.push("receive-task", "reply-to-master");
  }
  if (agent.surface === "web") {
    capabilities.push("poll-delivery", "per-agent-shell-workspace");
  }
  if (agent.surface === "tmux-ai") {
    capabilities.push("tmux-prompt-delivery", "reply-file", "short-reply-script");
  }
  return capabilities;
}

function pruneAgentRoster(now = Date.now()) {
  for (const [agentId, agent] of agentHubState.roster.entries()) {
    if (agent.surface === "tmux-ai") {
      continue;
    }
    if (now - Number(agent.lastSeenAt || 0) > AGENT_ROSTER_TTL_MS) {
      agentHubState.roster.delete(agentId);
    }
  }
}

function touchAgent(agentId, now = Date.now()) {
  const agent = agentHubState.roster.get(agentId);
  if (!agent) {
    return false;
  }
  agent.lastSeenAt = now;
  return true;
}

function pruneAgentMailbox() {
  agentHubState.mailbox = pruneAgentMailboxItems(agentHubState.mailbox, AGENT_MAILBOX_LIMIT);
}

function pruneAgentMailboxItems(mailbox, limit = AGENT_MAILBOX_LIMIT) {
  if (!Array.isArray(mailbox) || mailbox.length <= limit) {
    return Array.isArray(mailbox) ? mailbox : [];
  }
  const replyPendingTmuxAiTasks = mailbox.filter(isReplyPendingTmuxAiTask);
  const protectedMessageIds = new Set(replyPendingTmuxAiTasks.map((item) => item.messageId));
  const unacked = mailbox.filter((item) => !item.ackedAt && !protectedMessageIds.has(item.messageId));
  const acked = mailbox.filter((item) => item.ackedAt && !protectedMessageIds.has(item.messageId));
  return [
    ...replyPendingTmuxAiTasks,
    ...acked.slice(Math.max(0, acked.length - Math.floor(limit / 4))),
    ...unacked.slice(Math.max(0, unacked.length - limit))
  ];
}

function isReplyPendingTmuxAiTask(item) {
  return item?.deliverySurface === "tmux-ai" &&
    item.replyMode === "cli" &&
    !item.repliedAt &&
    Boolean(item.messageId);
}

function countPendingAgentMessages() {
  const counts = {};
  for (const item of agentHubState.mailbox) {
    if (!item.ackedAt) {
      counts[item.to] = (counts[item.to] || 0) + 1;
    }
  }
  return counts;
}

function buildAgentReplyCommand({ from, to, taskId, replyTo, bodyFile }) {
  return [
    shellQuote(process.execPath),
    shellQuote(path.join(ROOT_DIR, "server", "agent_reply_cli.js")),
    "--from",
    shellQuote(from),
    "--to",
    shellQuote(to),
    taskId ? `--task-id ${shellQuote(taskId)}` : "",
    "--reply-to",
    shellQuote(replyTo),
    "--body-file",
    shellQuote(bodyFile)
  ].filter(Boolean).join(" ");
}

function writeAgentReplyScript(scriptFile, fullReplyCommand) {
  fs.mkdirSync(path.dirname(scriptFile), { recursive: true });
  fs.writeFileSync(scriptFile, [
    "#!/usr/bin/env sh",
    "set -eu",
    fullReplyCommand,
    ""
  ].join("\n"), { mode: 0o700 });
}

function buildTmuxAiTaskPrompt({ from, to, role, taskId, messageId, body, replyBodyFile, replyCommand }) {
  const command = replyCommand || buildAgentReplyCommand({
    from: to,
    to: from,
    taskId,
    replyTo: messageId,
    bodyFile: replyBodyFile
  });
  return [
    "You are registered as a local tmux AI agent.",
    "Reply path is explicit: write final answer to the reply file, then run the CLI command.",
    "If the CLI fails, read its JSON error and fix the listed field before retrying once.",
    "",
    "Identity:",
    `Agent id: ${to}`,
    `Role: ${role}`,
    `Task from: ${from}`,
    taskId ? `Task id: ${taskId}` : "Task id: (none)",
    `Message id: ${messageId}`,
    "",
    "Task:",
    body,
    "",
    "Reply file:",
    replyBodyFile,
    "",
    "Reply command (short):",
    command,
    "",
    "The short command already contains all CLI flags. Do not reconstruct or memorize the long agent_reply_cli.js command.",
    "",
    "Do not report completion only in this terminal. The master receives results only through the CLI."
  ].join("\n");
}

async function sendTextToTmuxPane(paneId, text) {
  const value = String(text || "");
  const chunkSize = 500;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    await runTmuxCommand(["send-keys", "-t", paneId, "-l", value.slice(offset, offset + chunkSize)], { timeoutMs: 5000 });
  }
  await sleep(150);
  await runTmuxCommand(["send-keys", "-t", paneId, "Enter"], { timeoutMs: 5000 });
}

function safeFilePart(value) {
  return String(value || "").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 96) || "agent";
}

function validateAgentId(value, fieldName) {
  const text = String(value || "").trim();
  if (!AGENT_ID_PATTERN.test(text)) {
    throw new Error(`Invalid ${fieldName || "agentId"}. Use 1-64 characters: letters, numbers, dot, underscore, or dash; start with a letter or number.`);
  }
  return text;
}

function validateAgentRole(value) {
  const role = String(value || "").trim();
  if (!AGENT_ROLES.has(role)) {
    throw new Error("Invalid agent role. Use master or slave.");
  }
  return role;
}

function normalizeAgentDisplayName(value) {
  return String(value || "").trim().slice(0, 128);
}

function normalizeAgentTaskId(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) {
    throw new Error("Invalid task-id. Use 1-128 simple characters without spaces.");
  }
  return text;
}

function normalizeAgentMessageId(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,160}$/.test(text)) {
    throw new Error("Invalid messageId. Use simple characters without spaces.");
  }
  return text;
}

function agentHubError(errorCode, error, extra = {}) {
  const explanation = explainAgentHubError(errorCode, extra);
  return {
    ok: false,
    errorCode,
    error,
    ...explanation,
    ...extra
  };
}

function explainAgentHubError(errorCode, extra = {}) {
  const type = String(extra.type || "");
  if (errorCode === "recipient-not-registered") {
    return {
      hint: "The target agent is not online in the local agent hub.",
      nextAction: "Open the target web page or register the tmux-ai pane, click Save/Register, then run Agent Check or Roster before resending."
    };
  }
  if (errorCode === "sender-not-registered") {
    return {
      hint: "The sending page or tmux-ai runtime is not registered with this server.",
      nextAction: type === "agent-reply"
        ? "Register the tmux-ai pane from the master page again, then rerun the latest reply command."
        : "Set this page role to master or slave, click Save, then resend the task."
    };
  }
  if (errorCode === "tmux-target-not-found" || errorCode === "tmux-target-unavailable") {
    return {
      hint: "The selected tmux target cannot be resolved to one active pane.",
      nextAction: "Start the AI in tmux, click Refresh in the master panel, select the exact pane, then Register it again."
    };
  }
  if (errorCode === "missing-body") {
    return {
      hint: "The agent message has no task/result body.",
      nextAction: "Add the task or result text below the blank line in the agent helper block, then retry."
    };
  }
  if (errorCode === "duplicate-message-id") {
    return {
      hint: "The same message id was already accepted by the local hub.",
      nextAction: "Use a new helper identity or wait for the current task to complete before resending."
    };
  }
  if (errorCode === "duplicate-reply") {
    return {
      hint: "The original task already has a recorded reply.",
      nextAction: "Do not rerun this reply. Ask the master to create a new task if another result is needed."
    };
  }
  if (errorCode === "reply-target-not-found") {
    return {
      hint: "The reply-to message id does not match an active task for this sender.",
      nextAction: "Copy the reply-to value from the current task prompt, not from an older task."
    };
  }
  if (errorCode === "reply-recipient-mismatch") {
    return {
      hint: "The reply route does not match the original task sender and recipient.",
      nextAction: "Use the to/from values from the task prompt exactly."
    };
  }
  if (errorCode === "reply-task-mismatch") {
    return {
      hint: "The reply task id does not match the original task.",
      nextAction: "Copy the task-id from the task prompt exactly."
    };
  }
  return {};
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
    if (!isLowLevelVisionEnabled()) {
      return lowLevelVisionDisabledError(type);
    }
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

  if (type === "vision-list-tmux-windows" || type === "vision-list-visual-surfaces") {
    return listVisionTmuxWindows(message);
  }

  if (type === "vision-capture") {
    if (!isLowLevelVisionEnabled()) {
      return lowLevelVisionDisabledError(type);
    }
    const windowId = parseVisionWindowId(message.windowId);
    const response = await runVisionHelper(["capture", "--window-id", String(windowId)]);
    return ensureVisionWindowResponse(ensureVisionOk(response), { appName: message.appName || "" });
  }

  if (type === "vision-ocr") {
    if (!isLowLevelVisionEnabled()) {
      return lowLevelVisionDisabledError(type);
    }
    const imageRef = getVisionImageRef(message);
    const response = await runVisionHelper(["ocr", "--image", imageRef]);
    return ensureVisionOk(response);
  }

  if (type === "vision-type") {
    if (!isLowLevelVisionEnabled()) {
      return lowLevelVisionDisabledError(type);
    }
    const windowId = parseVisionWindowId(message.windowId);
    const text = validateVisionTextInput(message.text);
    const response = await runVisionHelper(["type", "--window-id", String(windowId), "--text", text]);
    return ensureVisionOk(response);
  }

  if (type === "vision-key") {
    if (!isLowLevelVisionEnabled()) {
      return lowLevelVisionDisabledError(type);
    }
    const windowId = parseVisionWindowId(message.windowId);
    const key = validateVisionKey(message.key);
    const response = await runVisionHelper(["key", "--window-id", String(windowId), "--key", key]);
    return ensureVisionOk(response);
  }

  if (type === "vision-terminal-self-test") {
    if (!isLowLevelVisionEnabled()) {
      return lowLevelVisionDisabledError(type);
    }
    return runVisionTerminalSelfTest(message);
  }

  if (type === "vision-tmux-run-line" || type === "vision-tmux-run") {
    if (!isDirectVisualTmuxEnabled()) {
      return visionError(
        "direct-visual-tmux-disabled",
        "Direct tmux visual run messages are disabled outside explicit local test mode.",
        { enableEnv: "AI_CHAT_SHELL_ENABLE_DIRECT_VISUAL_TMUX" }
      );
    }
    return handleVisionTmuxRunLineMessage(message);
  }

  if (type === "vision-tmux-ocr-run-line" || type === "vision-visual-run-line") {
    return handleVisionTmuxOcrRunLineMessage(message);
  }

  return visionError("unsupported-vision-message", `Unsupported vision message type: ${type}`);
}

async function listVisionTmuxWindows(message = {}) {
  const supportedApps = getVisionTmuxAppNames();
  const requestedApp = message.appName ? validateVisionAppName(message.appName) : "";
  if (requestedApp && !supportedApps.includes(requestedApp)) {
    return visionError("unsupported-visual-app", `Unsupported local visual tmux app: ${requestedApp}.`, {
      supportedApps
    });
  }

  const listed = ensureVisionOk(await runVisionHelper(["list-windows"]));
  if (listed.ok === false) {
    return listed;
  }

  const windows = (Array.isArray(listed.windows) ? listed.windows : [])
    .filter((windowInfo) => {
      const appName = String(windowInfo?.appName || "");
      return requestedApp ? appName === requestedApp : supportedApps.includes(appName);
    })
    .map((windowInfo) => ({
      ...windowInfo,
      surfaceType: "macos-window",
      visualAdapter: "tmux-ocr",
      supportedApp: true,
      tmuxVerified: false,
      requiresTmux: true
    }));

  return {
    ok: true,
    platform: os.platform(),
    supportedApps,
    surfaceType: "macos-window",
    visualAdapter: "tmux-ocr",
    windows,
    count: windows.length
  };
}

async function handleVisionTmuxOcrRunLineMessage(message) {
  const cmd = validateVisionTmuxCommand(message.cmd);
  const windowId = parseVisionWindowId(message.windowId);
  const timeoutMs = clampNumber(message.timeoutMs, 5000, 10 * 60 * 1000, DEFAULT_TIMEOUT_MS);
  const maxPages = clampNumber(message.maxPages, 1, 200, 40);
  const pageDelayMs = clampNumber(message.pageDelayMs, 100, 5000, 500);
  const appName = message.appName || "";
  const target = `vision-window:${windowId}`;
  const surface = await getVisionTmuxWindowById(windowId, { appName });
  if (surface.ok === false) {
    return surface;
  }
  const callKey = normalizeCallKey(message.callKey || message.id || hashText([
    "vision-ocr",
    windowId,
    appName,
    cmd,
    maxPages
  ].join("\n")));
  const force = message.callMeta?.force === true || message.force === true;
  const claim = claimServerShellCall(callKey, {
    cmd,
    cwd: "",
    target,
    timeoutMs,
    seq: message.seq,
    callMeta: message.callMeta || {},
    force
  });
  const result = await runVisionTmuxOcrLine({
    cmd,
    windowId,
    timeoutMs,
    maxPages,
    pageDelayMs,
    appName
  });
  const response = {
    ok: result.ok !== false,
    id: message.id,
    callKey,
    cmd,
    windowId,
    timeoutMs,
    maxPages,
    ...result
  };
  completeServerShellCall(callKey, {
    ...response,
    exitCode: Number.isInteger(response.exitCode) ? response.exitCode : (response.ok ? 0 : 1),
    timedOut: response.timedOut === true,
    truncated: response.truncated === true
  });
  return response;
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

  const callKey = normalizeCallKey(message.callKey || message.id || hashText([
    "vision-tmux",
    pane.id,
    cmd,
    timeoutMs,
    maxOutputChars
  ].join("\n")));
  const force = message.callMeta?.force === true || message.force === true;
  const claim = claimServerShellCall(callKey, {
    cmd,
    cwd: pane.currentPath || "",
    target: pane.id,
    timeoutMs,
    seq: message.seq,
    callMeta: message.callMeta || {},
    force
  });

  const result = await runTmuxVisualLine({
    cmd,
    pane,
    timeoutMs,
    maxOutputChars
  });
  const response = {
    ok: result.ok !== false,
    id: message.id,
    callKey,
    cmd,
    target: pane.id,
    targetName: pane.label,
    timeoutMs,
    ...result
  };
  completeServerShellCall(callKey, {
    ...response,
    exitCode: Number.isInteger(response.exitCode) ? response.exitCode : (response.ok ? 0 : 1),
    timedOut: response.timedOut === true,
    truncated: response.truncated === true
  });
  return response;
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

function failServerShellCall(callKey, error, extra = {}) {
  serverLedger.calls ||= {};
  serverLedger.calls[callKey] = {
    ...(serverLedger.calls[callKey] || {}),
    state: "failed",
    completedAt: Date.now(),
    exitCode: 1,
    durationMs: extra.durationMs,
    timedOut: false,
    truncated: false,
    error: summarizeError(error)
  };
  pruneServerLedger();
  saveServerLedger();
}

function summarizeError(error) {
  return String(error?.message || error || "").slice(0, 500);
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

async function runVisionTmuxOcrLine({ cmd, windowId, timeoutMs, maxPages, pageDelayMs, appName = "" }) {
  const started = Date.now();
  const surface = await getVisionTmuxWindowById(windowId, { appName });
  if (surface.ok === false) {
    return surface;
  }
  const runId = randomOcrSafeToken(8);
  const runWindowName = `${VISION_TMUX_OCR_RUN_PREFIX}${runId}`;
  const donePrefix = `${VISION_TMUX_OCR_DONE_PREFIX}${runId}`;
  const startMarker = `${VISION_TMUX_OCR_START_PREFIX}${runId}`;
  const historyLimit = VISION_TMUX_HISTORY_LIMIT;
  const runLine = buildTmuxVisualOcrRunLine({ cmd, runWindowName, donePrefix, startMarker, historyLimit });

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

  const pageResult = await readVisionOcrPages({
    windowId,
    maxPages,
    pageDelayMs
  });
  const pages = pageResult.pages;
  await pressVisionKey(windowId, "escape").catch(() => null);

  const ocrRawText = pages.map((page) => page.text).join("\n");
  const rawStitch = stitchOcrPagesDetailed(pages.map((page) => page.text));
  const rawStitchedText = rawStitch.text;
  const historyStartFound = visionTextIncludes(rawStitchedText, startMarker);
  const cleanedPageDetails = pages.map((page) => cleanVisionTmuxOcrTextDetailed(page.text, donePrefix));
  const cleanedPageTexts = cleanedPageDetails.map((detail) => detail.text);
  const cleanedStitch = stitchOcrPagesDetailed(cleanedPageTexts);
  const finalClean = cleanVisionTmuxOcrTextDetailed(cleanedStitch.text, donePrefix);
  const ocrText = finalClean.text;
  const ocrCleanupLossy = rawStitch.lossy
    || cleanedStitch.lossy
    || finalClean.lossy
    || cleanedPageDetails.some((detail) => detail.lossy);
  const parsed = parseVisionDoneFromText(done.statusText || done.text, donePrefix);

  if (pageResult.failed) {
    return visionError(pageResult.errorCode || "ocr-page-failed", pageResult.error || "Could not OCR output page.", {
      runId,
      runWindowName,
      startMarker,
      donePrefix,
      doneOcrText: done.text,
      doneWindowName: parsed.doneWindowName,
      exitCode: parsed.exitCode,
      exitCodeKnown: parsed.exitCodeKnown !== false,
      ocrPages: pages,
      failedPage: pageResult.failedPage,
      truncated: true,
      paginationEnded: pageResult.ended === true,
      historyLimit,
      historyStartFound,
      ocrCleanupLossy,
      durationMs: Date.now() - started
    });
  }

  return {
    ok: true,
    runId,
    runWindowName,
    startMarker,
    donePrefix,
    doneOcrText: done.text,
    doneWindowName: parsed.doneWindowName,
    exitCode: parsed.exitCode,
    exitCodeKnown: parsed.exitCodeKnown !== false,
    ocrText,
    ocrRawText,
    ocrPages: pages,
    ocrLineCount: ocrText ? ocrText.split("\n").length : 0,
    truncated: pageResult.truncated === true || !historyStartFound || ocrCleanupLossy || (pageResult.repeatSignatureDetected === true && pageResult.ended !== true),
    paginationEnded: pageResult.ended === true,
    repeatSignatureDetected: pageResult.repeatSignatureDetected === true,
    historyLimit,
    historyStartFound,
    ocrCleanupLossy,
    ocrFullOverlapPages: Array.from(new Set([...rawStitch.fullOverlapPages, ...cleanedStitch.fullOverlapPages])),
    durationMs: Date.now() - started
  };
}

function buildTmuxVisualOcrRunLine({ cmd, runWindowName, donePrefix, startMarker = "", historyLimit = VISION_TMUX_HISTORY_LIMIT }) {
  return [
    [
      `tmux rename-window ${shellQuote(runWindowName)}`,
      `tmux set-option -w history-limit ${Number(historyLimit) || VISION_TMUX_HISTORY_LIMIT}`,
      "clear",
      "tmux clear-history",
      startMarker ? `printf '%s\\n' ${shellQuote(startMarker)}` : "printf '\\n'",
      `/bin/sh -c ${shellQuote(cmd)}`
    ].join(" && "),
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

async function getVisionTmuxWindowById(windowId, { appName = "" } = {}) {
  const supportedApps = getVisionTmuxAppNames();
  const requestedApp = appName ? validateVisionAppName(appName) : "";
  if (requestedApp && !supportedApps.includes(requestedApp)) {
    return visionError("unsupported-visual-app", `Unsupported local visual tmux app: ${requestedApp}.`, {
      windowId,
      appName: requestedApp,
      supportedApps
    });
  }

  const listed = ensureVisionOk(await runVisionHelper(["list-windows"], { timeoutMs: 5000 }));
  if (listed.ok === false) {
    return listed;
  }

  const windows = Array.isArray(listed.windows) ? listed.windows : [];
  const windowInfo = windows.find((candidate) => Number(candidate?.windowId) === Number(windowId));
  if (!windowInfo) {
    return visionError("invalid-window", `Could not find visible target window ${windowId}.`, {
      windowId,
      supportedApps
    });
  }

  const actualApp = String(windowInfo.appName || "");
  if (requestedApp && actualApp !== requestedApp) {
    return visionError("unexpected-window-app", `Target window ${windowId} belongs to ${actualApp || "(unknown)"}, not ${requestedApp}.`, {
      windowId,
      appName: requestedApp,
      actualAppName: actualApp,
      supportedApps
    });
  }

  if (!supportedApps.includes(actualApp)) {
    return visionError("unsupported-visual-app", `Unsupported local visual tmux app: ${actualApp || "(unknown)"}.`, {
      windowId,
      appName: actualApp,
      supportedApps
    });
  }

  return {
    ok: true,
    window: windowInfo,
    supportedApps
  };
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
    const parsedDone = parseVisionDoneFromText(captured.statusText, donePrefix);
    if (parsedDone.exitCodeKnown === true) {
      return {
        found: true,
        text: lastText,
        statusText: captured.statusText,
        doneWindowName: parsedDone.doneWindowName,
        exitCode: parsedDone.exitCode,
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
  let ended = false;
  let repeatSignatureDetected = false;
  for (let index = 0; index < maxPages; index += 1) {
    const captured = await captureVisionOcrText(windowId);
    if (captured.ok === false) {
      pages.push({
        page: index + 1,
        ok: false,
        errorCode: captured.errorCode || "ocr-page-failed",
        error: captured.error || "Could not OCR page."
      });
      return {
        pages,
        ended: false,
        failed: true,
        failedPage: index + 1,
        errorCode: captured.errorCode || "ocr-page-failed",
        error: captured.error || "Could not OCR page.",
        truncated: true
      };
    }
    const pageText = captured.text;
    const statusSignature = normalizeOcrPageSignature(captured.statusText);
    const signature = normalizeOcrPageSignature([
      pageText,
      statusSignature ? `STATUS:${statusSignature}` : ""
    ].filter(Boolean).join("\n"));
    if (index > 0 && signature && signature === previousSignature) {
      repeatSignatureDetected = true;
      if (visionStatusLooksAtCopyModeBottom(captured.statusText)) {
        ended = true;
        break;
      }
    }
    pages.push({
      page: index + 1,
      ok: true,
      text: pageText,
      rawText: captured.text,
      statusText: captured.statusText,
      statusSignature,
      signature,
      results: captured.ocr.results || []
    });
    previousSignature = signature;
    await pressVisionKey(windowId, "page-down");
    await sleep(pageDelayMs);
  }
  return {
    pages,
    ended,
    failed: false,
    repeatSignatureDetected,
    truncated: pages.length >= maxPages && !ended
  };
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

function visionStatusLooksAtCopyModeBottom(statusText) {
  const matches = Array.from(String(statusText || "").matchAll(/\[(\d+)\/(\d+)\]/g));
  return matches.some((match) => Number(match[1]) === 0 && Number(match[2]) === 0);
}

function stitchOcrPages(pageTexts) {
  return stitchOcrPagesDetailed(pageTexts).text;
}

function stitchOcrPagesDetailed(pageTexts) {
  const stitched = [];
  const fullOverlapPages = [];
  for (let index = 0; index < pageTexts.length; index += 1) {
    const pageText = pageTexts[index];
    const lines = String(pageText || "")
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim());
    const overlap = findLineOverlap(stitched, lines, 120);
    if (lines.length > 0 && overlap >= lines.length) {
      fullOverlapPages.push(index + 1);
    }
    stitched.push(...lines.slice(overlap));
  }
  return {
    text: stitched.join("\n"),
    lossy: fullOverlapPages.length > 0,
    fullOverlapPages
  };
}

function cleanVisionTmuxOcrText(text, donePrefix = "") {
  return cleanVisionTmuxOcrTextDetailed(text, donePrefix).text;
}

function cleanVisionTmuxOcrTextDetailed(text, donePrefix = "") {
  const doneToken = normalizeOcrTokenText(donePrefix);
  const removedLines = [];
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => {
      const rawLine = String(line || "").replace(/\s+$/, "");
      const withoutStatusSuffix = rawLine.replace(/(?:\s{2,}\[\d+\/\d+\]|\[\d+\/\d+\])$/, "");
      if (withoutStatusSuffix !== rawLine) {
        removedLines.push({ line: rawLine.trim(), reason: "status-suffix", lossy: true });
      }
      return withoutStatusSuffix.trimEnd();
    })
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return false;
      }
      const normalized = normalizeOcrTokenText(trimmed);
      if (doneToken && normalized.includes(doneToken)) {
        removedLines.push({ line: trimmed, reason: "done-marker", lossy: false });
        return false;
      }
      if (normalized.includes(VISION_TMUX_OCR_RUN_PREFIX) || normalized.includes(VISION_TMUX_OCR_DONE_PREFIX)) {
        removedLines.push({ line: trimmed, reason: "vision-marker", lossy: false });
        return false;
      }
      if (normalized.includes(VISION_TMUX_OCR_START_PREFIX)) {
        removedLines.push({ line: trimmed, reason: "start-marker", lossy: false });
        return false;
      }
      if (/^\s*(?:.{0,80}[%$#]\s*)?tmux\s+copy-mode\s+\\+;\s+send-keys\b/i.test(trimmed) || /^\s*-X\s+history-top\b/i.test(trimmed)) {
        removedLines.push({ line: trimmed, reason: "copy-mode-command", lossy: true });
        return false;
      }
      if (/tmux attach-session/.test(trimmed) && /—|-/.test(trimmed)) {
        removedLines.push({ line: trimmed, reason: "terminal-title", lossy: true });
        return false;
      }
      return true;
    })
    .join("\n");
  return {
    text: lines,
    removedLines,
    lossy: removedLines.some((line) => line.lossy)
  };
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
  if (!match) {
    return {
      doneWindowName: donePrefix,
      exitCode: 124,
      exitCodeKnown: false
    };
  }
  const exitCode = Number(match[1]);
  return {
    doneWindowName: `${donePrefix}${exitCode}`,
    exitCode,
    exitCodeKnown: true
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

async function ensureForAiTmuxLayout(config = getForAiTmuxConfig()) {
  const createdWindows = [];
  let createdSession = false;

  const sessionCheck = await runTmuxCommandRaw(["has-session", "-t", exactTmuxSessionTarget(config.sessionName)], { timeoutMs: 5000 });
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
      exactTmuxSessionWindowTarget(config.sessionName),
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
      exactTmuxSessionWindowTarget(config.sessionName),
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
  const sessionCheck = await runTmuxCommandRaw(["has-session", "-t", exactTmuxSessionTarget(config.sessionName)], { timeoutMs: 5000 });
  if (sessionCheck.ok) {
    await runTmuxCommand(["kill-session", "-t", exactTmuxSessionTarget(config.sessionName)], { timeoutMs: 5000 });
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
    exactTmuxSessionTarget(sessionName),
    "-F",
    "#{window_name}"
  ], { timeoutMs: 5000 });
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function exactTmuxSessionTarget(sessionName) {
  return `=${sessionName}`;
}

function exactTmuxSessionWindowTarget(sessionName) {
  return `=${sessionName}:`;
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

function buildDefaultTargetErrorResponse(message, cmd, panes, config = getForAiTmuxConfig()) {
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

function getRunTmuxConfig(message = {}) {
  const agentId = String(message.agentId || "").trim();
  if (!agentId) {
    return getForAiTmuxConfig();
  }
  const safeAgentId = validateAgentId(agentId, "agentId");
  const base = getForAiTmuxConfig();
  return {
    ...base,
    agentId: safeAgentId,
    sessionName: normalizeTmuxName(`ForAI-${safeAgentId}`, `${DEFAULT_TMUX_SESSION_NAME}-${safeAgentId}`),
    sessionNameSource: "agentId"
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

function getVisionTmuxAppNames() {
  const configured = String(process.env.AI_CHAT_SHELL_VISION_TMUX_APPS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const names = configured.length ? configured : VISION_TMUX_DEFAULT_APPS;
  const valid = names.filter((appName) => {
    return VISION_TMUX_DEFAULT_APPS.includes(appName)
      && appName.length <= 128
      && !/[\x00-\x1f\x7f]/.test(appName);
  });
  return Array.from(new Set(valid.length ? valid : VISION_TMUX_DEFAULT_APPS));
}

function isDirectVisualTmuxEnabled() {
  return process.env.AI_CHAT_SHELL_ENABLE_DIRECT_VISUAL_TMUX === "1";
}

function isLowLevelVisionEnabled() {
  return process.env.AI_CHAT_SHELL_ENABLE_LOW_LEVEL_VISION === "1";
}

function lowLevelVisionDisabledError(type) {
  return visionError(
    "low-level-vision-disabled",
    `Low-level vision message ${type} is disabled outside explicit local test mode.`,
    { enableEnv: "AI_CHAT_SHELL_ENABLE_LOW_LEVEL_VISION" }
  );
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
  buildTmuxVisualOcrRunLine,
  buildMissingTargetResponse,
  cleanVisionTmuxOcrText,
  decodeTextFrames,
  detectDefaultTmuxSocketPath,
  encodeTextFrame,
  extractBoardPromptSignature,
  extractTmuxRunOutput,
  failServerShellCall,
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
  getVisionTmuxAppNames,
  handleAgentHubMessage,
  handleAgentHubMessageAsync,
  handleMessageText,
  handleVisionMessage,
  buildAgentReplyCommand,
  buildTmuxAiTaskPrompt,
  listTmuxPanes,
  normalizeBoardOutput,
  outputEndsWithBoardPrompt,
  parseTmuxPanes,
  parseVisionDoneFromText,
  pruneAgentMailboxItems,
  prepareStateLogFile,
  readBoardLogFromOffset,
  resetAgentHubForTests,
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
