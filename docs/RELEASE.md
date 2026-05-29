# Release Process

1. Ensure the worktree is clean.
2. Run checks:

   ```sh
   node --check extension/src/content.js
   node --check extension/src/background.js
   node --check extension/src/popup.js
   node --check server/shell_server.js
   node --check scripts/start_tmux_test_page_https.js
   node tests/chrome_extension_e2e.test.js
   node tests/background_settings_migration.test.js
   node tests/content_force_run.test.js
   node tests/content_shell_output_format.test.js
   node tests/manifest_consistency.test.js
   node tests/default_enabled_hosts.test.js
   node tests/tmux_helpers.test.js
   node tests/server_websocket_frames.test.js
   node tests/popup_config.test.js
   bash -n scripts/install_shell_server_agent.sh scripts/uninstall_shell_server_agent.sh scripts/start_shell_server.sh scripts/package_release.sh scripts/open_tmux_test_chrome.sh
   git diff --check
   ```

3. Build release assets:

   ```sh
   ./scripts/package_release.sh
   ```

4. For releases that need screenshots, run the e2e test with `AI_SHELL_E2E_SCREENSHOT_DIR`, then include the generated PNGs in the release assets:

   ```sh
   AI_SHELL_E2E_SCREENSHOT_DIR=docs/release-assets/vX.Y.Z node tests/chrome_extension_e2e.test.js
   ```

5. Create and push the tag:

   ```sh
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

6. Create the GitHub release with the generated archives, `SHA256SUMS.txt`, and any screenshot PNGs.
