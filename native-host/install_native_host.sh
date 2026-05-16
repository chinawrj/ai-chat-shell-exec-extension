#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <chrome-extension-id>" >&2
  echo "Load the extension first, then copy its ID from chrome://extensions." >&2
  exit 2
fi

EXTENSION_ID="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_PATH="$SCRIPT_DIR/shell_host_launcher.sh"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_PATH="$MANIFEST_DIR/com.local.chatgpt_shell_tool.json"

chmod +x "$HOST_PATH" "$SCRIPT_DIR/shell_host.js"
mkdir -p "$MANIFEST_DIR"

sed \
  -e "s#__HOST_PATH__#$HOST_PATH#g" \
  -e "s#__EXTENSION_ID__#$EXTENSION_ID#g" \
  "$SCRIPT_DIR/com.local.chatgpt_shell_tool.json.template" > "$MANIFEST_PATH"

echo "Installed native messaging host:"
echo "$MANIFEST_PATH"
