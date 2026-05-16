#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="$ROOT_DIR/.state"
LABEL="${SHELL_SERVER_AGENT_LABEL:-com.local.universal-shell-tool-server}"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
PATH_VALUE="${PATH:-/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin}"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Could not find an executable node binary. Install Node.js or set NODE_BIN=/path/to/node." >&2
  exit 1
fi

mkdir -p "$STATE_DIR" "$PLIST_DIR"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT_DIR/server/shell_server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$PATH_VALUE</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$STATE_DIR/shell-server.out.log</string>
  <key>StandardErrorPath</key>
  <string>$STATE_DIR/shell-server.err.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

for _ in {1..20}; do
  if curl -fsS http://127.0.0.1:17371/health >/dev/null; then
    echo "Shell server LaunchAgent installed and healthy."
    echo "Label: $LABEL"
    echo "Plist: $PLIST_PATH"
    echo "Logs: $STATE_DIR/shell-server.out.log and $STATE_DIR/shell-server.err.log"
    exit 0
  fi
  sleep 0.25
done

echo "LaunchAgent was installed, but the shell server health check failed." >&2
echo "Inspect logs:" >&2
echo "  $STATE_DIR/shell-server.out.log" >&2
echo "  $STATE_DIR/shell-server.err.log" >&2
exit 1
