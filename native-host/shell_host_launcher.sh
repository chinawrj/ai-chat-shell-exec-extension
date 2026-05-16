#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_PATH="/tmp/chatgpt_shell_host.log"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
{
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] launcher start"
  echo "SCRIPT_DIR=$SCRIPT_DIR"
  echo "PATH=$PATH"
  echo "NODE=$(/usr/bin/command -v node || true)"
  echo "UID=$(id -u)"
} >> "$LOG_PATH" 2>&1

exec /opt/homebrew/bin/node "$SCRIPT_DIR/shell_host.js" 2>> "$LOG_PATH"
