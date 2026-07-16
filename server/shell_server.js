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
const SERVER_PROTOCOL_VERSION = 6;
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
const SERVER_LEDGER_OUTPUT_LIMIT = 200000;
const SERVER_LEDGER_REPLAY_BUDGET_BYTES = 10 * 1024 * 1024;
const TMUX_FIELD_SEPARATOR = "__AI_CHAT_SHELL_FIELD__";
const TMUX_LIST_FORMAT = [
  "#{pane_id}",
  "#{session_name}",
  "#{window_index}",
  "#{window_name}",
  "#{pane_index}",
  "#{pane_active}",
  "#{pane_current_path}",
  "#{pane_current_command}",
  "#{session_created}",
  "#{pid}",
  "#{pane_pid}",
  "#{pane_tty}"
].join(TMUX_FIELD_SEPARATOR);
const TMUX_CAPTURE_HISTORY_LINES = 20000;
const TMUX_POLL_INTERVAL_MS = 250;
const TMUX_PANE_OWNER_OPTION = "@ai_chat_shell_exec_owner";
const TMUX_PANE_OWNER_VERSION = 1;
const TMUX_PANE_OWNER_LAUNCH_GRACE_MS = 5000;
const INTERACTIVE_SHELL_COMMANDS = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]);
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
const BOARD_NAME_SUFFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
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
const tmuxShellPaneQueues = new Map();
const tmuxShellPaneQueueDepths = new Map();

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

  socket.on("error", (error) => {
    // A page refresh or service-worker restart may close the client while the
    // tmux command is still running. The command lifecycle belongs to the
    // server ledger, so a late socket error must never terminate the server.
    console.log(`[socket] client disconnected: ${error.message || String(error)}`);
  });

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
          writeWebSocketResponse(socket, response);
        })
        .catch((error) => {
          console.error(`[error] ${error.message || String(error)}`);
          writeWebSocketResponse(socket, {
            ok: false,
            error: error.message || String(error)
          });
        });
    } catch (error) {
      console.error(`[error] ${error.message || String(error)}`);
      writeWebSocketResponse(socket, {
        ok: false,
        error: error.message || String(error)
      });
    }
  });
});

function writeWebSocketResponse(socket, response) {
  if (!socket || socket.destroyed || socket.writable !== true) {
    return false;
  }
  try {
    socket.end(encodeTextFrame(JSON.stringify(response)));
    return true;
  } catch (error) {
    console.log(`[socket] response could not be delivered: ${error.message || String(error)}`);
    return false;
  }
}

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

  if (message.type === "run-status") {
    return handleRunStatusMessage(message);
  }

  if (message.type === "run-result-presented") {
    return handleRunResultPresentedMessage(message);
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

  const started = Date.now();
  const force = message.callMeta?.force === true || message.force === true;
  const callKey = normalizeCallKey(message.callKey || message.id || hashText([
    pane.id,
    cmd,
    String(message.cwd || ""),
    timeoutMs,
    maxOutputChars
  ].join("\n")));
  const reservation = reserveServerShellCall(callKey, {
    kind: "shell",
    cmd,
    target: pane.id,
    timeoutMs,
    maxOutputChars,
    seq: message.seq,
    callMeta: message.callMeta || {},
    force
  });
  let claim = null;
  try {
    return await withTmuxShellPaneQueue({
      cmd,
      pane,
      ledgerKey: reservation.ledgerKey
    }, async (queueContext) => {
      const currentPane = queueContext.currentPane;
      await updatePersistentTmuxPaneOwner(queueContext.owner, {
        ledgerKey: reservation.ledgerKey
      });
      const cwd = resolveCwd(message.cwd, currentPane.currentPath);
      claim = adjudicateReservedServerShellCall(reservation.ledgerKey, {
        cmd,
        cwd,
        target: currentPane.id,
        executionTarget: buildTmuxPaneExecutionTarget(currentPane),
        timeoutMs,
        maxOutputChars,
        seq: message.seq,
        callMeta: message.callMeta || {},
        force
      });

      if (claim.action === "skip") {
        console.log(`[duplicate] reason=${claim.reason} callKey=${callKey} previousCallKey=${claim.previousCallKey || ""} target=${currentPane.id} cmd=${JSON.stringify(cmd)}`);
        const response = buildExecutedDuplicateResponse({
          message,
          callKey,
          claim,
          cmd,
          cwd,
          pane: currentPane,
          timeoutMs
        });
        completeServerShellCall(reservation.ledgerKey, {
          ...response,
          queued: queueContext.queued,
          queuedMs: queueContext.queuedMs
        });
        return response;
      }

      console.log(`[run] callKey=${callKey} seq=${message.seq || ""} target=${currentPane.id} cwd=${cwd} cmd=${JSON.stringify(cmd)}`);
      const result = await runTmuxShell({
        cmd,
        cwd,
        pane: currentPane,
        timeoutMs,
        maxOutputChars,
        ownerContext: queueContext.owner,
        ledgerKey: claim.ledgerKey
      });
      console.log(`[done] exitCode=${result.exitCode} durationMs=${Date.now() - started} timedOut=${result.timedOut}`);

      const response = {
        ok: true,
        id: message.id,
        callKey,
        executionId: claim.attemptId,
        agentId: config.agentId || "",
        cmd,
        cwd,
        target: currentPane.id,
        targetName: currentPane.label,
        timeoutMs,
        durationMs: Date.now() - started,
        ...result,
        queued: queueContext.queued,
        queuedMs: queueContext.queuedMs
      };
      if (isConfirmedTmuxExecution(result)) {
        completeServerShellCall(claim.ledgerKey, response);
      } else {
        failServerShellCall(claim.ledgerKey, new Error(result.stderr || "Shell command execution was not confirmed complete."), {
          durationMs: Date.now() - started
        });
      }
      return response;
    });
  } catch (error) {
    failServerShellCall(claim?.ledgerKey || reservation.ledgerKey, error, { durationMs: Date.now() - started });
    throw error;
  }
}

async function runTmuxShellQueued(options) {
  return withTmuxShellPaneQueue(options, async (queueContext) => {
    return runTmuxShell({
      ...options,
      pane: queueContext.currentPane,
      ownerContext: queueContext.owner
    });
  });
}

async function withTmuxShellPaneQueue(options, task) {
  const socketPath = getTmuxSocketPath() || "default-socket";
  const queueKey = buildTmuxShellQueueKey(options?.pane, socketPath);
  const previousSlot = tmuxShellPaneQueues.get(queueKey);
  const queuedAt = Date.now();
  let releaseSlot;
  const currentSlot = new Promise((resolve) => {
    releaseSlot = resolve;
  });
  tmuxShellPaneQueues.set(queueKey, currentSlot);
  tmuxShellPaneQueueDepths.set(queueKey, Number(tmuxShellPaneQueueDepths.get(queueKey) || 0) + 1);

  try {
    if (previousSlot) {
      console.log(`[queued] target=${options?.pane?.id || ""} cmd=${JSON.stringify(options?.cmd || "")}`);
      await previousSlot;
    }
    const currentPane = await verifyTmuxShellPaneBeforeDispatch(options?.pane, { socketPath, queued: Boolean(previousSlot) });
    const owner = await acquirePersistentTmuxPaneOwner(currentPane, {
      socketPath,
      kind: options?.kind || "shell",
      cmd: options?.cmd || "",
      ledgerKey: options?.ledgerKey || options?.reservationLedgerKey || ""
    });
    try {
      const queuedMs = Date.now() - queuedAt;
      const result = await task({
        queued: Boolean(previousSlot) || owner.waited,
        queuedMs,
        socketPath,
        currentPane: owner.pane,
        owner
      });
      return {
        ...result,
        queued: Boolean(previousSlot) || owner.waited,
        queuedMs
      };
    } finally {
      let released = false;
      try {
        released = await releasePersistentTmuxPaneOwner(owner);
      } catch (error) {
        console.error(`[tmux-owner] failed to release owner for ${currentPane.id}: ${error.message || String(error)}`);
      }
      if (released) {
        cleanupPersistentTmuxOwnerFiles(owner);
      } else {
        // A surviving pane option is the recovery lease. Keep its pid/status/
        // executed files intact so a later server can settle it without
        // destroying authoritative completion proof.
        console.error(`[tmux-owner] retained recovery files because owner release was not confirmed for ${currentPane.id}`);
      }
    }
  } finally {
    releaseSlot();
    if (tmuxShellPaneQueues.get(queueKey) === currentSlot) {
      tmuxShellPaneQueues.delete(queueKey);
    }
    const remainingDepth = Number(tmuxShellPaneQueueDepths.get(queueKey) || 1) - 1;
    if (remainingDepth > 0) {
      tmuxShellPaneQueueDepths.set(queueKey, remainingDepth);
    } else {
      tmuxShellPaneQueueDepths.delete(queueKey);
    }
  }
}

function buildTmuxShellQueueKey(pane = {}, socketPath = getTmuxSocketPath() || "default-socket") {
  return [
    socketPath,
    pane.serverPid || "unknown-server",
    pane.id || pane.address || pane.label || "unknown-pane"
  ].join(":");
}

function getTmuxShellPaneQueueDepth(pane = {}, socketPath = getTmuxSocketPath() || "default-socket") {
  return Number(tmuxShellPaneQueueDepths.get(buildTmuxShellQueueKey(pane, socketPath)) || 0);
}

async function verifyTmuxShellPaneBeforeDispatch(expectedPane = {}, queueContext = {}) {
  const expectedSocket = queueContext.socketPath || "default-socket";
  const currentSocket = getTmuxSocketPath() || "default-socket";
  if (currentSocket !== expectedSocket) {
    throw new Error("Queued tmux target socket changed before execution. Submit the helper again against the current target.");
  }
  if (!expectedPane.id) {
    throw new Error("Queued tmux target is missing its immutable pane id. Submit the helper again.");
  }

  const currentPane = (await listTmuxPanes({ quiet: queueContext.quiet === true })).find((pane) => pane.id === expectedPane.id);
  if (!currentPane) {
    throw new Error(`Queued tmux pane ${expectedPane.id} no longer exists. Submit the helper again against the current target.`);
  }

  const expectedServerPid = String(expectedPane.serverPid || "");
  const currentServerPid = String(currentPane.serverPid || "");
  if (
    (expectedServerPid || currentServerPid) &&
    (!expectedServerPid || !currentServerPid || expectedServerPid !== currentServerPid)
  ) {
    throw new Error(`Queued tmux pane ${expectedPane.id} belongs to a different tmux server instance. Submit the helper again against the current target.`);
  }
  if (queueContext.queued && !expectedServerPid) {
    throw new Error(`Cannot safely verify queued tmux pane ${expectedPane.id} because server instance metadata is missing. Submit the helper again.`);
  }
  return currentPane;
}

