# AI Chat Shell Exec

Chrome extension for explicit local command execution from AI chat pages such as `https://chatgpt.com/` and manually enabled sites like `https://claude.ai/`, routed through the default `ForAI:host` tmux pane.

This is local remote-code execution for AI chat. Install it only on machines you control, and only use it with conversations and models you trust enough to request local shell commands.

With the AI-facing instructions in this repo, the AI asks its human helper by returning exactly one explicit fenced code block and no prose. The extension recognizes six helper block types:

- Shell helper: request local terminal output from the default `ForAI` tmux session.
- Board helper: send one command line to the `ForAI` `board` tmux window or the configured board tmux pane.
- File helper: write one file under `$HOME/Downloads`.
- Agent message helper: send a task or result to another locally registered agent tab.
- Agent roster helper: let an AI master query online agents before delegating.
- Agent task-status helper: let an AI master check a delegated task by `message-id` or `task-id`.

Shell helper:

````
ai-helper-shell-start
pwd && ls -la
ai-helper-shell-end
````

Board helper:

````
ai-helper-board-start
version
ai-helper-board-end
````

File helper:

````
ai-helper-file-start
notes.txt
first line
second line
ai-helper-file-end
````

Agent message helper:

````
ai-helper-agent-message-start
to: slave-a
task-id: task-001

Investigate this independently and report back.
ai-helper-agent-message-end
````

Agent roster helper:

````
ai-helper-agent-roster-start
role: slave
ai-helper-agent-roster-end
````

Agent task-status helper:

````
ai-helper-agent-task-status-start
message-id: msg-001
ai-helper-agent-task-status-end
````

By default, shell helpers run in the `host` window of the `ForAI` tmux session. The local server creates the `ForAI` session plus `host` and `board` windows when the page plugin starts or when tmux targets are listed. New default windows start in the project root; set `AI_CHAT_SHELL_FORAI_CWD=/path/to/workspace` before starting the server to choose another default cwd. The board helper body is exactly one command line and defaults to the `ForAI` `board` window, or `AI_CHAT_SHELL_BOARD_TARGET` when set. A named board marker such as `ai-helper-board-R1-start` targets `ForAI:board-R1` when no environment override is set. The file helper's second line is a single file name, and the remaining lines are the exact file content. The file end marker is not written into the file.

For intentional repeated requests with the same payload, the AI may add a simple no-space identity suffix to the start marker, such as `ai-helper-shell-start:2`, `ai-helper-board-start:2`, `ai-helper-board-R1-start:2`, `ai-helper-file-start:2`, `ai-helper-agent-message-start:2`, `ai-helper-agent-roster-start:2`, or `ai-helper-agent-task-status-start:2`.

The content script waits until the assistant stops streaming, sends the request through the extension background worker to a local WebSocket server, then posts the captured output back into the chat composer as a `shell-output` block.

## Basic Helper Screenshots

These older screenshots show the basic shell/file helper reply shape. Multi-agent controls are described below.

![Shell helper result reply](docs/release-assets/v0.2.10/shell-helper-result.png)

File helper result reply:

![File helper result reply](docs/release-assets/v0.2.10/file-helper-result.png)

## Architecture

Chrome extensions cannot directly execute local shell commands. This project uses:

- `extension/`: Manifest V3 Chrome extension injected on HTTPS pages. The execution trigger is still limited to explicit ai-helper blocks.
- `server/`: Local WebSocket server bound to `127.0.0.1:17371` that ensures the default `ForAI` tmux workspace, sends shell commands into `ForAI:host`, sends board commands into the configured board pane, and hosts the local in-memory agent hub.

Flow:

`AI chat page -> content script -> extension background -> ws://127.0.0.1:17371/shell -> tmux pane or agent hub -> shell-output / agent-message reply`

## Install

Prerequisites:

- macOS or Ubuntu
- Chrome or another Chromium browser with unpacked extensions enabled
- Node.js available on `PATH`
- tmux available on `PATH`
- Claude Code CLI installed and logged in if you want to use a tmux-hosted Claude slave

Download the latest release from:

`https://github.com/chinawrj/ai-chat-shell-exec-extension/releases`

