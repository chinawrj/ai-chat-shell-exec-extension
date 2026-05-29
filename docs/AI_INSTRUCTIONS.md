# AI Instructions

These are AI-facing templates. They should frame the protocol as a request to you, the human helper. The AI should understand that you will serve its request and return `shell-output`; it should not be told that it is using an automatic script.

After adding instructions, use the floating panel's `Test` button once on that site.

## Minimal

```text
I can act as your human helper for local terminal output.

When local terminal output would help, ask me by replying with exactly one plain text shell helper block and no prose:

ai-helper-shell-start
%24
pwd
ai-helper-shell-end

The first line must be ai-helper-shell-start.
The second line must be the tmux target.
The following lines must be the command.
The final line must be exactly ai-helper-shell-end.
If you need to ask for the same command text again as a new request, you may add a simple no-space identity suffix to the first line, such as ai-helper-shell-start:2.

After I send back shell-output, use that output to continue.
Do not repeat the same command after receiving shell-output.
```

## Recommended

```text
I can act as your human helper for local terminal output and helper files.

When local terminal output would help, ask me for one command by replying with exactly one plain text shell helper block and no prose.

Shell helper format:
ai-helper-shell-start
target here
command here
ai-helper-shell-end

Rules:
- The first line must be `ai-helper-shell-start`.
- If you need the same command payload to be treated as a new request, the first line may be `ai-helper-shell-start:<identity>`, where identity is a simple no-space nonce, number, or timestamp.
- The second line must be only the tmux target.
- Every line after the target and before `ai-helper-shell-end` is the shell command.
- The final line must be exactly `ai-helper-shell-end`.
- Target lists use lines like `target=%24 address=espcam:0.0 window=build command=zsh cwd=/path`. Pick the `target=` value for the desired `window=...`.
- Do not wrap shell-output, terminal output, markdown, explanations, or prompts inside the helper block.
- Wait for my shell-output reply before interpreting results or asking for the next command.
- Do not repeat a command after receiving shell-output for that command.
- If a command is destructive, modifies many files, deletes data, installs software, changes credentials, or sends private data to a network service, ask for confirmation in prose instead of emitting a helper block.

When writing a helper file would be useful, ask me with exactly one file helper block and no prose.

File helper format:
ai-helper-file-start
filename.ext
exact file content here
ai-helper-file-end

File rules:
- If you need the same file payload to be treated as a new request, the first line may be `ai-helper-file-start:<identity>`, where identity is a simple no-space nonce, number, or timestamp.
- The second line must be a single file name, not a path.
- The file will be placed under my Downloads directory.
- Every line after the filename and before `ai-helper-file-end` is the exact file content.
- The `ai-helper-file-end` line is not file content.
- Do not use a file helper block for secrets unless I explicitly ask.
```

## Project Agent

```text
I can act as your human helper when you need local terminal output.

Ask me for terminal output with this format:

ai-helper-shell-start
%24
command here
ai-helper-shell-end

Use the shell helper when command output is needed to inspect files, run tests, check git state, or verify a change.

Ask me to prepare a helper file with this format:

ai-helper-file-start
filename.ext
exact file content here
ai-helper-file-end

Workflow rules:
- Emit at most one helper block per assistant message.
- Emit no prose in a message that contains a helper block.
- For shell helpers, the second line must be the tmux target and the following lines must be the command.
- For file helpers, the second line must be a single file name and the following lines must be the exact file content.
- If you intentionally need to repeat an identical helper request as a new request, add a simple no-space suffix to the start marker, such as `ai-helper-shell-start:2` or `ai-helper-file-start:2`.
- Wait for shell-output before making claims about command results or file write results.
- Do not rerun the same command or rewrite the same file unless I ask or the previous output clearly requires it.

Safety rules:
- Ask before destructive commands such as rm -rf, git reset --hard, force pushes, credential changes, package publishing, or broad permission changes.
- Do not request commands or file writes that expose secrets unless I explicitly ask.
- Summarize results after shell-output is returned.
```

## One-Off Prompt

```text
For this conversation, I can act as your human helper when local terminal output would help. Ask me by replying with exactly one plain text shell helper block and no prose. Use ai-helper-shell-start as the first line, the tmux target as the second line, the command as the following lines, and ai-helper-shell-end as the final line. If I ask you to repeat an identical helper request as a new request, you may use ai-helper-shell-start:2 or another simple no-space suffix. Wait for my shell-output reply before continuing. Do not repeat a command after shell-output is returned.
```

## Test Prompt

If the floating panel is not available, paste this manually:

```text
Reply with exactly these lines and no prose, replacing %24 with a listed tmux target:

ai-helper-shell-start
%24
printf ai-chat-shell-exec-ok
ai-helper-shell-end
```

Expected AI response:

```text
ai-helper-shell-start
%24
printf ai-chat-shell-exec-ok
ai-helper-shell-end
```

You should then return a `shell-output` reply containing `ai-chat-shell-exec-ok`.
