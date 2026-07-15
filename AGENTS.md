# Agent Guide

## Purpose

AI Chat Shell Exec is a no-build Chrome/Chromium Manifest V3 extension plus a local Node.js server. It lets AI chat pages run explicit ai-helper shell blocks through the default `ForAI:host` tmux pane, send board helper commands to `ForAI:board`, or write ai-helper file blocks into Downloads, then posts results back into the chat as `shell-output`.

Flow:

```text
AI chat page -> extension/src/content.js -> extension/src/background.js -> ws://127.0.0.1:17371/shell -> server/shell_server.js -> tmux pane
```

Treat this project as security-sensitive local remote-code execution.

## Repo Layout

- `extension/`: unpacked Chrome extension files.
- `extension/src/content.js`: page activation, helper block scanning/parsing, duplicate suppression, composer insertion, floating panel, per-origin binding.
- `extension/src/background.js`: settings defaults and migrations, health checks, browser-side call ledger, WebSocket forwarding.
- `extension/src/popup.js`: popup settings UI, tmux target display, config export/import.
- `server/shell_server.js`: local health/WebSocket server, default `ForAI` tmux workspace management, board target resolution, tmux command execution, persistent server ledger.
- `scripts/`: foreground server startup, legacy macOS LaunchAgent cleanup, and cross-platform dev/test/release helpers.
- `tests/`: standalone Node.js tests. There is no `package.json` or central test runner.
- `docs/AI_INSTRUCTIONS.md`: instructions for chat models to emit ai-helper blocks; this is not a coding-agent guide.
- `docs/FEATURE_TEST_MATRIX.md`: required feature-to-test table. Update it whenever a feature, invariant, or `tests/*.test.js` case changes.

## Common Commands

Run all automated tests:

```sh
./scripts/test_all.sh
```

The full test runner includes static checks, shell syntax checks, `git diff --check`, every `tests/*.test.js` file, and `tests/chrome_extension_e2e.test.js`, which launches a real Chromium-family browser with the unpacked extension and drives the local tmux test page. On Ubuntu it needs `DISPLAY`, Xvfb, or a cached Playwright Chromium browser; on macOS it can use Chrome for Testing, Chromium, Microsoft Edge, or Google Chrome. Set `CHROME_BIN` to force the browser binary.

Run a single test:

```sh
node tests/manifest_consistency.test.js
```

Run the shell server in the foreground:

```sh
./scripts/start_shell_server.sh
```

Run environment diagnostics:

```sh
./scripts/doctor.sh
```

Manual browser test flow:

```sh
node scripts/start_tmux_test_page_https.js
./scripts/open_tmux_test_chrome.sh
```

Remove any legacy macOS LaunchAgent and start the current foreground server:

```sh
./scripts/install_shell_server_agent.sh
```

Package a release:

```sh
./scripts/package_release.sh
```

`scripts/package_release.sh` refuses dirty worktrees unless `ALLOW_DIRTY=1`.

## Important Invariants

- There are two manifests: `manifest.json` at the repo root and `extension/manifest.json`. Keep them behaviorally aligned; `tests/manifest_consistency.test.js` enforces this.
- The extension ID is pinned by the manifest key: `lkmeogidbglhedgekjgbpbfjkpapnhke`.
- The local server accepts only `chrome-extension://lkmeogidbglhedgekjgbpbfjkpapnhke` by default. `AI_CHAT_SHELL_ALLOW_UNTRUSTED_ORIGINS=1` is only for local development tests.
- The WebSocket server is fixed at `127.0.0.1:17371`; the manual HTTPS test page defaults to `https://localhost:17443/tmux-test-page.html`.
- Default enabled hosts and chain limit are duplicated in `extension/src/background.js`, `extension/src/content.js`, and `extension/src/popup.js`. Current defaults are `["chatgpt.com", "m365.cloud.microsoft"]` and `maxChainCalls = 100`; `tests/default_enabled_hosts.test.js` enforces this.
- Shell helpers must use the plain text block format: first line `ai-helper-shell-start` or `ai-helper-shell-start:<identity>`, command body on every following line, final line `ai-helper-shell-end`. Shell helpers do not include a target line; they always run in the default `ForAI:host` tmux pane. JSON `shell-call` code blocks and `ai-helper-start-shell` aliases are intentionally not supported.
- File helpers use `ai-helper-file-start` or `ai-helper-file-start:<identity>`, a second-line file name, exact file content, and `ai-helper-file-end`; the server writes only a single file name directly under `$HOME/Downloads`.
- Helper identity suffixes are optional simple no-space values used for request diagnostics. Unsuffixed helper blocks derive identity from a stable plain text payload hash; neither form controls server execution dedup.
- Board target resolution and internal diagnostics accept pane id, `session:window.pane` address, or a unique window name. Ambiguous window names must not resolve. Shell helper targets are intentionally ignored.
- The shell server is the sole command-duplicate authority. After resolving the actual tmux pane it fingerprints the pane instance, command, and actual cwd; only a command with a server-controlled completion proof may return `duplicate: true`. Generic board prompt text is spoofable, so board execution dedup is deliberately disabled. Browser local storage key `shellCallLedger:v1` is non-blocking audit state, and the content script only scan-debounces the exact same rendered helper request while invalidating that tracking when helper DOM is recycled. Failed, cancelled, timed-out/unconfirmed, unavailable-target, transport, incomplete-pane-identity, board, and merely `running` calls remain retryable; immutable internal attempt ids prevent client call-key collisions; force runs bypass authoritative server dedup while recording `forced: true`.
- Do not weaken safeguards that reject copied `shell-output`, markdown wrappers, terminal prompts such as `$ ...`, or repeated command loops.
- `content.js` has tests that match specific function names and source text for force-run behavior. Rename/refactor those areas carefully.
- `server/shell_server.js` exports helper functions used directly by tests. Preserve exports when changing tmux or WebSocket logic.
- Shell-output formatting uses `cmdHash` for long or multiline commands so users and tests can diagnose command identity; server execution dedup uses the full received command after pane resolution.
- The server writes transient tmux scripts under `.state/tmux-runs` and removes them best-effort.
- `docs/FEATURE_TEST_MATRIX.md` must list every product feature or invariant and every `tests/*.test.js` case. Keep the table current in the same change as code or test edits; `tests/feature_test_matrix.test.js` enforces that every test file appears there.

## Development Notes

- After changing extension files, reload the unpacked extension in `chrome://extensions` and refresh any affected chat tabs.
- After changing server files, restart the foreground server.
- The installer compatibility script is macOS-specific and uses `launchctl` only to remove old LaunchAgents before starting the foreground `./scripts/start_shell_server.sh` flow. Ubuntu uses the foreground server flow unless the user adds their own service wrapper.
- `.state/`, `dist/`, `build/`, logs, and `node_modules/` are ignored.
- Prefer small, focused tests that exercise the standalone Node modules or VM-loaded extension scripts.

## Verified Baseline

During repo exploration, the full suite passed with:

```sh
./scripts/test_all.sh
```