If you use the release source archive, unzip it and run the commands below from the extracted project directory. If you clone the repository, use the repository root.

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked and choose either the project root or the `extension/` subdirectory.

4. Confirm the extension ID is:

   `lkmeogidbglhedgekjgbpbfjkpapnhke`

5. Start the local shell server in a terminal and leave it running while using the extension.

   ```sh
   ./scripts/start_shell_server.sh
   ```

   Runtime state and server logs default to `.state/` under this project directory. Set `AI_CHAT_SHELL_STATE_DIR=/path/to/state` only if you intentionally want runtime state elsewhere. If you use a named tmux socket, set `AI_CHAT_SHELL_TMUX_SOCKET` before starting the server.

   For compatibility with older setup instructions, `./scripts/install_shell_server_agent.sh` first removes any legacy macOS LaunchAgent and then starts the same foreground server. It does not install auto-start.

6. Reload the extension and reload the AI chat page.

After every extension code change, click Reload on the unpacked extension in `chrome://extensions`, then refresh each AI chat tab. Otherwise Chrome will keep running the old content script.

## Configure AI Instructions

For stable tool use, add human-helper instructions to the AI chat system you use. Put them in the chat system's custom instructions, project instructions, agent instructions, or the first message of a conversation. The AI-facing wording should say that you, the human, will serve helper blocks and return `shell-output`; it should not describe the format as an automatic script interface.

Start with:

`docs/AI_INSTRUCTIONS.md`

The short version is:

`````text
I can act as your human helper for local terminal output, board output, and helper files.

When output would help, reply with exactly one fenced code block and no prose.

For local terminal output, use:
````
ai-helper-shell-start
command here
ai-helper-shell-end
````

For board output, use:
````
ai-helper-board-start
one board command here
ai-helper-board-end
````

For writing one helper file under my Downloads directory, use:
````
ai-helper-file-start
filename.ext
exact file content here
ai-helper-file-end
````

Rules:
- Use a plain unlabeled code fence (four backticks) exactly, with no text before or after the code block.
- Shell helpers do not include a tmux target; the entire helper body is the shell command and runs in the default `ForAI` `host` window.
- Board helpers must contain exactly one non-empty board command line and no target. Use `ai-helper-board-R1-start` / `ai-helper-board-R1-end` to send to the `ForAI:board-R1` window.
- File helpers must put a single file name, not a path, on the second line.
- A simple no-space suffix such as `ai-helper-shell-start:2` may be used as an optional request identity for diagnostics. It is not required for a new retry helper and does not force rerun a command that the server already executed on the resolved tmux pane.
- After I send back shell-output, use that output to continue.
- Do not repeat a command after shell-output confirms execution. A command explicitly reported as not executed may be retried with a new identical helper.
`````

Then run the floating panel's `Test` button once on each AI chat site. `Test` validates the basic shell-helper path; multi-agent and tmux-ai paths have separate smoke tests below.

The toolbar popup shows whether the local server is reachable and lets you change:

- enabled/paused
- auto-enabled sites
- local server release, server protocol, and helper protocol diagnostics
- visible tmux panes and default `ForAI` workspace state for diagnostics
- default `ForAI` host/board/cwd state, plus a reset button for the default session
- auto-send shell results
- per-command browser confirmation
- shell state timeout, output cap, and automatic chain limit
- export/import settings and per-origin calibration bindings

On an enabled chat site, click the chat input once. The content script remembers the composer selector for that origin and uses it for later `shell-output` replies.

By default, shell scanning is auto-enabled on `chatgpt.com` and `m365.cloud.microsoft`. On every other site, including `claude.ai`, the extension does not inject page UI, scan content, or bind page events until you add the hostname in the toolbar popup. To enable a site, open the extension popup, add the hostname to enabled sites, save, then refresh that page.

The floating status panel also has calibration controls for unknown chat systems:

