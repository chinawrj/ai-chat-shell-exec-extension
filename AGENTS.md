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
- The shell server is the sole command-duplicate authority. After resolving the actual tmux pane it fingerprints the tmux server/pane plus the current pane shell PID, command, and actual cwd; only a command with a server-controlled completion proof may return `duplicate: true`. A `respawn-pane` shell therefore starts with no inherited duplicate history even though its pane id is unchanged, and missing pane-shell identity disables dedup. Ctrl+C after the executed marker produces prompt exit-130 completion and counts as executed history; interruption before that marker remains retryable through a newly rendered helper. Generic board prompt text is spoofable, so it is neither duplicate authority nor a strong serialization proof; shell-backed boards additionally use foreground-process-group readiness. Browser local storage key `shellCallLedger:v1` is non-blocking audit state. The content script scan-debounces the exact rendered helper and, after any shell/board backend response, persists pending composer delivery instead of resending the same run; recycled/new render roots remain eligible for backend adjudication. Failed, cancelled-before-execution, timed-out/unconfirmed, unavailable-target, transport, incomplete-pane-identity, board, and merely `running` calls never become duplicate authority; immutable internal attempt ids prevent client call-key collisions; force runs bypass authoritative server dedup while recording `forced: true`.
- Shell helper runners and direct Terminal vision test runs are serialized per resolved tmux pane instance. Queue identity uses the stable tmux socket + server pid + pane id, never mutable window addresses, names, indexes, or session metadata; a tokenized tmux pane option persists ownership across shell-server restarts. A request from a refreshed page waits behind the old page's still-running command without consuming its own runner state timeout. Manual-busy readiness is authoritative only for child work proved by tmux pane PID/TTY and foreground process-group metadata; missing metadata must fail closed and remain retryable. The root interactive shell's own blocking builtins (such as direct `read` or a pure-builtin loop) cannot be distinguished from its prompt without shell hooks, so use a script/child shell or dedicated pane. Capture cwd and create the authoritative command claim only after the request reaches the queue head and the pane instance is revalidated. Never send multiple runner command lines into one observed busy pane. Different pane instances remain concurrent, and observed indefinitely running foreground jobs require natural exit or Ctrl+C before queued work can start.
- Chrome 116 is the minimum supported browser version. Long WebSocket operations send a heartbeat every 20 seconds. If an MV3 runtime-channel/service-worker loss drops the response while the page survives, content polls the server's read-only, kind-scoped `run-status` using the same call key; it must never resend `run` or `run-board`. A full reload creates a new call key and relies on the persistent pane lease plus backend adjudication when the helper is rendered again. Each actual execution has a canonical `executionId`; duplicate chains inherit it, and a `run-result-presented` receipt distinguishes an already-presented result from clean recovery of an unpresented bounded replay. Presentation is monotonic across the canonical chain, including status recovery of duplicate entries created before a later receipt. Authoritative duplicate diagnostics are local-only and must never enter the composer/model. Persistent ownership must be bound to the immutable queued attempt before authoritative adjudication, nonterminal ledger entries must survive count pruning, and late failures must not downgrade terminal completion. Completed stdout/stderr have per-result and global replay bounds in the server ledger.
- Frontend `activeCallId` covers backend execution only, never the potentially slow composer auto-send calibration loop. Every successful helper response enters a bounded per-tab persistent pending-delivery queue before composer work; retries are local and preserve exact ownership. Each delivery may automatically write its content into the composer at most once. If the user removes or replaces that text, cancel the current queued helper-output batch; never reinsert it, never mark it presented, and let only a genuinely new rendered helper create a fresh delivery. A framework redraw that replaces the composer DOM node is not user cancellation when the current visible composer still contains the exact plugin-owned text; transfer send ownership to that node without another write. After the first write, button/form/keyboard calibration may retry only sending for shell, board, file, agent-message, roster, and task-status outputs; it must never repeat the backend operation or composer write. Inbound agent prompts follow the same one-write and redraw rules: actual removal, replacement, or navigation after writing cancels composer delivery and may retry only the local hub cancellation acknowledgement. Auto-send is a cancellable UI follow-up and must verify exact text, current visible composer association, and lifecycle before every side effect. A pending agent delivery defers, but does not mark or consume, a newly detected helper; submitted agent prompts are acked without reinsertion, identical agent-message response-loss retries are idempotent, and a page-agent profile change cancels the old delivery lifecycle.
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
