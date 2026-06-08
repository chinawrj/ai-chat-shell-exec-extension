#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"
REPAIR_MESSAGES=()
STATE_DIR_INPUT="${AI_CHAT_SHELL_STATE_DIR:-$ROOT_DIR/.state}"

if [[ "$STATE_DIR_INPUT" = /* ]]; then
  STATE_DIR="$STATE_DIR_INPUT"
else
  STATE_DIR="$ROOT_DIR/$STATE_DIR_INPUT"
fi

preflight_state_dir() {
  if [[ -e "$STATE_DIR" && ! -d "$STATE_DIR" ]]; then
    repair_path "$STATE_DIR" "state-path"
  fi
  mkdir -p "$STATE_DIR"
  maybe_redirect_logs
  for subdir in tmux-runs board-panes vision bin; do
    local subpath="$STATE_DIR/$subdir"
    if [[ -e "$subpath" && ! -d "$subpath" ]]; then
      repair_path "$subpath" "state-subpath-$subdir"
    fi
    mkdir -p "$subpath"
  done
  local tmp="$STATE_DIR/.state-preflight-shell-$$.tmp"
  local final="$STATE_DIR/.state-preflight-shell-$$.ok"
  printf 'ok\n' > "$tmp"
  mv "$tmp" "$final"
  rm -f "$final"
}

maybe_redirect_logs() {
  if [[ "${AI_CHAT_SHELL_LOG_TO_STATE:-0}" != "1" ]]; then
    return
  fi

  local out_log="$STATE_DIR/shell-server.out.log"
  local err_log="$STATE_DIR/shell-server.err.log"
  for log_path in "$out_log" "$err_log"; do
    if [[ -d "$log_path" ]]; then
      repair_path "$log_path" "log-file"
    elif [[ -e "$log_path" && ! -w "$log_path" ]]; then
      repair_path "$log_path" "log-file"
    fi
    : > "$log_path"
  done

  exec >>"$out_log" 2>>"$err_log"
  export AI_CHAT_SHELL_LOG_TO_STATE_REDIRECTED=1
  if (( ${#REPAIR_MESSAGES[@]} > 0 )); then
    for message in "${REPAIR_MESSAGES[@]}"; do
      echo "$message" >&2
    done
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
  mv "$target" "$backup"
  local message="Repaired shell server state path: moved $target to $backup"
  REPAIR_MESSAGES+=("$message")
  echo "$message" >&2
}

preflight_state_dir
export AI_CHAT_SHELL_STATE_DIR="$STATE_DIR"

exec "$NODE_BIN" "$ROOT_DIR/server/shell_server.js"
