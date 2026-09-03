# Changelog

## [Unreleased]

## [0.11.15] - 2026-09-03

- Generalizes first-conversation URL assignment recovery beyond ChatGPT. A same-origin provisional route that gains one opaque conversation-id segment, including M365 `/chat` to `/chat/<UUID>`, may retain a live helper only while its exact latest user-to-assistant turn, helper semantic payload, and user-text fingerprint all remain current. DOM ownership must also remain exact, except that ChatGPT may rebind one uniquely matching replacement turn through its stable user/assistant message IDs.
- Preserves shell/board/file/agent, Skill, and Draw.io ownership through that proven assignment while retaining exactly-once backend, composer-write, and submission behavior. An M365 Lexical composer redraw containing the exact plugin-owned result resumes send-only and never causes another write or helper execution.
- Keeps URL changes non-authoritative: query/hash-only changes, cross-origin changes, permanent conversation A-to-B navigation, transcript replacement, detached/reordered turns, copied text in replacement DOM, and persisted unsubmitted entries fail closed. Force remains bound to its original lifecycle, and the v0.8.6/v0.8.9 send actuator is unchanged.
- Quarantines a recognized assignment for at least four seconds of route stability as well as scan settlement. No automatic backend start, local preview commit, composer write, or send can use the temporarily retained old transcript during that window.
- Captures candidate-bound live-generation proof before asynchronous scan preflights. If the completed helper is already visible when an outer pending-state/settings read overlaps a URL-only `pushState`, the assigned route schedules its own settled rescan even when the host emits no later DOM mutation; changed user text or unproved replacement roots invalidate that proof. Exact same-semantic observer redraws and unique ChatGPT stable-ID replacement roots transfer both result ownership and the processed claim only after the route/turn proof succeeds, preventing both a lost result and a second dispatch after backend locks release.
- Separates completed claims from tentative pre-backend claims during route reconciliation. A helper paused on settings, approval, profile, or pending-state work before any backend request is released back to the settled scanner instead of inheriting a stale processed bit; runtime-dispatched and completed helpers retain exactly-once ownership.
- Adds focused positive/negative route-proof tests and independent real-Chrome M365 pages for helper completion after URL assignment, backend-in-flight retention, post-write composer redraw/send-only recovery, delayed old-transcript replacement, post-write transcript replacement, permanent UUID conversation navigation, and Skill-load zero-dispatch after replacement. The tests count runtime requests, composer writes, submitted messages, pending entries, and real tmux marker executions exactly. The test server now serves the exact M365 `/chat` and `/chat/<UUID>` route shapes.

## [0.11.14] - 2026-09-03

- Extends `AI_CHAT_SHELL_ENV_FILE` to exact-SHA Skill loads. Every valid variable declared in the freshly reread file is automatically eligible for `$NAME`/`${NAME}` expansion and overrides the same shell-server process variable without requiring a duplicate `AI_HELPER_SKILL_ENV_ALLOWLIST` entry.
- Preserves one-pass expansion, Claude runtime placeholders, non-spoofable server-owned Skill-root placeholders, output-size limits, and catalog SHA/version stability. Malformed, missing, unsafe, or oversized env files fail the load without returning file values or paths.
- Adds focused catalog/protocol regressions plus real unpacked-Chrome coverage for initial expansion, env-file hot reload without a server restart, non-allowlisted process isolation, and malformed-file failure. Skill protocol advances to 6 so an old foreground server is rejected clearly.
- Preserves an automatically detected helper across ChatGPT's one-time new-chat `/` to `/c` or `/uc` URL assignment while its settings read, backend request, MV3 runtime-channel status recovery, or durable result enqueue is in flight. The active execution lock and exact originating helper/turn proof move together, so shell and board results are recovered through kind-scoped read-only status, then written and submitted once without replaying the backend.
- Preserves send-only ownership when that proven URL assignment occurs after the result was already written and React replaces the composer with the same exact plugin-owned text. The original actuator is invalidated at the route boundary; recovery neither reruns the helper nor writes the composer again.
- Rejects transcript replacement, existing-chat navigation, detached/changed helpers, and a second route before any stale backend, recovery-status, or composer side effect. Recovery revalidates exact ownership both before and after each status await. Adds focused gated-settings/backend/runtime-loss races plus independent real-Chrome retained/replaced-transcript pages using a real tmux command; Force keeps its strict route boundary and the v0.8.6/v0.8.9 send actuator remains unchanged.
- Revalidates pending-result ownership after both local-state loading and the first durable write. A stale continuation removes only the exact entry object it created, cannot erase a newer same-call replacement or overwrite a newer active status, and Force backend or validation results cannot migrate across a route while persistence is blocked.
- Binds Draw.io render completion and automatic error feedback to the exact originating candidate/turn across settings and durable-queue awaits. One proven ChatGPT new-chat URL assignment may retain the result; transcript replacement, navigation between permanent conversations, or a second route cannot update the panel or write/send the old error in another chat.
- Prevents restored ordinary pending output from migrating into another route without a live exact candidate/turn guard, including an apparent `/` to permanent ChatGPT URL assignment. Queued, inserted, and submitted-unconfirmed shell/file/board/agent/Draw.io/Skill-prompt output now fails closed and its old storage is removed; already-submitted entries may migrate only to finish their presentation receipt without composer or old-status side effects.

## [0.11.13] - 2026-09-03

- Adds low-saturation whole-panel state themes while preserving the exact idle background: deep blue for active end-to-end helper work, deep green for completed work, and deep red for failures or actionable exceptions. The existing dot and explicit text remain, with matching accessibility labels.
- Covers shell, file, board, agent, Skill, and Draw.io lifecycles. Successful backend results remain blue until their user-visible composer delivery completes, then remain green if only the server presentation receipt is pending; failed results turn red immediately even while error delivery is pending, output-idle remains blue, and Ctrl+C after execution starts is a green completed execution.
- Prevents cancelled or superseded Draw.io work from overwriting a newer helper state, restores green when an already-rendered latest artifact cancels a staging replacement, and adds focused positive, negative, boundary, stale-result, and real-Chrome computed-style regressions plus release screenshots.

## [0.11.12] - 2026-09-02

