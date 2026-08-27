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
fs.writeFileSync(path.join(skillDir, "install.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

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
  assert.equal(health.skillProtocolVersion, 3);
  assert.equal(health.skillCatalogOk, true, JSON.stringify(health.skillCatalogErrors));
  assert.equal(health.skillCount, 0);
  assert.equal(health.discoveredSkillCount, 1);
  assert.match(health.skillCatalogSha, /^[a-f0-9]{64}$/);
  assertNoPrivateSkillPaths(health.skillCatalogErrors, "Health catalog diagnostics");

  const status = await request({ type: "skill-catalog-status" });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.equal(status.type, "skill-catalog-status");
  assert.equal(status.skillProtocolVersion, 3);
  assert.equal(status.skillCount, 0);
  assert.equal(status.discoveredSkillCount, 1);
  assert.equal(status.skills, undefined, "Status should not unnecessarily disclose the catalog list.");
  assertNoPrivateSkillPaths(status, "Skill status response");

  let management = await request({ type: "skill-management-list" });
  assert.equal(management.ok, true, JSON.stringify(management));
  assert.equal(management.type, "skill-management-list");
  assert.equal(management.skills.length, 1);
  assert.deepEqual(Object.keys(management.skills[0]).sort(), ["description", "id", "installAvailable", "installSha", "installed", "name", "sha"]);
  assert.equal(management.skills[0].installed, false);
  assert.equal(management.skills[0].installAvailable, true);
  assert.match(management.skills[0].installSha, /^[a-f0-9]{64}$/);

  let list = await request({ type: "skill-catalog-list" });
  assert.equal(list.ok, true, JSON.stringify(list));
  assert.equal(list.type, "skill-catalog-list");
  assert.equal(list.skills.length, 0, "The AI catalog must omit uninstalled Skills.");

  let installed = await request({
    type: "skill-install",
    skillId: "protocol-skill",
    skillSha: management.skills[0].sha,
    installSha: management.skills[0].installSha,
    catalogSha: management.catalogSha
  });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  assert.equal(installed.type, "skill-install");
  assert.equal(installed.exitCode, 0);
  assert.equal(installed.skill.installed, true);

  list = await request({ type: "skill-catalog-list" });
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
  assert.equal(freshStatus.skillCount, 0, "Changing SKILL.md must reset its installed state.");
  management = await request({ type: "skill-management-list" });
  installed = await request({
    type: "skill-install",
    skillId: "protocol-skill",
    skillSha: management.skills[0].sha,
    installSha: management.skills[0].installSha,
    catalogSha: management.catalogSha
  });
  assert.equal(installed.ok, true, JSON.stringify(installed));
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

  const invalidInstall = await request({
    type: "skill-install",
    skillId: "../protocol-skill",
    skillSha: list.skills[0].sha,
    installSha: management.skills[0].installSha,
    catalogSha: list.catalogSha
  });
  assert.equal(invalidInstall.ok, false);
  assert.equal(invalidInstall.errorCode, "invalid-skill-id");
  assertNoPrivateSkillPaths(invalidInstall, "Invalid Skill install failure");

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
