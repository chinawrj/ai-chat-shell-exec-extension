#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  SkillCatalogService,
  getConfiguredSkillRoots,
  getSkillRuntimeVariables
} = require("../server/skill_catalog");

const rootDir = path.join(__dirname, "..");
const bundledSkillsRoot = path.join(rootDir, "skills");
const skillPath = path.join(bundledSkillsRoot, "skill-creator", "SKILL.md");
const installPath = path.join(bundledSkillsRoot, "skill-creator", "install.sh");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-creator-test-"));

main().finally(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function main() {
  assert.equal(fs.lstatSync(skillPath).isFile(), true);
  assert.equal(fs.lstatSync(skillPath).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(installPath).isFile(), true);
  assert.equal(fs.lstatSync(installPath).isSymbolicLink(), false);
  const bundledInstallSource = fs.readFileSync(installPath, "utf8");
  assert.match(bundledInstallSource, /\$\{PWD\}\/SKILL\.md/);
  assert.doesNotMatch(bundledInstallSource, /dirname\s+["']?\$0|\$\{?0\}?/);

  const plural = getConfiguredSkillRoots({
    env: { AI_HELPER_SKILL_PATHS: bundledSkillsRoot },
    cwd: rootDir,
    homeDir: path.join(tempRoot, "home")
  });
  assert.deepEqual(plural.roots, [bundledSkillsRoot]);
  assert.equal(plural.source, "AI_HELPER_SKILL_PATHS");
  assert.equal(plural.explicitlyConfigured, true);

  const pluralService = new SkillCatalogService({
    env: {
      HOME: path.join(tempRoot, "home"),
      AI_HELPER_SKILL_PATHS: bundledSkillsRoot
    },
    cwd: rootDir,
    homeDir: path.join(tempRoot, "home"),
    stateDir: path.join(tempRoot, "plural-state"),
    cacheMs: 0
  });
  const pluralManagement = pluralService.manage();
  assert.equal(pluralManagement.skills[0].installed, false);
  assert.equal(pluralManagement.skills[0].installAvailable, true);
  const pluralList = await installSkillForTest(pluralService, "skill-creator");
  assert.equal(pluralList.ok, true, JSON.stringify(pluralList.errors));
  assert.equal(pluralList.skillCount, 1);
  assert.equal(pluralList.skills[0].id, "skill-creator");
  assert.match(pluralList.skills[0].description, /AI Chat Shell Exec local catalog/);
  assert.match(pluralList.skills[0].description, /not one-off prompts/);

  const loaded = pluralService.load({
    skillId: "skill-creator",
    catalogSha: pluralList.catalogSha
  });
  assertLoadedRoots(loaded, [bundledSkillsRoot], "AI_HELPER_SKILL_PATHS");
  assert.deepEqual(
    loaded.replacedVariables.filter((name) => name.startsWith("AI_HELPER_SKILL_ROOT")),
    ["AI_HELPER_SKILL_ROOTS_JSON", "AI_HELPER_SKILL_ROOT_SOURCE"]
  );
  assert.match(loaded.content, /If multiple roots are available/);
  assert.match(loaded.content, /If the roots JSON is empty, stop/);
  assert.match(loaded.content, /A path outside the resolved roots belongs to a different workflow/);
  assert.match(loaded.content, /Reject traversal, symlinked roots or files/);
  assert.match(loaded.content, /<skill-name>\/install\.sh/);
  assert.match(loaded.content, /return zero only after all required setup succeeds/i);
  assert.match(loaded.content, /immutable snapshot/i);
  assert.match(loaded.content, /working directory is the Skill directory/i);
  assert.match(loaded.content, /never derive the Skill directory from `\$0`/i);
  assert.match(loaded.content, /test -f "\$PWD\/SKILL\.md"/);
  assert.match(loaded.content, /remains unavailable to the AI until they open `View Skills`/i);
  assert.match(loaded.content, /Do not try to trigger installation through an AI helper/i);
  assert.match(loaded.content, /cmd: list/);
  assert.match(loaded.content, /Do not invent `cmd: rescan`/);
  assert.doesNotMatch(loaded.content, /\.claude\/skills/);

  const singularService = new SkillCatalogService({
    env: {
      HOME: path.join(tempRoot, "other-home"),
      AI_HELPER_SKILL_PATH: bundledSkillsRoot
    },
    cwd: rootDir,
    homeDir: path.join(tempRoot, "other-home"),
    stateDir: path.join(tempRoot, "singular-state"),
    cacheMs: 0
  });
  const singularList = await installSkillForTest(singularService, "skill-creator");
  assert.equal(singularList.ok, true, JSON.stringify(singularList.errors));
  assert.equal(singularList.skillCount, 1);
  assert.equal(singularList.skills[0].id, "skill-creator");
  const singularLoad = singularService.load({
    skillId: "skill-creator",
    catalogSha: singularList.catalogSha
  });
  assertLoadedRoots(singularLoad, [bundledSkillsRoot], "AI_HELPER_SKILL_PATH");
  const singularRuntime = getSkillRuntimeVariables({
    env: { AI_HELPER_SKILL_PATH: bundledSkillsRoot },
    cwd: rootDir,
    homeDir: path.join(tempRoot, "other-home")
  });
  assert.deepEqual(JSON.parse(singularRuntime.AI_HELPER_SKILL_ROOTS_JSON), [bundledSkillsRoot]);
  assert.equal(singularRuntime.AI_HELPER_SKILL_ROOT_SOURCE, "AI_HELPER_SKILL_PATH");

  const secondRoot = path.join(tempRoot, "second-root");
  fs.mkdirSync(secondRoot, { recursive: true });
  const multiple = getConfiguredSkillRoots({
    env: { AI_HELPER_SKILL_PATHS: `${bundledSkillsRoot}${path.delimiter}${secondRoot}` },
    cwd: rootDir,
    homeDir: path.join(tempRoot, "home")
  });
  assert.deepEqual(multiple.roots, [bundledSkillsRoot, secondRoot]);
  const multipleService = new SkillCatalogService({
    env: {
      HOME: path.join(tempRoot, "multi-home"),
      AI_HELPER_SKILL_PATHS: `${bundledSkillsRoot}${path.delimiter}${secondRoot}`,
      AI_HELPER_SKILL_ROOTS_JSON: "spoofed-roots",
      AI_HELPER_SKILL_ROOT_SOURCE: "spoofed-source",
      AI_HELPER_SKILL_ENV_ALLOWLIST: "AI_HELPER_SKILL_ROOTS_JSON,AI_HELPER_SKILL_ROOT_SOURCE"
    },
    cwd: rootDir,
    homeDir: path.join(tempRoot, "multi-home"),
    stateDir: path.join(tempRoot, "multi-state"),
    cacheMs: 0
  });
  const multipleList = await installSkillForTest(multipleService, "skill-creator");
  assert.equal(multipleList.ok, true, JSON.stringify(multipleList.errors));
  assert.equal(multipleList.skillCount, 1);
  const multipleLoad = multipleService.load({
    skillId: "skill-creator",
    catalogSha: multipleList.catalogSha
  });
  assertLoadedRoots(multipleLoad, [bundledSkillsRoot, secondRoot], "AI_HELPER_SKILL_PATHS");
  assert.ok(!multipleLoad.content.includes("spoofed-roots"));
  assert.ok(!multipleLoad.content.includes("spoofed-source"));
  const multipleRuntime = getSkillRuntimeVariables({
    env: { AI_HELPER_SKILL_PATHS: `${bundledSkillsRoot}${path.delimiter}${secondRoot}` },
    cwd: rootDir,
    homeDir: path.join(tempRoot, "multi-home")
  });
  assert.deepEqual(JSON.parse(multipleRuntime.AI_HELPER_SKILL_ROOTS_JSON), [bundledSkillsRoot, secondRoot]);
  assert.equal(multipleRuntime.AI_HELPER_SKILL_ROOT_SOURCE, "AI_HELPER_SKILL_PATHS");

  const empty = getConfiguredSkillRoots({
    env: { AI_HELPER_SKILL_PATHS: "" },
    cwd: rootDir,
    homeDir: path.join(tempRoot, "home")
  });
  assert.equal(empty.emptyConfiguration, true);
  assert.deepEqual(empty.roots, []);

  const pluralEmptyWins = getConfiguredSkillRoots({
    env: {
      AI_HELPER_SKILL_PATHS: "",
      AI_HELPER_SKILL_PATH: bundledSkillsRoot
    },
    cwd: rootDir,
    homeDir: path.join(tempRoot, "home")
  });
  assert.equal(pluralEmptyWins.source, "AI_HELPER_SKILL_PATHS");
  assert.equal(pluralEmptyWins.emptyConfiguration, true);
  assert.deepEqual(pluralEmptyWins.roots, []);
  const pluralEmptyRuntime = getSkillRuntimeVariables({
    env: {
      AI_HELPER_SKILL_PATHS: "",
      AI_HELPER_SKILL_PATH: bundledSkillsRoot
    },
    cwd: rootDir,
    homeDir: path.join(tempRoot, "home")
  });
  assert.deepEqual(JSON.parse(pluralEmptyRuntime.AI_HELPER_SKILL_ROOTS_JSON), []);
  assert.equal(pluralEmptyRuntime.AI_HELPER_SKILL_ROOT_SOURCE, "AI_HELPER_SKILL_PATHS");

  const fallbackHome = path.join(tempRoot, "fallback-home");
  const fallback = getConfiguredSkillRoots({ env: {}, cwd: rootDir, homeDir: fallbackHome });
  assert.equal(fallback.source, "default");
  assert.deepEqual(fallback.roots, [path.join(fallbackHome, ".claude", "skills")]);
  const defaultSkillsRoot = fallback.roots[0];
  const defaultSkillDirectory = path.join(defaultSkillsRoot, "skill-creator");
  fs.mkdirSync(defaultSkillDirectory, { recursive: true });
  fs.copyFileSync(skillPath, path.join(defaultSkillDirectory, "SKILL.md"));
  fs.copyFileSync(installPath, path.join(defaultSkillDirectory, "install.sh"));
  const defaultService = new SkillCatalogService({
    env: { HOME: fallbackHome },
    cwd: rootDir,
    homeDir: fallbackHome,
    stateDir: path.join(tempRoot, "default-state"),
    cacheMs: 0
  });
  const defaultList = await installSkillForTest(defaultService, "skill-creator");
  assert.equal(defaultList.ok, true, JSON.stringify(defaultList.errors));
  assert.equal(defaultList.skillCount, 1);
  const defaultLoad = defaultService.load({
    skillId: "skill-creator",
    catalogSha: defaultList.catalogSha
  });
  assertLoadedRoots(defaultLoad, [defaultSkillsRoot], "default");
  const defaultRuntime = getSkillRuntimeVariables({ env: {}, cwd: rootDir, homeDir: fallbackHome });
  assert.deepEqual(JSON.parse(defaultRuntime.AI_HELPER_SKILL_ROOTS_JSON), [defaultSkillsRoot]);
  assert.equal(defaultRuntime.AI_HELPER_SKILL_ROOT_SOURCE, "default");

  console.log("skill-creator Skill tests passed");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertLoadedRoots(load, roots, source) {
  assert.equal(load.ok, true, JSON.stringify(load));
  assert.match(load.content, new RegExp(escapeRegExp(JSON.stringify(roots))));
  assert.match(load.content, new RegExp(escapeRegExp(`Configuration source: \`${source}\``)));
  assert.doesNotMatch(load.content, /\$AI_HELPER_SKILL_(?:ROOTS_JSON|ROOT_SOURCE)/);
}

async function installSkillForTest(service, skillId) {
  const management = service.manage();
  const record = management.skills.find((skill) => skill.id === skillId);
  assert.ok(record, `Expected discovered Skill ${skillId}.`);
  const installed = await service.install({
    skillId,
    skillSha: record.sha,
    installSha: record.installSha,
    catalogSha: management.catalogSha
  });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  return service.list();
}
