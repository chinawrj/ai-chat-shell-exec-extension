const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const manifest = require(path.join(root, "extension", "manifest.json"));
const mismatchedVersion = `${manifest.version}.mismatch`;

const result = spawnSync(
  path.join(root, "scripts", "package_release.sh"),
  [mismatchedVersion],
  {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ALLOW_DIRTY: "1",
    },
  },
);

assert.notEqual(result.status, 0, "mismatched release version must fail");
assert.match(
  result.stderr,
  new RegExp(
    `Requested release version ${manifest.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.mismatch does not match extension manifest version`,
  ),
);

const packageResult = spawnSync(
  path.join(root, "scripts", "package_release.sh"),
  [manifest.version],
  {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ALLOW_DIRTY: "1",
    },
  },
);

assert.equal(packageResult.status, 0, packageResult.stderr || packageResult.stdout);
const extensionZip = path.join(
  root,
  "dist",
  "release",
  `v${manifest.version}`,
  `ai-chat-shell-exec-extension-v${manifest.version}-chrome-extension.zip`,
);
assert.ok(fs.existsSync(extensionZip), "extension release archive must be created");

const listResult = spawnSync("unzip", ["-Z1", extensionZip], { encoding: "utf8" });
assert.equal(listResult.status, 0, listResult.stderr || listResult.stdout);
const archiveEntries = new Set(listResult.stdout.trim().split(/\r?\n/));
for (const entry of [
  "drawio/viewer.html",
  "drawio/viewer.js",
  "vendor/drawio/viewer-static.min.js",
  "vendor/drawio/LICENSE",
  "vendor/drawio/ATTRIBUTION.md",
]) {
  assert.ok(archiveEntries.has(entry), `extension release archive must contain ${entry}`);
}

console.log("package release version tests passed");
