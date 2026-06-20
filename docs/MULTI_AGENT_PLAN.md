# Multi-Tab Agent Plan

Goal: simulate a multi-agent team with multiple AI chat tabs. A user assigns each enabled page a role (`master` or `slave`) and a stable `agentId`. The master receives custom instructions that let it delegate work to slaves. Pages communicate through the existing local WebSocket server, and each slave can use its own tmux workspace. The current shell/file/board helper detection remains the foundation so local test pages can verify the feature without real chat sites.

## Product Rules

- Keep existing shell/file/board helper blocks unchanged.
- Do not require the model to encode tmux targets in shell helpers.
- Agent messaging is a separate transport layer, not a new shell execution backend.
- Ordinary non-agent usage must stay concise and unchanged.
- Build and test against local multi-tab pages before trying real ChatGPT or other chat sites.
- Treat every agent message as security-sensitive local automation.

## Agent Message Format

````
ai-helper-agent-message-start
to: slave-a
task-id: task-20260620-001

Investigate the parser behavior and report findings.
ai-helper-agent-message-end
````

Rules:

- `to` is required and names one registered `agentId`.
- `task-id` is optional but strongly recommended.
- The first blank line ends headers; remaining lines are exact message body.
- Optional identity suffixes follow existing helper conventions, for example `ai-helper-agent-message-start:2`.
- The helper is routed through the local agent hub instead of tmux.

## Implementation Steps

### Step 1: Agent Identity And Roster

Goal: every enabled tab can identify as `none`, `master`, or `slave` with a stable `agentId`.

Implementation:

- Store per-origin/page agent role settings in extension local storage.
- Add background messages for setting/getting current agent role.
- Content registers active agent metadata with the local server.
- Server keeps an in-memory roster with heartbeat timestamps.

Verification:

- Unit test server registration, update, listing, and stale cleanup.
- Background test role persistence and forwarding.
- Local test page can show `master`, `slave-a`, and `slave-b` in roster.
- Existing non-agent pages do not register.

### Step 2: Agent Hub Mailbox

Goal: the server can route messages between registered agents.

Implementation:

- Add WebSocket message types: `agent-register`, `agent-list`, `agent-send`, `agent-poll`, and `agent-ack`.
- Use `messageId`, `from`, `to`, `taskId`, `body`, and `createdAt`.
- Start with in-memory mailbox; persistence is explicitly deferred.

Verification:

- Sending to a missing recipient returns a structured error.
- Polling returns only messages for that `agentId`.
- Acked messages are not delivered again.
- Restart behavior is documented as non-persistent for v1.

### Step 3: Agent Message Parser

Goal: master and slaves can emit explicit helper blocks for inter-agent messages.

Implementation:

- Extend `content.js` helper parser with `agent-message`.
- Parse headers and body without changing shell/file/board parsing.
- Forward parsed messages to background as `agent-send`.

Verification:

- Parser tests cover valid messages, suffixes, missing `to`, empty body, and fenced missing-end behavior.
- Existing shell/file/board parser tests still pass.
- Copied `shell-output` or quoted helper text remains rejected by existing candidate selection safeguards.

### Step 4: Slave Message Delivery

Goal: a slave tab can receive a master task and submit it into its chat composer.

Implementation:

- Slave content scripts poll their inbox.
- On message receipt, compose a slave prompt that includes source, task id, and instructions to reply with `ai-helper-agent-message`.
- Inject into the detected/bound composer and send.
- Ack only after successful composer insertion/send.

Verification:

- Local test page receives a master task in the slave composer.
- Delivery failures leave the message pending.
- Acked messages are not reinserted after refresh.

### Step 5: Per-Agent Tmux Workspace

Goal: slaves can call shell helpers without sharing the default `ForAI:host` pane.

Implementation:

- Non-agent pages continue to use `ForAI:host`.
- Agent pages attach `agentId` metadata to shell helper requests.
- Server maps safe agent IDs to tmux sessions such as `ForAI-slave-a`.
- Each agent session has its own `host` and `board` windows.

Verification:

- Sanitized agent IDs cannot escape the expected session namespace.
- `slave-a` and `slave-b` shell helpers run in separate tmux sessions.
- Non-agent shell helpers remain on `ForAI:host`.

### Step 6: Slave Reply To Master

Goal: a slave can report completion back to master.

Implementation:

- Slave emits `ai-helper-agent-message` with `to: master`.
- Master polls inbox and inserts the reply into its composer.
- Message text includes source agent and task id for synthesis.

Verification:

- Local e2e proves `master -> slave -> master`.
- Offline master leaves replies pending until it returns.
- Replies are not delivered to other slaves.

### Step 7: Local Multi-Tab E2E

Goal: prove the whole loop without real AI sites.

Implementation:

- Extend the local manual test page with master/slave modes.
- Open three tabs in the Chrome e2e test.
- Simulate deterministic AI output on each page.

Verification:

- Master delegates to two slaves.
- Each slave runs an independent shell helper.
- Master receives both slave results.
- `./scripts/test_all.sh` includes the new e2e coverage.

### Step 8: UI, Diagnostics, And Safety

Goal: make agent status visible without adding noise to ordinary users.

Implementation:

- Show agent role, roster, pending counts, and last error only when agent mode is enabled.
- Add pause/clear controls for the local agent hub.
- Enforce message size limits and agent ID sanitization.

Verification:

- Popup/floating-panel tests cover concise non-agent health and expanded agent status.
- Disabled hosts do not register or poll.
- Malicious agent IDs and oversized messages are rejected.

## Deferred Work

- Persistent mailbox across server restarts.
- Dependency-aware task board.
- Automatic file conflict detection.
- Browser/Horizon visual multi-agent control.
- Cross-machine agent communication.

## User Review Updates

- Polling is also the agent heartbeat. An active tab remains online as long as it keeps polling the local hub.
- If a page has a saved tab-local agent profile but the server roster was lost, the next poll re-registers the page automatically.
- The floating panel uses `Save` and `Roster` labels, suggests a default agent id after role selection, and shows pending message counts in roster output.
- Slave delivery prompts include the exact `ai-helper-agent-message` reply skeleton so the model does not have to infer the return format.
- If a message is inserted but the send button is not ready, the tab remembers that message id and retries send without repeatedly inserting duplicate text.