- Makes `View Skills` a complete local management inventory: every successfully discovered Skill is rendered exactly once, and `installed` is only per-row state rather than a list filter. The smaller AI/composer catalog-size bound may still fail closed without blanking the local management rows.
- Prevents partial or invalid scans, including temporarily missing explicit roots or a previously populated default root, from destructively reconciling authenticated installation receipts or replacing the last authoritative catalog state. A never-created default root stays healthy and empty; exact recovery restores installed rows without inventing a version.
- Keeps already-open `View Skills` dialogs current across tabs using version/SHA/count-triggered single-flight refresh, while accepting legitimate version repair, rejecting truly superseded responses, preserving rows on resolved/rejected refresh failure, deferring to local lifecycle operations that start before or during polling, and never writing to the AI composer.
- Adds focused mixed installed/uninstalled, oversized-catalog, invalid/partial inventory, explicit/default missing-root recovery, version-repair/stale/failed/closed/lifecycle-race dialog, and real Chrome install/uninstall/reinstall cross-tab regressions.

## [0.11.11] - 2026-09-02

- Adds `AI_CHAT_SHELL_ENV_FILE`, a strict data-only environment declaration file freshly read before each ai-helper shell command and trusted Skill lifecycle script. Values are never sourced, command-expanded, logged, copied into ledgers/protocol replies, or added to unrelated helper/server environments; shell injection reuses the existing private transient tmux runner script lifecycle.
- Binds shell duplicate authority to the exact environment-file content SHA, so a command completed under an old environment cannot suppress the same command after the file changes.
- Adds a trusted-click Skill `uninstall.sh` lifecycle with exact Skill/catalog/uninstaller SHA validation, no-follow reads, immutable snapshots, one serialized install/uninstall queue, 600-second output-idle handling, failure diagnostics isolation, and fail-closed installed-state transitions.
- Adds focused parser, safety, tmux, server protocol, background, content UI, result-page, and real unpacked-Chrome regressions for configured/absent/malformed environments plus install/uninstall success and failure.
- Adapts ChatGPT authored-message and helper-generation ownership to the current exact DOM contract, including bounded first-route completion recovery without accepting nested, historical, sponsored, rewritten, or second-route helper copies.
- Adds a nonce-bound sandboxed Draw.io `srcdoc` fallback for hosts whose `frame-src` CSP blocks the packaged extension iframe, while keeping XML on the channel-bound message path and retaining strict nonce/channel validation.
- Adds a guaranteed 20-second semantic-idle Force run fallback for the latest detected executable or Skill helper. DOM redraws, repeated scans, assistant activity, and composer-delivery state cannot postpone it forever; only an actual helper/backend operation pauses the accumulated clock.
- Keeps the Skills version/update chip in the panel header, adds a permanently discoverable Force run entry under More → Setup & recovery, and disables that entry only when no eligible helper exists or an operation is active.
- Requires trusted browser input for both Force run and Process Skill; host-page `.click()` or synthetic events fail closed before executable or local Skill work.
- Adds focused clock, redraw, lifecycle, dispatch, placement, positive/negative/boundary, and isolated real-Chrome regressions for Force run.
- Bumps the shell server protocol to 12 and Skill protocol to 5; restart the foreground server and reload the unpacked extension after upgrading.

## [0.11.10] - 2026-09-01

- Recognizes M365's current exact `.fai-CopilotMessage[role="article"]` assistant root throughout authored-message discovery and generation binding while retaining compatibility with the legacy `.fai-AssistantMessage` class.
- Recovers one complete valid Skill envelope when current M365 Copilot content preserves canonical protocol lines in `textContent` but collapses those same lines to exactly one ordinary space each in `innerText`; prose, suffixes, hidden fields, second envelopes, changed whitespace, unknown roles, and non-M365 roots remain rejected.
- Treats only the exact fixed plugin-owned Skill sync prompt as M365-flattenable submission content, and still requires a fresh exact `.fai-UserMessage[role="article"]` root beyond the pending delivery's baseline before finalizing it.
- Recovers a late-final M365 list/ACK only for the current tab's exact active challenge and synchronization phase; stale challenges, other tabs, later user turns, loads, and shell helpers remain inert.
- Makes each accepted late-final list/ACK semantic an inert page-scoped tombstone across replacement DOM roots, so M365 redraws cannot repeat the backend request, catalog message, or error reply.
- Accepts M365's single terminal markdown layout newline without tolerating a second newline or any hidden suffix.
- Pre-projects only known plugin-owned structured payloads to M365's newline-free form before the first composer write, preserving JSON braces that Lexical otherwise deletes while leaving arbitrary text and user drafts untouched.
- Adds focused positive, negative, history, identity, hidden-content, whitespace, terminal-newline, owner/phase, race, challenge, and one-finalization regressions plus host-mapped real Chrome M365 pages covering the complete flattened prompt → late-final Copilot list → brace-preserving catalog → Copilot ACK chain and tampered-prompt/later-user rejection.

## [0.11.9] - 2026-09-01

- Records and immediately persists a monotonic cancellation boundary when composer ownership is first lost, including trusted Enter/LineBreak emptying and the submitted-unconfirmed interval, and synchronously revalidates origin/attempt ownership after the async guard. Delayed cancellation recognition, reload, and same-URL replacement can no longer authorize stale Skill side effects or erase a genuinely newer helper result.
- Binds automatic executable and Skill detection to the latest explicit user turn and one exact current assistant response. Late-hydrated history, unknown-role content, authored/panel Stop lookalikes, removed-only controls, stale old-route controls, later user turns, second routes, and same-Element transcript rewrites now fail closed to explicit recovery.
- Preserves legitimate atomic, streamed, localized stable-control, same-route Stop-node reuse, and one-time provisional-to-permanent route flows, including slow completion beyond the previous generation tail.
- Binds every completed Skill result to its exact helper root, render generation, transcript, page lifecycle, and delivery attempt. Queued content can cross one settled exact-root URL assignment, while cross-chat, same-URL replacement, second-route, detach, reload-without-proof, and stale-backend cases are discarded without rerunning the backend.
- Adds a unified attempt-plus-origin guard before composer focus/write, after every asynchronous composer/proof/storage boundary, and throughout send-only actuator retries. Old queued, inserted, submitted-unconfirmed, or trusted-mutation work cannot write into another chat, send from another chat, finalize on copied proof, or clear a newer queue.
- Keeps historical helpers recoverable through **Force run** or **Process Skill**, and preserves exact one-write/one-backend semantics for valid pending delivery.
- Adds dedicated positive, negative, route, same-URL, DOM-reuse, cancellation, backend-race, independent-tab, and real Chrome Skill E2E regressions, with the feature matrix updated to match.

