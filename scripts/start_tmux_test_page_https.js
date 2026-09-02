#!/usr/bin/env node

const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT_DIR = path.join(__dirname, "..");
const STATE_ROOT_DIR = resolveStateDir(process.env.AI_CHAT_SHELL_STATE_DIR || path.join(ROOT_DIR, ".state"));
const STATE_DIR = path.join(STATE_ROOT_DIR, "test-page");
const CERT_PATH = path.join(STATE_DIR, "localhost-cert.pem");
const KEY_PATH = path.join(STATE_DIR, "localhost-key.pem");
const PORT = Number(process.env.TEST_PAGE_PORT || process.argv[2] || 17443);
const HOST = "127.0.0.1";
const PAGE_PATH = path.join(ROOT_DIR, "tests", "manual", "tmux-test-page.html");
const CHATGPT_CONTRACT_PAGE_PATH = path.join(ROOT_DIR, "tests", "manual", "chatgpt-contract-test-page.html");
const CHATGPT_CONTRACT_PATH = "/chatgpt-contract-test-page.html";
const CSP_DRAWIO_PATH = "/drawio-csp-test-page.html";
const CSP_DRAWIO_NONCE = "ai-chat-shell-e2e-drawio-csp-2026";

ensureCertificate();

const server = https.createServer({
  cert: fs.readFileSync(CERT_PATH),
  key: fs.readFileSync(KEY_PATH)
}, (req, res) => {
  const url = new URL(req.url, `https://localhost:${PORT}`);
  if (url.pathname !== "/" && url.pathname !== "/tmux-test-page.html" &&
      url.pathname !== CSP_DRAWIO_PATH && url.pathname !== CHATGPT_CONTRACT_PATH) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }

  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  };
  let page = fs.readFileSync(
    url.pathname === CHATGPT_CONTRACT_PATH ? CHATGPT_CONTRACT_PAGE_PATH : PAGE_PATH,
    "utf8"
  );
  if (url.pathname === CSP_DRAWIO_PATH) {
    headers["content-security-policy"] = [
      "default-src 'self'",
      `script-src 'nonce-${CSP_DRAWIO_NONCE}'`,
      `style-src 'nonce-${CSP_DRAWIO_NONCE}'`,
      "frame-src 'self'",
      "img-src 'self' data: blob:",
      "connect-src 'self' http://127.0.0.1:17371 ws://127.0.0.1:17371",
      "object-src 'none'",
      "base-uri 'none'"
    ].join("; ");
    page = page
      .replace("<style>", `<style nonce="${CSP_DRAWIO_NONCE}">`)
      .replace("<script>", `<script nonce="${CSP_DRAWIO_NONCE}">`);
  }
  res.writeHead(200, headers);
  res.end(page);
});

server.listen(PORT, HOST, () => {
  console.log(`tmux test page: https://localhost:${PORT}/tmux-test-page.html`);
  console.log("Chrome will ask you to accept the self-signed localhost certificate the first time.");
});

function ensureCertificate() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    return;
  }

  const result = spawnSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    KEY_PATH,
    "-out",
    CERT_PATH,
    "-sha256",
    "-days",
    "365",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1"
  ], { encoding: "utf8" });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "Failed to create localhost certificate.\n");
    process.stderr.write(`Install openssl or create ${CERT_PATH} and ${KEY_PATH} manually.\n`);
    process.exit(result.status || 1);
  }
}

function resolveStateDir(value) {
  const text = String(value || "").replace(/^~(?=$|\/)/, require("node:os").homedir());
  return path.isAbsolute(text) ? text : path.resolve(ROOT_DIR, text);
}
