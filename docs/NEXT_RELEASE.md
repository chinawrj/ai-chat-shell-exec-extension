# Next Release Plan

Target version: v0.2.11
Target date: after the next maintenance or compatibility fix.

## Theme

Follow up on real-world helper identity, browser, and platform feedback.

## Goals

1. Compatibility follow-up
   - Track chat products that insert extra prose or formatting around plain text helper blocks.
   - Keep AI-facing instructions neutral and focused on requests served by the human helper.
   - Preserve macOS and Ubuntu e2e coverage for unpacked Chromium-family extension runs.

2. Diagnostics
   - Keep `scripts/doctor.sh` current with release packaging and LaunchAgent behavior.
   - Improve user-facing errors for missing tmux sessions, inactive panes, or browser binding failures.
   - Watch for confusing duplicate-suppression cases around suffixed and unsuffixed helper blocks.

3. Zero-knowledge site hardening
   - Preserve the no site-specific DOM contract.
   - Improve fallback behavior only through browser semantics, user calibration, or generic diagnostics.

4. Release quality gate
   - Static JavaScript checks pass.
   - Shell scripts pass `bash -n`.
   - `scripts/doctor.sh` passes.
   - WebSocket frame tests pass.
   - Chrome extension e2e test passes with a real unpacked extension browser run.
   - At least one real AI chat full-chain test passes.

## Non-Goals

- No site-specific ChatGPT, Claude, or Copilot selectors.
- No JSON helper revival.
- No old `ai-helper-start-shell` alias revival.
- No export of command outputs, command ledgers, cookies, tokens, or page content.
