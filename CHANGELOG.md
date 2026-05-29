# Changelog

## Unreleased

- Nothing yet.

## [0.2.9] - 2026-05-29

- Updates the README short AI instruction to include the `ai-helper-file-start` / `ai-helper-file-end` file helper format alongside shell helpers.

## [0.2.8] - 2026-05-29

- Replaces JSON `shell-call` requests with plain text `ai-helper-shell-start` / target / command / `ai-helper-shell-end` blocks.
- Adds `ai-helper-file-start` / filename / content / `ai-helper-file-end` blocks that write files under `$HOME/Downloads`.
- Removes JSON shell-call parsing so commands and file contents no longer need JSON string escaping.
- Removes the old `ai-helper-start-shell` / `ai-helper-end-shell` shell helper aliases.
- Updates AI instructions to present helper blocks as requests served by a human helper, not as an automatic script interface.
- Updates manual test helpers, missing-target examples, and parser coverage for the new helper formats.
- Adds an automated Chrome extension e2e test that loads the unpacked extension, drives the tmux test page, and verifies returned `shell-output`.
- Adds release screenshots for shell and file helper result replies.

## [0.2.7] - 2026-05-22

- Shortens displayed commands in `shell-output` blocks to 64 characters.
- Adds `cmdHash` when the displayed command is abbreviated or normalized so duplicate suppression still works.
- Adds coverage for long, short, and multiline shell-output command formatting.

## [0.2.6] - 2026-05-22

- Releases the active shell-call lock once output has been inserted, so `Run latest` is not blocked by slow auto-send confirmation.
- Keeps the forced retry queue from v0.2.5 for clicks that happen while the previous command is still finishing.

## [0.2.5] - 2026-05-22

- Makes `Run latest` keep its forced retry semantics when clicked while a previous shell call is still clearing.
- Shows a clear `No shell-call found on this page` status when a manual scan finds nothing runnable.
- Adds coverage for the forced retry handoff state.

## [0.2.4] - 2026-05-22

- Fixes legacy chain-limit migration when Chrome sync storage preserved the old default as the string `"5"`.
- Makes the legacy chain-limit migration one-time so users can still choose lower custom limits after upgrading.
- Adds coverage for background settings migration.

## [0.2.3] - 2026-05-22

- Adds a floating-panel `Run latest` button that manually rechecks the latest `shell-call` and executes it.
- Manual `Run latest` ignores automatic scan limits, duplicate suppression, self-test waiting, and the chain limit.
- Manual forced runs use a one-time execution key so completed-call ledgers do not suppress the retry.

## [0.2.2] - 2026-05-19

- Raises the default automatic shell-call chain limit from 5 to 100.
- Removes the popup's upper bound for `maxChainCalls`; only the minimum of 1 is enforced.
- Migrates users still on the old default chain limit to the new default without changing custom values.

## [0.2.1] - 2026-05-19

- Enables `chatgpt.com` by default so the floating panel appears on a fresh install.
- Migrates users who still have the old default enabled-site list to the new default list without overwriting custom site lists.
- Adds coverage to keep default enabled hosts aligned across background, content, and popup code.

## [0.2.0] - 2026-05-19

- Defines the release around tmux-backed execution, diagnostics, portable calibration, and zero-knowledge hardening.
- Adds popup export/import for settings and per-origin calibration bindings.
- Routes shell-call execution through explicit tmux pane targets instead of spawning a new server-side shell.
- Lists tmux panes in the popup and in missing-target shell-output replies.
- Resolves the user tmux socket from LaunchAgent environments so background server calls can see interactive tmux panes.
- Adds a local HTTPS manual test page for exercising tmux-backed shell-call flows.
- Adds a helper to launch an isolated Chromium-family profile with the unpacked extension loaded for local testing.
- Adds an install doctor script for Node.js, manifest ID, shell server health, and origin-policy checks.
- Shows extension/server origin mismatches in popup and floating health checks.
- Keeps the root and `extension/` manifests aligned so either unpacked load path has the same version and permissions.
- Makes the local WebSocket server tolerate TCP-fragmented and coalesced text frames.
- Adds WebSocket frame parser coverage for partial, multiple, extended-length, masked, and server frames.

## [0.1.1] - 2026-05-16

- Adds AI instruction templates for ChatGPT, Claude, Copilot-style agents, and one-off prompts.
- Documents safe shell-call behavior, chaining rules, and the expected `shell-output` feedback loop.
- Updates README install flow to point users at the instruction templates before using the test button.

## [0.1.0] - 2026-05-16

Initial public release.

- Runs explicit `shell-call` blocks from AI chat pages through a local WebSocket shell server.
- Posts command results back as `shell-output` blocks.
- Uses zero-knowledge page adaptation based on editable elements, generic submit behavior, and optional user-bound controls.
- Includes a movable floating panel with `Test`, `Check`, and per-origin binding controls.
- Adds duplicate-execution protection in both the extension background worker and local server ledger.
- Adds a macOS LaunchAgent installer for keeping the local shell server running after login.
- Supports release packaging with SHA256 checksums.
