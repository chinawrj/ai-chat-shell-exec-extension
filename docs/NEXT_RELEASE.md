# Next Release Plan

Target version: v0.5.0
Target date: after the local visual adapter proof.

## Theme

Prove the macOS local visual control loop before moving the same model to Horizon.

See `docs/ROADMAP.md` for the longer v0.5.0 through v0.6.0 plan.

## Goals

1. Local visual surfaces
   - Treat Terminal.app and Ghostty as tmux UI surfaces.
   - Keep direct tmux as the test oracle, but make the visual path depend on screenshot/OCR/input rather than direct pane capture.

2. Completion and output reconstruction
   - Use tmux status/window-name markers to detect command completion.
   - Reconstruct long visible output with pagination and OCR stitching.
   - Use OCR bounding boxes to order terminal rows and avoid naive string concatenation.

3. Safety and scope
   - Keep single-line command execution for the visual path.
   - Preserve explicit helper blocks, duplicate suppression, and protocol checks.
   - Do not introduce Horizon/browser-specific code in this release.

4. Release quality gate
   - `./scripts/test_all.sh` passes.
   - `docs/FEATURE_TEST_MATRIX.md` includes every product feature or invariant and every `tests/*.test.js` case.
   - `scripts/doctor.sh` passes with a foreground server.
   - Release source and extension archives contain the current committed files and validate against `SHA256SUMS.txt`.

## Non-Goals

- No JSON helper revival.
- No old `ai-helper-start-shell` alias revival.
- No Horizon/browser visual adapter implementation in this release.
- No site-specific ChatGPT, Claude, Copilot, or Horizon selectors.
