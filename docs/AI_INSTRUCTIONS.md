# AI Instructions

AI Chat Shell Exec works best when the AI chat system is told how to request terminal command output. Add one of these templates to the system's custom instructions, project instructions, agent instructions, or the first message in a conversation.

After adding instructions, use the floating panel's `Test` button once on that site.

## Where To Put Them

Use whichever persistent instruction surface your AI chat system provides:

- ChatGPT: custom instructions, project instructions, GPT instructions, or the first message in a chat.
- Claude: profile instructions, project instructions, custom style instructions, or the first message in a chat.
- Copilot-style systems: agent instructions, system prompt, project instructions, or the first message in a chat.
- Unknown systems: paste the one-off prompt at the start of the conversation.

The instruction only needs to make the AI emit a targeted `shell-call` block.

## Minimal

Use this when you want the smallest possible instruction:

```text
When local terminal output would help, reply with exactly one fenced code block using the language shell-call and no prose.

Put only a JSON object inside the code block. It must include target and cmd, for example {"target":"%24","cmd":"pwd"}.

After I send back shell-output, use that output to continue.

Do not repeat the same command after receiving shell-output.
```

## Recommended

Use this as the default template for ChatGPT, Claude, and similar AI chat systems:

````text
When local terminal output would help, request one command by replying with exactly one fenced code block and no prose:

```shell-call
{"target":"%24","cmd":"command here"}
```

Rules:
- Put only a JSON object inside the shell-call block.
- Always include `target` and `cmd`. Use the tmux target from the latest shell-output target list or from the user.
- Target lists use lines like `target=%24 address=espcam:0.0 window=build command=zsh cwd=/path`. Pick the `target=` value for the desired `window=...`; do not put the window name itself in `target`.
- Keep requests minimal by default: use only `target` and `cmd`.
- `target` may be a pane id like `%24`, an address like `espcam:0.0`, or a unique window name like `build`.
- Do not wrap shell-output, terminal output, markdown, explanations, or prompts inside shell-call.
- Wait for my shell-output reply before interpreting results or requesting the next command.
- Do not repeat a command after receiving shell-output for that command.
- Prefer read-only commands first when inspecting a system or repository.
- If a command is destructive, modifies many files, deletes data, installs software, changes credentials, or sends private data to a network service, ask for confirmation in prose instead of emitting shell-call.
- Only add optional fields such as `cwd`, `timeoutMs`, or `maxOutputChars` when the user or previous output clearly requires them.
````

## Shell Syntax Highlighting Variant

Use this when an AI chat product does not support the `shell-call` code fence label or downgrades it to plain text:

````text
When local terminal output would help, reply with exactly one fenced code block and no prose.
Use the code fence language shell.
Put this marker as the first line inside the block:
# local-shell
Put only the JSON request after that marker.
If the chat product loses multi-line code block content, use the single-line form `# local-shell: {"target":"%24","cmd":"command"}` instead.
Wait for my shell-output reply before continuing.
Do not repeat a command after shell-output is returned.

```shell
# local-shell
{"target":"%24","cmd":"git status --short"}
```
````

The extension strips `# local-shell` before execution. The marker is there so normal shell examples are not treated as tool calls.
It also accepts `# local-shell: {"target":"%24","cmd":"git status --short"}` and runs only the JSON request after the colon.

## Project Agent

Use this for coding agents that should iterate through commands:

````text
You may request terminal command output with this format:

Tool request format:

```shell-call
{"target":"%24","cmd":"command here"}
```

Use the tool when command output is needed to inspect files, run tests, check git state, or verify a change.

Workflow rules:
- Emit at most one shell-call per assistant message.
- Emit no prose in a message that contains shell-call.
- Wait for shell-output before making claims about command results.
- Do not rerun the same command unless the user asks or the previous output clearly requires it.
- Always include a tmux `target`. If shell-output says the target is missing, choose one of the listed panes and retry once.
- In tmux target lists, choose by `window=build` or `window=monitor`. If the window name is unique, you may use it directly as `target`, for example `{"target":"build","cmd":"pwd"}`. If unsure, copy the matching `target=%...` value.
- Keep the JSON minimal by default. Usually send only `target` and `cmd`:

```shell-call
{"target":"%24","cmd":"npm test"}
```

- Add `cwd`, `timeoutMs`, or `maxOutputChars` only when necessary, such as when the target pane is not already in the project directory or a test is expected to run for a long time.

Safety rules:
- Ask before destructive commands such as rm -rf, git reset --hard, force pushes, credential changes, package publishing, or broad permission changes.
- Do not request commands that expose secrets unless the user explicitly asks.
- Summarize command results after shell-output is returned.
````

## One-Off Prompt

Use this when you cannot set persistent instructions:

```text
For this conversation, when local terminal output would help, reply with exactly one fenced code block whose language is shell-call. Put only one JSON object inside the block, including target and cmd, for example {"target":"%24","cmd":"pwd"}. Wait for my shell-output reply before continuing. Do not repeat a command after shell-output is returned.
```

## Test Prompt

If the floating panel is not available, paste this manually:

```text
Reply with exactly one fenced markdown code block and no prose.
Use the code fence language shell.
Put this marker as the first line inside the block:
# local-shell
Put only this JSON request after that marker, replacing %24 with a listed tmux target:
{"target":"%24","cmd":"printf ai-chat-shell-exec-ok"}
```

Expected AI response:

````text
```shell
# local-shell
{"target":"%24","cmd":"printf ai-chat-shell-exec-ok"}
```
````

The extension should run the command and post a `shell-output` reply containing `ai-chat-shell-exec-ok`.

Single-line fallback for sites that collapse code block lines:

````text
```shell
# local-shell: {"target":"%24","cmd":"printf ai-chat-shell-exec-ok"}
```
````

The floating panel's `Test` button performs a stricter version of this check with a generated token. During that self-test, the extension only runs the exact expected token command and only reports success when the returned stdout contains the token.