## [0.11.8] - 2026-08-31

- Fixes a new-chat SPA lifecycle race that parsed a live Skill `load` helper into Debug but then misclassified its first stable scan as existing history, leaving no backend request or AI-visible load result.
- Preserves cold-start safety by requiring candidate-bound live assistant-generation evidence before bypassing the initial-history gate; an unhandled assistant Skill helper without that evidence remains inert until the user explicitly invokes the separate contextual **Process Skill** recovery action, which uses the strict Skill protocol and never enters Force run.
- Prevents a second Skill helper from losing its final wake-up while the previous Skill helper is in flight, prevents stale backend results from crossing into another chat, preserves exactly-once claims across same-root route redraws, defers Skill work while an agent prompt owns the composer, and exposes baseline, generation, in-flight, and recovery state in Debug.
- Makes Force run and Process Skill single-flight and hides both while the AI is generating, Skill/backend or result-delivery work is active, an agent prompt owns the composer, or incompatible manual work is pending; explicit user messages and plugin-owned Skill output never become recovery candidates.
- Binds Force run to the exact page lifecycle and DOM-latest executable candidate through every awaited preflight, cancels if the helper or route changes, and rejects stale clicks while any backend helper is active instead of silently queuing hidden work.
- Adds focused positive/negative dispatch regressions plus real unpacked-Chrome cases in separate tabs for live new-chat auto-load, queued-result route recovery, cold-history redraw/manual recovery, stale Stop-control rejection, and user-message rejection while retaining the existing full-page E2E suite.

## [0.11.7] - 2026-08-31

- Replaces the Skill installer's absolute 120-second deadline with a 600-second stdout/stderr idle deadline. Either stream resets the clock even after bounded output capture is full, while the browser keeps long installation WebSockets alive without a shorter absolute watchdog.
- Requires explicit exit code 0 with no signal or idle timeout before a Skill can become installed; unknown and signal-terminated results now fail closed.
- Adds bounded main-shell-exit and idle-kill settlement so installer descendants holding inherited output pipes cannot permanently block later serialized installs.
- Shows nonzero, signal, and idle-timeout diagnostics in a one-use extension-origin result window. Sanitized bounded output remains in background memory only and never enters the chat page DOM, composer, AI messages, ledgers, logs, or extension storage.
- Bumps the Skill protocol to 4 so a new extension cannot silently use the old 120-second server behavior and an old extension cannot abandon a new long-running installer.
- Adds focused server/background/content/result-page regressions plus a real unpacked-Chrome exit-23 installer test covering the failure window, Retry state, uninstalled state, and composer/message isolation.
- Keeps Draw.io replacement renderers inside the viewport while transparent, noninteractive, and accessibility-hidden, preventing Chrome 151 from freezing cross-origin staging SVG layout and failure timers.

## [0.11.6] - 2026-08-30

- Splits Draw.io sandbox startup from render acceptance, pauses visible-time budgets while the page is hidden, retries one fresh local iframe when the first attempt does not accept the request, and uses iframe load as a fallback for a lost ready message.
- Removes the old combined 7-second parent render deadline: a slow final synchronous render may finish without being destroyed, while the isolated viewer uses immediate SVG detection, a mutation observer, and a separate 15-second visible-time output check after the packaged renderer returns.
- Enforces latest-only Draw.io outcomes across staging races: reselecting an already-rendered or cached invalid/failed candidate cancels any different in-flight renderer before restoring that local outcome.
- Recovers strict Skill helpers when a syntax-highlighting host inserts layout-only line breaks such as `catalog-version:\n2`; canonical `textContent` is accepted only when it differs by line breaks alone and passes the complete fail-closed protocol.
- Keeps truly malformed numeric lines, hidden extra content, duplicate/unknown fields, and mismatched envelopes rejected before background/server work.
- Lets a restored strong chat composer replace a stale weak remembered page input, while preserving an explicit **Bind input** choice as authoritative; queued Skill protocol replies then resume exactly one write/send without rerunning the backend operation.
- Makes Force Sync cleanup crash-safe by persisting a queued-only discard marker for obsolete in-flight Skill responses; reload consumes the marker without deleting a response that already reached the composer.
- Adds focused watchdog/policy/message-classifier, canonical-DOM, explicit-binding, stale-input, force-sync race, queued-composer recovery, negative protocol, and repeated real-Chromium Draw.io/Skill regressions.

## [0.11.5] - 2026-08-28

- Adds an explicit local Skill installation lifecycle: every discovered Skill starts uninstalled, the expanded Skills list exposes `Install`, `Installed`, retry, and missing-installer states, and only a trusted user click plus native confirmation can run an installer.
- Stores server-authenticated schema-v2 installation records in the fixed `skill-install-state.json` file under `AI_CHAT_SHELL_STATE_DIR`, reconciles add/delete/SKILL.md/installer changes, repairs invalid or forged records, and advances the monotonic local Skills version for meaningful changes while ignoring metadata-only JSON rewrites.
- Sends only installed and loadable Skills to AI, including every full bounded description, and explicitly tells the AI to preserve names and descriptions as routing metadata in the single `AI_CHAT_SHELL_SKILLS_CATALOG` memory entry.
- Keeps installation local to the extension/server management path: AI Skill helpers cannot execute installers, installer output stays out of the composer, and installs never touch tmux, command deduplication, Force run, or shell ledgers.
- Hardens installer execution with exact current id/Skill SHA/installer SHA/catalog validation, no-follow inode-safe reads, private immutable snapshots, a fixed `/bin/sh` invocation, minimal environment, per-service serialization, timeout/process-group termination, post-run revalidation, atomic `0600` state writes, and local-only diagnostics.
- Requires AI synchronization acknowledgement to echo the exact catalog version as well as SHA, preventing version-only installation-state changes from being falsely acknowledged.
- Bumps the Skill protocol to 3 and adds focused positive, negative, stale-state, failure, timeout, mutation, concurrency, panel, sync-prompt, packaging, and real-Chrome E2E regressions.

