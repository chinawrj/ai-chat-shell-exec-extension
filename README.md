# Universal Local Shell Tool

Prototype Chrome extension for explicit local shell tool calls on AI chat pages such as `https://chatgpt.com/` and `https://claude.ai/`.

An AI chat page can request a shell command by returning a fenced code block with the language `shell-call`:

````
```shell-call
pwd && ls -la
```
````

The content script waits until the assistant stops streaming, sends the command through the extension background worker to a local WebSocket shell server, then posts the output back into the chat composer as a `shell-output` block.

## Architecture

Chrome extensions cannot directly execute local shell commands. This project uses:

- `extension/`: Manifest V3 Chrome extension injected on HTTPS pages. The execution trigger is still limited to explicit `shell-call` blocks.
- `server/`: Local WebSocket server bound to `127.0.0.1:17371` that runs `/bin/zsh -lc <command>`.

Flow:

`AI chat page -> content script -> extension background -> ws://127.0.0.1:17371/shell -> local zsh -> shell-output reply`

## Install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked and choose either the project root:

   `/Users/rjwang/Documents/Codex/2026-05-15/https-chatgpt-com-shell-ai-shell`

   or the extension subdirectory:

   `/Users/rjwang/Documents/Codex/2026-05-15/https-chatgpt-com-shell-ai-shell/extension`

4. Confirm the extension ID is:

   `lkmeogidbglhedgekjgbpbfjkpapnhke`

5. Start the local shell server:

   ```sh
   /Users/rjwang/Documents/Codex/2026-05-15/https-chatgpt-com-shell-ai-shell/scripts/start_shell_server.sh
   ```

6. Reload the extension and reload the AI chat page.

After every extension code change, click Reload on the unpacked extension in `chrome://extensions`, then refresh each AI chat tab. Otherwise Chrome will keep running the old content script.

The toolbar popup shows whether the local server is reachable and lets you change:

- enabled/paused
- auto-send shell results
- per-command browser confirmation
- timeout, output cap, and automatic chain limit

On a new chat site, click the chat input once. The content script remembers the composer selector for that origin and uses it for later `shell-output` replies.

## Tool Call Format

Plain command:

````
```shell-call
uname -a
```
````

JSON command:

````
```shell-call
{
  "cmd": "git status --short",
  "cwd": "~/work/project",
  "timeoutMs": 30000,
  "maxOutputChars": 20000
}
```
````

Accepted tool language tags are `shell-call`, `shell_call`, `tool:shell`, `tool-shell`, and `local-shell`.

Some AI chat systems normalize unknown code block languages into ordinary `shell`, `bash`, `sh`, or `zsh` blocks. For those sites, the extension also accepts shell-like code blocks when the latest human prompt explicitly mentions one of the tool language tags above. This keeps ordinary shell examples from running while still supporting black-box chat systems that rewrite the rendered language label.

## Safety Defaults

- The extension runs explicit tool blocks. Ordinary `bash`, `sh`, `zsh`, and `shell` blocks are accepted only when the latest human prompt explicitly asked for one of the tool language tags and the block is part of that response.
- Browser confirmation is off by default for hands-free operation. Set `requireApproval` to `true` in extension storage if you want a prompt before each command.
- The extension and server reject obvious copied `shell-output` text, terminal prompts such as `$ ...`, and markdown wrappers before execution.
- Automatic chained shell calls are capped by `maxChainCalls` in extension storage. New human prompts reset the chain count; tool result replies do not.
- The WebSocket server only accepts Chrome extension requests by default. Set `CHATGPT_SHELL_ALLOW_UNTRUSTED_ORIGINS=1` only for local development tests.
- The shell server clamps timeout to 1 second through 10 minutes.
- Commands longer than 8000 characters are rejected before execution.
- Output is capped to avoid flooding the page.
- Repeated shell-call output loops are suppressed when the assistant repeats the same command after receiving a shell-output reply.
- A small status badge appears in the lower-right corner while the content script is active.

This is intentionally a local prototype. Treat it as remote code execution on your machine: only approve commands you understand.

## Development Loop

After changing extension files:

1. Reload the unpacked extension in `chrome://extensions`.
2. Refresh every AI chat tab you want to use.
3. Confirm the lower-right status badge shows the latest content script version.

After changing server files:

1. Stop the old shell server.
2. Start it again:

   ```sh
   /Users/rjwang/Documents/Codex/2026-05-15/https-chatgpt-com-shell-ai-shell/scripts/start_shell_server.sh
   ```

Health check:

```sh
curl http://127.0.0.1:17371/health
```

## Legacy Native Host

The earlier Native Messaging prototype is still in `native-host/`, but the current extension path uses the WebSocket server instead.

To uninstall the old Native Messaging manifest:

```sh
/Users/rjwang/Documents/Codex/2026-05-15/https-chatgpt-com-shell-ai-shell/native-host/uninstall_native_host.sh
```
