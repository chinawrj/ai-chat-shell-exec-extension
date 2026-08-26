#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-protocol-root-"));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-protocol-state-"));
const skillDir = path.join(root, "protocol-skill");
fs.mkdirSync(skillDir, { recursive: true });
const skillPath = path.join(skillDir, "SKILL.md");
fs.writeFileSync(skillPath, [
  "---",
  "name: protocol-skill",
  "description: Exercises the dedicated Skill server protocol.",
  "---",
  "home=$HOME",
  "secret=$NOT_ALLOWED"
].join("\n"));

process.env.AI_CHAT_SHELL_STATE_DIR = stateDir;
process.env.AI_HELPER_SKILL_PATHS = root;
process.env.HOME = "/protocol/home";
process.env.NOT_ALLOWED = "must-not-leak";
process.env.AI_CHAT_SHELL_TMUX_SOCKET = path.join(stateDir, "intentionally-missing-tmux.sock");

const {
  buildHealthResponse,
  handleMessageText
} = require("../server/shell_server");

main()
  .then(() => console.log("server Skill protocol tests passed"))
  .finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

async function main() {
  const health = buildHealthResponse();
  assert.equal(health.skillProtocolVersion, 1);
  assert.equal(health.skillCatalogOk, true, JSON.stringify(health.skillCatalogErrors));
  assert.equal(health.skillCount, 1);
  assert.match(health.skillCatalogSha, /^[a-f0-9]{64}$/);
  assertNoPrivateSkillPaths(health.skillCatalogErrors, "Health catalog diagnostics");

  const status = await request({ type: "skill-catalog-status" });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.type, "skill-catalog-status");
  assert.equal(status.skillProtocolVersion, 1);
  assert.equal(status.skillCount, 1);
  assert.equal(status.skills, undefined, "Status should not unnecessarily disclose the catalog list.");
  assertNoPrivateSkillPaths(status, "Skill status response");

  let list = await request({ type: "skill-catalog-list" });
  assert.equal(list.ok, true, JSON.stringify(list));
  assert.equal(list.type, "skill-catalog-list");
  assert.equal(list.skills.length, 1);
  assert.deepEqual(Object.keys(list.skills[0]).sort(), ["description", "id", "name", "sha"]);
  assert.equal(list.skills[0].id, "protocol-skill");
  assert.equal(list.skills[0].filePath, undefined, "Absolute local paths must not leak in a catalog response.");
  assertNoPrivateSkillPaths(list, "Skill list response");

  fs.appendFileSync(skillPath, "\ncache-probe=true\n");
  const cachedStatus = await request({ type: "skill-catalog-status" });
  assert.equal(cachedStatus.catalogSha, list.catalogSha, "Protocol status should reuse the recent catalog scan by default.");
  const freshStatus = await request({ type: "skill-catalog-status", fresh: true });
  assert.notEqual(freshStatus.catalogSha, list.catalogSha, "Protocol fresh status must bypass the catalog cache.");
  list = await request({ type: "skill-catalog-list" });
  assert.equal(list.catalogSha, freshStatus.catalogSha, "Protocol list must always observe the fresh catalog.");

  const loaded = await request({
    type: "skill-load",
    skillId: "protocol-skill",
    catalogSha: list.catalogSha
  });
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.equal(loaded.type, "skill-load");
  assert.ok(loaded.content.includes("home=/protocol/home"));
  assert.ok(loaded.content.includes("secret=$NOT_ALLOWED"));
  assert.ok(!loaded.content.includes("must-not-leak"));

  const invalidPath = await request({
    type: "skill-load",
    skillId: "../protocol-skill",
    catalogSha: list.catalogSha
  });
  assert.equal(invalidPath.ok, false);
  assert.equal(invalidPath.errorCode, "invalid-skill-id");
  assertNoPrivateSkillPaths(invalidPath, "Invalid Skill operation failure");

  fs.appendFileSync(skillPath, "\nchanged=true\n");
  const stale = await request({
    type: "skill-load",
    skillId: "protocol-skill",
    catalogSha: list.catalogSha
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.errorCode, "stale-catalog");
  assert.notEqual(stale.catalogSha, list.catalogSha);
  assertNoPrivateSkillPaths(stale, "Stale Skill operation failure");

  const rescanned = await request({ type: "skill-catalog-rescan" });
  assert.equal(rescanned.ok, true);
  assert.equal(rescanned.type, "skill-catalog-rescan");
  assert.equal(rescanned.catalogSha, stale.catalogSha);
  assert.equal(rescanned.version, list.version + 1);

  assert.equal(
    fs.existsSync(path.join(stateDir, "shell-ledger.json")),
    false,
    "Skill-only traffic must not enter the shell execution ledger."
  );
}

function request(payload) {
  return handleMessageText(JSON.stringify(payload));
}

function assertNoPrivateSkillPaths(value, label) {
  const serialized = JSON.stringify(value);
  for (const privatePath of [root, stateDir, skillPath]) {
    assert.ok(!serialized.includes(privatePath), `${label} leaked absolute local path ${privatePath}.`);
  }
}
