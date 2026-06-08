#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR_INPUT="${AI_CHAT_SHELL_STATE_DIR:-$ROOT_DIR/.state}"
if [[ "$STATE_DIR_INPUT" = /* ]]; then
  STATE_DIR="$STATE_DIR_INPUT"
else
  STATE_DIR="$ROOT_DIR/$STATE_DIR_INPUT"
fi
HELPER="${AI_CHAT_SHELL_VISION_HELPER:-$STATE_DIR/bin/macos-vision-helper}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '{"ok":false,"skipped":true,"errorCode":"non-macos","error":"Terminal vision self-test only runs on macOS."}\n'
  exit 0
fi

if [[ ! -x "$HELPER" ]]; then
  printf 'Vision helper is not built at %s\n' "$HELPER" >&2
  printf 'Run ./scripts/build_macos_vision_helper.sh first.\n' >&2
  exit 1
fi

TARGET="${1:-}"

printf 'Open a dedicated Terminal window attached to the target tmux pane, leave it visible, then press Return here.\n' >&2
read -r _

node - "$ROOT_DIR" "$HELPER" "$TARGET" <<'NODE'
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = process.argv[2];
const helper = process.argv[3];
const target = process.argv[4] || "";
process.env.AI_CHAT_SHELL_VISION_HELPER = helper;
const { handleVisionMessage } = require(path.join(root, "server", "shell_server.js"));

(async () => {
  const listed = spawnSync(helper, ["list-windows", "--json"], { encoding: "utf8" });
  if (listed.status !== 0) {
    throw new Error(listed.stderr || listed.stdout || "Could not list Terminal windows.");
  }
  const windows = JSON.parse(listed.stdout).windows || [];
  const terminal = windows.find((windowInfo) => windowInfo.appName === "Terminal");
  if (!terminal) {
    throw new Error("No visible Terminal window found.");
  }
  const result = await handleVisionMessage({
    type: "vision-terminal-self-test",
    target,
    windowId: terminal.windowId,
    timeoutMs: 15000
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
})().catch((error) => {
  console.log(JSON.stringify({
    ok: false,
    errorCode: "self-test-crashed",
    error: error.message || String(error)
  }, null, 2));
  process.exit(1);
});
NODE
