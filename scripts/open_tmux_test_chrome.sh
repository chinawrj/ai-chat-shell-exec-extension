#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROFILE_DIR="$ROOT_DIR/.state/chrome-tmux-test-profile"
EXTENSION_DIR="$ROOT_DIR/extension"
URL="${1:-https://localhost:17443/tmux-test-page.html}"
DEBUG_PORT="${CHROME_TEST_DEBUG_PORT:-9223}"
BROWSER_APP="${AI_SHELL_TEST_BROWSER_APP:-}"

if [[ ! -d "$EXTENSION_DIR" ]]; then
  echo "Extension directory is missing: $EXTENSION_DIR" >&2
  exit 1
fi

if ! curl -k -fsS "$URL" >/dev/null 2>&1; then
  echo "The tmux test page is not reachable at $URL" >&2
  echo "Start it first with: node scripts/start_tmux_test_page_https.js" >&2
  exit 1
fi

mkdir -p "$PROFILE_DIR"

if [[ -z "$BROWSER_APP" ]]; then
  for candidate in "Google Chrome for Testing" "Chromium" "Microsoft Edge" "Google Chrome"; do
    if [[ -d "/Applications/$candidate.app" ]]; then
      BROWSER_APP="$candidate"
      break
    fi
  done
fi

if [[ -z "$BROWSER_APP" ]]; then
  echo "Could not find a Chromium-family browser in /Applications." >&2
  exit 1
fi

if [[ "$BROWSER_APP" == "Google Chrome" ]]; then
  echo "Warning: recent Google Chrome builds can ignore --load-extension for local unpacked extensions." >&2
  echo "If the extension panel is absent, load $EXTENSION_DIR manually from chrome://extensions or set AI_SHELL_TEST_BROWSER_APP to Chromium/Microsoft Edge." >&2
fi

open -na "$BROWSER_APP" --args \
  "--user-data-dir=$PROFILE_DIR" \
  "--load-extension=$EXTENSION_DIR" \
  "--allow-insecure-localhost" \
  "--remote-debugging-port=$DEBUG_PORT" \
  "--no-first-run" \
  "--no-default-browser-check" \
  "$URL"

echo "Opened $BROWSER_APP test profile with AI Chat Shell Exec loaded:"
echo "  $URL"
echo "Profile:"
echo "  $PROFILE_DIR"
echo "Debug:"
echo "  http://127.0.0.1:$DEBUG_PORT/json"
