# Changelog

## [0.8.0] - 2026-06-22

- Adds read-only AI-facing `ai-helper-agent-roster-*` helpers so master agents can discover online slaves, surfaces, reply modes, pending counts, and capabilities without the user copying the floating-panel roster.
- Adds read-only `ai-helper-agent-task-status-*` helpers so master agents can inspect delegated tasks by `message-id` or `task-id` and receive actionable status/next-step output.
- Bumps helper protocol to `2` because the AI-facing helper surface now includes agent roster and task-status query helpers.
- Improves agent-message result and failure output with status-query hints and AI-executable recovery guidance.
- Updates README and AI instructions so the master workflow is roster -> delegate -> status/recovery rather than assuming the user already provided a slave id.

## [0.7.1] - 2026-06-22

- Updates the README multi-agent guide with copyable browser master/slave prompts, browser-tab smoke-test steps, and clearer pending-delivery behavior.
- Adds a simple web master + tmux Claude quick start that covers starting Claude in tmux, registering `slave-tmux` from the master panel, and verifying the first `TMUX_AI_SMOKE_OK` reply.
- Documents the project-level Claude Code skill fallback, the short per-task reply script workflow, `claude.ai` manual enablement, and common multi-agent troubleshooting cases.

## [0.7.0] - 2026-06-21

- Adds tmux-ai agents: an explicit tmux pane can register as a `master` or `slave` AI runtime and receive task prompts from the local agent hub.
- Adds the `agent-register-tmux-ai` and `agent-reply` hub messages plus `server/agent_reply_cli.js`, so tmux-hosted AI teammates return results by actively calling the CLI instead of relying on tmux output parsing.
- Bumps the shell server protocol to `4` while keeping helper protocol `1`, because tmux-ai agent registration and CLI reply support require matching server/background behavior.
- Extends the manual test page, tmux integration coverage, CLI tests, background forwarding tests, and Chrome e2e to cover web master -> tmux-ai slave -> CLI reply -> web master delivery.
- Adds an opt-in real Claude Code tmux slave e2e test for the full web master panel -> tmux-ai Claude -> CLI reply -> web master page path.
- Adds `reply-to` correlation for web slave replies, agent task status diagnostics, clearer agent hub error hints, and a project-level Claude Code skill for tmux-ai slave reply workflow.
- Generates a short per-task reply script for tmux-ai slaves so the AI only needs to write the reply file and run `sh ...-reply.sh`; the script wraps the longer CLI flags.

## [0.6.0] - 2026-06-21

- Adds local multi-agent tabs: users can register enabled chat pages as `master` or `slave` agents from the floating panel.
- Adds an in-memory local WebSocket agent hub with `agent-register`, `agent-unregister`, `agent-list`, `agent-send`, `agent-poll`, and `agent-ack` messages.
- Adds `ai-helper-agent-message-start` / `ai-helper-agent-message-end` helper blocks so master and slave tabs can exchange task messages through the local hub.
- Routes shell helpers from registered agent tabs into isolated per-agent tmux workspaces such as `ForAI-slave-a:host`, while non-agent pages continue to use `ForAI:host`.
- Keeps active agent tabs online with poll-based heartbeats, auto re-registers after local server roster loss, and prevents duplicate task insertion while a message waits for the send button.
- Improves the floating panel with clearer `Save`/`Roster` agent controls, default agent-id suggestions, and pending message counts.
- Requires both sender and recipient agents to be registered before accepting hub messages.
- Adds master/slave AI instruction templates, local manual test controls, feature/test matrix coverage, unit tests, tmux integration tests, and Chrome extension e2e coverage for multi-tab agent delivery.

## [0.5.2] - 2026-06-11

- Lets closed four-backtick fenced shell helpers recover when `ai-helper-shell-end` is missing.
- Lets closed four-backtick fenced file helpers recover when `ai-helper-file-end` is missing.
- Lets closed four-backtick fenced board helpers recover when `ai-helper-board-end` is missing.
- Keeps incomplete helper starts ignored when either the opening or closing four-backtick fence is absent.
- Adds parser coverage and updates the feature/test matrix for fenced missing-end recovery across all helper types.

## [0.5.1] - 2026-06-09

- Corrects the agent-facing project guide so shell helper blocks use the current no-target format and always run in `ForAI:host`.
- Keeps the basic non-vision tmux workflow explicit in maintenance guidance: foreground server startup, automatic `ForAI` workspace setup, and legacy LaunchAgent cleanup.
- Adds regression coverage so project docs do not reintroduce the obsolete shell target line.

## [0.5.0] - 2026-06-08

- Adds a local visual tmux surface discovery path for macOS windows, defaulting to Terminal.app and Ghostty.
- Bumps the shell server protocol to `3` while keeping helper protocol `1`.
- Reports visual protocol metadata and supported local visual tmux apps from server health.
- Lets the extension background forward the supported visual discovery/run requests through the same stale-server health gate used by shell, file, board, and tmux messages.
- Adds coverage for visual surface listing, background vision forwarding, stale-server blocking, and supported-app metadata.

