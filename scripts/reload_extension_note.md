# Reload Workflow

After changing extension files:

1. Click Reload on the unpacked extension in `chrome://extensions`.
2. Refresh every open AI chat tab that should use the new content script, such as `https://chatgpt.com/` and `https://claude.ai/`.
3. Keep `server/shell_server.js` running before testing `shell-call`.
4. Confirm the lower-right badge shows the latest content script version.