- `Test`: insert and send a full-chain self-test prompt. The prompt asks the AI to return an ai-helper shell block; the extension only treats the test as passed when the executed command and `stdout` contain that test's token. Unexpected helper blocks are ignored instead of being run.
- `Server Check`: verify local shell server release/protocol/helper compatibility, `ForAI` host/board/cwd readiness, and whether input/send/shell bindings exist for the current origin.
- `Reset tmux`: recreate the default `ForAI` tmux session with `host` and `board` windows. This kills only the current `ForAI` session.
- `Force run`: manually recheck the current page once and explicitly rerun the latest helper block, bypassing the shell server's completed-execution duplicate decision.
- `Bind input`: click it, then click the page's chat input.
- `Bind send`: click it, then click the page's send control.
- `Bind shell`: click it, then click a rendered helper/code block area.
- `Clear`: remove the saved bindings for the current origin.
- Agent controls: choose `master` or `slave`, enter an agent id, click `Save`, use `Roster` to list online agents, and use `Agent Check` to explain whether this tab, the local agent hub, browser-tab slaves, tmux panes, and tmux-ai slaves are ready.
- Tmux AI controls: from a saved master page, click `Refresh`, select the tmux pane where the AI slave is already running, enter a slave id, then click `Register`.

Drag the panel title to move the floating window. You can also click a bind mode and drag the relevant page element onto the panel when the page supports dragging. Bindings and panel position are stored per origin, so a calibration for one site does not affect another.

Use the popup's portable config area to move settings and bindings to another Chrome profile or machine. It exports only extension settings and calibration selectors; it does not export shell command ledgers or page content.

## Local Multi-Agent Tabs

The floating panel can register an enabled page as a local agent. Set a role (`master` or `slave`) and an `agentId`, then click `Save`. Selecting a role suggests a usable default id (`master` for a master tab and a tab-local `slave-*` id for a slave tab).

### Browser-Tab Quick Start

Typical browser-tab workflow:

1. Open an enabled master chat page, refresh it after changing extension settings, click the chat input once if the floating panel is not calibrated, set role `master`, keep or edit the id, then click `Save`.
2. Open one or more enabled slave chat pages, refresh them after changing extension settings, set role `slave`, use stable ids such as `slave-a`, then click `Save` on each.
3. On the master page, click `Agent Check` or `Roster` if you want human-readable diagnostics. The master AI can also query the same roster itself with the helper block below.
4. Put the master instructions from `docs/AI_INSTRUCTIONS.md` in the master chat. Put the slave instructions in each slave chat.

`Roster` lists agents currently registered with the local server and pending message counts. `Agent Check` explains common setup problems directly in the floating panel, such as an unsaved current tab, no browser-tab slave, no tmux-ai slave, a stale tmux-ai pane, or an unavailable local server. Browser-tab slaves are enough for browser-only workflows; tmux-ai is optional. These panel buttons are for human debugging; AI masters should use the read-only agent roster and task-status helpers.

Minimal master prompt to paste into the master chat:

`````text
You are the master agent. Before delegating, discover online teammates by sending exactly one roster helper block and no prose:

````
ai-helper-agent-roster-start
role: slave
ai-helper-agent-roster-end
````

Read the Agent roster result. Choose an agent with role=slave and canReceiveTask=true. When I ask you to delegate work to a teammate, send exactly one agent-message helper block and no prose:

````
ai-helper-agent-message-start
to: exact-slave-id-from-roster
task-id: task-unique-id

Specific task instructions for the slave.
ai-helper-agent-message-end
````

After sending a task, keep the returned messageId. If the task takes too long, query status with:

````
ai-helper-agent-task-status-start
message-id: message-id-from-agent-message-result
ai-helper-agent-task-status-end
````

Include enough context for the slave. Wait for the slave result before final synthesis.
`````

Minimal browser-slave prompt to paste into each browser slave chat:

`````text
You are a slave agent. When a master task is delivered, work only on that task. If you need local terminal output, request it with the normal ai-helper-shell block.

When finished, reply with exactly one agent-message helper block and no prose:

````
ai-helper-agent-message-start
to: master
task-id: task-id-from-master
reply-to: message-id-from-master

Result, findings, tests run, and blockers.
ai-helper-agent-message-end
````

Preserve `reply-to` exactly when the delivered task includes it.
`````

Agent pages can query online teammates and task state through the local WebSocket agent hub:

````
ai-helper-agent-roster-start
role: slave
ai-helper-agent-roster-end
````

