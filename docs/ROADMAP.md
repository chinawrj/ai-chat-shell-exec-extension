# Product Roadmap

This document records the working product memory for planned iterations. It is intentionally pragmatic: keep the default tmux workflow reliable first, then extend the same control model to visual surfaces such as local Terminal/Ghostty and VMware Horizon.

## Direction

The long-term target is a single helper protocol that can run commands through different execution surfaces:

- Direct tmux: local server sends commands to tmux and captures tmux buffers directly.
- Visual tmux: a macOS UI window displays a tmux session, while OCR and input control operate the visible terminal.
- Horizon tmux: a browser-hosted VMware Horizon session displays a remote Ubuntu tmux session, while the extension controls input and reconstructs output visually.

Current planning stance: direct tmux remains the primary product path, and local Terminal/Ghostty visual tmux remains an experimental adapter. Horizon tmux is parked and should not be implemented or planned as the next release unless a user explicitly asks to resume Horizon work.

The AI-facing helper format should stay simple. Prefer no-target shell helpers by default:

````
ai-helper-shell-start
git status --short
ai-helper-shell-end
````

Shell helpers do not encode tmux targets; `ForAI:host` is the single default shell surface.

## Release Plan

### v0.3.4: Stabilize `ForAI`

Goal: make the default `ForAI` workspace feel like a dependable product entry point.

- Add a reset flow for the default tmux workspace, such as `tmux-reset-forai`.
- Add a doctor check for server, tmux, `ForAI`, `host`, `board`, Chrome extension ID, and version/protocol compatibility.
- Improve floating-panel startup and `Check` status so it clearly reports `ForAI:host` and `ForAI:board` readiness.
- Expand Chrome e2e coverage so the main shell path uses a no-target helper block and proves default execution in `ForAI:host`.
- Default cwd policy: new `ForAI` windows start in the project root, with `AI_CHAT_SHELL_FORAI_CWD` available for an explicit workspace override.

### v0.4.0: Stabilize Protocol Boundaries

Goal: make extension/server/helper compatibility explicit.

- Add a protocol version independent from the extension release version.
- Have content/background/server checks report extension version, server protocol version, helper protocol version, and tmux workspace state.
- Make stale foreground server detection user-facing when the extension has been upgraded but the local server is still old.
- Keep JSON helper revival out of scope; plain `ai-helper-*` marker blocks remain the protocol.

### v0.5.0: Local Visual Adapter

Goal: prove the full visual control loop on macOS before involving Horizon.

- Treat Terminal.app and Ghostty as local visual surfaces that display a tmux session.
- Use macOS screenshot/OCR coordinates plus Accessibility/CGEvent input to run a single command.
- Use tmux status/window-name markers to detect command completion, rather than relying on OCR to infer shell state.
- Reconstruct long output from the visible tmux UI with pagination and OCR stitching.
- Keep direct tmux as the oracle/test adapter where possible, but do not require direct tmux access for the production visual path.

### v0.6.0: Local Multi-Agent Tabs

Goal: let users simulate a small local agent team with multiple chat tabs before adding any remote orchestration layer.

- Let enabled pages register as `master` or `slave` agents from the floating panel.
- Route agent task messages through the local WebSocket server with an in-memory roster and mailbox.
- Deliver incoming messages into the recipient tab's composer and acknowledge after the page sends them.
- Keep each registered agent tab's shell helpers isolated in a per-agent `ForAI-<agentId>:host` tmux workspace.
- Preserve the existing direct tmux workflow for non-agent pages.

### Shipped in v0.10.0: Inline Draw.io File Helper

Goal: let an AI place the complete contents of a native `.drawio` file in a helper block so the extension can render it as a user-facing SVG/image in a floating preview. This helper contains data, not a shell command.

````
ai-helper-drawio-start
<mxfile>...</mxfile>
ai-helper-drawio-end
````

The exact XML between the marker lines is the artifact. Preserve it byte-for-byte apart from normalising the chat renderer's line endings when necessary; do not trim, command-normalise, interpret a target/cwd line, or treat any XML line as shell text. An optional diagnostic identity suffix may follow the same safe suffix grammar as shell/file helpers, while an unsuffixed block derives its stable artifact identity from the complete payload hash.

Draw.io helpers are a separate, non-executable path:

- `ai-helper-shell-start` continues to send command text through background/server/tmux and the server remains the execution-duplicate authority.
- `ai-helper-drawio-start` is parsed and validated by the extension and must never be forwarded to tmux, the shell server, a board, or the chat composer.
- Rendering is a local, idempotent UI effect. It does not use canonical shell `executionId`, Force run, command ledgers, `shell-output`, result-presentation receipts, or the persistent composer-delivery queue.
- Across all visible candidates, only the last complete helper whose entire payload parses as valid draw.io XML is eligible to display. A newer incomplete or invalid helper never clears, hides, or replaces the current diagram. Scan-debounce the exact rendered helper/root and complete payload hash so streaming, DOM mutation, and a framework redraw of identical content cannot reopen or remount it. A Reopen control may deliberately show the already-rendered payload again without rescanning or contacting a backend.

The extension owns presentation. After the complete end marker is present and the message has settled, validate a bounded UTF-8 XML payload rooted at `<mxfile>` (and decide explicitly whether raw `<mxGraphModel>` is supported). Send the XML as data to a pinned, packaged draw.io viewer inside an isolated extension iframe. Render a changed candidate in a hidden, nonzero-size staging surface while the old SVG remains visible; attach a scan-generation token, discard any staging result that becomes stale, and atomically replace the visible diagram only after the still-latest candidate has produced a ready SVG. Never blank the preview between versions. The viewer renders vector graphics for the user; the content script supplies only the movable/resizable frame and Close, Reopen, Fit/Zoom, page/layer, and Download `.drawio` controls.

Do not use `innerHTML` for XML or inline untrusted SVG in the chat page. Keep rendered SVG inside the isolated viewer, or cross an image/blob boundary before displaying it. The sandboxed viewer must have no extension privileges, remote script execution, popups, top navigation, or unrestricted external image/font/link fetching. If `https://embed.diagrams.net` is ever offered, make it an explicit online mode because it sends the diagram outside the local page.

The diagram is for the user, not the AI. Do not insert XML, SVG, PNG, or automatic render output into the composer. A separate opt-in `Confirm to AI` action may send a short text-only acknowledgement after the user inspects the diagram, but diagram visibility and local reopen state must not depend on composer delivery.

The v0.10.0 implementation fixes these decisions:

- helper protocol `3`, a 1 MiB UTF-8 limit, strict `<mxfile>` plus `<diagram>` validation, optional identity suffixes, and an end-marker collision guard for XML CDATA/comments;
- packaged draw.io viewer `v31.1.5` with recorded SHA-256 and Apache-2.0 license, isolated by the manifest sandbox/CSP with no runtime renderer CDN;
- an in-memory per-page preview lifecycle with Close/Reopen and `.drawio` download; route/reload clears the artifact instead of persisting potentially sensitive diagram data;
- bounded invalid/render error logs in both the preview and browser console, while preserving the last successful SVG;
- parser/unit tests plus real-Chromium coverage for incomplete streaming, rapid helpers, identical DOM redraw, malformed XML, renderer failure, latest-outcome replacement, bounded one-time error delivery, success silence, viewport maximize/restore, and shell-backend isolation.

### Parked: Horizon Visual Adapter

Goal: reuse the local visual adapter model against VMware Horizon Web Access.

Status: deferred for a long period. Do not begin this work by default. Resume only when a user explicitly asks for Horizon/VMware Web Access support, and start by writing a fresh implementation plan.

- Assume the remote Ubuntu desktop always has tmux running.
- Treat Horizon as a browser visual surface, not as a shell API.
- Send input to the Horizon surface and reconstruct output from the tmux UI visible inside the remote desktop.
- Reuse tmux status/window-name markers for completion and pagination.
- Avoid site-specific Horizon DOM coupling unless generic browser semantics and user calibration are insufficient.

## Product Constraints

- This is security-sensitive local/remote command execution; preserve explicit helper blocks, duplicate suppression, and command/output rejection safeguards.
- Keep AI instructions short and human-helper framed.
- Prefer `ForAI:host` as the default shell target and `ForAI:board` as the default board target.
- Do not require the model to choose tmux panes for shell helpers.
- Keep test coverage proportional to risk: direct tmux and e2e coverage for default execution, visual adapter coverage for OCR/input reconstruction.