async function acquirePersistentTmuxPaneOwner(expectedPane, { socketPath, kind = "shell", cmd = "", ledgerKey = "" } = {}) {
  let waited = false;
  let readySince = 0;
  let lastWaitLogAt = 0;
  let lastWaitCommand = "";
  while (true) {
    const pane = await verifyTmuxShellPaneBeforeDispatch(expectedPane, { socketPath, queued: waited, quiet: waited });
    const existing = await readPersistentTmuxPaneOwner(pane);
    if (existing) {
      const readiness = await getTmuxPaneReadiness(pane);
      if (!readiness.known) {
        throw new Error(`Cannot safely wait behind the existing tmux pane owner for ${pane.id}: ${readiness.error || "process-group metadata is unavailable"}. Submit the helper again after tmux pane metadata is available.`);
      }
      waited = true;
      readySince = 0;
      const settled = await settlePersistentTmuxPaneOwner(existing, pane, socketPath);
      if (!settled) {
        await sleep(TMUX_POLL_INTERVAL_MS);
      }
      continue;
    }

    if (kind !== "board") {
      const readiness = await getTmuxPaneReadiness(pane);
      if (!readiness.known) {
        throw new Error(`Cannot safely verify that tmux pane ${pane.id} is idle: ${readiness.error || "process-group metadata is unavailable"}. Submit the helper again after tmux pane metadata is available.`);
      }
      if (!readiness.ready) {
        waited = true;
        readySince = 0;
        const currentCommand = pane.currentCommand || "";
        if (currentCommand !== lastWaitCommand || Date.now() - lastWaitLogAt >= 5000) {
          console.log(`[tmux-owner] waiting for foreground command target=${pane.id} currentCommand=${JSON.stringify(currentCommand)}`);
          lastWaitCommand = currentCommand;
          lastWaitLogAt = Date.now();
        }
        await sleep(TMUX_POLL_INTERVAL_MS);
        continue;
      }
    }
    readySince = readySince || Date.now();
    if (Date.now() - readySince < TMUX_POLL_INTERVAL_MS) {
      await sleep(TMUX_POLL_INTERVAL_MS);
      continue;
    }

    const owner = {
      version: TMUX_PANE_OWNER_VERSION,
      token: crypto.randomBytes(16).toString("hex"),
      socketPath,
      serverPid: String(pane.serverPid || ""),
      paneId: pane.id,
      kind,
      cmdHash: cmd ? hashText(cmd) : "",
      ledgerKey,
      createdAt: Date.now()
    };
    if (await tryClaimPersistentTmuxPaneOwner(pane, owner)) {
      return {
        ...owner,
        pane,
        waited
      };
    }
    waited = true;
    await sleep(TMUX_POLL_INTERVAL_MS);
  }
}

async function isTmuxPaneReadyForHelper(pane = {}) {
  return (await getTmuxPaneReadiness(pane)).ready;
}

async function getTmuxPaneReadiness(pane = {}) {
  const command = path.basename(String(pane.currentCommand || "").replace(/^-/, ""));
  if (!command) {
    return { known: false, ready: false, error: "pane_current_command is missing" };
  }
  if (!INTERACTIVE_SHELL_COMMANDS.has(command) && command !== path.basename(SHELL_RUNNER)) {
    return { known: true, ready: false, error: "a foreground command owns the pane" };
  }
  if (!pane.panePid) {
    return { known: false, ready: false, error: "pane_pid is missing" };
  }
  if (!normalizeProcessTty(pane.paneTty)) {
    return { known: false, ready: false, error: "pane_tty is missing" };
  }
  const processGroups = await readTmuxPaneProcessGroups(pane.panePid, pane.paneTty);
  if (!processGroups.known) {
    return { known: false, ready: false, error: "foreground process-group identity is unavailable" };
  }
  return {
    known: true,
    ready: processGroups.shellPgid === processGroups.foregroundPgid,
    error: processGroups.shellPgid === processGroups.foregroundPgid ? "" : "a foreground process group owns the pane"
  };
}

async function readTmuxPaneProcessGroups(panePid, paneTty = "") {
  const pid = Number(panePid || 0);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { known: false, shellPgid: 0, foregroundPgid: 0 };
  }

  const normalizedTty = normalizeProcessTty(paneTty);
  if (!normalizedTty) {
    return { known: false, shellPgid: 0, foregroundPgid: 0 };
  }
  let result = normalizedTty
    ? await runCommandRaw("ps", ["-t", normalizedTty, "-o", "pid=,ppid=,pgid=,tpgid=,tty=,comm="], {
      timeoutMs: 2000,
      maxOutputChars: 20000
    })
    : { ok: false, stdout: "" };
  if (!result.ok || !String(result.stdout || "").trim()) {
    // `ps -t` differs slightly across Darwin and procps. The all-process
    // fallback keeps the readiness proof portable while filtering strictly by
    // the tmux pane's controlling tty below.
    result = await runCommandRaw("ps", ["-axo", "pid=,ppid=,pgid=,tpgid=,tty=,comm="], {
      timeoutMs: 2000,
      maxOutputChars: 1000000
    });
  }

  const rows = parseProcessGroupRows(result.stdout).filter((row) =>
    !normalizedTty || normalizeProcessTty(row.tty) === normalizedTty
  );
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  let shellProcess = byPid.get(pid) || null;
  if (!shellProcess && rows.length > 0) {
    shellProcess = rows.find((row) =>
      INTERACTIVE_SHELL_COMMANDS.has(path.basename(row.command).replace(/^-/, "")) &&
      !byPid.has(row.ppid)
    ) || null;
  }
  if (shellProcess) {
    // pane_pid is normally tmux's first child, but walk tty-local parents so a
    // platform/version that reports the foreground child shell cannot make a
    // nested `zsh -c` or `sh script` look like the interactive prompt.
    const visited = new Set();
    while (byPid.has(shellProcess.ppid) && !visited.has(shellProcess.pid)) {
      visited.add(shellProcess.pid);
      shellProcess = byPid.get(shellProcess.ppid);
    }
  }

  const foregroundPgid = rows.find((row) => row.tpgid > 0)?.tpgid || 0;
  const shellPgid = shellProcess?.pgid || 0;
  return {
    known: result.ok && shellPgid > 0 && foregroundPgid > 0,
    shellPgid,
    foregroundPgid
  };
}

function normalizeProcessTty(value) {
  return String(value || "").trim().replace(/^\/dev\//, "");
}

function parseProcessGroupRows(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s+(.+)$/);
      return match ? {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        tpgid: Number(match[4]),
        tty: match[5],
        command: match[6]
      } : null;
    })
    .filter(Boolean);
}

async function readPersistentTmuxPaneOwner(pane = {}) {
  if (!pane.id) {
    return null;
  }
  const result = await runTmuxCommandRaw([
    "show-options",
    "-p",
    "-v",
    "-t",
    pane.id,
    TMUX_PANE_OWNER_OPTION
  ], { timeoutMs: 5000 });
  const encoded = String(result.stdout || "").trim();
  if (!result.ok || !encoded) {
    return null;
  }
  try {
    const owner = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return owner && typeof owner === "object" && owner.token ? owner : null;
  } catch (_error) {
    return {
      token: "invalid-owner-value",
      invalid: true,
      encoded
    };
  }
}

function encodePersistentTmuxPaneOwner(owner) {
  const persisted = { ...owner };
  delete persisted.pane;
  delete persisted.waited;
  return Buffer.from(JSON.stringify(persisted), "utf8").toString("base64url");
}

async function tryClaimPersistentTmuxPaneOwner(pane, owner) {
  const encoded = encodePersistentTmuxPaneOwner(owner);
  const condition = `#{==:#{${TMUX_PANE_OWNER_OPTION}},}`;
  const setCommand = `set-option -p -t ${shellQuote(pane.id)} ${TMUX_PANE_OWNER_OPTION} ${shellQuote(encoded)}`;
  await runTmuxCommand(["if-shell", "-F", "-t", pane.id, condition, setCommand, ""], { timeoutMs: 5000 });
  const current = await readPersistentTmuxPaneOwner(pane);
  return current?.token === owner.token;
}

async function updatePersistentTmuxPaneOwner(ownerContext, patch = {}) {
  if (!ownerContext?.pane?.id || !ownerContext.token) {
    return ownerContext;
  }
  const next = {
    ...ownerContext,
    ...patch
  };
  const currentEncoded = encodePersistentTmuxPaneOwner(ownerContext);
  const nextEncoded = encodePersistentTmuxPaneOwner(next);
  const condition = `#{==:#{${TMUX_PANE_OWNER_OPTION}},${currentEncoded}}`;
  const setCommand = `set-option -p -t ${shellQuote(ownerContext.pane.id)} ${TMUX_PANE_OWNER_OPTION} ${shellQuote(nextEncoded)}`;
  await runTmuxCommand(["if-shell", "-F", "-t", ownerContext.pane.id, condition, setCommand, ""], { timeoutMs: 5000 });
  const current = await readPersistentTmuxPaneOwner(ownerContext.pane);
  if (current?.token !== ownerContext.token) {
    throw new Error(`Lost persistent tmux pane ownership for ${ownerContext.pane.id} before dispatch.`);
  }
  Object.assign(ownerContext, patch);
  return ownerContext;
}

async function releasePersistentTmuxPaneOwner(ownerContext) {
  if (!ownerContext?.pane?.id || !ownerContext.token) {
    return false;
  }
  return clearPersistentTmuxPaneOwner(ownerContext.pane, ownerContext);
}

async function clearPersistentTmuxPaneOwner(pane, owner) {
  const encoded = owner.encoded || encodePersistentTmuxPaneOwner(owner);
  const condition = `#{==:#{${TMUX_PANE_OWNER_OPTION}},${encoded}}`;
  const unsetCommand = `set-option -p -u -t ${shellQuote(pane.id)} ${TMUX_PANE_OWNER_OPTION}`;
  await runTmuxCommand(["if-shell", "-F", "-t", pane.id, condition, unsetCommand, ""], { timeoutMs: 5000 });
  const current = await readPersistentTmuxPaneOwner(pane);
  return !current || current.token !== owner.token;
}

