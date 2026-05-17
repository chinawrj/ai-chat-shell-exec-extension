# AI Instructions

AI Chat Shell Exec works best when the AI chat system is told how to request shell execution. Add one of these templates to the system's custom instructions, project instructions, agent instructions, or the first message in a conversation.

After adding instructions, use the floating panel's `Test` button once on that site.

## Where To Put Them

Use whichever persistent instruction surface your AI chat system provides:

- ChatGPT: custom instructions, project instructions, GPT instructions, or the first message in a chat.
- Claude: profile instructions, project instructions, custom style instructions, or the first message in a chat.
- Copilot-style systems: agent instructions, system prompt, project instructions, or the first message in a chat.
- Unknown systems: paste the one-off prompt at the start of the conversation.

The extension does not need to know which product you use. The instruction only needs to make the AI emit the `shell-call` block.

## Minimal

Use this when you want the smallest possible instruction:

```text
When you need to run a local shell command, reply with exactly one fenced code block using the language shell-call and no prose.

Put only the shell command inside the code block.

After I send back shell-output, use that output to continue.

Do not repeat the same shell-call after receiving shell-output.
```

## Recommended

Use this as the default template for ChatGPT, Claude, and similar AI chat systems:

````text
You can request local shell execution through a browser extension.

When a shell command is needed, reply with exactly one fenced code block and no prose:

```shell-call
command here
```

Rules:
- Put only the command inside the shell-call block.
- Do not wrap shell-output, terminal output, markdown, explanations, or prompts inside shell-call.
- Wait for my shell-output reply before interpreting results or requesting the next command.
- Do not repeat a shell-call after receiving shell-output for that command.
- Prefer read-only commands first when inspecting a system or repository.
- If a command is destructive, modifies many files, deletes data, installs software, changes credentials, or sends private data to a network service, ask for confirmation in prose instead of emitting shell-call.
- If a working directory matters, use a JSON shell-call with cwd:

```shell-call
{"cmd":"git status --short","cwd":"~/path/to/project"}
```
````

## Shell Syntax Highlighting Variant

Use this when an AI chat product does not support the `shell-call` code fence label or downgrades it to plain text:

````text
You can request local shell execution through a browser extension.

When a shell command is needed, reply with exactly one fenced code block and no prose.
Use the code fence language shell.
Put this marker as the first line inside the block:
# local-shell
Put only the command after that marker.
If the chat product loses multi-line code block content, use the single-line form `# local-shell: <command>` instead.
Wait for my shell-output reply before continuing.
Do not repeat a command after shell-output is returned.

```shell
# local-shell
git status --short
```
````

The extension strips `# local-shell` before execution. The marker is there so normal shell examples are not treated as tool calls.
It also accepts `# local-shell: <command>` and runs only the command after the colon.

## Project Agent

Use this for coding agents that should iterate through commands:

````text
You can use a local shell tool through AI Chat Shell Exec.

Tool request format:

```shell-call
command here
```

Use the tool when command output is needed to inspect files, run tests, check git state, or verify a change.

Workflow rules:
- Emit at most one shell-call per assistant message.
- Emit no prose in a message that contains shell-call.
- Wait for shell-output before making claims about command results.
- Do not rerun the same command unless the user asks or the previous output clearly requires it.
- Prefer explicit cwd with JSON when operating on a project:

```shell-call
{"cmd":"npm test","cwd":"~/work/project","timeoutMs":120000,"maxOutputChars":40000}
```

Safety rules:
- Ask before destructive commands such as rm -rf, git reset --hard, force pushes, credential changes, package publishing, or broad permission changes.
- Do not request commands that expose secrets unless the user explicitly asks.
- Summarize command results after shell-output is returned.
````

## One-Off Prompt

Use this when you cannot set persistent instructions:

```text
For this conversation, you may request local shell execution by replying with exactly one fenced code block whose language is shell-call. Put only the command inside the block and no prose. Wait for my shell-output reply before continuing. Do not repeat a command after shell-output is returned.
```

## Test Prompt

If the floating panel is not available, paste this manually:

```text
Reply with exactly one fenced markdown code block and no prose.
Use the code fence language shell.
Put this marker as the first line inside the block:
# local-shell
Put only this command after that marker:
printf ai-chat-shell-exec-ok
```

Expected AI response:

````text
```shell
# local-shell
printf ai-chat-shell-exec-ok
```
````

The extension should run the command and post a `shell-output` reply containing `ai-chat-shell-exec-ok`.

Single-line fallback for sites that collapse code block lines:

````text
```shell
# local-shell: printf ai-chat-shell-exec-ok
```
````

The floating panel's `Test` button performs a stricter version of this check with a generated token. During that self-test, the extension only runs the exact expected token command and only reports success when the returned stdout contains the token.
