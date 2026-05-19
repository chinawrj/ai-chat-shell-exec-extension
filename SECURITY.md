# Security Policy

AI Chat Shell Exec intentionally lets an AI chat page request local commands that are sent into a selected tmux pane. That makes it remote-code execution on the machine where the local server is running.

## Supported Version

Security fixes are currently made against the latest public release only.

## Safety Model

- The extension only executes explicit tool blocks such as `shell-call`.
- Browser confirmation can be enabled from the extension popup.
- Commands must name an existing tmux target; missing or unknown targets are rejected.
- The local server listens only on `127.0.0.1:17371`.
- The local server accepts the pinned Chrome extension origin by default.
- Duplicate calls are blocked in both browser storage and the server ledger.
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