## [0.11.4] - 2026-08-27

- Keeps retrying the unchanged v0.8.6/v0.8.9 send actuator when the current visible composer still contains the exact plugin-written result, without repeating the backend helper operation or the one allowed composer write.
- Adds a persistent `submitted-unconfirmed` delivery phase: a cleared composer waits for a fresh exact submitted-user-message root instead of clicking or writing again, while user deletion, replacement, or a competing draft cancels safely.
- Captures fresh submission proof immediately from the page mutation that renders it, preventing a fast refresh or SPA transition from erasing the only valid proof before the normal retry timer runs.
- Preserves submitted-but-unconfirmed ownership across same-tab routes. Exact plugin text resumes send-only delivery; non-exact non-empty user text is never sent and cancels the pending batch.
- Prevents floating-panel mutations from retriggering the helper scanner and keeps backend completion, send pending, submission confirmation, and receipt-pending status distinct.
- Adds focused positive and negative regressions with a watchdog-protected 16-case route/delivery suite, plus real unpacked-extension Chrome coverage for refresh, hidden-tab MV3, composer redraw, route handoff, Force run, file delivery, and presentation receipts.

## [0.11.3] - 2026-08-27

- Keeps the acknowledged gray `Skills vN` chip interactive: clicking it opens the complete local Skills catalog without starting synchronization, creating a challenge, or writing to the AI composer. Update, syncing, and invalid states retain their distinct sync, disabled, and local-error behaviors.
- Adds a compact saved-role badge to the panel's existing top row. `None`, `Master`, and `Slave` remain text-visible as well as color-distinct, and unsaved advanced-form edits cannot misrepresent the active tmux routing role.
- Moves Page binding to the bottom of the advanced panel in a default-closed native details group while preserving all four binding actions.
- Adds focused source/state regressions and real-Chrome coverage for current/zero-Skill catalog viewing, sync-state separation, role badge save/restore/reset behavior and routing, compact non-overlap, advanced ordering, and Page binding collapse/expansion.
- Regenerates the README panel gallery from the real unpacked-extension Chrome E2E path, including the new role badge and bottom collapsed Page binding state.

## [0.11.2] - 2026-08-27

- Adds a bundled `skill-creator` for authoring focused Claude-compatible Skills in the AI Chat Shell Exec local catalog, with scoped discovery and explicit validation guidance.
- Keeps Skill destinations runtime-configurable through `AI_HELPER_SKILL_PATHS` or `AI_HELPER_SKILL_PATH`; the new Skill never assumes a fixed directory and requires user selection when multiple roots are ambiguous.
- Injects authoritative resolved roots JSON and configuration source into explicitly loaded Skill bodies through server-owned, non-spoofable runtime placeholders. The Skill uses a fresh challenge-free list request to validate new files without inventing a rescan command.
- Bumps Skill protocol to 2 so the extension rejects older foreground servers that cannot provide authoritative root metadata.
- Bounds runtime expansion before allocating the final body, configured root count, visited directory entries, traversal diagnostics, and public diagnostics so malicious local catalogs fail closed without blocking or amplifying server responses.
- Adds catalog-level, environment precedence/spoofing, scan-boundary, packaging, positive/negative, and independent forward-behavior coverage for single-root creation and ambiguous multi-root no-write behavior.

## [0.11.1] - 2026-08-27

- Fixes a never-acknowledged healthy catalog with zero Skills being incorrectly shown as current. Empty catalogs now request synchronization so the AI can clear a possibly stale `AI_CHAT_SHELL_SKILLS_CATALOG` memory entry.
- Keeps an empty catalog current after its real aggregate SHA is acknowledged, while failures remain pending, Force sync stays available, origins stay isolated, and removing the final Skill triggers a fresh update.
- Adds focused background and dynamic panel regressions plus a real-Chrome empty-root synchronization flow covering the green pending state, complete empty list, silent acknowledgement, and transition when the first Skill appears.

## [0.11.0] - 2026-08-26

- Adds a local Claude-compatible `SKILL.md` catalog backed by bounded server-side discovery, raw per-file SHA-256 hashing, one aggregate catalog SHA, and a persisted monotonic local version.
- Adds exact id/SHA Skill loading with one-pass allowlisted environment substitution; Skill operations never execute shell commands, contact tmux, or participate in command ledgers and Force run.
- Adds an origin-scoped, latest-only multi-tab synchronization handshake for the fixed `AI_CHAT_SHELL_SKILLS_CATALOG` memory entry. Runtime prompts explain the complete interaction and acknowledgement contract without embedding complete executable Skill helper markers.
- Adds a compact `Skills vN` state chip plus advanced catalog list, rescan, and force-sync controls. Updates remain highlighted until the latest full SHA is acknowledged, while invalid catalogs expose diagnostics without disabling shell helpers.
- Updates the stable AI instructions to load a Skill only when the fixed memory catalog indicates it is relevant, keeping catalog synchronization details in the runtime prompt.
- Bumps the server protocol to 11, helper protocol to 4, and introduces Skill protocol 1 so incompatible foreground servers fail closed.
- Adds dedicated positive and negative server, background, content, panel, and real-Chrome E2E regressions for catalog safety, environment expansion, multi-tab ownership, stale acknowledgements, prompt provenance, memory synchronization, and load behavior.
- Coalesces automatic multi-tab scans behind a 10-second server snapshot while keeping explicit and final-validation operations fresh; total raw bytes and actual serialized catalog length now fail closed before they can block the server or truncate an AI response.
- Hardens M365 user-message rejection and exact plugin-output provenance, permits same-owner force recovery without cross-tab takeover or closed-tab orphan locks, validates persisted version-state schema, and redacts absolute local paths from AI-facing Skill errors.
- Sizes the exact final dynamically fenced Skill-load reply on both server and content sides, rejecting fence amplification beyond 500,000 characters before any successful body can be silently truncated; recent M365 plugin-output provenance now expires at 60 seconds and is bound to the same page identity.

## [0.10.5] - 2026-08-26

