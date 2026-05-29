# Feature Test Matrix

This table is the required map between product features and automated test cases. When a feature or test case is added, removed, or renamed, update this file in the same change.

`./scripts/test_all.sh` is the single command for the full automated suite. It runs static checks, shell syntax checks, whitespace checks, every `tests/*.test.js` file, and the Chrome extension e2e test.

| Feature or invariant | Test cases | Coverage notes |
| --- | --- | --- |
| Root and `extension/` manifests stay behaviorally aligned for either unpacked load path. | `tests/manifest_consistency.test.js` | Compares manifest version, key, permissions, background worker, popup, and content script wiring. |
| Default enabled hosts and automatic chain limit stay aligned across background, content, and popup code. | `tests/default_enabled_hosts.test.js` | Enforces `chatgpt.com`, `m365.cloud.microsoft`, and `maxChainCalls = 100` in all duplicated defaults. |
| Background settings migration preserves existing user choices while migrating legacy defaults. | `tests/background_settings_migration.test.js` | Covers legacy enabled-host and chain-limit migration behavior. |
| Background file-helper message handling forwards file writes over WebSocket and records duplicate ledger state. | `tests/background_write_file_message.test.js` | Covers write-file payload shape, success response handling, and browser-side duplicate suppression. |
| Plain text shell helper parsing accepts `ai-helper-shell-start`, target, command body, and `ai-helper-shell-end`. | `tests/content_plain_text_shell_call.test.js` | Covers parsing, extracted helper blocks inside surrounding text, empty targets, validation, and command body preservation. |
| Plain text file helper parsing accepts `ai-helper-file-start`, filename, exact content, and `ai-helper-file-end`. | `tests/content_plain_text_shell_call.test.js` | Covers JSON-like file content as plain text, trailing blank lines, file validation, and file helper result formatting. |
| JSON helper requests and old `ai-helper-start-shell` aliases remain unsupported. | `tests/content_plain_text_shell_call.test.js` | Covers language-hint rejection and shell-call validation rejection for old markers. |
| Optional helper identity suffixes distinguish otherwise-identical shell and file helper payloads. | `tests/content_plain_text_shell_call.test.js`, `tests/chrome_extension_e2e.test.js` | Covers suffixed shell and file parsing, semantic key differences, malformed suffix rejection, unsuffixed payload hashes, and a real suffixed shell e2e request. |
| Shell-output formatting is compact but still preserves command identity for duplicate suppression. | `tests/content_shell_output_format.test.js` | Covers short commands, long commands, multiline commands, `cmdHash`, and same-command detection. |
| Manual `Run latest` force execution preserves forced retry behavior and user-facing status text. | `tests/content_force_run.test.js` | Source-level guard for force-run function names, forced scan path, pending retry status, force key generation, and active-call release. |
| Popup settings UI can load, save, normalize enabled sites, list tmux targets, and export/import portable config without ledgers. | `tests/popup_config.test.js` | Covers tmux target display, site normalization, config export/import, clamping, and exclusion of command ledgers. |
| Tmux target parsing and resolution accept pane id, `session:window.pane`, and unique window names while rejecting ambiguous names. | `tests/tmux_helpers.test.js` | Covers pane parsing, target resolution, tmux socket argument building, and tmux environment socket extraction. |
| Missing tmux targets produce a helper-readable failure with available pane examples. | `tests/tmux_helpers.test.js` | Covers missing target response shape and example helper block. |
| File helpers write only a single file name under the Downloads directory. | `tests/tmux_helpers.test.js` | Covers safe path resolution, traversal rejection, byte counts, and file content writes. |
| Tmux run output extraction finds start/done markers, exit codes, timeout partial output, and truncation. | `tests/tmux_helpers.test.js` | Covers complete, failing, partial, missing-marker, and truncated command output cases. |
| WebSocket text frame parsing handles fragmented, coalesced, extended-length, masked client, and server frames. | `tests/server_websocket_frames.test.js` | Covers low-level frame decoder and encoder behavior used by the local server. |
| Chrome extension e2e flow works with a real unpacked extension, Chromium-family browser, tmux pane, shell helper, file helper, and optional screenshots. | `tests/chrome_extension_e2e.test.js` | Launches or reuses the local shell server and HTTPS test page, inserts helper blocks, verifies returned `shell-output`, and writes screenshots when requested. |
| Feature/test coverage documentation stays in sync with all committed automated test files. | `tests/feature_test_matrix.test.js` | Fails if any `tests/*.test.js` file is missing from this matrix or if this matrix is not referenced from project docs. |
| Full automated checks and tests can be run with one command on macOS and Ubuntu. | `scripts/test_all.sh`, `tests/feature_test_matrix.test.js` | The runner performs syntax checks, `git diff --check`, every Node test, and the Chrome extension e2e test. |