The roster output includes `agentId`, `role`, `surface`, `replyMode`, `pending`, `canReceiveTask`, `lastSeenAgeMs`, and `capabilities`. `surface=web` means the slave is another browser tab; `surface=tmux-ai` means the slave is an AI running in tmux and replying through the short reply script.

For `tmux-ai`, `canReceiveTask=true` means the pane is registered as a slave. The exact tmux pane is revalidated when the master sends a task; if the pane has disappeared, the agent-message result returns `tmux-target-unavailable` with recovery guidance.

````
ai-helper-agent-task-status-start
message-id: msg-001
ai-helper-agent-task-status-end
````

Task-status output includes states such as `waiting-for-recipient-poll`, `delivered-waiting-for-reply`, `waiting-for-tmux-ai-reply`, and `replied-waiting-for-master`, plus a `nextAction`.

Agent pages can send messages through the same hub:

````
ai-helper-agent-message-start
to: slave-a
task-id: task-001

Investigate this independently and report back.
ai-helper-agent-message-end
````

Messages are delivered to the recipient tab's composer and acknowledged after the page sends them. If the target AI page is not ready, the extension keeps the message as a visible pending delivery in the floating panel and retries until the composer/send control is ready. The pending panel explains what is cached, whether it is waiting for the composer, waiting for the send button, or retrying only the local ack.

Agent tabs poll the local hub as a heartbeat, so active tabs stay online in the roster; if the in-memory roster is lost after a local server restart, the page re-registers itself on the next poll.

A slave should reply to the master with the same helper format using `to: master`. When the delivered master task includes `reply-to`, keep that value in the reply so the hub can correlate the result with the original task:

````
ai-helper-agent-message-start
to: master
task-id: task-001
reply-to: msg-001

Result, findings, tests run, and blockers.
ai-helper-agent-message-end
````

The hub rejects stale or malformed result routing with explicit diagnostics. Common failures such as missing recipient, unregistered sender, wrong master, wrong task id, stale `reply-to`, or duplicate reply include `hint`, `nextAction`, and sometimes `aiNextAction` fields, which are also shown in failed agent-message `shell-output`.

For long-running delegated work, the server also exposes `agent-task-status` for diagnostics. It reports whether a task is waiting for the recipient to poll, delivered and waiting for reply, waiting for a tmux-ai short-script reply, or replied but not yet picked up by the master.

When a registered agent page emits a normal shell helper, the server routes it to an isolated tmux workspace named `ForAI-<agentId>:host`. Non-agent pages continue to use the default `ForAI:host` path.

Browser-tab smoke test:

1. Ask the master AI: `Query the agent roster, choose slave-a if it is online, then send it a task asking it to reply with exactly BROWSER_AGENT_SMOKE_OK.`
2. Expected first result: the master emits an `ai-helper-agent-roster-start` block and receives an `Agent roster result` listing `slave-a`.
3. Expected result: the slave page receives the task, sends an agent-message reply with `reply-to`, and the master page receives `BROWSER_AGENT_SMOKE_OK`.

### Tmux AI Agents

A tmux pane can also be registered as a `tmux-ai` agent when that pane is already running an AI teammate such as Claude. The server treats that pane as an AI runtime: it sends task prompts into the pane, and the AI must actively return the result by calling the provided CLI. The server does not scan tmux output for replies.

### Web Master + Tmux Claude Quick Start

This is the intended simple path when the master is a web AI page and the slave is Claude running in tmux:

1. Start the local server from this checkout or release source archive. Keep this foreground process running in one terminal, then use another terminal for the next step:

   ```sh
   ./scripts/start_shell_server.sh
   ```

2. Open a tmux pane and start Claude Code from the same checkout or release source archive so the project-level skill is available. This one-line form starts Claude inside tmux with the project directory as cwd:

   ```sh
   tmux new-session -s ClaudeSlave -c /path/to/ai-chat-shell-exec-extension claude
   ```

   If you already have a tmux window open, run `cd /path/to/ai-chat-shell-exec-extension` inside that pane before starting `claude`.

3. Open the web master chat page in Chrome, make sure this site is enabled, then use the floating panel:
   - role: `master`
   - agent id: `master`
   - click `Save`