## [0.4.0] - 2026-06-08

- Separates the extension release version from server protocol compatibility by reporting `serverProtocolVersion` and `helperProtocolVersion` from the local server health endpoint.
- Bumps the shell server protocol to `2` and defines helper protocol `1` for the plain `ai-helper-*` marker format.
- Makes stale foreground server detection explicit when the extension sees an old server protocol or missing helper protocol metadata, with restart guidance for `./scripts/start_shell_server.sh`.
- Shows server release, server protocol, helper protocol, and `ForAI` state in floating-panel, popup, and doctor diagnostics.
- Adds protocol metadata tests for current health responses, old server detection, and helper protocol mismatch handling.

## [0.3.5] - 2026-06-08

- Hardens shell server startup against broken `.state` paths by preflighting and automatically repairing safe state-directory conflicts before listening.
- Adds `AI_CHAT_SHELL_STATE_DIR` so runtime state can be explicitly moved when needed.
- Removes macOS LaunchAgent auto-start; the shell server now runs as an explicit foreground process with `./scripts/start_shell_server.sh`.
- Keeps `./scripts/install_shell_server_agent.sh` as a compatibility shortcut that removes legacy LaunchAgents and then starts the foreground server.
- Reports state directory health and repair actions from `/health` and `scripts/doctor.sh`, and blocks extension execution when the server reports unusable state.
- Covers missing, corrupted, conflicting, auto-repaired, and unwritable state-directory cases in automated tests.

## [0.3.4] - 2026-06-07

- Starts new `ForAI` `host` and `board` tmux windows in the project root by default, with `AI_CHAT_SHELL_FORAI_CWD` available for an explicit default working directory.
- Adds a `tmux-reset-forai` server message plus floating-panel and popup reset actions to recreate the default `ForAI` workspace, including when the session is already missing.
- Removes shell helper target-line parsing so every line between `ai-helper-shell-start` and `ai-helper-shell-end` is command text, including heredocs; legacy shell target fields are ignored.
- Improves startup, `Check`, popup, health, and doctor diagnostics for default host, board, cwd, and server protocol state.
- Expands Chrome extension e2e coverage so the primary shell path uses a no-target helper block and verifies default execution in `ForAI:host`.

## [0.3.3] - 2026-06-01

- Ensures the default `ForAI` tmux session exists when the page plugin starts, with `host` and `board` windows created automatically.
- Defaults shell helpers without an explicit target to the `ForAI` `host` window.
- Resolves board helpers to the `ForAI` `board` window by default while preserving `AI_CHAT_SHELL_BOARD_TARGET` overrides.

## [0.3.2] - 2026-06-01

- Updates AI-facing helper examples and the floating-panel self-test prompt to use plain four-backtick fences.
- Keeps runtime helper detection marker-based so rendered `ai-helper-*` blocks continue to work across chat UIs.
- Adds parser coverage for four-backtick markdown-wrapped helper examples.
- Unifies the floating panel, extension, and release version at `0.3.2`, and warns from the panel when content/background versions do not match.

## [0.3.1] - 2026-05-30

- Clarifies the README introduction so users see all supported helper block types immediately: shell, board, and file.
- Adds top-level README examples for `ai-helper-shell-start`, `ai-helper-board-start`, and `ai-helper-file-start`.
- Keeps the AI-facing guidance explicit that helper requests must be exactly one fenced `text` code block with no prose.

## [0.3.0] - 2026-05-30

- Adds `ai-helper-board-start` / `ai-helper-board-end` blocks for sending one command line to the configured board tmux pane.
- Resolves board commands through `AI_CHAT_SHELL_BOARD_TARGET` or the unique tmux window named `board`.
- Probes the board prompt before every board command and refuses to send the command if no prompt can be identified.
- Captures board output with tmux `pipe-pane` byte offsets, including prompt-based completion and timeout partial output.
- Renders terminal control sequences in board output so common backspace and line-clear redraws match the visible tmux pane.
- Updates README and AI instruction samples to require fenced `text` helper blocks for shell, board, and file helpers.
- Adds unit and tmux integration coverage for board helper parsing, target selection, prompt probing, output capture, and duplicate suppression.

## [0.2.10] - 2026-05-29

- Adds optional helper identity suffixes such as `ai-helper-shell-start:2` and `ai-helper-file-start:2`.
- Uses the helper identity in duplicate suppression so otherwise-identical helper payloads with different suffixes can run as distinct requests.
- Derives a stable payload-hash identity for unsuffixed plain text helper blocks.
- Rejects malformed helper identity suffixes while keeping JSON helper requests and old `ai-helper-start-shell` aliases unsupported.
- Updates AI instructions and README examples for the optional suffix without changing the human-helper framing.

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