async function settlePersistentTmuxPaneOwner(owner, pane, socketPath) {
  if (
    owner.invalid ||
    owner.socketPath !== socketPath ||
    String(owner.serverPid || "") !== String(pane.serverPid || "") ||
    owner.paneId !== pane.id
  ) {
    await clearPersistentTmuxPaneOwner(pane, owner);
    return true;
  }

  if (owner.kind === "shell" && owner.pidPath && owner.statusPath) {
    const state = readTmuxShellRunState(owner.pidPath, owner.statusPath);
    if (state.completed) {
      await recoverCompletedPersistentTmuxOwner(owner, state, pane);
      await clearPersistentTmuxPaneOwner(pane, owner);
      cleanupPersistentTmuxOwnerFiles(owner);
      return true;
    }
    if (state.processKnown && state.processAlive) {
      return false;
    }
    if (state.processKnown) {
      failPersistentTmuxOwnerLedger(owner, "Recovered tmux helper process exited without a completion proof.");
      await clearPersistentTmuxPaneOwner(pane, owner);
      cleanupPersistentTmuxOwnerFiles(owner);
      return true;
    }
  }

  if (owner.kind === "vision-self-test") {
    if (isProcessAlive(owner.processPid)) {
      return false;
    }
    failPersistentTmuxOwnerLedger(owner, "The process owning the Terminal vision self-test exited before releasing the tmux pane.");
    await clearPersistentTmuxPaneOwner(pane, owner);
    cleanupPersistentTmuxOwnerFiles(owner);
    return true;
  }

  if (owner.kind === "board") {
    const timing = getBoardTimingConfig();
    const ownerAgeMs = Date.now() - Number(owner.createdAt || 0);
    const latest = owner.boardLogPath
      ? readBoardLogFromOffset(owner.boardLogPath, owner.boardOffset, DEFAULT_MAX_OUTPUT_CHARS)
      : null;
    if (owner.boardState === "prompt-returned") {
      await stopTmuxPanePipe(pane.id).catch(() => null);
      completeRecoveredBoardOwner(owner, pane, latest);
      await clearPersistentTmuxPaneOwner(pane, owner);
      return true;
    }
    if (!owner.boardLogPath) {
      if (ownerAgeMs < TMUX_PANE_OWNER_LAUNCH_GRACE_MS) {
        return false;
      }
      failPersistentTmuxOwnerLedger(owner, "Recovered board request exited during preflight before command dispatch.");
      await clearPersistentTmuxPaneOwner(pane, owner);
      return true;
    }
    if (
      owner.boardState !== "sent" &&
      ownerAgeMs >= TMUX_PANE_OWNER_LAUNCH_GRACE_MS &&
      Number(latest?.bytesRead || 0) === 0
    ) {
      // `prepared` is persisted before the single tmux transaction that both
      // changes it to `sent` and submits literal+Enter. Therefore zero output
      // in any earlier state proves that no atomic dispatch was committed.
      await stopTmuxPanePipe(pane.id).catch(() => null);
      failPersistentTmuxOwnerLedger(owner, "Recovered board request exited before atomic command dispatch.");
      await clearPersistentTmuxPaneOwner(pane, owner);
      return true;
    }
    const idleForMs = owner.boardLogPath ? Date.now() - getFileMtimeMs(owner.boardLogPath) : 0;
    const promptReturned = Boolean(
      latest?.bytesRead > 0 &&
      outputEndsWithBoardPrompt(latest.normalized, owner.boardPrompt) &&
      idleForMs >= timing.promptIdleMs &&
      await isBoardPaneReadyAfterCommand(pane, owner.boardShellPrompt === true)
    );
    if (!promptReturned) {
      // The old server may have died immediately before or after the atomic
      // literal+Enter dispatch. Without a returned prompt there is no safe
      // distinction, so retain the pane lease instead of risking another send.
      return false;
    }
    await stopTmuxPanePipe(pane.id).catch(() => null);
    completeRecoveredBoardOwner(owner, pane, latest);
    await clearPersistentTmuxPaneOwner(pane, owner);
    return true;
  }

  if (owner.kind === "visual" && owner.donePrefix) {
    const windowName = await getTmuxWindowName(pane.id).catch(() => "");
    const persistedStatus = owner.statusPath ? readExitStatusFile(owner.statusPath) : null;
    const executed = Boolean(owner.executedPath && fs.existsSync(owner.executedPath));
    if (windowName.startsWith(owner.donePrefix) || persistedStatus !== null) {
      const parsed = parseTmuxVisualDoneWindowName(windowName, owner.donePrefix);
      if (executed && owner.ledgerKey) {
        completeServerShellCall(owner.ledgerKey, {
          exitCode: persistedStatus === null ? parsed.exitCode : persistedStatus,
          durationMs: Date.now() - Number(owner.createdAt || Date.now()),
          timedOut: false,
          truncated: false
        });
      } else if (!executed) {
        failPersistentTmuxOwnerLedger(owner, "Recovered visual tmux helper completed without an executed marker.");
      }
      await clearPersistentTmuxPaneOwner(pane, owner);
      cleanupPersistentTmuxOwnerFiles(owner);
      return true;
    }
    if (Date.now() - Number(owner.createdAt || 0) < TMUX_PANE_OWNER_LAUNCH_GRACE_MS) {
      return false;
    }
    if (!await isTmuxPaneReadyForHelper(pane)) {
      return false;
    }
    if (!executed) {
      // A previous server may have died after buffering the visual launcher but
      // before Enter. With no executed proof and an idle foreground shell, the
      // buffered line is stale and must be cancelled before releasing the pane.
      await runTmuxCommand(["send-keys", "-t", pane.id, "C-c"], { timeoutMs: 5000 }).catch(() => null);
    }
    failPersistentTmuxOwnerLedger(
      owner,
      executed
        ? "Recovered visual tmux helper returned to the prompt without a completion proof."
        : "Recovered visual tmux helper became stale before execution was confirmed."
    );
    await clearPersistentTmuxPaneOwner(pane, owner);
    cleanupPersistentTmuxOwnerFiles(owner);
    return true;
  }

  if (Date.now() - Number(owner.createdAt || 0) < TMUX_PANE_OWNER_LAUNCH_GRACE_MS) {
    return false;
  }
  if (!await isTmuxPaneReadyForHelper(pane)) {
    return false;
  }
  failPersistentTmuxOwnerLedger(owner, "Persistent tmux helper ownership became stale before execution was confirmed.");
  await clearPersistentTmuxPaneOwner(pane, owner);
  cleanupPersistentTmuxOwnerFiles(owner);
  return true;
}

function completeRecoveredBoardOwner(owner, pane, latest) {
  if (!owner?.ledgerKey || !latest || Number(latest.bytesRead || 0) <= 0) {
    failPersistentTmuxOwnerLedger(owner, "Recovered board command returned without captured output.");
    return false;
  }
  const entry = serverLedger.calls?.[owner.ledgerKey] || {};
  const durationMs = Date.now() - Number(owner.createdAt || Date.now());
  const crossedTimeout = Number(entry.timeoutMs || 0) > 0 && durationMs >= Number(entry.timeoutMs);
  return completeServerShellCall(owner.ledgerKey, {
    ok: true,
    exitCode: crossedTimeout ? 124 : 0,
    stdout: latest.stdout,
    stderr: crossedTimeout
      ? "The board command exceeded its response timeout, but the pane lease remained active until the prompt returned."
      : "",
    durationMs,
    timedOut: crossedTimeout,
    truncated: latest.truncated === true,
    executed: true,
    executionCompleted: false,
    completionObserved: true,
    queued: entry.queued === true,
    queuedMs: Number(entry.queuedMs || 0),
    target: pane.id,
    targetName: pane.label || ""
  });
}

async function recoverCompletedPersistentTmuxOwner(owner, state, pane) {
  if (!owner.ledgerKey || !owner.executedPath || !fs.existsSync(owner.executedPath)) {
    failPersistentTmuxOwnerLedger(owner, "Recovered tmux helper completed without an executed marker.");
    return;
  }
  const interruptSignal = readTmuxShellInterruptSignal(owner.interruptedPath);
  const captured = owner.startMarker && owner.doneMarker
    ? await captureTmuxPane(pane.id).catch(() => "")
    : "";
  const extracted = owner.startMarker && owner.doneMarker
    ? extractTmuxRunOutput(captured, owner.startMarker, owner.doneMarker, owner.maxOutputChars || DEFAULT_MAX_OUTPUT_CHARS)
    : { stdout: "", truncated: false, foundDone: false };
  completeServerShellCall(owner.ledgerKey, {
    exitCode: state.exitCode,
    stdout: extracted.stdout,
    stderr: formatTmuxShellInterruptMessage(interruptSignal),
    durationMs: Date.now() - Number(owner.createdAt || Date.now()),
    timedOut: false,
    truncated: extracted.truncated === true,
    executed: true,
    executionCompleted: true,
    completionMarkerMissing: extracted.foundDone !== true,
    interrupted: Boolean(interruptSignal),
    interruptSignal
  });
}

function failPersistentTmuxOwnerLedger(owner, message) {
  if (owner.ledgerKey) {
    failServerShellCall(owner.ledgerKey, new Error(message), {
      durationMs: Date.now() - Number(owner.createdAt || Date.now())
    });
  }
}

