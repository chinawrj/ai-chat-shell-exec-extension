const assert = require("assert");
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

console.log("package release version tests passed");