- Makes the last complete Draw.io helper the sole current outcome: success shows only its SVG and clears old errors, while validation or render failure clears the old SVG/download and shows only the newest error.
- Sends a bounded Draw.io failure report to the AI through the existing durable one-write composer delivery queue; successful renders remain local-only and produce no reply.
- Adds a real Maximize/Restore control that expands the Draw.io preview to the browser viewport and restores its previous movable/resizable layout.
- Keeps Draw.io selection independent of the optional role filter while continuing to reject helpers in explicitly identified user messages.
- Adds unit and real-Chrome E2E regressions for latest-only selection, error replacement, one-time failure replies, success silence, no shell-backend contact, and viewport maximize/restore.

## [0.10.4] - 2026-08-25

- Adds README documentation showing the real compact extension panel in healthy idle, expanded advanced-controls, contextual Draw.io, Force run, running Stop helper, and output-idle Continue/Stop states.
- Places `Continue waiting` and `Stop helper` side by side in the output-idle decision card and hides the redundant upper Stop control, while preserving the existing confirmed exact-run termination path.
- Keeps staged Draw.io replacement iframes renderable while visually transparent and offscreen, preventing Chromium from intermittently skipping SVG layout before the atomic preview swap.
- Generates the documentation images as tightly cropped panel screenshots from the real unpacked-extension Chrome E2E flow instead of manually composed mockups.
- Adds regression coverage that verifies every README panel image exists, is a valid PNG, and remains linked from the documented state table.

## [0.10.3] - 2026-08-25

- Replaces the oversized floating panel with a compact, state-driven 292px bar: idle shows only server status and `More`, errors add `Server Check`, a runnable helper adds `Force run`, and an active shell helper replaces it with `Stop helper`.
- Preserves every existing setup, binding, Agent, tmux-ai, and debug capability in four labelled advanced groups that remain collapsed by default; Draw.io appears contextually only after a preview or error log exists and remains available for reopening after Close.
- Uses one user-facing stop concept: `Stop helper` is hidden while idle, shown only for an active helper, and remains the exact-owner termination control when an output-idle run asks the user to continue or stop.
- Adds source-level and real-Chromium regression coverage for compact defaults, advanced control preservation and grouping, expand/collapse behavior, contextual Continue, and active-only Stop.

## [0.10.2] - 2026-08-25

- Removes extension-side and shell-server command-body heuristics that incorrectly rejected valid scripts containing `shell-output`, result headings, Markdown fences, terminal prompts, metadata labels, or helper markers.
- Keeps automatic feedback-loop protection tied to exact fenced/DOM `shell-output` provenance instead of command keywords; an explicit **Force run** can execute a structurally suppressed helper and is no longer vetoed by either endpoint's text classifier.
- Removes legacy frontend parsing of commands from historical shell-output and narrows tool-result classification to complete known output envelopes so ordinary user discussion of `shell-output` still resets chain state.
- Adds unit and real-Chromium regressions for ordinary keyword-heavy heredoc execution, structural auto-suppression, and successful Force execution through the real shell server.
- Bumps the shell server protocol to 10 so the updated extension detects a still-running older server; restart the foreground shell server after updating.

## [0.10.1] - 2026-08-25

- Lets `AI_HELPER_FILE_PATH` replace `$HOME/Downloads` as the server-side destination for `ai-helper-file` output while retaining single-file-name and traversal protections. An explicitly empty override fails closed.
- Adds `docs/AI_INSTRUCTIONS_FULL.md`, one unified instruction set intended for direct Custom Instructions use, covering shell, board, file, Draw.io, and role-aware local agent helpers without the variant menu in `docs/AI_INSTRUCTIONS.md`.
- Updates setup, AI-facing instructions, agent invariants, and feature/test documentation for the configurable file destination.

## [0.10.0] - 2026-08-20

- Adds `ai-helper-drawio-start[:identity]` / `ai-helper-drawio-end`, whose body is a complete native `.drawio` `<mxfile>` document and is never treated as a command or sent to background/server/tmux/composer delivery.
- Displays only the last complete XML-valid helper in a movable, resizable user-facing SVG preview. New artifacts render in hidden staging and replace the previous iframe atomically only after fresh SVG readiness, preventing streaming and update flicker.
- Keeps the last successful SVG visible when newer XML is malformed or the renderer fails, with bounded in-preview and browser-console error diagnostics plus Close, Reopen, zoom/layer toolbar, and `.drawio` download controls.
- Packages the official draw.io `v31.1.5` static viewer locally with recorded SHA-256, Apache-2.0 license, third-party attribution, asset terms, and trademark independence statement; the Chrome release archive includes the viewer and notices and runs it offline in an unprivileged manifest sandbox iframe under restrictive CSP.
- Adds parser/unit and real-Chromium coverage for incomplete streaming, two rapid helpers, identical DOM redraw, end-marker-looking CDATA, size/root/page validation, malformed XML, renderer failure, old-SVG retention, and zero backend/composer side effects.
- Bumps the extension to `0.10.0` and helper protocol to `3`; restart the foreground shell server after updating.

## [0.9.11] - 2026-08-14

- Redefines the shell command timeout as an output-idle timeout: observable output resets the clock, the default increases from 30 seconds to 3 minutes, and existing installations using the old default migrate automatically while custom values remain unchanged.
- Persists an `awaiting-user` run phase and streams idle progress to the originating tab without closing the shell result channel or fabricating a completed result.
- Adds a floating-panel idle alert with `Continue waiting` and `Force terminate`, plus an always-available `Stop helper` action. Continue resets the idle interval; termination is scoped to the current None/Master/Slave role and revalidates the exact tmux owner before signaling its foreground process group.
- Preserves idle state through runtime-channel loss, page refresh, and shell-server recovery using the server ledger and persistent tmux owner metadata.
- Bumps the server protocol to 9 and adds private-tmux plus real Chromium coverage for output heartbeat reset, repeated idle alerts, Continue, role isolation, and panel termination.

## [0.9.10] - 2026-08-14

- Persists the active None/Master/Slave profile in extension-owned per-tab session storage, so a page refresh keeps both the floating-panel display and actual shell/board/agent routing on the same tmux workspace even when the page clears its own session storage.
- Routes panel startup checks, health checks, full-chain tests, shell helpers, and board helpers through the active role's `ForAI-<agentId>` session; Role=None continues to use the default `ForAI` session.
- Scopes the floating panel's `Reset tmux` action to the active role's exact session, leaving default and other agent sessions untouched.
- Bumps the server protocol to 8 and adds unit, private-tmux integration, and real Chromium refresh/reset coverage.

