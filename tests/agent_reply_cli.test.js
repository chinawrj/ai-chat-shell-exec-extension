#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const {
  buildAgentReplyPayload,
  explainAgentReplyCliFailure,
  parseArgs,
  sendJsonOverWebSocket
} = require("../server/agent_reply_cli.js");
const {
  decodeTextFrames,
  encodeTextFrame
} = require("../server/shell_server.js");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-reply-cli-"));

main()
  .then(() => {
    console.log("agent reply CLI tests passed");
  })
  .finally(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });

async function main() {
  const bodyFile = path.join(tmpDir, "reply.md");
  fs.writeFileSync(bodyFile, "result from tmux AI\n", "utf8");

  const options = parseArgs([
    "--from", "slave-tmux",
    "--to", "master",
    "--task-id", "task-001",
    "--reply-to", "msg-001",
    "--body-file", bodyFile,
    "--server-url", "ws://127.0.0.1:9999/shell"
  ]);
  assert.equal(options.from, "slave-tmux");
  assert.equal(options.to, "master");
  assert.equal(options.taskId, "task-001");
  assert.equal(options.replyTo, "msg-001");
  assert.equal(options.bodyFile, bodyFile);
  assert.equal(options.serverUrl, "ws://127.0.0.1:9999/shell");

  const payload = buildAgentReplyPayload(options);
  assert.deepEqual(payload, {
    type: "agent-reply",
    from: "slave-tmux",
    to: "master",
    taskId: "task-001",
    replyTo: "msg-001",
    body: "result from tmux AI\n"
  });

  const emptyFile = path.join(tmpDir, "empty.md");
  fs.writeFileSync(emptyFile, "  \n", "utf8");
  assert.throws(() => buildAgentReplyPayload({
    from: "slave-tmux",
    to: "master",
    replyTo: "msg-001",
    bodyFile: emptyFile
  }), /Reply body file is empty/);

  assert.throws(() => parseArgs(["--from"]), /Missing value/);
  assert.throws(() => buildAgentReplyPayload({}), /Missing required option --from/);
  assert.match(
    explainAgentReplyCliFailure({
      ok: false,
      errorCode: "sender-not-registered",
      error: "Agent sender is not registered: slave-tmux"
    }).nextAction,
    /Register the tmux pane/
  );
  assert.match(
    explainAgentReplyCliFailure({
      ok: false,
      errorCode: "reply-target-not-found",
      error: "Reply target not found"
    }).hint,
    /does not match an active tmux-ai task/
  );
  assert.match(
    explainAgentReplyCliFailure({
      ok: false,
      errorCode: "cli-input-error",
      error: "Missing required option --from"
    }).nextAction,
    /Copy the full reply command/
  );

  const fakeServer = await startFakeWebSocketServer();
  try {
    const response = await sendJsonOverWebSocket(`ws://127.0.0.1:${fakeServer.port}/shell`, payload);
    assert.equal(response.ok, true);
    assert.equal(response.type, "agent-reply");
    assert.equal(response.from, "slave-tmux");
    assert.equal(response.to, "master");
    assert.equal(fakeServer.messages.length, 1);
    assert.deepEqual(fakeServer.messages[0], payload);
  } finally {
    await fakeServer.close();
  }
}

function startFakeWebSocketServer() {
  const messages = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let handshaken = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshaken) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
          return;
        }
        handshaken = true;
        buffer = buffer.subarray(headerEnd + 4);
        socket.write([
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Accept: test",
          "",
          ""
        ].join("\r\n"));
      }
      const decoded = decodeTextFrames(buffer);
      if (decoded.messages.length === 0) {
        return;
      }
      const payload = JSON.parse(decoded.messages[0]);
      messages.push(payload);
      socket.write(encodeTextFrame(JSON.stringify({
        ok: true,
        type: payload.type,
        from: payload.from,
        to: payload.to
      })));
      socket.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        messages,
        port: server.address().port,
        close: () => new Promise((closeResolve) => server.close(closeResolve))
      });
    });
  });
}
