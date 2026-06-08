# Next Release Plan

Target version: v0.4.0
Target date: after the next protocol compatibility iteration.

## Theme

Stabilize extension/server/helper protocol boundaries before expanding visual-control surfaces.

See `docs/ROADMAP.md` for the longer v0.4.0 through v0.6.0 plan.

## Goals

1. Protocol identity
   - Keep the extension release version separate from the server protocol version.
   - Add a helper protocol version for the plain `ai-helper-*` marker format.
   - Report extension version, server protocol version, helper protocol version, and tmux workspace state from the user-facing health surfaces.

2. Stale server detection
   - Make stale foreground server detection explicit when the extension has been upgraded but the local server is still old.
   - Keep error text actionable: restart the foreground server from the current checkout.
   - Preserve the current origin policy and do not weaken local WebSocket safeguards.

3. Compatibility checks
   - Keep content/background/server startup checks aligned.
   - Keep popup and floating-panel diagnostics clear about protocol mismatches and `ForAI` readiness.
   - Expand tests for version/protocol mismatch cases without adding site-specific DOM coupling.

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
