#!/usr/bin/env node

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_OUTPUT_CHARS = 20000;
const LOG_PATH = "/tmp/chatgpt_shell_host.log";

let inputBuffer = Buffer.alloc(0);
let pendingMessages = 0;
let stdinEnded = false;

log("host start");

process.stdin.on("data", (chunk) => {
  log(`stdin data bytes=${chunk.length}`);
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  readMessages();
});

process.stdin.on("end", () => {
  log("stdin end");
  stdinEnded = true;
  exitWhenIdle();
});

function readMessages() {
  while (inputBuffer.length >= 4) {
    const length = inputBuffer.readUInt32LE(0);
    if (inputBuffer.length < 4 + length) {
      return;
    }

    const raw = inputBuffer.subarray(4, 4 + length).toString("utf8");
    inputBuffer = inputBuffer.subarray(4 + length);
    log(`message bytes=${length}`);

    pendingMessages += 1;
    Promise.resolve()
      .then(() => handleMessage(JSON.parse(raw)))
      .then(writeMessage)
      .catch((error) => writeMessage({ ok: false, error: error.message || String(error) }))
      .finally(() => {
        pendingMessages -= 1;
        log(`message done pending=${pendingMessages}`);
        exitWhenIdle();
      });
  }
}

async function handleMessage(message) {
  if (!message || message.type !== "run") {
    throw new Error("Unsupported message type.");
  }

  const cmd = String(message.cmd || "").trim();
  log(`handle message id=${message.id || ""} cmd=${JSON.stringify(cmd)}`);
  if (!cmd) {
    throw new Error("Missing command.");
  }

  const timeoutMs = clampNumber(message.timeoutMs, 1000, 10 * 60 * 1000, DEFAULT_TIMEOUT_MS);
  const maxOutputChars = clampNumber(message.maxOutputChars, 1000, 200000, DEFAULT_MAX_OUTPUT_CHARS);
  const cwd = resolveCwd(message.cwd);
  const started = Date.now();

  return runShell(cmd, cwd, timeoutMs, maxOutputChars).then((result) => ({
    ok: true,
    id: message.id,
    cmd,
    cwd,
    timeoutMs,
    durationMs: Date.now() - started,
    ...result
  }));
}

function runShell(cmd, cwd, timeoutMs, maxOutputChars) {
  return new Promise((resolve) => {
    log(`spawn cwd=${cwd} timeoutMs=${timeoutMs}`);
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
      log(`child error ${error.message}`);
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
      log(`child close code=${code} signal=${signal}`);
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

function writeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
  log(`wrote response bytes=${body.length} ok=${message.ok}`);
}

function exitWhenIdle() {
  if (stdinEnded && pendingMessages === 0 && inputBuffer.length === 0) {
    log("exit idle");
    process.exit(0);
  }
}

function log(message) {
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Logging must never interfere with the native messaging protocol.
  }
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

function resolveCwd(rawCwd) {
  if (!rawCwd) {
    return os.homedir();
  }

  const expanded = String(rawCwd).replace(/^~(?=$|\/)/, os.homedir());
  return path.resolve(expanded);
}
