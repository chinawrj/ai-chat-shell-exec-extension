# Next Release Plan

Target version: v0.11.x maintenance after the v0.11.0 local Skills catalog release, unless a user explicitly asks for Horizon work.
Target date: as needed for reliability, compatibility, or security fixes.

## Theme

Keep the default direct tmux workflow simple and reliable while maintaining the local-only Draw.io artifact preview and safe high-level Skills catalog service. Do not start the Horizon visual adapter unless a user directly asks for it.

See `docs/ROADMAP.md` for the longer visual-control plan.

## Goals

1. Direct tmux reliability
   - Keep no-target shell helpers running through `ForAI:host`.
   - Keep startup, `Server Check`, doctor diagnostics, and reset behavior clear for non-vision users.
   - Preserve concise popup/floating-panel status when vision is unused.

2. Local visual adapter maintenance
   - Keep Terminal.app/Ghostty support working without changing the AI-facing helper block format.
   - Fix OCR/input regressions only when they affect the existing local visual adapter.
   - Avoid expanding visual scope by default.

3. Safety and compatibility
   - Preserve explicit helper blocks, duplicate suppression, and protocol checks.
   - Keep release version, server protocol, and helper protocol compatibility checks aligned.
   - Keep docs and tests aligned with the current no-target shell helper protocol.
   - Keep Draw.io XML non-executable, offline, sandboxed, and isolated from composer delivery.
   - Preserve the last successful SVG across streaming, malformed XML, and renderer failures without flicker.

4. Release quality gate
   - `./scripts/test_all.sh` passes.
   - `docs/FEATURE_TEST_MATRIX.md` includes every product feature or invariant and every `tests/*.test.js` case.
   - `scripts/doctor.sh` passes with a foreground server.
   - Release source and extension archives contain the current committed files and validate against `SHA256SUMS.txt`.

5. Local Skills catalog
   - Keep catalog discovery, hashing, versioning, loading, and environment substitution inside bounded server APIs with no tmux or shell execution.
   - Keep synchronization origin-scoped, latest-only, and bound to the fixed memory entry plus full catalog SHA.
   - Keep runtime synchronization self-explaining without embedding complete Skill helper marker strings in prompts.

## Non-Goals

- No Horizon visual adapter work unless a user explicitly asks for it.
- No JSON helper revival.
- No old `ai-helper-start-shell` alias revival.
- No privileged Horizon protocol integration.
- No direct remote shell API assumption.

## Parked Backlog

Horizon visual adapter work is intentionally parked for a long period. If a user explicitly asks to resume it, restart from the parked Horizon section in `docs/ROADMAP.md` and first produce a fresh plan before implementation.
