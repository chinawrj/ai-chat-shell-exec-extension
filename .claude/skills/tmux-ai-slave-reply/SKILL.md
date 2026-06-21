---
name: tmux-ai-slave-reply
description: Use when Claude is running inside a tmux pane registered as an AI Chat Shell Exec tmux-ai slave and receives a task prompt containing a Reply file and short Reply command. Complete the task, write the result to the reply file, and run the provided short reply script exactly once.
---

# Tmux AI Slave Reply

Use this skill when the current prompt says the pane is registered as a local tmux AI agent or includes:

- `Reply file:`
- `Reply command (short):`
- `agent_reply_cli.js`
- `Do not report completion only in this terminal`

## Required Workflow

1. Read the task details from the prompt:
   - `Agent id`
   - `Task from`
   - `Task id`
   - `Message id`
   - `Reply file`
   - `Reply command`
2. Complete the requested work using the repo and tools available in this tmux Claude session.
3. Write only the final answer for the master into the exact reply file path from the prompt.
4. Run the exact short reply command from the prompt once, normally `sh '<...-reply.sh>'`.
5. If the CLI returns JSON with `ok: true`, stop. Do not send a separate terminal-only completion as the result.
6. If the CLI returns `ok: false`, read `errorCode`, `hint`, and `nextAction`, fix the specific issue, and retry only when the fix is clear.

## Rules

- Never invent `--from`, `--to`, `--task-id`, `--reply-to`, or `--body-file`; copy them from the current task prompt.
- Never reuse a reply command from an older task.
- Prefer the short reply script command over reconstructing the longer `agent_reply_cli.js` command.
- Do not put progress notes, Markdown fences, or extra commentary in the reply file unless the task asks for them.
- Do not claim completion until `agent_reply_cli.js` returns `ok: true`.
- If the master asks for a token or exact phrase, write exactly that requested content to the reply file.
- If the task cannot be completed, write a concise failure report to the reply file, then run the reply command so the master receives the failure.

## CLI Failure Handling

Use the CLI JSON response to decide the next step:

- `sender-not-registered`: the tmux pane registration is stale. Ask the user/master to register this pane again.
- `recipient-not-registered`: the master page is not registered. Ask the user/master to open the master page and click Save.
- `reply-target-not-found`: the command is from the wrong or expired task. Use the latest task prompt.
- `reply-recipient-mismatch` or `reply-task-mismatch`: copy the route/task fields from the current prompt exactly.
- `duplicate-reply`: stop; the master already has a reply for this task.
- Empty reply body: write the final answer into the reply file, then rerun the same command.

## Minimal Command Pattern

When the task is complete, the shell work should effectively be:

```sh
printf '%s\n' 'final answer for the master' > '/exact/reply/file/from/prompt.md'
sh '/exact/reply/script/from/prompt-reply.sh'
```

Use the actual reply file and reply script paths from the prompt, not the placeholders above. The reply script already contains the long CLI flags.