## [0.9.9] - 2026-08-13

- Replaces the legacy 8000-character shell-helper cap with a 1 MiB UTF-8 script-body limit now that helpers execute from temporary script files.
- Keeps interactive board and vision commands on their independent 8000-character single-line limit, and rejects complete WebSocket messages above 2 MiB from the announced frame length before buffering the payload.
- Bounds long command response echoes, server logs, and pending-delivery accounting with previews, hashes, and total-storage limits.
- Bumps the server protocol to 7, exposes the active script/interactive/transport limits in server health, and adds unit plus real Chromium coverage for a 9000-character helper script.

## [0.9.8] - 2026-07-22

- Fixes M365 Copilot results that were written into `Message Copilot` but never sent: the post-write ownership guard now recognizes M365 Lexical's exact newline flattening and caret sentinel, then lets the unchanged v0.8.9 send actuator run.
- Keeps user drafts fail-closed. M365 host normalization is accepted only after the extension has written the delivery, only on the exact M365 composer signature, and only when every non-newline character is unchanged; every pre-existing draft containing characters—including whitespace-only and exact pending text—remains occupied and is never auto-sent.
- Recognizes fresh exact M365 `.fai-UserMessage[role="article"]` submissions, including M365's observed newline flattening only for known structured plugin deliveries with no trimming or other character changes. A cleared composer or auto-send-disabled insertion without a new matching user-message root remains unpresented, produces no receipt/tombstone, and cannot suppress later clean backend recovery.
- Stops inactive generic tool/side-panel textareas from masquerading as a second reply composer and vetoing auto-send, while still failing closed for lower-scored strong reply composers and an actively edited ambiguous textarea.
- Reports a preflight ownership veto as retryable guard readiness instead of falsely claiming that the original actuator finished; only the synchronous `onStarted` boundary consumes the lifecycle's send generation.
- Hardens composer redraw ownership without changing the five pinned send-actuator functions (which are identical in v0.8.6 and v0.8.9): an empty-first framework replacement gets one bounded handoff, unrelated search/panel editors cannot steal composer identity, every visible non-empty competing reply draft vetoes sending, trusted removal waits briefly for delayed submission proof, and actuator generation is recorded after guard preflight without awaiting persistence before the first original actuator call.
- Updates real-browser coverage for empty-first composer redraw plus route change, and loads unpacked extensions on Chrome 137+ through the unsafe-authorized CDP pipe while retaining the legacy Chrome 116-136 startup path.

## [0.9.7] - 2026-07-22

- Restores the five composer send-actuator functions byte-for-byte from v0.8.9, including its button lookup order, delayed heuristic fallback, form/keyboard fallback timing, and submission detection.
- Removes the later persistent click/form/keyboard budget and send-button association filters without reverting durable pending delivery, SPA route recovery, one-write composer ownership, backend deduplication, tmux serialization, refresh recovery, or Ctrl+C completion fixes.
- Keeps the v0.8.9 actuator behind the existing ownership/lifecycle boundary: each invocation retains its original bounded 80-round button/form/keyboard attempts, stale events are blocked if the page or composer changes mid-run, and the persistent delivery queue cannot restart another 80-round loop every two seconds within one page lifecycle.
- Keeps the original 125/150ms timing usable in hidden tabs through a bounded MV3 background delay message, and carries rendered-helper handling only across a route transition with an actual pending delivery so SPA redraw recovery cannot re-execute a file or other non-shell helper.
- Extends the outer ownership guard to detached composer subtrees, continuously proves the guarded node is still the current composer, rejects trusted user mutations during the v0.8.9 confirmation window, aborts the old 80-round loop at its next await boundary after ownership loss, permits one bounded exact-text composer-redraw handoff, and preserves even not-yet-inserted queued results across their route handoff without repeating the backend operation.
- Replaces regressions for the superseded actuator behavior with a full-SHA-256, single-declaration v0.8.9 compatibility lock while retaining route, agent, draft-preservation, backend, intentional-deletion, and real-browser coverage.

## [0.9.6] - 2026-07-17

- Makes the helper retry timer and agent poll loop detect same-tab route-only `pushState`/`replaceState` changes before loading route-scoped pending state, so an exact plugin-owned composer value cannot be stranded merely because the host changed the URL without a DOM mutation.
- Revalidates the fresh current visible composer before every send actuator side effect. A connected but hidden/stale old editor and a localized saved button outside the current composer structure have zero send authority.
- Persists one cumulative five-actuation envelope across helper and agent retries: at most three button clicks, one form submit, and one keyboard submit. Page interruption/reload recovery cannot reset it, and a visible-but-no-op button cannot starve the form/keyboard fallbacks.
- Adds route-only helper/agent migration, hidden connected composer, stale localized binding, and cross-call actuation-budget regressions.

## [0.9.5] - 2026-07-17

- Tightens the v0.9.4 send actuator after team review: an enabled button receives at most one delayed-readiness fallback beyond the first two clicks, and a stale saved selector is never used merely because no heuristic button exists. Strict localized send labels remain supported.
- Restores a real replacement selection before the controlled-contenteditable `beforeinput` fallback so editor frameworks can observe the intended full replacement rather than only a later DOM mutation.
- Carries submitted/presented-but-unacknowledged delivery entries and local presentation tombstones across same-tab SPA route changes, and removes the old storage key only after the new snapshot is confirmed written.
- Adds direct backend-failure, rejected-output, and presentation-receipt send-only regressions. The real Chromium redraw test now changes the SPA URL during the plugin input event and proves the full result still submits exactly once through the production actuator.

## [0.9.4] - 2026-07-17

- Preserves exact plugin-owned send-only delivery across same-tab SPA URL changes, fixing results or agent prompts that remained visibly stuck in the composer after ChatGPT moved a new conversation to its canonical route. Backend execution and composer insertion remain single-shot; different user text cancels without a send.
- Routes backend failures and rejected-helper feedback through the same durable local delivery queue so every extension-owned composer write has a send-only fallback.
- Uses the native input/textarea value setter so controlled React editors receive the inserted value, retries an enabled send button beyond the first two no-op clicks within a bounded deadline, and retains explicit localized/custom Send bindings when no current-page heuristic control exists.
- Adds route-transfer, React tracked-input, delayed-button, localized-binding, and exact-text redraw regressions. The Chromium test now models composer replacement with a live submit handler and requires exactly one full submitted user message with an empty current composer.

