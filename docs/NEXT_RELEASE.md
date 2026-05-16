# Next Release Target: v0.2.0

Target date: after the next full ChatGPT and Claude regression pass.

## Theme

Make the extension easier to install, diagnose, and carry across unknown AI chat sites.

## Goals

1. Installation diagnostics
   - Keep `scripts/doctor.sh` as the first-line support command.
   - Surface extension/server origin mismatches in the popup and floating panel.

2. Portable calibration
   - Let users export settings and per-origin bindings from the popup.
   - Let users import those settings on another Chrome profile or machine.
   - Do not export shell call ledgers or command history.

3. Zero-knowledge site hardening
   - Preserve the no site-specific DOM contract.
   - Improve fallback behavior only through browser semantics, user calibration, or generic diagnostics.

4. Release quality gate
   - Static JavaScript checks pass.
   - Shell scripts pass `bash -n`.
   - `scripts/doctor.sh` passes.
   - WebSocket frame tests pass.
   - ChatGPT full-chain test passes.
   - Claude full-chain test passes.

## Non-Goals

- No site-specific ChatGPT, Claude, or Copilot selectors.
- No broad automatic execution of ordinary shell examples.
- No export of command outputs, command ledgers, cookies, tokens, or page content.
