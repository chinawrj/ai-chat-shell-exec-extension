# Security Policy

AI Chat Shell Exec intentionally lets an AI chat page request local commands that are sent into a selected tmux pane. That makes it remote-code execution on the machine where the local server is running.

## Supported Version

Security fixes are currently made against the latest public release only.

## Safety Model

- The extension only executes explicit helper blocks such as `ai-helper-shell-start` / `ai-helper-shell-end`.
- Browser confirmation can be enabled from the extension popup.
- Commands must name an existing tmux target; missing or unknown targets are rejected.
- The local server listens only on `127.0.0.1:17371`.
- The local server accepts the pinned Chrome extension origin by default.
- The browser never adjudicates command duplicates from command text or prior output. It prevents repeated DOM scans from resubmitting the exact same rendered helper request, including tracking DOM-node recycling and structurally rendered `shell-output`; after any backend response, local composer retries use a bounded pending-result queue rather than another run. The shell server makes the final decision after resolving the actual tmux pane, and only a command with a server-controlled completion proof on the same tmux server/pane and current pane shell PID plus actual cwd can be considered duplicate. Replacing the shell with `tmux respawn-pane` changes that fingerprint, while missing pane-shell PID disables dedup instead of risking a false positive. A command interrupted by Ctrl+C after its server-controlled executed marker is written is completed execution history and may be deduplicated; interruption before that marker remains runnable through a newly rendered helper. Running, timed-out/unconfirmed, failed, unavailable-target, transport-lost, and incomplete-pane-identity attempts do not become duplicate authority. Generic board prompts are spoofable, so board execution dedup is disabled and fails open; Force run explicitly bypasses a completed verdict where authoritative dedup is available.
- Shell helper runners are serialized by stable tmux socket + server-pid + pane-id identity and a tokenized ownership lease stored on the pane. This prevents a refreshed page or restarted server from injecting a runner command into terminal input owned by an older observed foreground process. Manual-busy readiness is authoritative only when tmux PID/TTY metadata and the foreground process group can be proved; missing metadata fails closed and remains retryable. The root interactive shell's own blocking builtins (for example direct `read` or a pure-builtin loop) are indistinguishable from its prompt without shell-hook integration, so run them through a script/child shell or in a dedicated pane. Mutable window addresses cannot bypass the queue, and the target instance is revalidated after waiting so tmux reset/pane-id reuse fails safely instead of executing against a replacement pane. Different panes remain independent; direct Terminal vision test runs share the lease and cannot preempt shell helpers.
- Completed shell and board output is retained under per-result and global server-ledger replay bounds for status recovery. Persistent ownership is bound to the same immutable queued attempt before authoritative adjudication, nonterminal attempts are not discarded by count pruning, and a late failure cannot downgrade an already terminal completed result. The browser's kind-scoped `run-status` request is read-only and can settle or retrieve only the original server call key; it never claims or executes a command. Same-call status recovery applies when the page survives a runtime-channel/service-worker interruption. Canonical execution identities and presentation receipts ensure that an already-presented duplicate is local-only, including recovery of duplicate ledger entries that predate the receipt, while a result never presented before reload can be restored cleanly without exposing duplicate diagnostics. Page lifecycle tokens prevent an old page's result from being inserted into a different conversation.
- Composer ownership is exact-text and lifecycle scoped, and every automatic delivery has a one-write limit. If inserted helper output is removed or replaced, that action cancels the current queued output batch without a presentation receipt; no cached entry may reclaim the composer. If an inserted agent prompt is removed, replaced, or loses its page lifecycle, composer delivery is cancelled and only its local hub acknowledgement may retry. A helper remains detected but unconsumed only while a non-cancelled pending agent delivery owns the composer; it resumes after submission, cancellation acknowledgement, or a page-agent profile change. Already-submitted agent prompts are acknowledged from the rendered user message rather than reinserted.
- Board helpers intentionally do not infer duplicate authority from prompt text. Shell-backed boards add foreground-process-group readiness, but a generic non-shell TUI has only spoofable prompt text; its serialization is therefore best effort and must not be treated as shell execution proof. A returned prompt permits bounded result recovery, but board execution keys remain empty and an explicit later board helper always executes again. Runtime loss uses read-only status recovery; the same rendered board helper is never automatically resent.
- Command length, timeout, and output size are capped.

These controls reduce accidental execution, but they do not make untrusted commands safe.

## Recommendations

- Use this extension only on a machine and browser profile dedicated to local development.
- Enable per-command confirmation when testing new chat systems.
- Read shell commands before approving them.
- Avoid running it in repositories or directories containing secrets unless that is intentional.
- Do not set `AI_CHAT_SHELL_ALLOW_UNTRUSTED_ORIGINS=1` outside local development tests.

## Reporting Issues

Open a GitHub issue with reproduction steps. Do not include secrets, private command output, tokens, cookies, or browser profile data.
