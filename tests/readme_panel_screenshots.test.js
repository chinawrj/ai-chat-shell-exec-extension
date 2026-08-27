#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const e2eSource = fs.readFileSync(path.join(root, "tests", "chrome_extension_e2e.test.js"), "utf8");
const assetRoot = "docs/release-assets/v0.11.3";
const screenshots = [
  "extension-panel-idle.png",
  "extension-panel-skills-update.png",
  "extension-panel-force.png",
  "extension-panel-running.png",
  "extension-panel-awaiting-user.png",
  "extension-panel-drawio.png",
  "extension-panel-advanced.png",
  "extension-panel-page-binding.png"
];

assert.match(readme, /## Latest Extension Panel Screenshots/);
assert.match(readme, /real unpacked-extension Chrome E2E flow rather than composed mockups/);
assert.ok(
  readme.indexOf("## Latest Extension Panel Screenshots") < readme.indexOf("## Basic Helper Screenshots"),
  "Current panel screenshots must appear before the historical helper-result screenshots."
);
assert.match(e2eSource, /async function savePanelScreenshot\(page, filePath\)/);
assert.match(e2eSource, /ai-chat-shell-exec-screenshot-stage/);

for (const filename of screenshots) {
  const relativePath = `${assetRoot}/${filename}`;
  const absolutePath = path.join(root, relativePath);
  assert.ok(readme.includes(relativePath), `README is missing ${relativePath}.`);
  assert.ok(e2eSource.includes(filename), `Chrome E2E does not generate ${filename}.`);
  assert.ok(fs.existsSync(absolutePath), `Missing README screenshot ${relativePath}.`);

  const image = fs.readFileSync(absolutePath);
  assert.ok(image.length > 1000, `${relativePath} is unexpectedly small.`);
  assert.deepEqual(
    Array.from(image.subarray(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    `${relativePath} is not a PNG.`
  );
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  assert.ok(width >= 600 && width <= 700, `${relativePath} width ${width} is outside the panel-crop bound.`);
  assert.ok(height >= 200 && height <= 1400, `${relativePath} height ${height} is outside the panel-crop bound.`);
}

console.log("README panel screenshot tests passed");