function cleanupPersistentTmuxOwnerFiles(owner = {}) {
  for (const filePath of [owner.scriptPath, owner.launcherPath, owner.pidPath, owner.statusPath, owner.executedPath, owner.interruptedPath]) {
    if (!filePath) {
      continue;
    }
    try {
      fs.unlinkSync(filePath);
    } catch (_error) {
      // Best-effort recovery cleanup.
    }
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
  const boardName = normalizeRequestedBoardName(message.boardName || "");

  const timeoutMs = clampNumber(message.timeoutMs, 1000, 10 * 60 * 1000, DEFAULT_TIMEOUT_MS);
  const maxOutputChars = clampNumber(message.maxOutputChars, 1000, 200000, DEFAULT_MAX_OUTPUT_CHARS);
  const layout = await ensureForAiTmuxLayout();
  const panes = layout.panes;
  const resolved = resolveBoardPane(panes, process.env.AI_CHAT_SHELL_BOARD_TARGET || "", boardName);
  if (!resolved.pane) {
    return buildBoardTargetErrorResponse({
      message,
      cmd,
      boardName,
      panes,
      error: resolved.error
    });
  }

  const pane = resolved.pane;
  const cwd = pane.currentPath || "";
  const callKey = normalizeCallKey(message.callKey || message.id || hashText([
    "board",
    boardName,
    pane.id,
    cmd,
    timeoutMs,
    maxOutputChars
  ].join("\n")));
  const started = Date.now();
  const force = message.callMeta?.force === true || message.force === true;
  const reservation = reserveServerShellCall(callKey, {
    kind: "board",
    cmd,
    boardName,
    target: pane.id,
    timeoutMs,
    maxOutputChars,
    seq: message.seq,
    callMeta: message.callMeta || {},
    force
  });

  try {
    console.log(`[run-board] callKey=${callKey} seq=${message.seq || ""} boardName=${boardName || "board"} target=${pane.id} cmd=${JSON.stringify(cmd)}`);
    const result = await runTmuxBoard({
      cmd,
      pane,
      timeoutMs,
      maxOutputChars,
      reservationLedgerKey: reservation.ledgerKey,
      claimPayload: {
        cmd,
        boardName,
        timeoutMs,
        maxOutputChars,
        seq: message.seq,
        callMeta: message.callMeta || {},
        force
      }
    });
    console.log(`[done-board] ok=${result.ok !== false} exitCode=${result.exitCode} durationMs=${Date.now() - started} timedOut=${result.timedOut}`);

    const response = {
      ok: result.ok !== false,
      id: message.id,
      callKey,
      executionId: reservation.attemptId,
      cmd,
      boardName,
      cwd,
      target: pane.id,
      targetName: pane.label,
      timeoutMs,
      durationMs: Date.now() - started,
      ...result
    };
    if (result.executed !== true) {
      failServerShellCall(reservation.ledgerKey, new Error(result.error || result.stderr || "Board command execution was not confirmed complete."), {
        durationMs: Date.now() - started
      });
    } else {
      // A returned board prompt is sufficient to deliver this attempt's
      // captured result, but generic board prompts remain deliberately
      // ineligible for execution dedup (executionKey is always empty).
      completeServerShellCall(reservation.ledgerKey, response);
    }
    return response;
  } catch (error) {
    failServerShellCall(reservation.ledgerKey, error, { durationMs: Date.now() - started });
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
    completeServerShellCall(claim.ledgerKey, {
      ...response,
      exitCode: 0,
      timedOut: false,
      truncated: false
    });
    return response;
  } catch (error) {
    failServerShellCall(claim.ledgerKey, error, { durationMs: Date.now() - started });
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
  const body = String(message.body || "");
  if (!body.trim()) {
    return agentHubError("missing-body", "Missing agent message body.", { type: "agent-send" });
  }
  if (body.length > AGENT_MESSAGE_MAX_CHARS) {
    return agentHubError("message-too-large", `Agent message body is too large (${body.length} chars, max ${AGENT_MESSAGE_MAX_CHARS}).`, { type: "agent-send" });
  }
  const taskId = normalizeAgentTaskId(message.taskId || "");
  const messageId = normalizeAgentMessageId(message.messageId || `msg-${now}-${crypto.randomBytes(6).toString("hex")}`);
  const replyTo = normalizeAgentMessageId(message.replyTo || "");
  const existingResponse = resolveExistingAgentSend({ messageId, from, to, taskId, replyTo, body });
  if (existingResponse) {
    return existingResponse;
  }
  if (!touchAgent(from, now)) {
    return agentHubError("sender-not-registered", `Agent sender is not registered: ${from}`, { type: "agent-send", from });
  }
  if (!agentHubState.roster.has(to)) {
    return agentHubError("recipient-not-registered", `Agent recipient is not registered: ${to}`, { type: "agent-send", to });
  }
  const recipient = agentHubState.roster.get(to);
  if (recipient?.surface === "tmux-ai") {
    return agentHubError("tmux-ai-send-requires-async", "tmux-ai delivery requires the async agent hub path.", { type: "agent-send", to });
  }

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
    hubMessageType: "agent-send",
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

function resolveExistingAgentSend({ messageId, from, to, taskId, replyTo = "", body }) {
  const existing = agentHubState.mailbox.find((item) => item.messageId === messageId);
  if (!existing) {
    return null;
  }
  const identical = existing.from === from &&
    existing.to === to &&
    String(existing.taskId || "") === String(taskId || "") &&
    String(existing.replyTo || "") === String(replyTo || "") &&
    String(existing.body || "") === String(body || "") &&
    existing.hubMessageType !== "agent-reply";
  if (!identical) {
    return agentHubError("duplicate-message-id", `Agent message already exists with different payload: ${messageId}`, {
      type: "agent-send",
      messageId
    });
  }
  return {
    ok: true,
    type: "agent-send",
    message: existing,
    idempotent: true
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
  const body = String(message.body || "");
  if (!body.trim()) {
    return agentHubError("missing-body", "Missing agent message body.", { type: "agent-send" });
  }
  if (body.length > AGENT_MESSAGE_MAX_CHARS) {
    return agentHubError("message-too-large", `Agent message body is too large (${body.length} chars, max ${AGENT_MESSAGE_MAX_CHARS}).`, { type: "agent-send" });
  }
  const taskId = normalizeAgentTaskId(message.taskId || "");
  const messageId = normalizeAgentMessageId(message.messageId || `msg-${now}-${crypto.randomBytes(6).toString("hex")}`);
  const replyTo = normalizeAgentMessageId(message.replyTo || "");
  const existingResponse = resolveExistingAgentSend({ messageId, from, to, taskId, replyTo, body });
  if (existingResponse) {
    return existingResponse;
  }
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

  const delivery = await deliverTmuxAiTask({ sender, recipient, body, taskId, messageId, now });
  if (!delivery.ok) {
    return delivery;
  }

  const envelope = {
    messageId,
    from,
    to,
    taskId,
    replyTo,
    body,
    hubMessageType: "agent-send",
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
    hubMessageType: "agent-reply",
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
  completeServerShellCall(claim.ledgerKey, {
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

  const force = message.callMeta?.force === true || message.force === true;
  const started = Date.now();
  const callKey = normalizeCallKey(message.callKey || message.id || hashText([
    "vision-tmux",
    pane.id,
    cmd,
    timeoutMs,
    maxOutputChars
  ].join("\n")));
  const reservation = reserveServerShellCall(callKey, {
    kind: "visual",
    cmd,
    target: pane.id,
    timeoutMs,
    maxOutputChars,
    seq: message.seq,
    callMeta: message.callMeta || {},
    force
  });
  let claim = null;
  try {
    return await withTmuxShellPaneQueue({
      cmd,
      pane,
      kind: "visual",
      ledgerKey: reservation.ledgerKey
    }, async (queueContext) => {
      const currentPane = queueContext.currentPane;
      await updatePersistentTmuxPaneOwner(queueContext.owner, {
        ledgerKey: reservation.ledgerKey
      });
      const cwd = currentPane.currentPath || "";
      claim = adjudicateReservedServerShellCall(reservation.ledgerKey, {
        cmd,
        cwd,
        target: currentPane.id,
        executionTarget: buildTmuxPaneExecutionTarget(currentPane),
        timeoutMs,
        seq: message.seq,
        callMeta: message.callMeta || {},
        force
      });

      if (claim.action === "skip") {
        const response = buildExecutedDuplicateResponse({
          message,
          callKey,
          claim,
          cmd,
          cwd,
          pane: currentPane,
          timeoutMs
        });
        completeServerShellCall(reservation.ledgerKey, {
          ...response,
          queued: queueContext.queued,
          queuedMs: queueContext.queuedMs
        });
        return response;
      }

      const result = await runTmuxVisualLine({
        cmd,
        pane: currentPane,
        timeoutMs,
        maxOutputChars,
        ownerContext: queueContext.owner,
        ledgerKey: claim.ledgerKey
      });
      const response = {
        ok: result.ok !== false,
        id: message.id,
        callKey,
        cmd,
        cwd,
        target: currentPane.id,
        targetName: currentPane.label,
        timeoutMs,
        ...result,
        queued: queueContext.queued,
        queuedMs: queueContext.queuedMs
      };
      if (isConfirmedTmuxExecution(result)) {
        completeServerShellCall(claim.ledgerKey, {
          ...response,
          exitCode: Number.isInteger(response.exitCode) ? response.exitCode : (response.ok ? 0 : 1),
          timedOut: response.timedOut === true,
          truncated: response.truncated === true
        });
      } else {
        failServerShellCall(claim.ledgerKey, new Error(result.stderr || "Visual tmux command execution was not confirmed complete."), {
          durationMs: Date.now() - started
        });
      }
      return response;
    });
  } catch (error) {
    failServerShellCall(claim?.ledgerKey || reservation.ledgerKey, error, { durationMs: Date.now() - started });
    throw error;
  }
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

  return withTmuxShellPaneQueue({
    pane,
    cmd: "vision-terminal-self-test"
  }, async (queueContext) => {
    const currentPane = await verifyTmuxShellPaneBeforeDispatch(pane, queueContext);
    return runVisionTerminalSelfTestInPane(message, currentPane, started, queueContext.owner);
  });
}

async function runVisionTerminalSelfTestInPane(message, pane, started, ownerContext = null) {

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
    maxOutputChars: 20000,
    ownerContext
  });
  if (prep.ok === false || prep.exitCode !== 0) {
    return visionError("tmux-prep-failed", prep.stderr || "Could not prepare the tmux pane for vision self-test.", { prep });
  }


  // The OCR/window interaction below can outlive the shell preparation by
  // many seconds. Persist the live server process as the lease owner so a
  // freshly started handler cannot mistake the now-idle prompt for a free
  // pane and overlap another helper with this self-test.
  await updatePersistentTmuxPaneOwner(ownerContext, {
    kind: "vision-self-test",
    processPid: process.pid,
    selfTestStartedAt: Date.now()
  });

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

function reserveServerShellCall(callKey, payload = {}) {
  const now = Date.now();
  const force = payload.callMeta?.force === true || payload.force === true;
  const attemptId = crypto.randomBytes(8).toString("hex");
  const ledgerKey = `${callKey}:${attemptId}`;
  serverLedger.calls ||= {};
  serverLedger.calls[ledgerKey] = {
    callKey,
    attemptId,
    executionId: "",
    kind: normalizeServerCallKind(payload.kind),
    state: "running",
    phase: "queued",
    startedAt: now,
    queuedAt: now,
    queued: true,
    cmdHash: hashText(payload.cmd),
    cwd: "",
    target: payload.target || "",
    executionTarget: "",
    executionKey: "",
    timeoutMs: payload.timeoutMs,
    maxOutputChars: payload.maxOutputChars,
    seq: payload.seq || "",
    origin: payload.callMeta?.origin || "",
    pathname: payload.callMeta?.pathname || "",
    promptHash: payload.callMeta?.promptHash || "",
    forced: force,
    handlerProcessPid: process.pid
  };
  saveServerLedger();
  return { action: "reserved", ledgerKey, attemptId };
}

function adjudicateReservedServerShellCall(ledgerKey, payload = {}) {
  serverLedger.calls ||= {};
  const reservation = serverLedger.calls[ledgerKey];
  if (!ledgerKey || !reservation || reservation.state !== "running") {
    throw new Error("Queued shell call reservation is missing or no longer running.");
  }

  const force = payload.callMeta?.force === true || payload.force === true;
  const executionKey = buildServerExecutionKey(payload);
  if (!force && executionKey) {
    const completed = Object.entries(serverLedger.calls).find(([candidateKey, entry]) =>
      candidateKey !== ledgerKey && entry?.state === "completed" && entry.executionKey === executionKey
    );
    if (completed) {
      const [previousLedgerKey, previous] = completed;
      serverLedger.calls[ledgerKey] = {
        ...reservation,
        phase: "duplicate",
        authoritativeAt: Date.now(),
        cwd: payload.cwd,
        target: payload.target || "",
        executionTarget: payload.executionTarget || "",
        executionKey,
        executionId: previous.executionId || previous.attemptId || "",
        forced: false
      };
      saveServerLedger();
      return {
        action: "skip",
        reason: "already-executed-on-target",
        executionKey,
        ledgerKey,
        attemptId: reservation.attemptId,
        previousCallKey: previous.callKey || previousLedgerKey,
        previous
      };
    }
  }

  serverLedger.calls[ledgerKey] = {
    ...reservation,
    phase: "running",
    authoritativeAt: Date.now(),
    cwd: payload.cwd,
    target: payload.target || "",
    executionTarget: payload.executionTarget || "",
    executionKey,
    executionId: reservation.attemptId,
    timeoutMs: payload.timeoutMs,
    maxOutputChars: payload.maxOutputChars,
    seq: payload.seq || reservation.seq || "",
    origin: payload.callMeta?.origin || reservation.origin || "",
    pathname: payload.callMeta?.pathname || reservation.pathname || "",
    promptHash: payload.callMeta?.promptHash || reservation.promptHash || "",
    forced: force
  };
  saveServerLedger();
  return {
    action: "run",
    executionKey,
    ledgerKey,
    attemptId: reservation.attemptId
  };
}

function claimServerShellCall(callKey, payload) {
  const now = Date.now();
  const force = payload.callMeta?.force === true || payload.force === true;
  const executionKey = buildServerExecutionKey(payload);

  if (!force && executionKey) {
    const completed = Object.entries(serverLedger.calls || {}).find(([, entry]) =>
      entry?.state === "completed" && entry.executionKey === executionKey
    );
    if (completed) {
      const [previousLedgerKey, previous] = completed;
      return {
        action: "skip",
        reason: "already-executed-on-target",
        executionKey,
        previousCallKey: previous.callKey || previousLedgerKey,
        previous
      };
    }
  }

  serverLedger.calls ||= {};
  const attemptId = crypto.randomBytes(8).toString("hex");
  const ledgerKey = `${callKey}:${attemptId}`;
  serverLedger.calls[ledgerKey] = {
    callKey,
    attemptId,
    executionId: attemptId,
    state: "running",
    startedAt: now,
    cmdHash: hashText(payload.cmd),
    cwd: payload.cwd,
    target: payload.target || "",
    executionTarget: payload.executionTarget || "",
    executionKey,
    timeoutMs: payload.timeoutMs,
    maxOutputChars: payload.maxOutputChars,
    seq: payload.seq || "",
    origin: payload.callMeta?.origin || "",
    pathname: payload.callMeta?.pathname || "",
    promptHash: payload.callMeta?.promptHash || "",
    forced: force
  };
  saveServerLedger();
  return { action: "run", executionKey, ledgerKey, attemptId };
}

function buildServerExecutionKey(payload = {}) {
  const executionTarget = String(payload.executionTarget || "").trim();
  if (!executionTarget) {
    return "";
  }
  return hashText([
    executionTarget,
    String(payload.cmd || "").trim(),
    String(payload.cwd || "").trim()
  ].join("\n"));
}

function isConfirmedTmuxExecution(result = {}) {
  return result.executed === true && result.executionCompleted === true;
}

function buildTmuxPaneExecutionTarget(pane = {}) {
  if (!pane.serverPid || !pane.sessionCreated || !pane.id || !pane.panePid) {
    return "";
  }
  return [
    "tmux-pane",
    getTmuxSocketPath() || "default-socket",
    pane.serverPid,
    pane.sessionCreated,
    pane.id,
    pane.panePid
  ].join(":");
}

function buildExecutedDuplicateResponse({ message, callKey, claim, cmd, cwd = "", pane, timeoutMs, boardName = "" }) {
  const previous = claim?.previous || {};
  const replayedOutput = previous.resultStored === true;
  const executionId = previous.executionId || previous.attemptId || "";
  return {
    ok: true,
    id: message?.id,
    callKey,
    executionId,
    cmd,
    boardName,
    cwd,
    target: pane?.id || previous.target || "",
    targetName: pane?.label || "",
    timeoutMs,
    durationMs: 0,
    exitCode: Number.isInteger(previous.exitCode) ? previous.exitCode : 0,
    stdout: replayedOutput ? String(previous.stdout || "") : "",
    stderr: replayedOutput ? String(previous.stderr || "") : "",
    truncated: replayedOutput && previous.truncated === true,
    timedOut: false,
    executed: true,
    executionCompleted: true,
    duplicate: true,
    skipped: true,
    replayedOutput,
    previousResultPresented: previous.resultPresented === true,
    resultPresented: previous.resultPresented === true,
    reason: claim?.reason || "already-executed-on-target",
    previousCallKey: claim?.previousCallKey || "",
    previousCompletedAt: previous.completedAt || 0,
    previousInterrupted: previous.interrupted === true,
    previousInterruptSignal: previous.interruptSignal || ""
  };
}

function completeServerShellCall(ledgerKey, response) {
  serverLedger.calls ||= {};
  if (!ledgerKey || !serverLedger.calls[ledgerKey]) {
    return false;
  }
  const stdout = limitServerLedgerOutput(response.stdout);
  const stderr = limitServerLedgerOutput(response.stderr);
  serverLedger.calls[ledgerKey] = {
    ...serverLedger.calls[ledgerKey],
    state: "completed",
    phase: "completed",
    executionId: response.executionId || serverLedger.calls[ledgerKey].executionId || serverLedger.calls[ledgerKey].attemptId || "",
    completedAt: Date.now(),
    ok: response.ok !== false,
    exitCode: response.exitCode,
    resultStored: true,
    stdout: stdout.text,
    stderr: stderr.text,
    durationMs: response.durationMs,
    timedOut: response.timedOut === true,
    truncated: response.truncated === true || stdout.truncated || stderr.truncated,
    executed: response.executed !== false,
    executionCompleted: response.executionCompleted !== false,
    completionObserved: response.completionObserved === true,
    completionMarkerMissing: response.completionMarkerMissing === true,
    interrupted: response.interrupted === true,
    interruptSignal: response.interruptSignal || "",
    cancelledBeforeExecution: response.cancelledBeforeExecution === true,
    retryable: response.retryable === true,
    queued: response.queued === true,
    queuedMs: Number(response.queuedMs || 0),
    continuedAfterTimeout: response.continuedAfterTimeout === true,
    processKnown: response.processKnown === true,
    processAlive: response.processAlive === true,
    processPid: Number(response.processPid || 0),
    timeoutReason: response.timeoutReason || "",
    duplicate: response.duplicate === true,
    skipped: response.skipped === true,
    replayedOutput: response.replayedOutput === true,
    resultPresented: response.resultPresented === true || serverLedger.calls[ledgerKey].resultPresented === true,
    previousResultPresented: response.previousResultPresented === true,
    reason: response.reason || "",
    previousCallKey: response.previousCallKey || "",
    previousCompletedAt: Number(response.previousCompletedAt || 0),
    previousInterrupted: response.previousInterrupted === true,
    previousInterruptSignal: response.previousInterruptSignal || "",
    target: response.target || serverLedger.calls[ledgerKey].target || "",
    targetName: response.targetName || ""
  };
  pruneServerLedger();
  saveServerLedger();
  return true;
}

function limitServerLedgerOutput(value) {
  const text = String(value || "");
  if (text.length <= SERVER_LEDGER_OUTPUT_LIMIT) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, SERVER_LEDGER_OUTPUT_LIMIT),
    truncated: true
  };
}

function failServerShellCall(ledgerKey, error, extra = {}) {
  serverLedger.calls ||= {};
  if (!ledgerKey || !serverLedger.calls[ledgerKey]) {
    return false;
  }
  if (serverLedger.calls[ledgerKey].state === "completed") {
    // Completion proof is monotonic. A late owner-recovery error, socket
    // failure, or cleanup race must never erase duplicate authority for a
    // command the server already proved completed.
    return false;
  }
  serverLedger.calls[ledgerKey] = {
    ...serverLedger.calls[ledgerKey],
    state: "failed",
    phase: "failed",
    completedAt: Date.now(),
    exitCode: 1,
    durationMs: extra.durationMs,
    timedOut: false,
    truncated: false,
    error: summarizeError(error)
  };
  pruneServerLedger();
  saveServerLedger();
  return true;
}

function finishUnconfirmedServerShellCall(ledgerKey, response = {}) {
  serverLedger.calls ||= {};
  if (!ledgerKey || !serverLedger.calls[ledgerKey]) {
    return false;
  }
  serverLedger.calls[ledgerKey] = {
    ...serverLedger.calls[ledgerKey],
    state: "unconfirmed",
    phase: "unconfirmed",
    completedAt: Date.now(),
    exitCode: response.exitCode,
    durationMs: response.durationMs,
    timedOut: response.timedOut === true,
    truncated: response.truncated === true
  };
  pruneServerLedger();
  saveServerLedger();
  return true;
}

async function handleRunStatusMessage(message) {
  const callKey = String(message?.callKey || "").trim();
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(callKey)) {
    throw new Error("Missing or invalid shell callKey for status recovery.");
  }

  const kind = normalizeServerCallKind(message?.kind);
  let located = findLatestServerCallByCallKey(callKey, kind);
  if (
    located?.entry?.state === "running" &&
    located.entry.phase === "queued" &&
    located.entry.handlerProcessPid &&
    !isProcessAlive(located.entry.handlerProcessPid)
  ) {
    failServerShellCall(located.ledgerKey, new Error("The shell server exited while this request was still queued; no command was dispatched."));
    located = findLatestServerCallByCallKey(callKey, kind);
  }
  if (located?.entry?.state === "running") {
    await recoverPersistentOwnerForLedgerKey(located.ledgerKey).catch(() => false);
    located = findLatestServerCallByCallKey(callKey, kind);
  }

  if (!located) {
    return withProtocolMetadata({
      ok: true,
      type: "run-status",
      callKey,
      kind,
      found: false,
      state: "not-found"
    });
  }

  const { ledgerKey, entry } = located;
  const response = {
    ok: true,
    type: "run-status",
    callKey,
    kind,
    attemptId: entry.attemptId || ledgerKey,
    found: true,
    state: entry.state || "running",
    phase: entry.phase || entry.state || "running",
    queued: entry.queued === true,
    startedAt: Number(entry.startedAt || 0),
    completedAt: Number(entry.completedAt || 0)
  };
  if (entry.state === "completed" && entry.resultStored === true) {
    response.result = buildStoredShellResult(entry);
  } else if (entry.state === "failed" || entry.state === "unconfirmed") {
    response.error = entry.error || (entry.state === "unconfirmed"
      ? "Shell execution did not produce an authoritative completion proof."
      : "Shell execution failed.");
  }
  return withProtocolMetadata(response);
}

function handleRunResultPresentedMessage(message) {
  const executionId = String(message?.executionId || "").trim();
  if (!/^[a-f0-9]{16}$/i.test(executionId)) {
    throw new Error("Missing or invalid executionId for result presentation receipt.");
  }
  const presentedAt = Date.now();
  let matched = 0;
  for (const [ledgerKey, entry] of Object.entries(serverLedger.calls || {})) {
    const canonicalId = String(entry?.executionId || entry?.attemptId || "");
    if (canonicalId !== executionId) {
      continue;
    }
    serverLedger.calls[ledgerKey] = {
      ...entry,
      executionId,
      resultPresented: true,
      resultPresentedAt: presentedAt
    };
    matched += 1;
  }
  if (matched > 0) {
    saveServerLedger();
  }
  return withProtocolMetadata({
    ok: true,
    type: "run-result-presented",
    executionId,
    found: matched > 0,
    matched
  });
}

function findLatestServerCallByCallKey(callKey, kind = "shell") {
  const matches = Object.entries(serverLedger.calls || {})
    .filter(([, entry]) => entry?.callKey === callKey && normalizeServerCallKind(entry?.kind) === kind)
    .sort(([, left], [, right]) => Number(right.startedAt || 0) - Number(left.startedAt || 0));
  if (matches.length === 0) {
    return null;
  }
  const [ledgerKey, entry] = matches[0];
  return { ledgerKey, entry };
}

function buildStoredShellResult(entry = {}) {
  return {
    ok: entry.ok !== false,
    callKey: entry.callKey || "",
    executionId: entry.executionId || entry.attemptId || "",
    resultPresented: entry.resultPresented === true,
    cwd: entry.cwd || "",
    target: entry.target || "",
    targetName: entry.targetName || "",
    timeoutMs: Number(entry.timeoutMs || 0),
    exitCode: Number.isInteger(entry.exitCode) ? entry.exitCode : 0,
    stdout: String(entry.stdout || ""),
    stderr: String(entry.stderr || ""),
    durationMs: Number(entry.durationMs || 0),
    timedOut: entry.timedOut === true,
    truncated: entry.truncated === true,
    executed: entry.executed === true,
    executionCompleted: entry.executionCompleted === true,
    completionObserved: entry.completionObserved === true,
    completionMarkerMissing: entry.completionMarkerMissing === true,
    interrupted: entry.interrupted === true,
    interruptSignal: entry.interruptSignal || "",
    cancelledBeforeExecution: entry.cancelledBeforeExecution === true,
    retryable: entry.retryable === true,
    queued: entry.queued === true,
    queuedMs: Number(entry.queuedMs || 0),
    continuedAfterTimeout: entry.continuedAfterTimeout === true,
    processKnown: entry.processKnown === true,
    processAlive: entry.processAlive === true,
    processPid: Number(entry.processPid || 0),
    timeoutReason: entry.timeoutReason || "",
    duplicate: entry.duplicate === true,
    skipped: entry.skipped === true,
    replayedOutput: entry.replayedOutput === true,
    // A presentation receipt is canonical across the whole duplicate chain.
    // A duplicate entry may have persisted `previousResultPresented: false`
    // before another request presented the same execution. Status recovery
    // must observe that later monotonic receipt instead of replaying the result
    // to the model again.
    previousResultPresented: entry.previousResultPresented === true || entry.resultPresented === true,
    reason: entry.reason || "",
    previousCallKey: entry.previousCallKey || "",
    previousCompletedAt: Number(entry.previousCompletedAt || 0),
    previousInterrupted: entry.previousInterrupted === true,
    previousInterruptSignal: entry.previousInterruptSignal || "",
    recovered: true
  };
}

function normalizeServerCallKind(value) {
  const kind = String(value || "shell").trim().toLowerCase();
  return ["shell", "board", "visual"].includes(kind) ? kind : "shell";
}

async function recoverPersistentOwnerForLedgerKey(ledgerKey) {
  const socketPath = getTmuxSocketPath() || "default-socket";
  const panes = await listTmuxPanes({ quiet: true });
  for (const pane of panes) {
    const owner = await readPersistentTmuxPaneOwner(pane);
    if (owner?.ledgerKey !== ledgerKey) {
      continue;
    }
    await settlePersistentTmuxPaneOwner(owner, pane, socketPath);
    return true;
  }
  return false;
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
  if (entries.length > SERVER_LEDGER_LIMIT) {
    const removable = entries
      .filter(([, entry]) => ["completed", "failed", "unconfirmed"].includes(entry?.state))
      .sort(([, a], [, b]) => Number(b.completedAt || b.startedAt || 0) - Number(a.completedAt || a.startedAt || 0))
      .reverse();
    const removeCount = Math.min(entries.length - SERVER_LEDGER_LIMIT, removable.length);
    removable
      .slice(0, removeCount)
      .forEach(([key]) => {
        delete serverLedger.calls[key];
      });
  }
  enforceServerLedgerReplayBudget(serverLedger);
}

function enforceServerLedgerReplayBudget(ledger) {
  let retainedBytes = 0;
  const completed = Object.values(ledger.calls || {})
    .filter((entry) => entry?.state === "completed" && entry.resultStored === true)
    .sort((left, right) => Number(right.completedAt || 0) - Number(left.completedAt || 0));
  for (const entry of completed) {
    const replayBytes = Buffer.byteLength(String(entry.stdout || ""), "utf8") +
      Buffer.byteLength(String(entry.stderr || ""), "utf8");
    if (retainedBytes + replayBytes <= SERVER_LEDGER_REPLAY_BUDGET_BYTES) {
      retainedBytes += replayBytes;
      continue;
    }
    // Keep executionKey/completion proof for authoritative duplicate
    // adjudication, but expire only the replay payload to bound synchronous
    // ledger rewrites and startup parsing.
    entry.stdout = "";
    entry.stderr = "";
    entry.resultStored = false;
    entry.resultExpired = true;
  }
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
    /^ai-helper-board-[A-Za-z0-9][A-Za-z0-9._-]{0,63}-(?:start|end)(?::[A-Za-z0-9._:-]{1,128})?$/.test(line) ||
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

function normalizeRequestedBoardName(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const match = raw.match(/^board-(.+)$/);
  if (!match || !BOARD_NAME_SUFFIX_PATTERN.test(match[1])) {
    throw new Error(`Board name must be empty or board-<suffix>, where suffix matches ${BOARD_NAME_SUFFIX_PATTERN.source}.`);
  }
  return raw;
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

async function runTmuxShell({ cmd, cwd, pane, timeoutMs, maxOutputChars, ownerContext = null, ledgerKey = "" }) {
  const runId = crypto.randomBytes(8).toString("hex");
  const startMarker = `__AI_CHAT_SHELL_EXEC_START_${runId}__`;
  const doneMarker = `__AI_CHAT_SHELL_EXEC_DONE_${runId}__`;
  const scriptPath = path.join(TMUX_SCRIPT_DIR, `${runId}.zsh`);
  const launcherPath = path.join(TMUX_SCRIPT_DIR, `${runId}.launcher.sh`);
  const pidPath = path.join(TMUX_SCRIPT_DIR, `${runId}.pid`);
  const statusPath = path.join(TMUX_SCRIPT_DIR, `${runId}.status`);
  const executedPath = path.join(TMUX_SCRIPT_DIR, `${runId}.executed`);
  const interruptedPath = path.join(TMUX_SCRIPT_DIR, `${runId}.interrupted`);
  fs.mkdirSync(TMUX_SCRIPT_DIR, { recursive: true });
  fs.writeFileSync(scriptPath, buildTmuxRunScript({
    cmd,
    cwd,
    startMarker,
    doneMarker,
    pidPath,
    statusPath,
    executedPath,
    interruptedPath
  }), { mode: 0o700 });
  fs.writeFileSync(launcherPath, buildTmuxRunLauncherScript({
    scriptPath,
    pidPath,
    statusPath,
    executedPath,
    interruptedPath,
    doneMarker
  }), { mode: 0o700 });

  await updatePersistentTmuxPaneOwner(ownerContext, {
    kind: "shell",
    ledgerKey,
    startMarker,
    doneMarker,
    maxOutputChars,
    scriptPath,
    launcherPath,
    pidPath,
    statusPath,
    executedPath,
    interruptedPath
  });

  const started = Date.now();
  const markerLossGraceMs = 2000;
  let processExitMissingSince = 0;
  let unknownStateSince = 0;
  let continuedAfterTimeout = false;
  let lastCapture = "";
  try {
    await sendTmuxLiteralLine(pane.id, `/bin/sh ${shellQuote(launcherPath)}`);

    while (true) {
      await sleep(TMUX_POLL_INTERVAL_MS);
      lastCapture = await captureTmuxPane(pane.id).catch(() => lastCapture);
      const extracted = extractTmuxRunOutput(lastCapture, startMarker, doneMarker, maxOutputChars);
      if (extracted.foundDone) {
        const executed = fs.existsSync(executedPath);
        const interruptSignal = readTmuxShellInterruptSignal(interruptedPath);
        return {
          executed,
          executionCompleted: executed,
          cancelledBeforeExecution: !executed && Boolean(interruptSignal),
          retryable: !executed,
          interrupted: Boolean(interruptSignal),
          interruptSignal,
          exitCode: extracted.exitCode,
          stdout: extracted.stdout,
          stderr: formatTmuxShellInterruptMessage(interruptSignal),
          truncated: extracted.truncated,
          timedOut: false,
          continuedAfterTimeout,
          target: pane.id,
          targetName: pane.label
        };
      }

      const state = readTmuxShellRunState(pidPath, statusPath);
      if (state.completed) {
        // The status file is a server-controlled completion acknowledgement.
        // Give the terminal one short flush window for the done marker, then
        // return immediately even if pane capture lost that marker.
        await sleep(50);
        lastCapture = await captureTmuxPane(pane.id).catch(() => lastCapture);
        const finalExtracted = extractTmuxRunOutput(lastCapture, startMarker, doneMarker, maxOutputChars);
        const executed = fs.existsSync(executedPath);
        const interruptSignal = readTmuxShellInterruptSignal(interruptedPath);
        return {
          executed,
          executionCompleted: executed,
          cancelledBeforeExecution: !executed && Boolean(interruptSignal),
          retryable: !executed,
          interrupted: Boolean(interruptSignal),
          interruptSignal,
          exitCode: finalExtracted.foundDone ? finalExtracted.exitCode : state.exitCode,
          stdout: finalExtracted.stdout,
          stderr: formatTmuxShellInterruptMessage(interruptSignal),
          truncated: finalExtracted.truncated,
          timedOut: false,
          completionMarkerMissing: !finalExtracted.foundDone,
          processKnown: true,
          processAlive: false,
          processPid: state.pid || 0,
          continuedAfterTimeout,
          target: pane.id,
          targetName: pane.label
        };
      }

      if (Date.now() - started < timeoutMs) {
        continue;
      }

      if (state.processAlive) {
        continuedAfterTimeout = true;
        processExitMissingSince = 0;
        unknownStateSince = 0;
        continue;
      }

      if (state.processKnown) {
        processExitMissingSince = processExitMissingSince || Date.now();
        if (Date.now() - processExitMissingSince < markerLossGraceMs) {
          continue;
        }
        const partial = extractTmuxRunOutput(lastCapture, startMarker, doneMarker, maxOutputChars);
        return {
          executed: fs.existsSync(executedPath),
          executionCompleted: false,
          exitCode: 124,
          stdout: partial.stdout,
          stderr: "Timed out waiting for tmux completion marker after the shell process exited without reporting completion.",
          truncated: partial.truncated,
          timedOut: true,
          timeoutReason: "process-exited-missing-completion",
          processKnown: true,
          processAlive: false,
          processPid: state.pid || 0,
          continuedAfterTimeout,
          target: pane.id,
          targetName: pane.label
        };
      }

      unknownStateSince = unknownStateSince || Date.now();
      if (Date.now() - unknownStateSince < markerLossGraceMs) {
        continue;
      }
      const partial = extractTmuxRunOutput(lastCapture, startMarker, doneMarker, maxOutputChars);
      return {
        executed: fs.existsSync(executedPath),
        executionCompleted: false,
        exitCode: 124,
        stdout: partial.stdout,
        stderr: "Timed out waiting for tmux command completion marker and could not confirm a running shell process.",
        truncated: partial.truncated,
        timedOut: true,
        timeoutReason: "process-state-unknown",
        processKnown: false,
        processAlive: false,
        processPid: 0,
        continuedAfterTimeout,
        target: pane.id,
        targetName: pane.label
      };
    }
  } finally {
    if (!ownerContext) {
      cleanupPersistentTmuxOwnerFiles({
        scriptPath,
        launcherPath,
        pidPath,
        statusPath,
        executedPath,
        interruptedPath
      });
    }
  }
}

function readTmuxShellInterruptSignal(interruptedPath) {
  try {
    return fs.readFileSync(interruptedPath, "utf8").trim().toUpperCase();
  } catch {
    return "";
  }
}

function formatTmuxShellInterruptMessage(signal) {
  if (!signal) {
    return "";
  }
  return signal === "INT"
    ? "Command interrupted by Ctrl+C (SIGINT)."
    : `Command interrupted by SIG${signal}.`;
}

function readTmuxShellRunState(pidPath, statusPath) {
  const pid = readPidFile(pidPath);
  const exitCode = readExitStatusFile(statusPath);
  if (exitCode !== null) {
    return {
      completed: true,
      exitCode,
      pid,
      processKnown: pid > 0,
      processAlive: false
    };
  }
  if (pid > 0) {
    return {
      completed: false,
      exitCode: 124,
      pid,
      processKnown: true,
      processAlive: isProcessAlive(pid)
    };
  }
  return {
    completed: false,
    exitCode: 124,
    pid: 0,
    processKnown: false,
    processAlive: false
  };
}

function readPidFile(pidPath) {
  try {
    const text = fs.readFileSync(pidPath, "utf8").trim();
    const pid = Number(text);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function readExitStatusFile(statusPath) {
  try {
    const text = fs.readFileSync(statusPath, "utf8").trim();
    if (!/^\d+$/.test(text)) {
      return null;
    }
    const exitCode = Number(text);
    return Number.isInteger(exitCode) && exitCode >= 0 ? exitCode : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

async function runTmuxBoard(options) {
  return withTmuxShellPaneQueue({
    cmd: options?.cmd,
    pane: options?.pane,
    kind: "board",
    ledgerKey: options?.reservationLedgerKey || options?.ledgerKey || ""
  }, async (queueContext) => {
    const ledgerKey = options?.reservationLedgerKey || options?.ledgerKey || "";
    if (options?.reservationLedgerKey) {
      await updatePersistentTmuxPaneOwner(queueContext.owner, { ledgerKey });
      adjudicateReservedServerShellCall(ledgerKey, {
        ...(options.claimPayload || {}),
        cwd: queueContext.currentPane.currentPath || "",
        target: queueContext.currentPane.id,
        // Generic board prompts are serialization evidence only and never
        // establish execution duplicate authority.
        executionTarget: ""
      });
    }
    const result = await runTmuxBoardInPane({
      ...options,
      pane: queueContext.currentPane,
      ownerContext: queueContext.owner,
      ledgerKey
    });
    return {
      ...result,
      cwd: queueContext.currentPane.currentPath || ""
    };
  });
}

async function runTmuxBoardInPane({ cmd, pane, timeoutMs, maxOutputChars, ownerContext = null, ledgerKey = "" }) {
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
      executed: false,
      truncated: false,
      timedOut: false,
      target: pane.id,
      targetName: pane.label
    };
  }

  const boardShellPrompt = INTERACTIVE_SHELL_COMMANDS.has(
    path.basename(String(pane.currentCommand || "")).replace(/^-/, "")
  );
  let pipeStarted = false;
  try {
    const prompt = await readStableBoardPrompt(pane, timing);
    if (!prompt) {
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "",
        error: "Board prompt probe failed; command was not sent.",
        executed: false,
        truncated: false,
        timedOut: false,
        target: pane.id,
        targetName: pane.label
      };
    }

    await startTmuxPanePipe(pane.id, logPath);
    pipeStarted = true;
    await sleep(timing.pollMs);

    const commandOffset = getFileSize(logPath);
    await updatePersistentTmuxPaneOwner(ownerContext, {
      kind: "board",
      ledgerKey,
      processPid: process.pid,
      boardLogPath: logPath,
      boardPrompt: prompt,
      boardShellPrompt,
      boardOffset: commandOffset,
      boardState: "prepared"
    });
    await updatePersistentTmuxPaneOwnerAndSendLine(ownerContext, {
      boardState: "sent"
    }, cmd);
    const captured = await waitForBoardPromptAndPaneReady({
      pane,
      logPath,
      offset: commandOffset,
      prompt,
      timeoutMs,
      idleMs: timing.promptIdleMs,
      pollMs: timing.pollMs,
      maxOutputChars,
      requireShellReady: boardShellPrompt
    });
    await updatePersistentTmuxPaneOwner(ownerContext, {
      boardState: "prompt-returned"
    });

    return {
      executed: true,
      executionCompleted: false,
      completionObserved: true,
      exitCode: captured.crossedTimeout ? 124 : 0,
      stdout: captured.stdout,
      stderr: captured.crossedTimeout ? "The board command exceeded its response timeout, but the pane lease remained active until the prompt returned." : "",
      truncated: captured.truncated,
      timedOut: captured.crossedTimeout,
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

async function readStableBoardPrompt(pane, timing) {
  if (INTERACTIVE_SHELL_COMMANDS.has(path.basename(String(pane.currentCommand || "")).replace(/^-/, "")) &&
      !await isTmuxPaneReadyForHelper(pane)) {
    return "";
  }
  const first = normalizeBoardOutput(await captureTmuxPane(pane.id, DEFAULT_MAX_OUTPUT_CHARS));
  await sleep(timing.probeIdleMs);
  const currentPane = await verifyTmuxShellPaneBeforeDispatch(pane, {
    socketPath: getTmuxSocketPath() || "default-socket",
    quiet: true
  });
  if (INTERACTIVE_SHELL_COMMANDS.has(path.basename(String(currentPane.currentCommand || "")).replace(/^-/, "")) &&
      !await isTmuxPaneReadyForHelper(currentPane)) {
    return "";
  }
  const second = normalizeBoardOutput(await captureTmuxPane(pane.id, DEFAULT_MAX_OUTPUT_CHARS));
  if (first !== second) {
    return "";
  }
  const prompt = extractBoardPromptSignature(second);
  return looksLikeBoardPrompt(prompt) ? prompt : "";
}

function looksLikeBoardPrompt(prompt) {
  const text = String(prompt || "").trim();
  return text.length > 0 && text.length <= 200 && /(?:[$#%>]|[›❯λ])$/.test(text);
}

async function waitForBoardPromptAndPaneReady({ pane, logPath, offset, prompt, timeoutMs, idleMs, pollMs, maxOutputChars, requireShellReady = false }) {
  const startedAt = Date.now();
  let lastSize = getFileSize(logPath);
  let lastChangeAt = Date.now();
  let latest = readBoardLogFromOffset(logPath, offset, maxOutputChars);
  let lastPaneCheckAt = 0;

  while (true) {
    await sleep(pollMs);
    if (Date.now() - lastPaneCheckAt >= 1000) {
      await verifyTmuxShellPaneBeforeDispatch(pane, {
        socketPath: getTmuxSocketPath() || "default-socket",
        queued: true,
        quiet: true
      });
      lastPaneCheckAt = Date.now();
    }
    latest = readBoardLogFromOffset(logPath, offset, maxOutputChars);
    if (latest.size !== lastSize) {
      lastSize = latest.size;
      lastChangeAt = Date.now();
    }
    if (latest.bytesRead > 0 &&
        outputEndsWithBoardPrompt(latest.normalized, prompt) &&
        Date.now() - lastChangeAt >= idleMs) {
      const currentPane = await verifyTmuxShellPaneBeforeDispatch(pane, {
        socketPath: getTmuxSocketPath() || "default-socket",
        queued: true,
        quiet: true
      });
      if (await isBoardPaneReadyAfterCommand(currentPane, requireShellReady)) {
        return {
          ...latest,
          crossedTimeout: Date.now() - startedAt >= timeoutMs
        };
      }
    }
  }
}

async function isBoardPaneReadyAfterCommand(pane, requireShellReady = false) {
  const command = path.basename(String(pane.currentCommand || "")).replace(/^-/, "");
  if (!requireShellReady && !INTERACTIVE_SHELL_COMMANDS.has(command)) {
    // Generic board TUIs do not expose an authoritative completion primitive.
    // Their stable returned input prompt is sufficient for serialization, but
    // remains deliberately insufficient for execution deduplication.
    return true;
  }
  return isTmuxPaneReadyForHelper(pane);
}

async function runTmuxVisualLine({ cmd, pane, timeoutMs, maxOutputChars, ownerContext = null, ledgerKey = "" }) {
  const started = Date.now();
  const runId = randomOcrSafeToken(8);
  const runWindowName = `${VISION_TMUX_RUN_PREFIX}_RUN_${runId}`;
  const donePrefix = `${VISION_TMUX_RUN_PREFIX}_DONE_${runId}_`;
  const statusPath = path.join(TMUX_SCRIPT_DIR, `${runId}.visual.status`);
  const executedPath = path.join(TMUX_SCRIPT_DIR, `${runId}.visual.executed`);
  fs.mkdirSync(TMUX_SCRIPT_DIR, { recursive: true });
  const runLine = buildTmuxVisualRunLine({ cmd, runWindowName, donePrefix, statusPath, executedPath });

  await updatePersistentTmuxPaneOwner(ownerContext, {
    kind: "visual",
    ledgerKey,
    runWindowName,
    donePrefix,
    statusPath,
    executedPath
  });

  try {
    await runTmuxCommand(["send-keys", "-t", pane.id, "C-l"], { timeoutMs: 5000 });
    await runTmuxCommand(["clear-history", "-t", pane.id], { timeoutMs: 5000 });
    await runTmuxCommand(["rename-window", "-t", pane.id, runWindowName], { timeoutMs: 5000 });
    await sendTmuxLiteralLine(pane.id, runLine);

    const done = await waitForTmuxWindowDone({
      target: pane.id,
      donePrefix,
      timeoutMs,
      statusPath
    });
    const terminalText = await captureTmuxPane(pane.id, maxOutputChars);
    const parsed = parseTmuxVisualDoneWindowName(done.windowName, donePrefix);
    const lineCount = terminalText ? terminalText.split("\n").length : 0;
    const charCount = terminalText.length;

    return {
      ok: done.found,
      executed: fs.existsSync(executedPath),
      executionCompleted: done.found && fs.existsSync(executedPath),
      runId,
      runWindowName,
      doneWindowName: done.windowName,
      exitCode: done.found ? (Number.isInteger(done.exitCode) ? done.exitCode : parsed.exitCode) : 124,
      terminalText,
      lineCount,
      charCount,
      truncated: done.truncated || charCount >= maxOutputChars,
      timedOut: !done.found,
      continuedAfterTimeout: done.continuedAfterTimeout === true,
      completionMarkerMissing: done.completionMarkerMissing === true,
      stderr: done.found ? "" : "Timed out waiting for tmux window done marker. The command may still be running in the target pane.",
      durationMs: Date.now() - started
    };
  } finally {
    if (!ownerContext) {
      cleanupPersistentTmuxOwnerFiles({ statusPath, executedPath });
    }
  }
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

function buildTmuxVisualRunLine({ cmd, runWindowName, donePrefix, statusPath = "", executedPath = "" }) {
  return [
    `tmux rename-window ${shellQuote(runWindowName)}`,
    executedPath ? `printf '1\\n' > ${shellQuote(executedPath)}` : "",
    `/bin/sh -c ${shellQuote(cmd)}`,
    "__AI_VISION_EXIT_CODE=$?",
    statusPath ? `printf '%s\\n' "$__AI_VISION_EXIT_CODE" > ${shellQuote(statusPath)}` : "",
    `tmux rename-window \"${donePrefix}\${__AI_VISION_EXIT_CODE}\"`
  ].filter(Boolean).join("; ");
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

async function waitForTmuxWindowDone({ target, donePrefix, timeoutMs, statusPath = "" }) {
  const started = Date.now();
  let lastWindowName = "";
  let continuedAfterTimeout = false;
  while (true) {
    await sleep(TMUX_POLL_INTERVAL_MS);
    lastWindowName = await getTmuxWindowName(target);
    if (lastWindowName.startsWith(donePrefix)) {
      return {
        found: true,
        windowName: lastWindowName,
        truncated: false,
        continuedAfterTimeout
      };
    }
    const status = statusPath ? readExitStatusFile(statusPath) : null;
    if (status !== null) {
      return {
        found: true,
        windowName: lastWindowName,
        exitCode: status,
        truncated: false,
        continuedAfterTimeout,
        completionMarkerMissing: true
      };
    }
    if (Date.now() - started >= timeoutMs) {
      continuedAfterTimeout = true;
      if (!statusPath) {
        return {
          found: false,
          windowName: lastWindowName,
          truncated: false,
          continuedAfterTimeout
        };
      }
    }
  }
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

function buildTmuxRunScript({ cmd, cwd, startMarker, doneMarker, pidPath, statusPath, executedPath, interruptedPath }) {
  return [
    `#!${SHELL_RUNNER}`,
    "set +e",
    interruptedPath ? "__ai_chat_shell_exec_finish_signal() {" : "",
    interruptedPath ? "  __ai_chat_shell_exec_signal=$1" : "",
    interruptedPath ? "  __ai_chat_shell_exec_status=$2" : "",
    interruptedPath ? "  trap - INT TERM HUP" : "",
    interruptedPath ? `  printf '%s\\n' \"$__ai_chat_shell_exec_signal\" > ${shellQuote(interruptedPath)}` : "",
    interruptedPath ? `  printf '%s\\n' \"$__ai_chat_shell_exec_status\" > ${shellQuote(statusPath)}` : "",
    interruptedPath ? `  printf '\\n%s:%s\\n' ${shellQuote(doneMarker)} \"$__ai_chat_shell_exec_status\"` : "",
    interruptedPath ? "  exit \"$__ai_chat_shell_exec_status\"" : "",
    interruptedPath ? "}" : "",
    interruptedPath ? "trap '__ai_chat_shell_exec_finish_signal INT 130' INT" : "",
    interruptedPath ? "trap '__ai_chat_shell_exec_finish_signal TERM 143' TERM" : "",
    interruptedPath ? "trap '__ai_chat_shell_exec_finish_signal HUP 129' HUP" : "",
    `printf '\\n%s\\n' ${shellQuote(startMarker)}`,
    `printf '%s\\n' \"$$\" > ${shellQuote(pidPath)}`,
    "(",
    cwd ? `  cd -- ${shellQuote(cwd)} || exit $?` : "",
    executedPath ? `  printf '1\\n' > ${shellQuote(executedPath)}` : "",
    cmd,
    ")",
    "__ai_chat_shell_exec_status=$?",
    interruptedPath ? "trap - INT TERM HUP" : "",
    `printf '%s\\n' \"$__ai_chat_shell_exec_status\" > ${shellQuote(statusPath)}`,
    `printf '\\n%s:%s\\n' ${shellQuote(doneMarker)} \"$__ai_chat_shell_exec_status\"`,
    "exit \"$__ai_chat_shell_exec_status\"",
    ""
  ].filter((line) => line !== "").join("\n");
}

function buildTmuxRunLauncherScript({ scriptPath, pidPath, statusPath, interruptedPath, doneMarker }) {
  return [
    "#!/bin/sh",
    "set +e",
    "__ai_chat_shell_launcher_finish() {",
    "  __ai_chat_shell_launcher_signal=$1",
    "  __ai_chat_shell_launcher_status=$2",
    "  trap - INT TERM HUP",
    `  if [ ! -e ${shellQuote(statusPath)} ]; then`,
    `    printf '%s\\n' "$__ai_chat_shell_launcher_signal" > ${shellQuote(interruptedPath)}`,
    `    printf '%s\\n' "$__ai_chat_shell_launcher_status" > ${shellQuote(statusPath)}`,
    `    printf '\\n%s:%s\\n' ${shellQuote(doneMarker)} "$__ai_chat_shell_launcher_status"`,
    "  fi",
    "  exit \"$__ai_chat_shell_launcher_status\"",
    "}",
    "trap '__ai_chat_shell_launcher_finish INT 130' INT",
    "trap '__ai_chat_shell_launcher_finish TERM 143' TERM",
    "trap '__ai_chat_shell_launcher_finish HUP 129' HUP",
    `printf '%s\\n' "$$" > ${shellQuote(pidPath)}`,
    `${shellQuote(SHELL_RUNNER)} ${shellQuote(scriptPath)}`,
    "__ai_chat_shell_launcher_status=$?",
    "trap - INT TERM HUP",
    `if [ ! -e ${shellQuote(statusPath)} ]; then`,
    "  case \"$__ai_chat_shell_launcher_status\" in",
    `    130) printf 'INT\\n' > ${shellQuote(interruptedPath)} ;;`,
    `    143) printf 'TERM\\n' > ${shellQuote(interruptedPath)} ;;`,
    `    129) printf 'HUP\\n' > ${shellQuote(interruptedPath)} ;;`,
    "  esac",
    `  printf '%s\\n' "$__ai_chat_shell_launcher_status" > ${shellQuote(statusPath)}`,
    `  printf '\\n%s:%s\\n' ${shellQuote(doneMarker)} "$__ai_chat_shell_launcher_status"`,
    "fi",
    "exit \"$__ai_chat_shell_launcher_status\"",
    ""
  ].join("\n");
}

async function listTmuxPanes({ quiet = false } = {}) {
  const result = await runTmuxCommand(["list-panes", "-a", "-F", TMUX_LIST_FORMAT], { timeoutMs: 5000 });
  const panes = parseTmuxPanes(result.stdout);
  if (!quiet) {
    console.log(`[tmux-list] socket=${getTmuxSocketPath() || "(default)"} panes=${panes.length} stdoutChars=${result.stdout.length}`);
  }
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
        currentCommand,
        sessionCreated,
        serverPid,
        panePid,
        paneTty
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
        sessionCreated: sessionCreated || "",
        serverPid: serverPid || "",
        panePid: panePid || "",
        paneTty: paneTty || "",
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

function resolveBoardPane(panes, configuredTarget = "", boardName = "") {
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

  return resolveDefaultBoardPane(panes, getForAiTmuxConfig(), boardName);
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

function resolveDefaultBoardPane(panes, config = getForAiTmuxConfig(), boardName = "") {
  const targetBoardWindowName = boardName || config.boardWindowName;
  const matches = panes.filter((pane) =>
    pane.session === config.sessionName &&
    pane.windowName === targetBoardWindowName
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
      error: `Multiple tmux panes match ${config.sessionName}:${targetBoardWindowName}. Set AI_CHAT_SHELL_BOARD_TARGET to a pane id or session:window.pane.`
    };
  }
  return {
    pane: null,
    error: `No tmux pane found in ${config.sessionName}:${targetBoardWindowName}. Run tmux setup or set AI_CHAT_SHELL_BOARD_TARGET.`
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

function buildBoardTargetErrorResponse({ message, cmd, boardName = "", panes, error }) {
  return {
    ok: false,
    id: message.id,
    callKey: message.callKey || message.id || "",
    cmd,
    boardName,
    targetRequired: false,
    error,
    tmuxPanes: panes,
    example: buildBoardHelperExample(cmd, boardName)
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

function buildBoardHelperExample(cmd = "version", boardName = "") {
  const boardSuffix = boardName && boardName.startsWith("board-") ? boardName.slice("board-".length) : "";
  const startMarker = boardSuffix ? `ai-helper-board-${boardSuffix}-start` : HELPER_BOARD_START;
  const endMarker = boardSuffix ? `ai-helper-board-${boardSuffix}-end` : HELPER_BOARD_END;
  return [
    startMarker,
    cmd || "version",
    endMarker
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

function getFileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
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

function buildTmuxLiteralLineArgs(paneId, text) {
  return [
    "send-keys", "-t", paneId, "-l", String(text || ""),
    ";",
    "send-keys", "-t", paneId, "Enter"
  ];
}

function sendTmuxLiteralLine(paneId, text) {
  // One tmux client request makes the literal payload and Enter inseparable
  // from the shell server's perspective. In particular, a Node/server crash
  // cannot leave a dangerous helper launcher buffered at the prompt.
  return runTmuxCommand(buildTmuxLiteralLineArgs(paneId, text), { timeoutMs: 5000 });
}

async function updatePersistentTmuxPaneOwnerAndSendLine(ownerContext, patch, text) {
  if (!ownerContext?.pane?.id || !ownerContext.token) {
    throw new Error("Cannot atomically dispatch without persistent tmux pane ownership.");
  }
  const next = {
    ...ownerContext,
    ...patch
  };
  const currentEncoded = encodePersistentTmuxPaneOwner(ownerContext);
  const nextEncoded = encodePersistentTmuxPaneOwner(next);
  const paneId = ownerContext.pane.id;
  const condition = `#{==:#{${TMUX_PANE_OWNER_OPTION}},${currentEncoded}}`;
  const dispatchCommand = [
    `set-option -p -t ${shellQuote(paneId)} ${TMUX_PANE_OWNER_OPTION} ${shellQuote(nextEncoded)}`,
    `send-keys -t ${shellQuote(paneId)} -l ${shellQuote(String(text || ""))}`,
    `send-keys -t ${shellQuote(paneId)} Enter`
  ].join(" ; ");
  await runTmuxCommand([
    "if-shell", "-F", "-t", paneId,
    condition,
    dispatchCommand,
    ""
  ], { timeoutMs: 5000 });
  const current = await readPersistentTmuxPaneOwner(ownerContext.pane);
  if (!current || encodePersistentTmuxPaneOwner(current) !== nextEncoded) {
    throw new Error(`Lost persistent tmux pane ownership for ${paneId} before atomic dispatch.`);
  }
  Object.assign(ownerContext, patch);
  return ownerContext;
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
  acquirePersistentTmuxPaneOwner,
  buildBoardHelperExample,
  buildBoardLogPath,
  buildBoardTargetErrorResponse,
  buildServerExecutionKey,
  buildTmuxPaneExecutionTarget,
  buildTmuxShellQueueKey,
  buildHealthResponse,
  buildDefaultTargetErrorResponse,
  buildTmuxCommandArgs,
  buildTmuxLiteralLineArgs,
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
  getTmuxPaneReadiness,
  getTmuxShellPaneQueueDepth,
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
  isConfirmedTmuxExecution,
  buildAgentReplyCommand,
  buildTmuxAiTaskPrompt,
  buildTmuxRunScript,
  listTmuxPanes,
  normalizeBoardOutput,
  outputEndsWithBoardPrompt,
  parseTmuxPanes,
  parseVisionDoneFromText,
  pruneAgentMailboxItems,
  prepareStateLogFile,
  readBoardLogFromOffset,
  readTmuxShellRunState,
  releasePersistentTmuxPaneOwner,
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
  runTmuxShellQueued,
  startServer,
  stitchOcrPages,
  validateBoardCommand,
  validateVisionAppName,
  validateVisionTmuxCommand,
  validateVisionKey,
  validateVisionTextInput,
  verifyTmuxShellPaneBeforeDispatch,
  visionOcrOutputText,
  visionOcrRows,
  visionOcrStatusText,
  visionOcrText,
  visionTextIncludes,
  writeWebSocketResponse,
  writeDownloadsFile
};
