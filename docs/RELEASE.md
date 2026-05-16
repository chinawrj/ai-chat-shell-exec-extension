# Release Process

1. Ensure the worktree is clean.
2. Run checks:

   ```sh
   node --check extension/src/content.js
   node --check extension/src/background.js
   node --check server/shell_server.js
   bash -n scripts/install_shell_server_agent.sh scripts/uninstall_shell_server_agent.sh scripts/start_shell_server.sh scripts/package_release.sh
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
