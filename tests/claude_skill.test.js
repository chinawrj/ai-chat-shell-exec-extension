#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.join(__dirname, "..");
const skillPath = path.join(rootDir, ".claude", "skills", "tmux-ai-slave-reply", "SKILL.md");

const text = fs.readFileSync(skillPath, "utf8");
const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);

assert.ok(frontmatter, "Claude skill must start with YAML frontmatter.");
assert.match(frontmatter[1], /^name:\s*tmux-ai-slave-reply$/m);
assert.match(frontmatter[1], /^description:\s*Use when Claude is running inside a tmux pane registered as an AI Chat Shell Exec tmux-ai slave/m);
assert.match(text, /Reply file:/);
assert.match(text, /Reply command \(short\):/);
assert.match(text, /agent_reply_cli\.js/);
assert.match(text, /Run the exact short reply command from the prompt once/);
assert.match(text, /Prefer the short reply script command/);
assert.match(text, /sh '\/exact\/reply\/script\/from\/prompt-reply\.sh'/);
assert.match(text, /Never invent `--from`, `--to`, `--task-id`, `--reply-to`, or `--body-file`/);
assert.match(text, /Do not claim completion until `agent_reply_cli\.js` returns `ok: true`/);
assert.match(text, /duplicate-reply/);

console.log("Claude skill tests passed");
