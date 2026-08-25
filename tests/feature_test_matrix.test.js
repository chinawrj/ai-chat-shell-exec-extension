#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.join(__dirname, "..");
const matrixPath = path.join(rootDir, "docs", "FEATURE_TEST_MATRIX.md");
const runnerPath = path.join(rootDir, "scripts", "test_all.sh");
const readmePath = path.join(rootDir, "README.md");
const releasePath = path.join(rootDir, "docs", "RELEASE.md");
const agentsPath = path.join(rootDir, "AGENTS.md");
const fullInstructionsPath = path.join(rootDir, "docs", "AI_INSTRUCTIONS_FULL.md");
const chromeE2ePath = path.join(rootDir, "tests", "chrome_extension_e2e.test.js");

const matrix = fs.readFileSync(matrixPath, "utf8");
const runner = fs.readFileSync(runnerPath, "utf8");
const docs = [
  fs.readFileSync(readmePath, "utf8"),
  fs.readFileSync(releasePath, "utf8"),
  fs.readFileSync(agentsPath, "utf8")
].join("\n");
const fullInstructions = fs.readFileSync(fullInstructionsPath, "utf8");
const chromeE2e = fs.readFileSync(chromeE2ePath, "utf8");

const testFiles = fs.readdirSync(path.join(rootDir, "tests"))
  .filter((file) => file.endsWith(".test.js"))
  .map((file) => `tests/${file}`)
  .sort();

for (const testFile of testFiles) {
  assert.match(matrix, new RegExp(escapeRegExp(testFile), "g"), `${testFile} is missing from docs/FEATURE_TEST_MATRIX.md`);
}

assert.match(matrix, /Feature or invariant \| Test cases \| Coverage notes/);
assert.match(matrix, /scripts\/test_all\.sh/);
assert.match(runner, /find tests -maxdepth 1 -name '\*\.test\.js'/);
assert.match(runner, /tests\/chrome_extension_e2e\.test\.js/);
assert.match(docs, /docs\/FEATURE_TEST_MATRIX\.md/);
assert.match(docs, /\.\/scripts\/test_all\.sh/);
assert.match(docs, /Shell helpers do not include a tmux target/);
assert.match(docs, /default `ForAI:host` tmux pane/);
assert.doesNotMatch(docs, /second line target/);
assert.match(docs, /AI_HELPER_FILE_PATH/);
assert.match(docs, /docs\/AI_INSTRUCTIONS_FULL\.md/);
for (const marker of [
  "ai-helper-shell-start",
  "ai-helper-board-start",
  "ai-helper-file-start",
  "ai-helper-drawio-start",
  "ai-helper-agent-roster-start",
  "ai-helper-agent-message-start",
  "ai-helper-agent-task-status-start"
]) {
  assert.match(fullInstructions, new RegExp(marker), `Full AI instructions must include ${marker}`);
}
assert.match(fullInstructions, /configured helper-file directory, which defaults to `\$HOME\/Downloads`/);
assert.doesNotMatch(fullInstructions, /^## (Minimal|Recommended|Project Agent|Multi-Agent Master|Multi-Agent Slave|One-Off Prompt|Test Prompt)$/m);
assert.doesNotMatch(fullInstructions, /`````text/);
assert.match(chromeE2e, /AI_HELPER_FILE_PATH: null/);
assert.match(chromeE2e, /AI_HELPER_FILE_PATH: helperFileOverrideDir/);
assert.match(chromeE2e, /The overridden E2E file must not also be written under Downloads/);

console.log("feature/test matrix tests passed");

function escapeRegExp(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