4. In the master panel's tmux-ai controls:
   - click `Refresh`
   - select the tmux pane running Claude
   - enter slave id `slave-tmux`
   - click `Register`
   - click `Agent Check` and confirm it reports a ready `tmux-ai` slave

5. Give the master AI the minimal master prompt above or the `Multi-Agent Master` section from `docs/AI_INSTRUCTIONS.md`, then ask it to query the roster and delegate a task to `slave-tmux`. The roster result should list `slave-tmux` with `surface=tmux-ai` and `canReceiveTask=true`.

6. The server pastes the task into Claude's tmux pane. Claude should write the result to the shown reply file and run the short `sh ...-reply.sh` command. The master page receives the result as an agent message.

The local server validates the target pane before registering it as a `tmux-ai` slave. The local manual test page exposes the same registration message for debugging, but the master panel is the normal control entry.

Sending an agent task to that id pastes a prompt into the target pane. The prompt includes a reply file and a short per-task script command like:

```sh
printf '%s\n' 'final result' > /path/to/agent-replies/msg-001-slave-tmux.md
sh /path/to/agent-replies/msg-001-slave-tmux-reply.sh
```

The tmux-hosted AI should write its final answer to the body file and run the short script exactly once. The script wraps the longer `agent_reply_cli.js --from --to --task-id --reply-to --body-file ...` command so the slave does not need to copy or remember every flag. The CLI sends `agent-reply` to the local server, which delivers the result to the recipient agent mailbox. If the recipient web page is open but not ready to send yet, the extension shows the reply as pending and acknowledges it only after the page sends it into the chat.

This repository also includes a project-level Claude Code skill at `.claude/skills/tmux-ai-slave-reply/SKILL.md`. The skill is checked into GitHub and included in the source release archive. When Claude is running from this checkout or a release source archive, the skill teaches a tmux-hosted Claude slave to use the reply file and short reply script from the task prompt instead of only answering in the terminal.

If Claude asks whether it can write under `agent-replies/` or run the generated reply script, approve it for the smoke test or delegated task.

If you are not sure Claude Code loaded the project skill, paste the `Tmux AI Agent` section from `docs/AI_INSTRUCTIONS.md` into that Claude session once. The fallback instruction is intentionally the same workflow as the skill: write the reply file, then run the short reply script.

The tmux task prompt and the Claude skill both say the same thing: do the work, write the final result to the reply file, then run the short `sh ...-reply.sh` command once. If that command returns JSON with `ok: false`, read `errorCode`, `hint`, and `nextAction`, fix the specific issue, and retry only when the fix is clear.

First tmux-ai smoke test:

1. Confirm the master page is saved as agent id `master`, the master AI has received the master prompt, and `Agent Check` reports `slave-tmux` as a ready `tmux-ai` slave.
2. Ask the master AI: `Query the agent roster, choose slave-tmux, and ask it to reply with exactly TMUX_AI_SMOKE_OK.`
3. Expected first result: the master emits an `ai-helper-agent-roster-start` block and receives an `Agent roster result` listing `slave-tmux`.
4. Expected final result: Claude in tmux receives a task prompt, writes `TMUX_AI_SMOKE_OK` to the reply file, runs the short reply script, and the master page receives `TMUX_AI_SMOKE_OK`.
5. If Claude only says it is done in the terminal, tell it: `Use the Reply file and Reply command (short) from the task prompt. The master only receives the result after the short script returns ok: true.`

For the opt-in real Claude end-to-end test, open Claude in a tmux pane and run:

```sh
AI_CHAT_SHELL_REAL_CLAUDE_E2E=1 \
AI_CHAT_SHELL_REAL_CLAUDE_TARGET='%1' \
node tests/real_claude_tmux_slave_e2e.test.js
```

When `AI_CHAT_SHELL_REAL_CLAUDE_TARGET` is omitted, the test uses the first tmux pane whose command or window name looks like Claude. By default it auto-approves Claude Code prompts that ask to allow writes under `agent-replies/` or to run the generated `sh ...-reply.sh` script; set `AI_CHAT_SHELL_REAL_CLAUDE_AUTO_APPROVE=0` to handle those prompts manually.

