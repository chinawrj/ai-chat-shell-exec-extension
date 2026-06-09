# Release Process

1. Ensure the worktree is clean.
2. Run checks:

   ```sh
   ./scripts/test_all.sh
   ```

3. Review the version-specific release notes under `docs/release-notes/vX.Y.Z.md` and run any extra manual validation they list. For visual-control releases this includes:

   ```sh
   ./scripts/build_macos_vision_helper.sh
   ./scripts/run_terminal_vision_self_test.sh
   ```

4. Confirm the feature/test table is current:

   ```sh
   $EDITOR docs/FEATURE_TEST_MATRIX.md
   ```

   The full test runner enforces that every `tests/*.test.js` file appears in the table.

5. Build release assets:

   ```sh
   ./scripts/package_release.sh
   ```

6. For releases that need screenshots, run the e2e test with `AI_SHELL_E2E_SCREENSHOT_DIR`, then include the generated PNGs in the release assets:

   ```sh
   AI_SHELL_E2E_SCREENSHOT_DIR=docs/release-assets/vX.Y.Z node tests/chrome_extension_e2e.test.js
   ```

   Use absolute `https://github.com/.../releases/download/vX.Y.Z/...png` image URLs in release notes, because relative repository paths do not render from GitHub release pages. Keep the README `Latest Screenshots` section pointing at the latest committed screenshot files.

7. Create and push the tag:

   ```sh
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

8. Create the GitHub release with the generated archives, `SHA256SUMS.txt`, and any screenshot PNGs.
