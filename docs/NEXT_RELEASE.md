# Next Release Plan

Target version: v0.3.1
Target date: after the next maintenance or compatibility fix.

## Theme

Follow up on real-world board helper, browser, and platform feedback.

## Goals

1. Compatibility follow-up
   - Track chat products that insert extra prose or formatting around plain text helper blocks.
   - Keep AI-facing instructions neutral and focused on requests served by the human helper.
   - Preserve macOS and Ubuntu e2e coverage for unpacked Chromium-family extension runs.

2. Diagnostics
   - Keep `scripts/doctor.sh` current with release packaging and LaunchAgent behavior.
   - Improve user-facing errors for missing tmux sessions, inactive panes, or browser binding failures.
   - Watch for confusing duplicate-suppression cases around suffixed and unsuffixed helper blocks.
   - Improve diagnostics for board prompt probe failures and active `tmux pipe-pane` conflicts.

3. Zero-knowledge site hardening
   - Preserve the no site-specific DOM contract.
   - Improve fallback behavior only through browser semantics, user calibration, or generic diagnostics.

4. Release quality gate
   - `./scripts/test_all.sh` passes.
   - `docs/FEATURE_TEST_MATRIX.md` includes every product feature or invariant and every `tests/*.test.js` case.
   - `scripts/doctor.sh` passes.
   - At least one real AI chat full-chain test passes.

## Non-Goals

- No site-specific ChatGPT, Claude, or Copilot selectors.
- No JSON helper revival.
- No old `ai-helper-start-shell` alias revival.
- No export of command outputs, command ledgers, cookies, tokens, or page content.