For AI-facing master/slave instruction templates, see `docs/AI_INSTRUCTIONS.md`.

### Multi-Agent Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| `Agent Check` says this tab is not saved as an agent | The page has not registered with the local hub | Select `master` or `slave`, enter an id, then click `Save`. |
| `Roster` does not show a slave tab | The slave page is closed, not enabled, or has not clicked `Save` | Open the slave page, enable the site if needed, click the composer once, then click `Save`. |
| Master sends to a missing slave | The `to:` header does not match any registered agent id | Use `Roster` to copy the exact id, then resend with a new helper identity if needed. |
| Slave reply is rejected as wrong route or wrong task | The reply lost or changed `reply-to`, `to`, or `task-id` | Copy the reply skeleton from the delivered task. Preserve `reply-to` exactly. |
| Tmux-ai registration cannot find the pane | The AI is not running in tmux, or the selected target is stale/ambiguous | Start the AI in tmux, click `Refresh`, select the exact pane, then `Register` again. |
| Claude does not mention `Reply file` or `Reply command` in the tmux task | Claude CLI did not load the project skill or did not receive the fallback instruction | Paste the `Tmux AI Agent` section from `docs/AI_INSTRUCTIONS.md` into the Claude session, then resend the task. |
| Claude in tmux reports completion but master receives nothing | Claude answered in the terminal but did not run the short reply script | In the tmux prompt, write the result to the reply file and run the shown `sh ...-reply.sh` command. |
| The short reply script returns `ok: false` | The local hub rejected the reply | Read `errorCode`, `hint`, and `nextAction` from the JSON output; usually the fix is to reopen/save the master page or use the latest task prompt. |
| Master page is open but the result does not appear in chat yet | The page composer or send button is not ready | Keep the master tab open. The pending panel explains whether the message is cached, waiting for composer/send, or retrying local ack. |

## Local Visual Tmux Adapter

The server also exposes macOS-only `vision-*` messages for experiments where Terminal.app or Ghostty displays a tmux session and the server controls that visible window through screenshot/OCR plus Accessibility input. Build the helper first:

```sh
./scripts/build_macos_vision_helper.sh
```

The local visual adapter defaults to Terminal.app and Ghostty as supported tmux UI windows. Set `AI_CHAT_SHELL_VISION_TMUX_APPS` to a comma-separated subset of `Terminal,Ghostty` only for local experiments. Horizon/browser visual control is intentionally left for a later release.

## Tool Call Format

Plain command blocks are rejected because the server no longer chooses a shell by itself. The AI-facing format is a request to the human helper, and the extension recognizes only this shell helper block shape:

````
ai-helper-shell-start
uname -a
ai-helper-shell-end
````

The default target is the `host` window in the `ForAI` tmux session. The local server ensures `ForAI`, `host`, and `board` exist before listing targets or running a shell helper. New default windows start in the project root unless `AI_CHAT_SHELL_FORAI_CWD` is set.

Keep AI requests minimal by default:

````
ai-helper-shell-start
git status --short
ai-helper-shell-end
````

For shell helpers, every line between `ai-helper-shell-start` and `ai-helper-shell-end` is the command body. Multiline commands, heredocs, and `cat <<EOF` file creation are supported as normal shell script text. Shell helpers do not support a target line, and legacy shell target fields are ignored. Legacy JSON shell-call requests and the old `ai-helper-start-shell` / `ai-helper-end-shell` aliases are not supported.

For board output, use:

````
ai-helper-board-start
version
ai-helper-board-end
````

The board helper body is exactly one non-empty board command line. It does not include a target or cwd. The server resolves the target from `AI_CHAT_SHELL_BOARD_TARGET` when set, otherwise from the `board` window in the `ForAI` tmux session. To send to another board window, use a safe suffix in both markers, for example `ai-helper-board-R1-start` and `ai-helper-board-R1-end` target `ForAI:board-R1`. Each board request first probes the current board prompt; if the prompt cannot be identified, the command is not sent.

