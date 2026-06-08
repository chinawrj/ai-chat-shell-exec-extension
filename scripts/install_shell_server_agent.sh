#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

echo "Cleaning up any legacy LaunchAgent from older releases..." >&2
"$SCRIPT_DIR/uninstall_shell_server_agent.sh" >/dev/null 2>&1 || true

echo "Starting AI Chat Shell Exec foreground server..." >&2
echo "Press Ctrl-C to stop it." >&2
exec "$SCRIPT_DIR/start_shell_server.sh"
