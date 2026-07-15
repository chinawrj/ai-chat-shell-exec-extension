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
- The browser never adjudicates command duplicates from command text or prior output. It only prevents repeated DOM scans from resubmitting the exact same rendered helper request, including tracking DOM-node recycling and structurally rendered `shell-output`. The shell server makes the final decision after resolving the actual tmux pane, and only a command with a server-controlled completion proof on that pane instance and actual cwd can be considered duplicate. Running, timed-out/unconfirmed, failed, unavailable-target, and incomplete-pane-identity attempts remain runnable. Generic board prompts are spoofable, so board execution dedup is disabled and fails open; Force run explicitly bypasses a completed verdict where authoritative dedup is available.
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
