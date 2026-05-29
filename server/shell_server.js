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
const STATE_DIR = path.join(__dirname, "..", ".state");
const TMUX_SCRIPT_DIR = path.join(STATE_DIR, "tmux-runs");
const LEDGER_PATH = path.join(STATE_DIR, "shell-ledger.json");
const SERVER_LEDGER_LIMIT = 1000;
const RUNNING_LOCK_GRACE_MS = 15000;
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
const HELPER_SHELL_START = "ai-helper-shell-start";
const HELPER_SHELL_END = "ai-helper-shell-end";
const HELPER_FILE_START = "ai-helper-file-start";
const HELPER_FILE_END = "ai-helper-file-end";
const UNSUPPORTED_HELPER_MARKERS = new Set(["ai-helper-start-shell", "ai-helper-end-shell"]);
const SHELL_RUNNER = process.env.AI_CHAT_SHELL_RUNNER || (fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh");
const ALLOW_UNTRUSTED_ORIGINS = process.env.AI_CHAT_SHELL_ALLOW_UNTRUSTED_ORIGINS === "1";
let serverLedger = loadServerLedger();

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      service: "ai-chat-shell-exec-server",
      executionBackend: "tmux",
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      allowedOrigin: ALLOWED_ORIGIN,
      allowUntrustedOrigins: ALLOW_UNTRUSTED_ORIGINS,
      stateDir: STATE_DIR,
      tmuxSocket: getTmuxSocketPath() || null,
      ledgerEntries: Object.keys(serverLedger.calls || {}).length
    }));
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
  server.listen(PORT, HOST, () => {
    console.log(`AI Chat Shell Exec server listening on ws://${HOST}:${PORT}/shell`);
    console.log(`Allowed origin: ${ALLOWED_ORIGIN}`);
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
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

async function handleMessageText(text) {
  const message = JSON.parse(text);
  if (!message || !message.type) {
    throw new Error("Unsupported message type.");
  }

  if (message.type === "tmux-list") {
    return {
      ok: true,
      panes: await listTmuxPanes()
    };
  }

  if (message.type === "write-file") {
    return handleWriteFileMessage(message);
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
  const panes = await listTmuxPanes();
  const target = normalizeTmuxTarget(message.target || message.tmuxTarget || "");
  if (!target) {
    return buildMissingTargetResponse(message, cmd, panes);
  }

  const pane = resolveTmuxTarget(target, panes);
  if (!pane) {
    return buildInvalidTargetResponse(message, cmd, target, panes);
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
  const claim = claimServerShellCall(callKey, {
    cmd,
    cwd,
    target: pane.id,
    timeoutMs,
    maxOutputChars,
    seq: message.seq,
    callMeta: message.callMeta || {}
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

function handleWriteFileMessage(message) {
  const started = Date.now();
  const filename = String(message.filename || "");
  const content = String(message.content || "");
  const downloadsDir = path.join(os.homedir(), "Downloads");
  const filePath = resolveDownloadsFilePath(filename, downloadsDir);
  const callKey = normalizeCallKey(message.callKey || message.id || hashText([filename, content].join("\n")));
  const claim = claimServerShellCall(callKey, {
    cmd: content,
    cwd: downloadsDir,
    target: filePath,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    seq: message.seq,
    callMeta: message.callMeta || {}
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
  const existing = serverLedger.calls?.[callKey];
  const lockTtl = Math.max(5000, Number(payload.timeoutMs || DEFAULT_TIMEOUT_MS) + RUNNING_LOCK_GRACE_MS);

  if (existing?.state === "completed") {
    return { action: "skip", reason: "completed" };
  }
  if (existing?.state === "running" && now - Number(existing.startedAt || 0) < lockTtl) {
    return { action: "skip", reason: "running" };
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
    promptHash: payload.callMeta?.promptHash || ""
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

function loadServerLedger() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
    if (parsed && typeof parsed === "object") {
      return {
        version: 1,
        calls: parsed.calls && typeof parsed.calls === "object" ? parsed.calls : {}
      };
    }
  } catch {
    // Missing or invalid ledger files are treated as an empty ledger.
  }
  return { version: 1, calls: {} };
}

function saveServerLedger() {
  pruneServerLedger();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tempPath = `${LEDGER_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(serverLedger, null, 2));
  fs.renameSync(tempPath, LEDGER_PATH);
}

function pruneServerLedger() {
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
      // Best-effort cleanup; stale files are harmless and remain under .state/.
    }
  }
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

  const byWindowName = panes.filter((pane) => pane.windowName === normalized);
  return byWindowName.length === 1 ? byWindowName[0] : null;
}

function buildMissingTargetResponse(message, cmd, panes) {
  return buildTargetErrorResponse({
    message,
    cmd,
    panes,
    error: "Missing tmux target. Use an ai-helper shell block with target and command.",
    targetRequired: true
  });
}

function buildInvalidTargetResponse(message, cmd, target, panes) {
  return buildTargetErrorResponse({
    message,
    cmd,
    panes,
    error: `Unknown or ambiguous tmux target: ${target}`,
    targetRequired: true
  });
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

function buildTmuxTargetExample(panes, cmd = "pwd") {
  const target = panes[0]?.id || "%pane_id";
  return [
    HELPER_SHELL_START,
    target,
    cmd || "pwd",
    HELPER_SHELL_END
  ].join("\n");
}

async function captureTmuxPane(target) {
  const result = await runTmuxCommand([
    "capture-pane",
    "-p",
    "-J",
    "-S",
    `-${TMUX_CAPTURE_HISTORY_LINES}`,
    "-t",
    target
  ], { timeoutMs: 5000 });
  return result.stdout;
}

function runTmuxCommand(args, options) {
  return runCommand("tmux", buildTmuxCommandArgs(args), options);
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

function runCommand(command, args, { timeoutMs = 5000 } = {}) {
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
      stdout = appendLimited(stdout, chunk.toString("utf8"), 1000000);
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString("utf8"), 1000000);
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
  }).then((result) => {
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
  buildTmuxCommandArgs,
  buildMissingTargetResponse,
  decodeTextFrames,
  detectDefaultTmuxSocketPath,
  encodeTextFrame,
  extractTmuxRunOutput,
  getTmuxEnvSocketPath,
  getTmuxSocketPath,
  listTmuxPanes,
  parseTmuxPanes,
  resolveDownloadsFilePath,
  resolveTmuxTarget,
  runTmuxShell,
  startServer,
  writeDownloadsFile
};
