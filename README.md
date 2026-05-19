# AI Chat Shell Exec

Chrome extension for explicit local command execution from AI chat pages such as `https://chatgpt.com/` and `https://claude.ai/`, routed through a selected tmux pane.

This is local remote-code execution for AI chat. Install it only on machines you control, and only use it with conversations and models you trust enough to request local shell commands.

An AI chat page can request a command by returning a fenced code block with the language `shell-call`. Each request must specify a tmux target:

````
```shell-call
{"target":"%24","cmd":"pwd && ls -la"}
```
````

The content script waits until the assistant stops streaming, sends the command through the extension background worker to a local WebSocket server, the server sends it into the selected tmux pane, then the content script posts the captured pane output back into the chat composer as a `shell-output` block.

## Architecture

Chrome extensions cannot directly execute local shell commands. This project uses:

- `extension/`: Manifest V3 Chrome extension injected on HTTPS pages. The execution trigger is still limited to explicit `shell-call` blocks.
- `server/`: Local WebSocket server bound to `127.0.0.1:17371` that lists tmux panes, sends commands into a selected pane, and captures output between completion markers.

Flow:

`AI chat page -> content script -> extension background -> ws://127.0.0.1:17371/shell -> tmux pane -> shell-output reply`

## Install

Prerequisites:

- macOS
- Chrome or another Chromium browser with unpacked extensions enabled
- Node.js available on `PATH`
- tmux available on `PATH`

Download the latest release from:

`https://github.com/chinawrj/ai-chat-shell-exec-extension/releases`

If you use the release source archive, unzip it and run the commands below from the extracted project directory. If you clone the repository, use the repository root.

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked and choose either the project root or the `extension/` subdirectory.

4. Confirm the extension ID is:

   `lkmeogidbglhedgekjgbpbfjkpapnhke`

5. Install and start the local shell server LaunchAgent:

   ```sh
   ./scripts/install_shell_server_agent.sh
   ```

   This creates `~/Library/LaunchAgents/com.local.ai-chat-shell-exec-server.plist`, starts the server now, and keeps it running after login. Logs are written under `.state/`. The installer also sets `AI_CHAT_SHELL_TMUX_SOCKET` to the default user tmux socket; override it before running the installer if you use a named tmux socket.

   For a temporary foreground server during development, use:

   ```sh
   ./scripts/start_shell_server.sh
   ```

6. Reload the extension and reload the AI chat page.

After every extension code change, click Reload on the unpacked extension in `chrome://extensions`, then refresh each AI chat tab. Otherwise Chrome will keep running the old content script.

## Configure AI Instructions

For stable tool use, add shell tool instructions to the AI chat system you use. Put them in the chat system's custom instructions, project instructions, agent instructions, or the first message of a conversation.

Start with:

`docs/AI_INSTRUCTIONS.md`

The short version is:

```text
When local terminal output would help, reply with exactly one fenced code block using the language shell-call and no prose. Put only a JSON object inside with target and cmd, for example {"target":"%24","cmd":"pwd"}. After I send back shell-output, use that output to continue. Do not repeat the same command after receiving shell-output.
```

Then run the floating panel's `Test` button once on each AI chat site.

The toolbar popup shows whether the local server is reachable and lets you change:

- enabled/paused
- auto-enabled sites
- available tmux targets to copy into `shell-call` JSON
- auto-send shell results
- per-command browser confirmation
- timeout, output cap, and automatic chain limit
- export/import settings and per-origin calibration bindings

On an enabled chat site, click the chat input once. The content script remembers the composer selector for that origin and uses it for later `shell-output` replies.

By default, shell scanning is auto-enabled only on `m365.cloud.microsoft`. On every other site, the extension does not inject page UI, scan content, or bind page events until you add the hostname in the toolbar popup.

The floating status panel also has calibration controls for unknown chat systems:

- `Test`: insert and send a full-chain self-test prompt. The prompt asks the AI to return a one-line `shell-call`; the extension only treats the test as passed when the executed command and `stdout` contain that test's token. Unexpected self-test shell calls are ignored instead of being run.
- `Check`: verify local shell server health and show whether input/send/shell bindings exist for the current origin.
- `Bind input`: click it, then click the page's chat input.
- `Bind send`: click it, then click the page's send control.
- `Bind shell`: click it, then click a rendered shell-call/code block area.
- `Clear`: remove the saved bindings for the current origin.

Drag the panel title to move the floating window. You can also click a bind mode and drag the relevant page element onto the panel when the page supports dragging. Bindings and panel position are stored per origin, so a calibration for one site does not affect another.

Use the popup's portable config area to move settings and bindings to another Chrome profile or machine. It exports only extension settings and calibration selectors; it does not export shell command ledgers or page content.

## Tool Call Format

Plain command blocks are rejected because the server no longer chooses a shell by itself. Use JSON with a `target` and `cmd`:

````
```shell-call
{"target":"%24","cmd":"uname -a"}
```
````

`target` can be a tmux pane id such as `%24`, a `session:window.pane` address such as `espcam:0.0`, or a unique window name such as `build`.

When the extension returns a target list, each line is formatted for the AI to read, for example `target=%24 address=espcam:0.0 window=build command=zsh cwd=/path active=true`. Choose the `target=` value that matches the desired `window=...`.

Keep AI requests minimal by default:

````
```shell-call
{"target":"%24","cmd":"git status --short"}
```
````

If the desired window name is unique, this also works:

````
```shell-call
{"target":"build","cmd":"git status --short"}
```
````

Optional fields such as `cwd`, `timeoutMs`, and `maxOutputChars` are supported, but should be added only when needed.

Accepted tool language tags are `shell-call`, `shell_call`, `tool:shell`, `tool-shell`, and `local-shell`.

Some AI chat systems normalize unknown code block languages into ordinary `shell`, `bash`, `sh`, or `zsh` blocks. For those sites, the extension also accepts shell-like code blocks when either:

- the first line inside the block is a tool marker such as `# local-shell` or `# local-shell: {"target":"%24","cmd":"git status --short"}`; or
- the latest human prompt explicitly mentions one of the tool language tags above.

The marker form keeps standard shell syntax highlighting while preserving an explicit tool boundary:

````text
```shell
# local-shell
{"target":"%24","cmd":"git status --short"}
```
````

For chat systems that are unreliable with multi-line code blocks, use the single-line marker form:

````text
```shell
# local-shell: {"target":"%24","cmd":"git status --short"}
```
````

## Zero-Knowledge Site Strategy

The extension does not hard-code a ChatGPT, Claude, or Copilot DOM contract. The default strategy is:

- detect editable chat inputs from standard browser semantics such as `textarea`, `input`, `contenteditable`, and `role="textbox"`;
- detect tool requests from explicit tool-language code blocks or shell-like blocks with a `# local-shell` marker;
- post results by writing into the remembered editable input;
- submit first through generic form submission and synthetic Enter key events;
- fall back to a saved user-bound send control, then broad send-button heuristics if needed.

For sites with unusual editors or send controls, use the floating panel to bind the input, send control, or shell-call display area.

## Safety Defaults

- The extension runs explicit tool blocks. Ordinary `bash`, `sh`, `zsh`, and `shell` blocks are accepted only when the block contains a `# local-shell` marker or the latest human prompt explicitly asked for one of the tool language tags.
- Every command must name a tmux target. Missing or unknown targets are rejected and the reply lists available panes.
- The default auto-enabled host list contains only `m365.cloud.microsoft`; every other site requires an explicit per-site opt-in before scanning can run.
- Browser confirmation is off by default for hands-free operation. Set `requireApproval` to `true` in extension storage if you want a prompt before each command.
- The extension and server reject obvious copied `shell-output` text, terminal prompts such as `$ ...`, and markdown wrappers before execution.
- Automatic chained shell calls are capped by `maxChainCalls` in extension storage. New human prompts reset the chain count; tool result replies do not.
- Duplicate execution is blocked before the command reaches the local server. The content script generates a stable call key from the site, latest human intent, tmux target, command, cwd, timeout, and output cap; the background worker claims that key with an internal sequence number. The local server keeps a second persistent ledger in `.state/shell-ledger.json`, so refreshing a chat page or reloading the extension does not rerun an already completed call.
- The WebSocket server only accepts Chrome extension requests by default. Set `AI_CHAT_SHELL_ALLOW_UNTRUSTED_ORIGINS=1` only for local development tests.
- The local server clamps timeout to 1 second through 10 minutes. When a tmux command times out, the server stops waiting and reports that the command may still be running in the pane.
- Commands longer than 8000 characters are rejected before execution.
- Output is capped to avoid flooding the page.
- Repeated shell-call output loops are suppressed when the assistant repeats the same command after receiving a shell-output reply.
- A small status badge appears in the lower-right corner while the content script is active.

Treat shell calls as remote code execution on your machine. Review the security notes in `SECURITY.md` before sharing this with other users.

## Development Loop

After changing extension files:

1. Reload the unpacked extension in `chrome://extensions`.
2. Refresh every AI chat tab you want to use.
3. Confirm the lower-right status badge shows the latest content script version.

After changing server files with the LaunchAgent installed:

```sh
./scripts/install_shell_server_agent.sh
```

For foreground development:

1. Stop the old shell server.
2. Start it again:

   ```sh
   ./scripts/start_shell_server.sh
   ```

Health check:

```sh
curl http://127.0.0.1:17371/health
```

Manual tmux test page:

```sh
node scripts/start_tmux_test_page_https.js
```

Open `https://localhost:17443/tmux-test-page.html`, accept the local certificate warning, reload the unpacked extension, copy a tmux target from the popup, click the page composer once, then insert a targeted `shell-call`. This local test port is auto-enabled by the development content script.

To launch an isolated Chromium-family test profile with this unpacked extension already loaded:

```sh
./scripts/open_tmux_test_chrome.sh
```

The helper prefers Chrome for Testing, Chromium, then Microsoft Edge before Google Chrome. Recent Google Chrome builds can ignore `--load-extension` for local unpacked extensions; in that case load `extension/` manually from `chrome://extensions` or set `AI_SHELL_TEST_BROWSER_APP`.

Installation diagnostics:

```sh
./scripts/doctor.sh
```

Local checks:

```sh
node --check extension/src/content.js
node --check extension/src/background.js
node --check extension/src/popup.js
node --check server/shell_server.js
node --check scripts/start_tmux_test_page_https.js
node tests/manifest_consistency.test.js
node tests/tmux_helpers.test.js
node tests/server_websocket_frames.test.js
node tests/popup_config.test.js
bash -n scripts/*.sh
```

Uninstall the LaunchAgent:

```sh
./scripts/uninstall_shell_server_agent.sh
```

Build release archives:

```sh
./scripts/package_release.sh
```

## License

MIT
