#!/usr/bin/env bash
set -euo pipefail

LABEL="${SHELL_SERVER_AGENT_LABEL:-com.local.ai-chat-shell-exec-server}"
LEGACY_LABEL="com.local.universal-shell-tool-server"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl remove "$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"

if [[ "$LABEL" != "$LEGACY_LABEL" ]]; then
  LEGACY_PLIST_PATH="$PLIST_DIR/$LEGACY_LABEL.plist"
  launchctl bootout "gui/$(id -u)" "$LEGACY_PLIST_PATH" >/dev/null 2>&1 || true
  launchctl remove "$LEGACY_LABEL" >/dev/null 2>&1 || true
  rm -f "$LEGACY_PLIST_PATH"
fi

echo "Shell server LaunchAgent removed: $LABEL"
