#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const { URL } = require("node:url");

const DEFAULT_SERVER_URL = "ws://127.0.0.1:17371/shell";
const DEFAULT_ORIGIN = "chrome-extension://lkmeogidbglhedgekjgbpbfjkpapnhke";
const MAX_BODY_CHARS = 20000;

if (require.main === module) {
  main().catch((error) => {
    const response = {
      ok: false,
      errorCode: "cli-input-error",
      error: error.message || String(error)
    };
    process.stdout.write(`${JSON.stringify(explainAgentReplyCliFailure(response), null, 2)}\n`);
    process.exitCode = 1;
  });
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return { ok: true, help: true };
  }
  const payload = buildAgentReplyPayload(options);
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ ok: true, payload }, null, 2)}\n`);
    return { ok: true, payload };
  }
  const response = await sendJsonOverWebSocket(options.serverUrl || DEFAULT_SERVER_URL, payload, options.origin || DEFAULT_ORIGIN);
  const explained = explainAgentReplyCliFailure(response);
  process.stdout.write(`${JSON.stringify(explained, null, 2)}\n`);
  if (!explained?.ok) {
    process.exitCode = 1;
  }
  return explained;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    options[key] = value;
    i += 1;
  }
  return {
    serverUrl: DEFAULT_SERVER_URL,
    origin: DEFAULT_ORIGIN,
    ...options
  };
}

function buildAgentReplyPayload(options) {
  const from = requiredOption(options, "from");
  const to = requiredOption(options, "to");
  const replyTo = requiredOption(options, "replyTo");
  const bodyFile = requiredOption(options, "bodyFile");
  const body = fs.readFileSync(bodyFile, "utf8");
  if (!body.trim()) {
    throw new Error(`Reply body file is empty: ${bodyFile}`);
  }
  if (body.length > MAX_BODY_CHARS) {
    throw new Error(`Reply body file is too large (${body.length} chars, max ${MAX_BODY_CHARS}): ${bodyFile}`);
  }
  return {
    type: "agent-reply",
    from,
    to,
    taskId: String(options.taskId || ""),
    replyTo,
    body
  };
}

function requiredOption(options, name) {
  const value = String(options[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required option --${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  return value;
}

function explainAgentReplyCliFailure(response) {
  if (!response || response.ok !== false) {
    return response;
  }
  const errorCode = String(response.errorCode || "");
  const error = String(response.error || "");
  const lowerError = error.toLowerCase();
  let hint = "";
  let nextAction = "";

  if (errorCode === "sender-not-registered") {
    hint = "The --from agent is not registered as a tmux-ai slave on this server.";
    nextAction = "Register the tmux pane from the master page panel again, then rerun the exact reply command from the latest task.";
  } else if (errorCode === "sender-not-tmux-ai") {
    hint = "Only tmux-ai slaves may use this CLI reply path.";
    nextAction = "Use the tmux-ai slave id shown in the master panel, not a web page agent id.";
  } else if (errorCode === "recipient-not-registered") {
    hint = "The --to master agent is not currently registered.";
    nextAction = "Open the master page, set role master, click Save, then rerun this reply command.";
  } else if (errorCode === "reply-target-not-found") {
    hint = "The --reply-to message id does not match an active tmux-ai task for this slave.";
    nextAction = "Use the reply command from the most recent task prompt; do not reuse an older command.";
  } else if (errorCode === "reply-recipient-mismatch") {
    hint = "The --to value does not match the original sender of the task.";
    nextAction = "Copy the --to value from the task prompt exactly.";
  } else if (errorCode === "reply-task-mismatch") {
    hint = "The --task-id value does not match the task that created this reply command.";
    nextAction = "Copy the --task-id value from the task prompt exactly, or omit it only when the prompt has no task id.";
  } else if (errorCode === "duplicate-reply") {
    hint = "This task already has a reply recorded.";
    nextAction = "Do not rerun this command unless the master sends a new task with a new --reply-to message id.";
  } else if (errorCode === "missing-body" || lowerError.includes("body file is empty")) {
    hint = "The reply body is empty.";
    nextAction = "Write the final answer into the --body-file path, then rerun the same CLI command.";
  } else if (errorCode === "cli-input-error" && /missing required option/i.test(error)) {
    hint = "The reply CLI command is missing a required flag.";
    nextAction = "Copy the full reply command from the tmux task prompt instead of reconstructing it manually.";
  } else if (errorCode === "cli-input-error" && /only ws:\/\//i.test(error)) {
    hint = "The reply CLI can only connect to the local WebSocket server over ws://.";
    nextAction = "Use the default --server-url, or pass a ws://127.0.0.1:17371/shell URL.";
  } else {
    hint = "The local agent hub rejected the reply.";
    nextAction = "Check --from, --to, --reply-to, --task-id, and --body-file against the latest tmux task prompt.";
  }

  return {
    ...response,
    hint,
    nextAction
  };
}

function sendJsonOverWebSocket(serverUrl, payload, origin = DEFAULT_ORIGIN) {
  const url = new URL(serverUrl);
  if (url.protocol !== "ws:") {
    throw new Error(`Only ws:// server URLs are supported: ${serverUrl}`);
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: url.hostname,
      port: Number(url.port || 80)
    });
    let buffer = Buffer.alloc(0);
    let handshakeDone = false;
    const key = crypto.randomBytes(16).toString("base64");
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to ${serverUrl}`));
    }, 10000);

    socket.on("connect", () => {
      socket.write([
        `GET ${url.pathname || "/"} HTTP/1.1`,
        `Host: ${url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `Origin: ${origin}`,
        "",
        ""
      ].join("\r\n"));
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeDone) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
          return;
        }
        const header = buffer.subarray(0, headerEnd).toString("utf8");
        if (!/^HTTP\/1\.1 101\b/.test(header)) {
          clearTimeout(timeout);
          socket.destroy();
          reject(new Error(`WebSocket handshake failed: ${header.split(/\r?\n/)[0] || "unknown"}`));
          return;
        }
        handshakeDone = true;
        buffer = buffer.subarray(headerEnd + 4);
        socket.write(encodeMaskedTextFrame(JSON.stringify(payload)));
      }

      const decoded = decodeServerTextFrame(buffer);
      if (!decoded) {
        return;
      }
      clearTimeout(timeout);
      socket.end();
      try {
        resolve(JSON.parse(decoded.text));
      } catch (error) {
        reject(error);
      }
    });

    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on("close", () => {
      clearTimeout(timeout);
    });
  });
}

function encodeMaskedTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(payload.length, 6);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) {
    masked[i] ^= mask[i % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function decodeServerTextFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }
  const first = buffer[0];
  const opcode = first & 0x0f;
  if (opcode !== 0x1) {
    throw new Error(`Unsupported WebSocket opcode: ${opcode}`);
  }
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    const high = buffer.readUInt32BE(offset);
    const low = buffer.readUInt32BE(offset + 4);
    if (high !== 0) {
      throw new Error("WebSocket frame is too large.");
    }
    length = low;
    offset += 8;
  }
  if (buffer.length < offset + length) {
    return null;
  }
  return {
    text: buffer.subarray(offset, offset + length).toString("utf8"),
    remaining: buffer.subarray(offset + length)
  };
}

function usage() {
  return [
    "Usage:",
    "  node server/agent_reply_cli.js --from AGENT --to AGENT --reply-to MESSAGE_ID --body-file PATH [--task-id TASK_ID]",
    "",
    "Options:",
    "  --server-url URL   WebSocket server URL (default ws://127.0.0.1:17371/shell)",
    "  --dry-run          Print the payload without sending it"
  ].join("\n");
}

module.exports = {
  buildAgentReplyPayload,
  decodeServerTextFrame,
  encodeMaskedTextFrame,
  explainAgentReplyCliFailure,
  main,
  parseArgs,
  sendJsonOverWebSocket
};
