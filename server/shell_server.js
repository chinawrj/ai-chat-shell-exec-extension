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
const LEDGER_PATH = path.join(STATE_DIR, "shell-ledger.json");
const SERVER_LEDGER_LIMIT = 1000;
const RUNNING_LOCK_GRACE_MS = 15000;
const ALLOW_UNTRUSTED_ORIGINS = process.env.CHATGPT_SHELL_ALLOW_UNTRUSTED_ORIGINS === "1";
let serverLedger = loadServerLedger();

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      service: "chatgpt-shell-server",
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      allowedOrigin: ALLOWED_ORIGIN,
      allowUntrustedOrigins: ALLOW_UNTRUSTED_ORIGINS
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

  socket.on("data", (chunk) => {
    const message = decodeTextFrame(chunk);
    if (!message) {
      return;
    }

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
  });
});

server.listen(PORT, HOST, () => {
  console.log(`ChatGPT shell server listening on ws://${HOST}:${PORT}/shell`);
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

function shutdown() {
  console.log("ChatGPT shell server stopping");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

async function handleMessageText(text) {
  const message = JSON.parse(text);
  if (!message || message.type !== "run") {
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
  const cwd = resolveCwd(message.cwd);
  const callKey = normalizeCallKey(message.callKey || message.id || hashText([
    cmd,
    cwd,
    timeoutMs,
    maxOutputChars
  ].join("\n")));
  const started = Date.now();
  const claim = claimServerShellCall(callKey, {
    cmd,
    cwd,
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

  console.log(`[run] callKey=${callKey} seq=${message.seq || ""} cwd=${cwd} cmd=${JSON.stringify(cmd)}`);
  const result = await runShell(cmd, cwd, timeoutMs, maxOutputChars);
  console.log(`[done] exitCode=${result.exitCode} durationMs=${Date.now() - started} timedOut=${result.timedOut}`);

  const response = {
    ok: true,
    id: message.id,
    callKey,
    cmd,
    cwd,
    timeoutMs,
    durationMs: Date.now() - started,
    ...result
  };
  completeServerShellCall(callKey, response);
  return response;
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

function runShell(cmd, cwd, timeoutMs, maxOutputChars) {
  return new Promise((resolve) => {
    const child = spawn("/bin/zsh", ["-lc", cmd], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk.toString("utf8"), maxOutputChars);
      truncated = truncated || stdout.length >= maxOutputChars;
    });

    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString("utf8"), maxOutputChars);
      truncated = truncated || stderr.length >= maxOutputChars;
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: 127,
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`,
        truncated,
        timedOut
      });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: Number.isInteger(code) ? code : 128,
        signal,
        stdout,
        stderr,
        truncated,
        timedOut
      });
    });
  });
}

function decodeTextFrame(buffer) {
  if (buffer.length < 6) {
    return "";
  }

  const opcode = buffer[0] & 0x0f;
  if (opcode === 0x8) {
    return "";
  }
  if (opcode !== 0x1) {
    throw new Error("Only text WebSocket frames are supported.");
  }

  const masked = Boolean(buffer[1] & 0x80);
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
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
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] ^= mask[i % 4];
    }
  }

  return payload.toString("utf8");
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

function resolveCwd(rawCwd) {
  if (!rawCwd) {
    return os.homedir();
  }

  const expanded = String(rawCwd).replace(/^~(?=$|\/)/, os.homedir());
  const resolved = path.resolve(expanded);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`cwd is not a directory: ${resolved}`);
  }
  return resolved;
}
