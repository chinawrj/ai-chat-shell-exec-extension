# Next Release Plan

Target version: v0.6.0
Target date: after the Horizon visual adapter proof.

## Theme

Reuse the local visual tmux adapter model against VMware Horizon Web Access.

See `docs/ROADMAP.md` for the longer visual-control plan.

## Goals

1. Horizon visual surface
   - Treat Horizon as a browser-hosted visual surface, not as a shell API.
   - Reuse the same single-line tmux command model, completion marker, and OCR pagination strategy from the local adapter.
   - Keep any browser control generic; avoid site-specific Horizon DOM coupling unless calibration proves generic input is insufficient.

2. Remote tmux assumptions
   - Assume the remote Ubuntu desktop already displays a tmux session.
   - Detect completion through tmux status/window-name markers visible inside the remote desktop.
   - Reconstruct output from visible OCR pages rather than direct tmux capture.

3. Safety and diagnostics
   - Preserve explicit helper blocks, duplicate suppression, and protocol checks.
   - Keep local Terminal/Ghostty support working while adding Horizon.
   - Add diagnostics that clearly distinguish local visual, Horizon visual, and direct tmux paths.

4. Release quality gate
   - `./scripts/test_all.sh` passes.
   - `docs/FEATURE_TEST_MATRIX.md` includes every product feature or invariant and every `tests/*.test.js` case.
   - `scripts/doctor.sh` passes with a foreground server.
   - Release source and extension archives contain the current committed files and validate against `SHA256SUMS.txt`.

## Non-Goals

- No JSON helper revival.
- No old `ai-helper-start-shell` alias revival.
- No privileged Horizon protocol integration.
- No direct remote shell API assumption.
