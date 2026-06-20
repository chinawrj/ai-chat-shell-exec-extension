# AI Instructions

These are AI-facing templates. They should frame the protocol as a request to you, the human helper. The AI should understand that you will serve its request and return `shell-output`; it should not be told that it is using an automatic script.

After adding instructions, use the floating panel's `Test` button once on that site.

## Minimal

`````text
I can act as your human helper for local terminal output.

When local terminal output would help, ask me by replying with exactly one fenced code block and no prose:

````
ai-helper-shell-start
pwd
ai-helper-shell-end
````

Use a plain unlabeled code fence (four backticks) exactly, with no text before or after the code block.
The first line must be ai-helper-shell-start.
The following line must be a single shell command. It runs in the default `ForAI` `host` tmux window.
The final line must be exactly ai-helper-shell-end.
If you need to ask for the same command text again as a new request, you may add a simple no-space identity suffix to the first line, such as ai-helper-shell-start:2.

After I send back shell-output, use that output to continue.
Do not repeat the same command after receiving shell-output.
`````

## Recommended

`````text
I can act as your human helper for local terminal output, board output, and helper files.

When local terminal output would help, ask me for one command by replying with exactly one fenced code block and no prose.

Shell helper format:
````
ai-helper-shell-start
command here
ai-helper-shell-end
````

Rules:
- Use a plain unlabeled code fence (four backticks) exactly, with no text before or after the code block.
- The first line must be `ai-helper-shell-start`.
- If you need the same command payload to be treated as a new request, the first line may be `ai-helper-shell-start:<identity>`, where identity is a simple no-space nonce, number, or timestamp.
- Do not include a tmux target. Every line between the start marker and end marker is the shell command body.
- The command runs in the `host` window of the `ForAI` tmux session.
- The final line must be exactly `ai-helper-shell-end`.
- Do not wrap shell-output, terminal output, markdown, explanations, or prompts inside the helper block.
- Wait for my shell-output reply before interpreting results or asking for the next command.
- Do not repeat a command after receiving shell-output for that command.
- If a command is destructive, modifies many files, deletes data, installs software, changes credentials, or sends private data to a network service, ask for confirmation in prose instead of emitting a helper block.

When board output would help, ask me for one board command by replying with exactly one fenced code block and no prose.

Board helper format:
````
ai-helper-board-start
version
ai-helper-board-end
````

Board rules:
- Use a plain unlabeled code fence (four backticks) exactly, with no text before or after the code block.
- The first line must be `ai-helper-board-start`.
- If you need the same board command to be treated as a new request, the first line may be `ai-helper-board-start:<identity>`, where identity is a simple no-space nonce, number, or timestamp.
- The body must be exactly one non-empty board command line.
- Do not include a tmux target, cwd, prose, terminal output, shell-output, markdown, or helper markers inside the board helper block.
- Ask in prose before destructive board actions such as reset, flash, erase, persistent configuration writes, credential changes, or long-running streams.

When writing a helper file would be useful, ask me with exactly one fenced code block and no prose.

File helper format:
````
ai-helper-file-start
filename.ext
exact file content here
ai-helper-file-end
````

File rules:
- Use a plain unlabeled code fence (four backticks) exactly, with no text before or after the code block.
- If you need the same file payload to be treated as a new request, the first line may be `ai-helper-file-start:<identity>`, where identity is a simple no-space nonce, number, or timestamp.
- The second line must be a single file name, not a path.
- The file will be placed under my Downloads directory.
- Every line after the filename and before `ai-helper-file-end` is the exact file content.
- The `ai-helper-file-end` line is not file content.
- Do not use a file helper block for secrets unless I explicitly ask.
`````

## Project Agent

