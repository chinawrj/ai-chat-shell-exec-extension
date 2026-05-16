#!/usr/bin/env bash
set -euo pipefail

LABEL="${SHELL_SERVER_AGENT_LABEL:-com.local.universal-shell-tool-server}"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl remove "$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"

echo "Shell server LaunchAgent removed: $LABEL"