## [0.9.3] - 2026-07-17

- Extends the durable one-write, send-only retry queue to every successful helper response, fixing file and agent-query results that could remain in the composer forever after the first send calibration failed.
- Keeps the backend operation and composer write single-shot while retrying only exact-text send ownership through button, form, and keyboard fallbacks; empty or different user text still cancels immediately.
- Strengthens real Chromium coverage so the file-result test synchronously replaces the composer during the input event and must observe the result as a submitted user message, not merely text somewhere in the page body.

## [0.9.2] - 2026-07-17

- Fixes a v0.9.1 regression where a page framework replacing the composer DOM node after insertion could leave exact plugin-owned content unsent or incorrectly treat the redraw as user cancellation.
- Reacquires only the current visible composer containing the exact inserted text before helper-output or agent-prompt auto-send. Different user text remains untouched and is never adopted as plugin-owned.
- Adds focused regression coverage for helper and agent composer redraws while retaining the v0.9.1 intentional-deletion cancellation behavior.

## [0.9.1] - 2026-07-17

- Treats removal or replacement of automatically inserted helper output as an explicit user cancellation: the extension never writes that content again, cancels the already-queued composer batch, and leaves the server result unpresented so a genuinely new helper may recover it later.
- Gives inbound agent prompts the same one-write limit. Removing or editing the prompt cancels automatic composer delivery; only the local hub cancellation acknowledgement may retry, and SPA navigation cannot reinsert a prompt whose composer write already began.
- Prevents file, agent-message, roster, task-status, and other non-persistent helper responses from re-executing the same rendered helper merely because composer auto-send was not confirmed. Pre-execution failures remain retryable only when no composer mutation occurred.
- Adds regression coverage for intentional deletion, queued-result cancellation, send-only retry without reinsertion, failed cancellation acknowledgements, and side-effecting non-shell helper responses.

## [0.9.0] - 2026-07-16

- Persists per-pane runner ownership in tmux so a restarted shell server adopts or waits for the existing runner instead of injecting a second command into a busy pane; manually started child processes are held until their foreground process group exits or is interrupted.
- Detects nested `zsh/sh -c` foreground jobs from the pane PID/TTY process tree, fails closed with a retryable result when that readiness metadata cannot be proved, and submits each literal command plus Enter in one tmux client transaction so a server crash cannot leave a half-entered helper launcher. A blocking builtin executed by the root interactive shell itself is not externally distinguishable from its prompt without shell-hook integration, so it must be placed in a script/child shell or run in a dedicated pane.
- Moves authoritative cwd capture and duplicate claims to the actual queue head, after pane-idle and pane-instance revalidation, and keeps direct Terminal vision runs in the same non-preemptive pane queue.
- Persists a non-authoritative queued reservation before a request waits for its pane, binds that reservation to persistent pane ownership before queue-head adjudication, and preserves all nonterminal ledger attempts under count pruning. Read-only status recovery can therefore find queued/running work across a server crash without granting it duplicate authority; actual cwd and the execution fingerprint are attached only at the revalidated queue head, and a late handler failure cannot downgrade an already completed attempt.
- Returns pre-execution Ctrl+C promptly as exit 130 but retryable, while preserving post-execution Ctrl+C as completed history eligible for authoritative server dedup.
- Stores bounded completed shell results in the server ledger and adds a read-only status query so a surviving page can recover from MV3 service-worker/channel loss without sending the command again; a full page reload instead relies on the persistent pane lease plus authoritative backend adjudication and clean result recovery when the helper is rendered again.
- Gives each real execution a canonical `executionId` plus a server presentation receipt: already-presented duplicates stay entirely in the local panel, while a result never presented before refresh is restored as a clean original result without `duplicate`, `skipped`, replay, or reason diagnostics entering the model.
- Extends authoritative pane fingerprints with the current pane shell PID so `tmux respawn-pane` cannot inherit stale duplicate history, fails dedup open when that identity is missing, and makes canonical presentation receipts monotonic for read-only recovery of already-persisted duplicate attempts.
- Persists bounded per-tab pending shell/board replies before composer delivery, retries only that local delivery after composer/send failures or same-page reload, and never resends the same rendered command after a backend response.
- Keeps long WebSocket operations alive with 20-second heartbeats and requires Chrome 116+, whose extension service workers support this lifecycle pattern.
- Isolates helper calls across SPA navigation, reload, and enable/disable lifecycle changes; ignores hidden stale streaming controls and lets an unexpected helper cancel a pending self-test instead of permanently consuming the helper.
- Releases the frontend execution lock as soon as a result is inserted, and makes composer auto-send verify exact text ownership immediately before every click/form/keyboard side effect so overwritten drafts cannot be sent.
- Keeps an assistant helper unconsumed while an agent message owns the composer, recognizes agent prompts that the page/user already submitted so they are acked without reinsertion, and makes page-agent profile changes immediately cancel the old delivery lifecycle.
- Serializes board delivery with the same immutable-pane/persistent-owner mechanism, replaces the mutating prompt probe with a stable read-only check, and retains the lease past a response timeout. Shell-backed board panes add foreground-process-group proof; a generic non-shell TUI exposes only spoofable prompt text, so its prompt-based serialization is best effort and is never duplicate authority.
- Recovers long board results through a kind-scoped read-only status query after runtime loss without resending `run-board`; captured prompt-return results remain replayable but keep an empty execution key and can never suppress a later explicit board command.
- Makes identical agent-message response-loss retries idempotent without redelivering to web or tmux-ai recipients, while payload changes under the same message id remain conflicts; rejected-helper feedback now shares the exact composer FIFO and draft-preservation safeguards.
- Recovers stale pre-dispatch direct-visual leases without executing buffered text, keeps Terminal vision self-test ownership across its OCR phase, ignores late client-socket resets, and bounds total replay payload retained in the persistent ledger.
- Bumps the server protocol to 6 and adds real tmux, server-restart, result-recovery, Ctrl+C, browser-refresh, clean unpresented-result replay, local-only delivered-duplicate, board status recovery, and over-30-second Chromium regressions.

## [0.8.9] - 2026-07-15