The start marker can include an optional helper identity suffix, for example `ai-helper-shell-start:20260529-1`, `ai-helper-board-start:20260529-1`, `ai-helper-board-R1-start:20260529-1`, or `ai-helper-file-start:20260529-1`. Use a simple no-space nonce, number, or timestamp when an otherwise identical helper payload should be treated as a new request. Without a suffix, the extension derives a stable identity from the plain text helper payload.

To write a file under `$HOME/Downloads`, use:

````
ai-helper-file-start
notes.txt
first line
second line with "quotes" and {json}
ai-helper-file-end
````

The file helper format maps the second line to the file name and writes every following line up to, but not including, `ai-helper-file-end`.

For agent messages, use:

````
ai-helper-agent-message-start
to: slave-a
task-id: task-001

Task body here.
ai-helper-agent-message-end
````

For slave replies, preserve `reply-to` when the delivered task includes it:

````
ai-helper-agent-message-start
to: master
task-id: task-001
reply-to: msg-001

Result body here.
ai-helper-agent-message-end
````

Agent-message helpers route text through the local agent hub. They do not execute shell commands by themselves; if an agent needs terminal output, that agent emits a separate shell helper from its own tab.

For agent roster discovery, use:

````
ai-helper-agent-roster-start
role: slave
surface: tmux-ai
ai-helper-agent-roster-end
````

`role` and `surface` are optional filters. Valid roles are `master` and `slave`; valid surfaces are `web` and `tmux-ai`. The result is a `shell-output` block listing online agents and capabilities.

For delegated task status, use either `message-id` or `task-id`:

````
ai-helper-agent-task-status-start
message-id: msg-001
ai-helper-agent-task-status-end
````

The result is a `shell-output` block with task state and `nextAction` guidance for the AI master.

## Zero-Knowledge Site Strategy

The extension does not hard-code a ChatGPT, Claude, or Copilot DOM contract. The default strategy is:

- detect editable chat inputs from standard browser semantics such as `textarea`, `input`, `contenteditable`, and `role="textbox"`;
- detect tool requests from explicit shell, board, and file helper blocks;
- post results by writing into the remembered editable input;
- submit first through generic form submission and synthetic Enter key events;
- fall back to a saved user-bound send control, then broad send-button heuristics if needed.

For sites with unusual editors or send controls, use the floating panel to bind the input, send control, or helper display area.

## Safety Defaults

- The extension runs only explicit shell, board, file, agent-message, agent-roster, and agent-task-status helper blocks. Ordinary `bash`, `sh`, `zsh`, `shell`, and JSON code blocks are not executable tool requests.
- Shell helper commands always run in `ForAI:host`; target lines are not part of the shell helper protocol.
- Agent-message helpers only route messages through the local agent hub. They do not execute commands unless the receiving agent later emits its own explicit helper block.
- Agent-roster and agent-task-status helpers are read-only local hub queries; they do not execute shell commands.
- Reset actions in the floating panel and popup kill and recreate only the default `ForAI` session.
- Board helper blocks do not include a raw tmux target. They use `AI_CHAT_SHELL_BOARD_TARGET`, `ForAI:board`, or a safe named board marker such as `ai-helper-board-R1-start` for `ForAI:board-R1`; the server refuses to send the command if the board prompt probe fails.
- File helper blocks write only a single file name directly under `$HOME/Downloads`; path separators and traversal are rejected.
- The default auto-enabled host list contains `chatgpt.com` and `m365.cloud.microsoft`; every other site requires an explicit per-site opt-in before scanning can run.
- Browser confirmation is off by default for hands-free operation. Set `requireApproval` to `true` in extension storage if you want a prompt before each command.
- The extension and server reject obvious copied `shell-output` text, terminal prompts such as `$ ...`, and markdown wrappers before execution.
- Automatic chained helper calls are capped by `maxChainCalls` in extension storage. The default is 100, and the popup enforces only a minimum of 1. New human prompts reset the chain count; tool result replies do not.
- Command duplicate decisions belong exclusively to the local shell server after it resolves the actual tmux pane. The execution fingerprint contains the tmux pane instance, full command, and actual cwd. Only a prior command with a server-controlled completion proof on that same pane instance can return `duplicate: true`; browser-side sightings, confirmation cancellation, target/health/transport failures, server failures, timeouts with unconfirmed completion, and `running` claims are not execution duplicates. Generic board CLIs expose only a textual prompt, which command output can imitate, so board requests deliberately fail open and are never suppressed as execution duplicates. Each server attempt has an internal collision-proof identity, independent of browser call keys. If pane-instance metadata is incomplete, dedup also fails open. The content script only prevents the exact same rendered helper request from being resubmitted by repeated DOM scans, while a new helper containing identical command text is still forwarded. The background ledger remains a non-blocking audit trail. `Force run` explicitly bypasses the server decision.
- The runtime state directory defaults to `.state/` under this project directory and is rebuildable: it stores server logs, dedupe ledger data, tmux temporary scripts, board logs, vision temp files, local test assets, and helper build artifacts. The startup script and server preflight the state directory and repair or recreate it before accepting commands. Safe conflicts are moved aside with a `.broken-*` suffix. Use `AI_CHAT_SHELL_STATE_DIR` only when you intentionally want state elsewhere.
- The WebSocket server only accepts Chrome extension requests by default. Set `AI_CHAT_SHELL_ALLOW_UNTRUSTED_ORIGINS=1` only for local development tests.
- The local server clamps the shell state timeout to 1 second through 10 minutes. This is not a command runtime limit: after that window, the server keeps waiting while the tmux runner process is still alive. It returns `timedOut: true` only when the completion marker is missing and the runner process is gone or cannot be confirmed.
- Commands longer than 8000 characters are rejected before execution.
- Output is capped to avoid flooding the page.
- Repeated command loops are adjudicated by the shell server against completed execution history for the resolved tmux pane; the page does not infer execution from prior `shell-output` text.
- A small status badge appears in the lower-right corner while the content script is active.

