#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST_PATH="$ROOT_DIR/extension/manifest.json"
SERVER_URL="http://127.0.0.1:17371/health"

status=0

pass() {
  printf 'ok: %s\n' "$1"
}

fail() {
  printf 'error: %s\n' "$1" >&2
  status=1
}

info() {
  printf 'info: %s\n' "$1"
}

cd "$ROOT_DIR" || exit 1

info "Project: $ROOT_DIR"

if command -v node >/dev/null 2>&1; then
  pass "Node.js found: $(command -v node) ($(node --version))"
else
  fail "Node.js was not found on PATH"
fi

if command -v tmux >/dev/null 2>&1; then
  pass "tmux found: $(command -v tmux) ($(tmux -V))"
  panes="$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index} #{window_name} #{pane_current_command}' 2>/dev/null || true)"
  if [[ -n "$panes" ]]; then
    pass "tmux panes are visible"
    printf '%s\n' "$panes" | sed 's/^/info: tmux pane /'
  else
    fail "No tmux panes are visible. Start tmux and open a shell pane before using shell-call."
  fi
else
  fail "tmux was not found on PATH"
fi

if [[ -r "$MANIFEST_PATH" ]]; then
  pass "Extension manifest is readable: $MANIFEST_PATH"
else
  fail "Extension manifest is missing or unreadable: $MANIFEST_PATH"
fi

if command -v node >/dev/null 2>&1 && [[ -r "$MANIFEST_PATH" ]]; then
  node - "$MANIFEST_PATH" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");

const manifestPath = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const expectedId = "lkmeogidbglhedgekjgbpbfjkpapnhke";
const publicKeyPem = [
  "-----BEGIN PUBLIC KEY-----",
  manifest.key.match(/.{1,64}/g).join("\n"),
  "-----END PUBLIC KEY-----"
].join("\n");
const der = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
const digest = crypto.createHash("sha256").update(der).digest();
const id = Array.from(digest.subarray(0, 16), (byte) =>
  String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 0x0f))
).join("");

if (id === expectedId) {
  console.log(`ok: Manifest key resolves to expected extension ID ${id}`);
} else {
  console.error(`error: Manifest key resolves to ${id}, expected ${expectedId}`);
  process.exitCode = 1;
}
NODE
  [[ $? -eq 0 ]] || status=1
fi

if command -v curl >/dev/null 2>&1; then
  health="$(curl -fsS "$SERVER_URL" 2>/dev/null || true)"
  if [[ -n "$health" ]]; then
    pass "Shell server health endpoint is reachable"
    node - "$health" <<'NODE'
const health = JSON.parse(process.argv[2]);
const expectedOrigin = "chrome-extension://lkmeogidbglhedgekjgbpbfjkpapnhke";
console.log(`info: Shell server pid ${health.pid || "unknown"}`);
console.log(`info: Shell server allowedOrigin ${health.allowedOrigin || "(missing)"}`);
if (health.allowUntrustedOrigins === true || health.allowedOrigin === expectedOrigin) {
  console.log("ok: Shell server origin policy matches this release");
} else {
  console.error(`error: Shell server origin policy does not match ${expectedOrigin}`);
  process.exitCode = 1;
}
NODE
    [[ $? -eq 0 ]] || status=1
  else
    fail "Shell server is not reachable at $SERVER_URL"
    info "Run ./scripts/install_shell_server_agent.sh"
  fi
else
  fail "curl was not found on PATH"
fi

if [[ $status -eq 0 ]]; then
  pass "Doctor checks passed"
else
  fail "Doctor checks failed"
fi

exit "$status"