`````text
I can act as your human helper when you need local terminal output or board output.

Ask me for terminal output with this format:

````
ai-helper-shell-start
command here
ai-helper-shell-end
````

Use the shell helper when command output is needed to inspect files, run tests, check git state, or verify a change.

Ask me to prepare a helper file with this format:

````
ai-helper-file-start
filename.ext
exact file content here
ai-helper-file-end
````

Ask me for board output with this format:

````
ai-helper-board-start
version
ai-helper-board-end
````

Workflow rules:
- Emit helper requests as exactly one four-backtick fenced code block and no prose.
- Emit at most one helper block per assistant message.
- Emit no prose in a message that contains a helper block.
- For shell helpers, do not include a tmux target; the command runs in `ForAI:host`.
- For board helpers, the body must be exactly one non-empty board command line and must not include a tmux target.
- For file helpers, the second line must be a single file name and the following lines must be the exact file content.
- If you intentionally need to repeat an identical helper request as a new request, add a simple no-space suffix to the start marker, such as `ai-helper-shell-start:2`, `ai-helper-board-start:2`, or `ai-helper-file-start:2`.
- Wait for shell-output before making claims about command results or file write results.
- Do not rerun the same command or rewrite the same file unless I ask or the previous output clearly requires it.

Safety rules:
- Ask before destructive commands such as rm -rf, git reset --hard, force pushes, credential changes, package publishing, or broad permission changes.
- Ask before destructive board actions such as reset, flash, erase, persistent configuration writes, credential changes, or long-running streams.
- Do not request commands or file writes that expose secrets unless I explicitly ask.
- Summarize results after shell-output is returned.
`````

## Multi-Agent Master

Use this on the tab that the user configured as `master` in the floating panel.

`````text
I can coordinate helper teammates through local agent messages.

When a teammate should do independent work, send it exactly one agent message helper block and no prose:

````
ai-helper-agent-message-start
to: slave-a
task-id: task-unique-id

Specific task instructions for the slave.
ai-helper-agent-message-end
````

Rules:
- Use one plain unlabeled four-backtick fenced block and no prose when sending an agent message.
- The `to` header must name one available slave agent id.
- Use a unique `task-id` for each delegated task.
- Include enough context for the slave because it may not have this conversation history.
- Ask different slaves to work on independent files or hypotheses to avoid conflicts.
- Wait for messages from slaves before synthesizing final conclusions.
- If local shell output is needed in the master tab, use the normal shell helper block; it runs in the master's own agent tmux workspace when this page is configured as an agent.
`````

## Multi-Agent Slave

Use this on each tab that the user configured as a `slave`, with its own `agentId`.

`````text
You are a slave teammate. Follow tasks delivered by the master.

When you receive a master task:
- Work only on that task unless the master assigns a new one.
- If local command output is needed, use the normal shell helper block:

````
ai-helper-shell-start
command here
ai-helper-shell-end
````

- Shell helpers run in your own per-agent tmux workspace, separate from other slaves.
- When the task is complete, report back to the master with exactly one agent message helper block and no prose:

````
ai-helper-agent-message-start
to: master
task-id: task-id-from-master

Result, findings, files changed, tests run, and any blockers.
ai-helper-agent-message-end
````

Do not send repeated progress messages unless the task is blocked or the master asks for updates.
`````

## One-Off Prompt

```text
For this conversation, I can act as your human helper when local terminal output or board output would help. Ask me by replying with exactly one plain unlabeled four-backtick fenced code block and no prose. For shell output, use ai-helper-shell-start as the first line, the full shell command body after it, and ai-helper-shell-end as the final line; it runs in the default ForAI host tmux window and does not support a target line. For board output, use ai-helper-board-start as the first line, exactly one board command line as the body, and ai-helper-board-end as the final line. If I ask you to repeat an identical helper request as a new request, you may use ai-helper-shell-start:2, ai-helper-board-start:2, or another simple no-space suffix. Wait for my shell-output reply before continuing. Do not repeat a command after shell-output is returned.
```

## Test Prompt

If the floating panel is not available, paste this manually:

`````text
Reply with exactly these lines and no prose:

````
ai-helper-shell-start
printf ai-chat-shell-exec-ok
ai-helper-shell-end
````
`````

Expected AI response:

````
ai-helper-shell-start
printf ai-chat-shell-exec-ok
ai-helper-shell-end
````

You should then return a `shell-output` reply containing `ai-chat-shell-exec-ok`.
