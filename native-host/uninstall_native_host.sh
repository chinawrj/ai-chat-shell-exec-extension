#!/usr/bin/env bash
set -euo pipefail

MANIFEST_PATH="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.local.chatgpt_shell_tool.json"
rm -f "$MANIFEST_PATH"
echo "Removed native messaging host manifest:"
echo "$MANIFEST_PATH"
