# Next Release Target: v0.2.6

Target date: after the next maintenance or compatibility fix.

## Theme

Polish the tmux-backed release based on real user feedback.

## Goals

1. Compatibility follow-up
   - Track chat products that downgrade or reformat `shell-call` code fences.
   - Keep AI-facing instructions neutral and focused on terminal output requests.

2. Diagnostics
   - Keep `scripts/doctor.sh` current with release packaging and LaunchAgent behavior.
   - Improve user-facing errors for missing tmux sessions or inactive panes.

3. Zero-knowledge site hardening
   - Preserve the no site-specific DOM contract.
   - Improve fallback behavior only through browser semantics, user calibration, or generic diagnostics.

4. Release quality gate
   - Static JavaScript checks pass.
   - Shell scripts pass `bash -n`.
   - `scripts/doctor.sh` passes.
   - WebSocket frame tests pass.
   - At least one real AI chat full-chain test passes.

## Non-Goals

- No site-specific ChatGPT, Claude, or Copilot selectors.
- No broad automatic execution of ordinary shell examples.
- No export of command outputs, command ledgers, cookies, tokens, or page content.
