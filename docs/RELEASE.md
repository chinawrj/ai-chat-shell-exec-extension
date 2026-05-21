# Release Process

1. Ensure the worktree is clean.
2. Run checks:

   ```sh
   node --check extension/src/content.js
   node --check extension/src/background.js
   node --check extension/src/popup.js
   node --check server/shell_server.js
   node --check scripts/start_tmux_test_page_https.js
   node tests/background_settings_migration.test.js
   node tests/content_force_run.test.js
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

4. Create and push the tag:

   ```sh
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

5. Create the GitHub release with the generated archives and `SHA256SUMS.txt`.
