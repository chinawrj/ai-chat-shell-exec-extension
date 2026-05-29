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

const matrix = fs.readFileSync(matrixPath, "utf8");
const runner = fs.readFileSync(runnerPath, "utf8");
const docs = [
  fs.readFileSync(readmePath, "utf8"),
  fs.readFileSync(releasePath, "utf8"),
  fs.readFileSync(agentsPath, "utf8")
].join("\n");

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

console.log("feature/test matrix tests passed");

function escapeRegExp(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
