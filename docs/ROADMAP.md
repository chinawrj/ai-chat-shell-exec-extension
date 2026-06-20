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