- Serializes shell helper runners per resolved tmux pane so a helper submitted after refreshing a page cannot be typed into a pane still occupied by the old page's long-running command.
- Starts each queued helper's shell state timeout only after that helper reaches the front of its pane queue, preventing false `process-state-unknown` timeouts and deletion of scripts that have not started yet.
- Keeps different tmux panes independent, allowing agent panes to execute concurrently while the default `ForAI:host` pane is busy.
- Keys queues by the stable tmux server and pane ids so moving or renumbering a busy pane cannot bypass serialization; Terminal vision self-tests share the same pane queue.
- Revalidates the tmux socket, server instance, and pane id after queue wait, failing safely instead of executing against a replacement pane after tmux reset.
- Adds `queued` and `queuedMs` shell-output diagnostics.
- Adds real tmux and Chromium page-refresh regression coverage for long-running commands followed by new helpers.

## [0.8.8] - 2026-07-15

- Makes tmux shell helpers return immediately when the user interrupts an actually started command with Ctrl+C instead of waiting for the shell state timeout.
- Reports interruption explicitly as `exitCode: 130`, `interrupted: true`, and `interruptSignal: INT`, without mislabeling it as a timeout.
- Treats a command that reached the shell and was then interrupted as executed history eligible for same-pane, same-cwd, same-command server dedup; interruption before actual execution remains retryable.
- Keeps the tmux runner and command in the foreground process group, removing the background-child behavior that could leave the server waiting after Ctrl+C.
- Adds real isolated-tmux regression coverage for bounded Ctrl+C response latency and the subsequent authoritative duplicate verdict, plus ledger and shell-output diagnostics coverage.

## [0.8.7] - 2026-07-15

- Moves authoritative command-duplicate adjudication to the shell server after actual tmux pane resolution, keyed by pane instance, command, and actual cwd.
- Removes content-script semantic-command and prior-shell-output execution blocking; a new helper with identical command text is forwarded even after cancellation or failure.
- Keeps browser request scan-debouncing and audit ledgers non-authoritative, while allowing only completed server executions to return `duplicate: true` and preserving Force run as an explicit bypass.
- Adds regression coverage for failed retries, same-pane duplicates, different agent panes, tmux reset/recreation, board prompt failures, direct visual tmux execution, and frontend identical-command forwarding.
- Uses collision-proof internal server attempt identities so concurrent browser requests cannot overwrite one another's execution state.
- Keeps timed-out or otherwise unconfirmed tmux executions retryable, records the board pane's actual cwd for audit, and disables dedup when tmux pane-instance metadata is incomplete.
- Invalidates frontend request tracking when helper DOM nodes are recycled and recognizes structurally rendered `language-shell-output` blocks even after Markdown fences disappear.
- Disables execution dedup for generic board CLIs because textual prompts can be imitated by command output; board requests fail open instead of risking a false completed verdict.

## [0.8.6] - 2026-07-03

- Adds named board helper markers such as `ai-helper-board-R1-start` / `ai-helper-board-R1-end` so board commands can target `ForAI:board-R1`, `ForAI:board-SAT2`, and other safe `board-<suffix>` windows.
- Keeps existing `ai-helper-board-start` helpers targeting the default `ForAI:board` window, while preserving `AI_CHAT_SHELL_BOARD_TARGET` as the highest-priority override.
- Adds server-side `boardName` validation so WebSocket payloads cannot use named board support to select arbitrary tmux targets.
- Expands parser, background forwarding, tmux helper, and tmux integration coverage for default and named board behavior.
- Updates README, AI instructions, and the feature/test matrix for the named board helper protocol.

## [0.8.5] - 2026-06-25

- Changes ai-helper shell timeout semantics to pid/status-aware waiting: the configured shell state timeout is no longer a command runtime limit, and the server keeps waiting while the tmux runner process is still alive.
- Adds per-run pid and completion-status files for tmux shell runs so missing completion markers can report explicit timeout/process metadata.
- Removes the extension-side WebSocket runtime watchdog for shell `run` messages while keeping watchdogs for shorter non-shell operations.
- Adds shell-output timeout/process-state diagnostics and relabels the popup timeout setting as `State timeout ms`.

## [0.8.4] - 2026-06-24

- Keeps saved agent ids as floating-panel defaults only, so newly opened tabs on the same origin do not automatically consume master/slave messages until the user clicks Save in that tab.
- Persists pending sent-but-unacked agent delivery state, so a refreshed page retries only the local ack instead of inserting or sending the same agent message again.
- Marks missing tmux-ai panes as stale in async roster results and prevents stale tmux-ai agents from being advertised as receivable.
- Adds clearer Agent Check and pending-delivery recovery hints for stale tmux-ai panes and missing send-button bindings.
- Expands Chrome E2E coverage to use real floating-panel slave registration, real master `agent-message` helper delegation, and the real tmux-ai Refresh dropdown path.

## [0.8.3] - 2026-06-24

- Treats browser-tab slaves as ready Agent Check targets, making tmux-ai optional for browser-only master/slave workflows.
- Marks tmux-ai slaves as stale when their registered pane is no longer available.
- Keeps page agents heartbeating while helper calls are running and surfaces repeated polling failures in the floating panel.
- Clarifies floating-panel actions by separating `Server Check` from `Agent Check`.
- Adds Chrome E2E coverage for browser-only Agent Check readiness, roster helpers, task-status helpers, and quoted slave reply templates.

## [0.8.2] - 2026-06-22

- Removes backend duplicate-execution blocking from the extension background worker and local shell server.
- Keeps browser and server ledgers as non-blocking audit records only; repeated completed or running call keys now execute again.
- Ensures old or unexpected `duplicate/skipped` responses no longer silently suppress chat-window `shell-output` replies.
- Keeps only the content script's minimal same-page auto-scan loop guard, with manual Force run still available.

## [0.8.1] - 2026-06-22

- Fixes a Force run race where clicking the button while another helper was active could lose the forced run request after a short retry window.
- Keeps Force run pending until the active helper finishes, then runs the latest visible helper with forced dedup metadata.
- Normalizes background force handling for both `callMeta.force=true` and top-level `force=true` across shell, file, board, and vision messages.
- Marks server-side post-claim execution failures as `failed` instead of leaving stale `running` ledger entries.

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
