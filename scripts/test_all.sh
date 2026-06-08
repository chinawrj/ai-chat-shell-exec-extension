#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

run node --check extension/src/content.js
run node --check extension/src/background.js
run node --check extension/src/popup.js
run node --check server/shell_server.js
run node --check scripts/start_tmux_test_page_https.js
run node --check tests/chrome_extension_e2e.test.js

SHELL_SCRIPTS=(
  scripts/install_shell_server_agent.sh
  scripts/uninstall_shell_server_agent.sh
  scripts/start_shell_server.sh
  scripts/package_release.sh
  scripts/open_tmux_test_chrome.sh
  scripts/build_macos_vision_helper.sh
  scripts/run_terminal_vision_self_test.sh
  scripts/test_all.sh
)

for shell_script in "${SHELL_SCRIPTS[@]}"; do
  run bash -n "$shell_script"
done

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  run git diff --check
fi

TEST_FILES=()
while IFS= read -r test_file; do
  TEST_FILES+=("$test_file")
done < <(find tests -maxdepth 1 -name '*.test.js' -type f | sort)
E2E_TEST="tests/chrome_extension_e2e.test.js"

for test_file in "${TEST_FILES[@]}"; do
  if [[ "$test_file" == "$E2E_TEST" ]]; then
    continue
  fi
  run node "$test_file"
done

if [[ -f "$E2E_TEST" ]]; then
  run node "$E2E_TEST"
fi

printf '\nAll checks and tests passed.\n'
