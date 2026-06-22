#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MANIFEST_PATH="$ROOT_DIR/extension/manifest.json"
SERVER_URL="http://127.0.0.1:17371/health"
EXPECTED_SERVER_PROTOCOL_VERSION=3
EXPECTED_HELPER_PROTOCOL_VERSION=2
FORAI_SESSION="${AI_CHAT_SHELL_TMUX_SESSION:-ForAI}"
FORAI_HOST_WINDOW="${AI_CHAT_SHELL_HOST_WINDOW:-host}"
FORAI_BOARD_WINDOW="${AI_CHAT_SHELL_BOARD_WINDOW:-board}"
STATE_DIR_INPUT="${AI_CHAT_SHELL_STATE_DIR:-$ROOT_DIR/.state}"
if [[ "$STATE_DIR_INPUT" = /* ]]; then
  STATE_DIR="$STATE_DIR_INPUT"
else
  STATE_DIR="$ROOT_DIR/$STATE_DIR_INPUT"
fi

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

run_tmux() {
  if [[ -n "${AI_CHAT_SHELL_TMUX_SOCKET:-}" ]]; then
    tmux -S "$AI_CHAT_SHELL_TMUX_SOCKET" "$@"
  else
    tmux "$@"
  fi
}

repair_path() {
  local target="$1"
  local reason="$2"
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%S)"
  local backup="${target}.broken-${reason}-${stamp}-$$"
  local index=0
  while [[ -e "$backup" ]]; do
    index=$((index + 1))
    backup="${target}.broken-${reason}-${stamp}-$$-${index}"
  done
  if mv "$target" "$backup" 2>/dev/null; then
    info "Repaired path by moving $target to $backup"
    return 0
  fi
  fail "Could not repair path: $target"
  return 1
}

cd "$ROOT_DIR" || exit 1

info "Project: $ROOT_DIR"
info "State dir: $STATE_DIR"

if [[ -e "$STATE_DIR" && ! -d "$STATE_DIR" ]]; then
  repair_path "$STATE_DIR" "state-path" || true
fi

if [[ -e "$STATE_DIR" && ! -d "$STATE_DIR" ]]; then
  fail "Shell server state path exists but is not a directory: $STATE_DIR"
else
  if mkdir -p "$STATE_DIR" 2>/dev/null; then
    for subdir in tmux-runs board-panes vision bin; do
      subpath="$STATE_DIR/$subdir"
      if [[ -e "$subpath" && ! -d "$subpath" ]]; then
        repair_path "$subpath" "state-subpath-$subdir" || true
      fi
      mkdir -p "$subpath" 2>/dev/null || fail "Shell server state subdirectory cannot be created: $subpath"
    done
    tmp="$STATE_DIR/.state-preflight-doctor-$$.tmp"
    final="$STATE_DIR/.state-preflight-doctor-$$.ok"
    if printf 'ok\n' > "$tmp" 2>/dev/null && mv "$tmp" "$final" 2>/dev/null && rm -f "$final"; then
      pass "Shell server state directory is writable"
    else
      rm -f "$tmp" "$final" 2>/dev/null || true
      fail "Shell server state directory is not writable: $STATE_DIR"
    fi
  else
    fail "Shell server state directory cannot be created: $STATE_DIR"
  fi
fi

if command -v node >/dev/null 2>&1; then
  pass "Node.js found: $(command -v node) ($(node --version))"
else
  fail "Node.js was not found on PATH"
fi

if command -v tmux >/dev/null 2>&1; then
  pass "tmux found: $(command -v tmux) ($(tmux -V))"
  if [[ -n "${AI_CHAT_SHELL_TMUX_SOCKET:-}" ]]; then
    info "Using tmux socket from AI_CHAT_SHELL_TMUX_SOCKET=${AI_CHAT_SHELL_TMUX_SOCKET}"
  fi
  panes="$(run_tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index} #{window_name} #{pane_current_command}' 2>/dev/null || true)"
  if [[ -n "$panes" ]]; then
    pass "tmux panes are visible"
    printf '%s\n' "$panes" | sed 's/^/info: tmux pane /'
  else
    fail "No tmux panes are visible. Start tmux and open a shell pane before using shell-call."
  fi

  forai_panes="$(run_tmux list-panes -a -F '#{session_name}	#{window_name}	#{pane_id}	#{pane_current_path}' 2>/dev/null || true)"
  forai_host="$(printf '%s\n' "$forai_panes" | awk -F '\t' -v s="$FORAI_SESSION" -v w="$FORAI_HOST_WINDOW" '$1 == s && $2 == w { print $3 " " $4; exit }')"
  forai_board="$(printf '%s\n' "$forai_panes" | awk -F '\t' -v s="$FORAI_SESSION" -v w="$FORAI_BOARD_WINDOW" '$1 == s && $2 == w { print $3 " " $4; exit }')"
  if [[ -n "$forai_host" ]]; then
    pass "Default tmux host target exists: ${FORAI_SESSION}:${FORAI_HOST_WINDOW} (${forai_host})"
  else
    fail "Default tmux host target is missing: ${FORAI_SESSION}:${FORAI_HOST_WINDOW}. Open an enabled chat page and click Check, or use the floating panel Reset tmux action."
  fi
  if [[ -n "$forai_board" ]]; then
    pass "Default tmux board target exists: ${FORAI_SESSION}:${FORAI_BOARD_WINDOW} (${forai_board})"
  else
    fail "Default tmux board target is missing: ${FORAI_SESSION}:${FORAI_BOARD_WINDOW}. Open an enabled chat page and click Check, or use the floating panel Reset tmux action."
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
    node - "$health" "$MANIFEST_PATH" "$EXPECTED_SERVER_PROTOCOL_VERSION" "$EXPECTED_HELPER_PROTOCOL_VERSION" <<'NODE'
const fs = require("node:fs");
const health = JSON.parse(process.argv[2]);
const manifest = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const expectedServerProtocolVersion = Number(process.argv[4]);
const expectedHelperProtocolVersion = Number(process.argv[5]);
const expectedOrigin = "chrome-extension://lkmeogidbglhedgekjgbpbfjkpapnhke";
const serverProtocolVersion = Number(health.serverProtocolVersion ?? health.protocolVersion);
const helperProtocolVersion = Number(health.helperProtocolVersion);
console.log(`info: Shell server pid ${health.pid || "unknown"}`);
console.log(`info: Extension release version ${manifest.version || "(missing)"}`);
console.log(`info: Shell server release version ${health.serverReleaseVersion || health.releaseVersion || "(missing)"}`);
console.log(`info: Shell server protocolVersion ${Number.isFinite(serverProtocolVersion) ? serverProtocolVersion : "(missing)"}`);
console.log(`info: Shell helper protocolVersion ${Number.isFinite(helperProtocolVersion) ? helperProtocolVersion : "(missing)"}`);
console.log(`info: Shell server allowedOrigin ${health.allowedOrigin || "(missing)"}`);
console.log(`info: Shell server default tmux ${health.tmuxDefaultSession || "(missing)"}:${health.tmuxDefaultHostWindow || "(missing)"} board=${health.tmuxDefaultBoardWindow || "(missing)"}`);
console.log(`info: Shell server default cwd ${health.tmuxDefaultCwd || "(missing)"} (${health.tmuxDefaultCwdSource || "unknown"})`);
console.log(`info: Shell server state dir ${health.stateDir || "(missing)"} (${health.stateSource || "unknown"})`);
if (health.stateRepaired === true && Array.isArray(health.stateRepairs)) {
  for (const repair of health.stateRepairs) {
    console.log(`info: Shell server repaired ${repair.path || "(unknown)"} -> ${repair.backupPath || "(unknown)"}`);
  }
}
if (health.allowUntrustedOrigins === true || health.allowedOrigin === expectedOrigin) {
  console.log("ok: Shell server origin policy matches this release");
} else {
  console.error(`error: Shell server origin policy does not match ${expectedOrigin}`);
  process.exitCode = 1;
}
if (serverProtocolVersion === expectedServerProtocolVersion) {
  console.log("ok: Shell server protocol version is supported");
} else {
  console.error(`error: Shell server protocol version is unsupported or missing: ${Number.isFinite(serverProtocolVersion) ? serverProtocolVersion : "(missing)"}. Expected ${expectedServerProtocolVersion}. Restart ./scripts/start_shell_server.sh from this checkout.`);
  process.exitCode = 1;
}
if (helperProtocolVersion === expectedHelperProtocolVersion) {
  console.log("ok: Shell helper protocol version is supported");
} else {
  console.error(`error: Shell helper protocol version is unsupported or missing: ${Number.isFinite(helperProtocolVersion) ? helperProtocolVersion : "(missing)"}. Expected ${expectedHelperProtocolVersion}. Restart ./scripts/start_shell_server.sh from this checkout.`);
  process.exitCode = 1;
}
if (health.tmuxDefaultCwdError) {
  console.error(`error: Shell server default cwd is invalid: ${health.tmuxDefaultCwdError}`);
  process.exitCode = 1;
} else if (health.tmuxDefaultCwd) {
  console.log("ok: Shell server default cwd is valid");
}
if (health.stateOk === true) {
  console.log("ok: Shell server state directory is healthy");
} else {
  console.error(`error: Shell server state directory is unhealthy: ${health.stateError || health.error || "(missing error)"}`);
  process.exitCode = 1;
}
NODE
    [[ $? -eq 0 ]] || status=1
  else
    fail "Shell server is not reachable at $SERVER_URL"
    info "Run ./scripts/start_shell_server.sh"
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