Treat shell calls as remote code execution on your machine. Review the security notes in `SECURITY.md` before sharing this with other users.

## Development Loop

After changing extension files:

1. Reload the unpacked extension in `chrome://extensions`.
2. Refresh every AI chat tab you want to use.
3. Confirm the lower-right status badge shows the current extension version and that `Server Check` reports no content/background version mismatch.

After changing server files:

1. Stop the old shell server.
2. Start it again:

   ```sh
   ./scripts/start_shell_server.sh
   ```

3. Confirm the popup or floating-panel `Server Check` reports the expected server protocol and helper protocol. A stale foreground server is rejected before commands are forwarded.

Health check:

```sh
curl http://127.0.0.1:17371/health
```

Manual tmux test page:

```sh
node scripts/start_tmux_test_page_https.js
```

Open `https://localhost:17443/tmux-test-page.html`, accept the local certificate warning, reload the unpacked extension, click the page composer once, then insert a shell helper block. This local test port is auto-enabled by the development content script.

To launch an isolated Chromium-family test profile with this unpacked extension already loaded:

```sh
./scripts/open_tmux_test_chrome.sh
```

The helper prefers Chrome for Testing, Chromium, then Microsoft Edge before Google Chrome. Recent Google Chrome builds can ignore `--load-extension` for local unpacked extensions; in that case load `extension/` manually from `chrome://extensions` or set `AI_SHELL_TEST_BROWSER_APP`.

Installation diagnostics:

```sh
./scripts/doctor.sh
```

Full automated checks, including the Chrome extension e2e test:

```sh
./scripts/test_all.sh
```

The Chrome extension e2e test launches a real Chromium-family browser with the unpacked extension, starts the local tmux test page and shell server when needed, inserts an ai-helper block, and verifies the returned `shell-output`. It works on macOS with Chrome for Testing/Chromium/Chrome and on Ubuntu with a display, Xvfb, or a cached Playwright Chromium browser under `~/.cache/ms-playwright`. Set `CHROME_BIN` to force a browser binary.

Feature and test coverage is tracked in `docs/FEATURE_TEST_MATRIX.md`. Add or update a row there whenever a feature or test case changes.

Remove a legacy macOS LaunchAgent from older releases without starting the server:

```sh
./scripts/uninstall_shell_server_agent.sh
```

Build release archives:

```sh
./scripts/package_release.sh
```

## License

MIT
