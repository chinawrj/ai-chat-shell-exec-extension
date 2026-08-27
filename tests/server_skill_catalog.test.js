#!/usr/bin/env node

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MAX_LOADED_SKILL_CHARS,
  MAX_SKILL_CATALOG_JSON_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_LOAD_REPLY_CHARS,
  MAX_SKILL_PUBLIC_ISSUES,
  MAX_SKILL_ROOTS,
  MAX_SKILL_SCAN_ENTRIES,
  MAX_SKILL_TRAVERSAL_ISSUES,
  MAX_SKILL_TOTAL_BYTES,
  SKILL_CATALOG_CACHE_MS,
  SkillCatalogService,
  aggregateSkillShas,
  expandSkillEnvironment,
  formatSkillLoadReplyForSizing,
  getConfiguredSkillRoots,
  getSkillEnvironmentAllowlist,
  getSkillRuntimeVariables,
  parseSkillFrontmatter
} = require("../server/skill_catalog");

const temporaryPaths = [];

try {
  testAggregateShaUsesOnlySortedRawFileShasAndKeepsDuplicates();
  testConfiguredRootsAndFrontmatter();
  testCatalogScanningRawShaVersionAndPersistence();
  testCatalogCacheAndFreshOperations();
  testInvalidCatalogsFailClosed();
  testSymlinkAndRootContainmentProtection();
  testFileSizeEncodingDepthAndCountBoundaries();
  testScanWorkAndDiagnosticBoundaries();
  testTotalSizeAndSerializedMetadataBoundaries();
  testDescriptionAndExpandedLoadBoundaries();
  testFormattedSkillLoadReplyBoundaries();
  testEnvironmentExpansionIsAllowlistedAndSinglePass();
  testSkillLoadRequiresCurrentCatalog();
  testCorruptStateIsRebuilt();
  console.log("server Skill catalog tests passed");
} finally {
  for (const target of temporaryPaths.reverse()) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function testAggregateShaUsesOnlySortedRawFileShasAndKeepsDuplicates() {
  const shaA = sha256(Buffer.from("alpha"));
  const shaB = sha256(Buffer.from("beta"));
  assert.equal(aggregateSkillShas([shaA, shaB]), aggregateSkillShas([shaB, shaA]));
  assert.notEqual(
    aggregateSkillShas([shaA]),
    aggregateSkillShas([shaA, shaA]),
    "Duplicate raw files must remain visible to the aggregate SHA."
  );

  const expected = crypto.createHash("sha256");
  for (const sha of [shaA, shaB].sort()) {
    expected.update(`${Buffer.byteLength(sha, "utf8")}:`);
    expected.update(sha);
  }
  assert.equal(aggregateSkillShas([shaA, shaB]), expected.digest("hex"));
}

function testConfiguredRootsAndFrontmatter() {
  const home = makeTempDir("skill-home-");
  const cwd = makeTempDir("skill-cwd-");
  assert.deepEqual(
    getConfiguredSkillRoots({ env: {}, cwd, homeDir: home }).roots,
    [path.join(home, ".claude", "skills")]
  );
  const configured = getConfiguredSkillRoots({
    env: { AI_HELPER_SKILL_PATHS: `./one${path.delimiter}~/two\n./one` },
    cwd,
    homeDir: home
  });
  assert.deepEqual(configured.roots, [path.join(cwd, "one"), path.join(home, "two")]);
  assert.equal(configured.source, "AI_HELPER_SKILL_PATHS");
  assert.equal(configured.explicitlyConfigured, true);
  assert.equal(
    getConfiguredSkillRoots({ env: { AI_HELPER_SKILL_PATH: "" }, cwd, homeDir: home }).emptyConfiguration,
    true
  );

  assert.deepEqual(parseSkillFrontmatter([
    "---",
    "name: quoted-skill",
    "description: \"quoted description\"",
    "---",
    "body"
  ].join("\n")), { name: "quoted-skill", description: "quoted description" });
  assert.deepEqual(parseSkillFrontmatter([
    "---",
    "name: block-skill",
    "description: >",
    "  first line",
    "  second line",
    "---"
  ].join("\n")), { name: "block-skill", description: "first line second line" });
  assert.throws(() => parseSkillFrontmatter("name: missing-envelope"), /frontmatter/i);
  assert.throws(() => parseSkillFrontmatter("---\nname: Upper_Case\ndescription: invalid id\n---"), /name/i);
  assert.throws(() => parseSkillFrontmatter("---\nname: missing-description\n---"), /description/i);
  assert.throws(
    () => parseSkillFrontmatter("---\nname: invalid-quote\ndescription: \"unterminated\n---"),
    /YAML|quoted/i,
    "Malformed YAML quoting must not silently become catalog metadata."
  );
}

function testCatalogScanningRawShaVersionAndPersistence() {
  const root = makeTempDir("skill-root-");
  const stateDir = makeTempDir("skill-state-");
  const alphaPath = writeSkill(root, "nested/alpha", {
    name: "alpha",
    description: "Alpha description",
    body: "Alpha body\n"
  });
  const betaPath = writeSkill(root, "beta", {
    name: "beta",
    description: "Beta description",
    body: "Beta body\n"
  });
  const env = { AI_HELPER_SKILL_PATHS: root };
  const service = new SkillCatalogService({ stateDir, env, cwd: root, homeDir: root });

  const first = service.list();
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  assert.equal(first.version, 1);
  assert.deepEqual(first.skills.map((skill) => skill.id), ["alpha", "beta"]);
  assert.equal(first.skills[0].sha, sha256(fs.readFileSync(alphaPath)));
  assert.equal(first.skills[1].sha, sha256(fs.readFileSync(betaPath)));
  assert.match(first.catalogSha, /^[a-f0-9]{64}$/);

  const same = service.rescan();
  assert.equal(same.catalogSha, first.catalogSha);
  assert.equal(same.version, first.version, "An unchanged scan must not create a catalog version.");
  const restarted = new SkillCatalogService({ stateDir, env, cwd: root, homeDir: root }).list();
  assert.equal(restarted.catalogSha, first.catalogSha);
  assert.equal(restarted.version, first.version, "Catalog version must survive a shell-server restart.");

  const movedDir = path.join(root, "renamed-parent");
  fs.mkdirSync(movedDir);
  fs.renameSync(alphaPath, path.join(movedDir, "SKILL.md"));
  const moved = service.rescan();
  assert.equal(moved.catalogSha, first.catalogSha, "Path-only moves must not affect the raw-SHA aggregate.");
  assert.equal(moved.version, first.version);

  fs.appendFileSync(betaPath, "Changed raw bytes\n");
  const changed = service.rescan();
  assert.notEqual(changed.catalogSha, first.catalogSha);
  assert.equal(changed.version, first.version + 1);

  fs.rmSync(betaPath);
  const deleted = service.rescan();
  assert.notEqual(deleted.catalogSha, changed.catalogSha);
  assert.equal(deleted.version, changed.version + 1);
}

function testCatalogCacheAndFreshOperations() {
  const root = makeTempDir("skill-cache-root-");
  const stateDir = makeTempDir("skill-cache-state-");
  const skillPath = writeSkill(root, "cached", {
    name: "cached",
    description: "Cache freshness coverage",
    body: "revision one"
  });
  const service = new SkillCatalogService({
    stateDir,
    env: { AI_HELPER_SKILL_PATHS: root },
    cwd: root,
    homeDir: root,
    cacheMs: SKILL_CATALOG_CACHE_MS
  });

  const initialStatus = service.status();
  fs.appendFileSync(skillPath, "\nrevision two");
  const cachedStatus = service.status();
  assert.equal(cachedStatus.catalogSha, initialStatus.catalogSha, "Non-fresh status calls must reuse the 10-second scan cache.");
  assert.equal(cachedStatus.version, initialStatus.version);

  const freshStatus = service.status({ force: true });
  assert.notEqual(freshStatus.catalogSha, initialStatus.catalogSha, "A fresh status call must bypass the scan cache.");
  fs.appendFileSync(skillPath, "\nrevision three");
  const freshList = service.list();
  assert.notEqual(freshList.catalogSha, freshStatus.catalogSha, "Catalog list must always scan fresh.");

  fs.appendFileSync(skillPath, "\nrevision four");
  const freshLoad = service.load({ skillId: "cached", catalogSha: freshList.catalogSha });
  assert.equal(freshLoad.ok, false);
  assert.equal(freshLoad.errorCode, "stale-catalog", "Skill load must scan fresh before accepting a catalog SHA.");
  assert.notEqual(freshLoad.catalogSha, freshList.catalogSha);

  fs.appendFileSync(skillPath, "\nrevision five");
  const freshRescan = service.rescan();
  assert.notEqual(freshRescan.catalogSha, freshLoad.catalogSha, "Explicit rescan must always bypass the status cache.");
}

function testInvalidCatalogsFailClosed() {
  const root = makeTempDir("skill-invalid-root-");
  const stateDir = makeTempDir("skill-invalid-state-");
  writeSkill(root, "valid", { name: "valid", description: "Valid", body: "body" });
  writeSkill(root, "duplicate-a", { name: "duplicate", description: "First", body: "a" });
  writeSkill(root, "duplicate-b", { name: "duplicate", description: "Second", body: "b" });
  const malformedPath = path.join(root, "malformed", "SKILL.md");
  fs.mkdirSync(path.dirname(malformedPath), { recursive: true });
  fs.writeFileSync(malformedPath, "---\nname: malformed\n---\nbody\n");

  const service = new SkillCatalogService({
    stateDir,
    env: { AI_HELPER_SKILL_PATHS: root },
    cwd: root,
    homeDir: root
  });
  const list = service.list();
  assert.equal(list.ok, false);
  assert.deepEqual(list.skills.map((skill) => skill.id), ["valid"]);
  assert.ok(list.errors.some((error) => error.code === "duplicate-skill-id"));
  assert.ok(list.errors.some((error) => error.code === "invalid-skill-frontmatter"));
  assert.match(list.catalogSha, /^[a-f0-9]{64}$/);
  assert.equal(
    service.load({ skillId: "valid", catalogSha: list.catalogSha }).errorCode,
    "catalog-invalid",
    "No Skill may load from a partial/unhealthy catalog."
  );

  const explicitMissing = new SkillCatalogService({
    stateDir: makeTempDir("skill-missing-state-"),
    env: { AI_HELPER_SKILL_PATHS: path.join(root, "does-not-exist") },
    cwd: root,
    homeDir: root
  }).list();
  assert.equal(explicitMissing.ok, false);
  assert.ok(explicitMissing.errors.some((error) => error.code === "skill-root-missing"));
  assertNoLocalPathLeak(explicitMissing, [root], "Missing-root diagnostics");

  const implicitMissingHome = makeTempDir("skill-implicit-home-");
  const implicitMissing = new SkillCatalogService({
    stateDir: makeTempDir("skill-implicit-state-"),
    env: {},
    cwd: root,
    homeDir: implicitMissingHome
  }).list();
  assert.equal(implicitMissing.ok, true);
  assert.equal(implicitMissing.skillCount, 0);
  assert.ok(implicitMissing.warnings.some((warning) => warning.code === "skill-root-missing"));

  const emptyExplicit = new SkillCatalogService({
    stateDir: makeTempDir("skill-empty-state-"),
    env: { AI_HELPER_SKILL_PATHS: "" },
    cwd: root,
    homeDir: root
  }).list();
  assert.equal(emptyExplicit.ok, false);
  assert.ok(emptyExplicit.errors.some((error) => error.code === "empty-skill-paths"));
}

function testSymlinkAndRootContainmentProtection() {
  const root = makeTempDir("skill-symlink-root-");
  const outside = makeTempDir("skill-symlink-outside-");
  const stateDir = makeTempDir("skill-symlink-state-");
  const outsideSkill = writeSkill(outside, "outside", {
    name: "outside",
    description: "Must stay outside",
    body: "outside"
  });
  fs.mkdirSync(path.join(root, "linked-file"), { recursive: true });
  fs.symlinkSync(outsideSkill, path.join(root, "linked-file", "SKILL.md"));
  fs.symlinkSync(path.dirname(outsideSkill), path.join(root, "linked-directory"));

  const list = new SkillCatalogService({
    stateDir,
    env: { AI_HELPER_SKILL_PATHS: root },
    cwd: root,
    homeDir: root
  }).list();
  assert.equal(list.ok, false);
  assert.equal(list.skillCount, 0);
  assert.ok(list.errors.filter((error) => error.code === "skill-symlink-rejected").length >= 2);
  assertNoLocalPathLeak(list, [root, outside], "Symlink catalog diagnostics");

  const symlinkRoot = path.join(makeTempDir("skill-root-link-parent-"), "root-link");
  fs.symlinkSync(outside, symlinkRoot);
  const linkedRootList = new SkillCatalogService({
    stateDir: makeTempDir("skill-root-link-state-"),
    env: { AI_HELPER_SKILL_PATHS: symlinkRoot },
    cwd: root,
    homeDir: root
  }).list();
  assert.equal(linkedRootList.ok, false);
  assert.ok(linkedRootList.errors.some((error) => error.code === "invalid-skill-root"));
  assertNoLocalPathLeak(linkedRootList, [symlinkRoot, outside], "Symlink-root diagnostics");
}

function testFileSizeEncodingDepthAndCountBoundaries() {
  const maxSkillBytes = MAX_SKILL_FILE_BYTES;
  const exactRoot = makeTempDir("skill-size-exact-root-");
  writeSkillWithExactBytes(exactRoot, "exact-size", "exact-size", maxSkillBytes);
  const exact = createService(exactRoot, "skill-size-exact-state-").list();
  assert.equal(exact.ok, true, JSON.stringify(exact.errors));
  assert.equal(exact.skillCount, 1, "A SKILL.md exactly at the byte limit must remain valid.");

  const oversizedRoot = makeTempDir("skill-size-over-root-");
  writeSkillWithExactBytes(oversizedRoot, "over-size", "over-size", maxSkillBytes + 1);
  const oversized = createService(oversizedRoot, "skill-size-over-state-").list();
  assert.equal(oversized.ok, false);
  assert.equal(oversized.skillCount, 0);
  assert.ok(oversized.errors.some((error) => error.code === "skill-too-large"));

  const invalidUtf8Root = makeTempDir("skill-utf8-root-");
  const invalidUtf8Dir = path.join(invalidUtf8Root, "invalid-utf8");
  fs.mkdirSync(invalidUtf8Dir, { recursive: true });
  fs.writeFileSync(path.join(invalidUtf8Dir, "SKILL.md"), Buffer.concat([
    Buffer.from("---\nname: invalid-utf8\ndescription: Invalid UTF-8 bytes\n---\n", "utf8"),
    Buffer.from([0xc3, 0x28])
  ]));
  const invalidUtf8 = createService(invalidUtf8Root, "skill-utf8-state-").list();
  assert.equal(invalidUtf8.ok, false);
  assert.ok(invalidUtf8.errors.some((error) => error.code === "invalid-skill-encoding"));

  const depth12Root = makeTempDir("skill-depth12-root-");
  writeSkill(depth12Root, Array.from({ length: 12 }, (_, index) => `d${index + 1}`).join("/"), {
    name: "depth-twelve",
    description: "Allowed maximum depth",
    body: "depth 12"
  });
  const depth12 = createService(depth12Root, "skill-depth12-state-").list();
  assert.equal(depth12.ok, true, JSON.stringify(depth12.errors));
  assert.equal(depth12.skillCount, 1);

  const depth13Root = makeTempDir("skill-depth13-root-");
  writeSkill(depth13Root, Array.from({ length: 13 }, (_, index) => `d${index + 1}`).join("/"), {
    name: "depth-thirteen",
    description: "Rejected over maximum depth",
    body: "depth 13"
  });
  const depth13 = createService(depth13Root, "skill-depth13-state-").list();
  assert.equal(depth13.ok, false);
  assert.equal(depth13.skillCount, 0);
  assert.ok(depth13.errors.some((error) => error.code === "skill-depth-exceeded"));

  const count500Root = makeTempDir("skill-count500-root-");
  writeManySkills(count500Root, 500);
  const count500 = createService(count500Root, "skill-count500-state-").list();
  assert.equal(count500.ok, true, JSON.stringify(count500.errors.slice(0, 3)));
  assert.equal(count500.skillCount, 500, "Exactly the maximum number of Skills must remain valid.");

  const count501Root = makeTempDir("skill-count501-root-");
  writeManySkills(count501Root, 501);
  const count501 = createService(count501Root, "skill-count501-state-").list();
  assert.equal(count501.ok, false, "An extra SKILL.md must never be silently truncated into a healthy catalog.");
  assert.equal(count501.skillCount, 500);
  assert.ok(
    count501.errors.some((error) => error.code === "skill-count-exceeded"),
    "A catalog over the file-count limit must report skill-count-exceeded."
  );
}

function testScanWorkAndDiagnosticBoundaries() {
  const exactRootListBase = makeTempDir("skill-root-count-exact-base-");
  const exactConfiguredRoots = Array.from({ length: MAX_SKILL_ROOTS }, (_, index) => {
    const root = path.join(exactRootListBase, `root-${index}`);
    fs.mkdirSync(root, { recursive: true });
    return root;
  });
  const exactRootCountList = new SkillCatalogService({
    stateDir: makeTempDir("skill-root-count-exact-state-"),
    env: { AI_HELPER_SKILL_PATHS: exactConfiguredRoots.join(path.delimiter) },
    cwd: exactRootListBase,
    homeDir: exactRootListBase
  }).list();
  assert.equal(exactRootCountList.ok, true, JSON.stringify(exactRootCountList.errors));
  assert.equal(exactRootCountList.rootCount, MAX_SKILL_ROOTS);

  const rootListBase = makeTempDir("skill-root-count-base-");
  const configuredRoots = Array.from(
    { length: MAX_SKILL_ROOTS + 1 },
    (_, index) => path.join(rootListBase, `root-${index}`)
  );
  const rootCountService = new SkillCatalogService({
    stateDir: makeTempDir("skill-root-count-state-"),
    env: { AI_HELPER_SKILL_PATHS: configuredRoots.join(path.delimiter) },
    cwd: rootListBase,
    homeDir: rootListBase
  });
  const rootCountList = rootCountService.list();
  assert.equal(rootCountList.ok, false);
  assert.equal(rootCountList.rootCount, MAX_SKILL_ROOTS + 1);
  assert.deepEqual(rootCountList.skills, []);
  assert.ok(rootCountList.errors.some((error) => error.code === "skill-root-count-exceeded"));

  const entryRoot = makeTempDir("skill-entry-limit-root-");
  const runSyntheticEntryScan = (entryCount, statePrefix) => {
    const originalOpendirSync = fs.opendirSync;
    let fakeReadCount = 0;
    fs.opendirSync = function boundedEntryFixture(target, options) {
      if (path.resolve(String(target)) === entryRoot) {
        return {
          readSync() {
            if (fakeReadCount >= entryCount) {
              return null;
            }
            const index = fakeReadCount;
            fakeReadCount += 1;
            return {
              name: `resource-${String(index).padStart(5, "0")}`,
              isSymbolicLink: () => false,
              isDirectory: () => false,
              isFile: () => false
            };
          },
          closeSync() {}
        };
      }
      return originalOpendirSync.call(fs, target, options);
    };
    try {
      return {
        list: createService(entryRoot, statePrefix).list(),
        readCount: () => fakeReadCount
      };
    } finally {
      fs.opendirSync = originalOpendirSync;
    }
  };
  const exactEntryScan = runSyntheticEntryScan(MAX_SKILL_SCAN_ENTRIES, "skill-entry-exact-state-");
  assert.equal(exactEntryScan.list.ok, true, JSON.stringify(exactEntryScan.list.errors));
  assert.equal(exactEntryScan.readCount(), MAX_SKILL_SCAN_ENTRIES);
  const overEntryScan = runSyntheticEntryScan(MAX_SKILL_SCAN_ENTRIES + 1, "skill-entry-limit-state-");
  assert.equal(overEntryScan.list.ok, false);
  assert.equal(overEntryScan.readCount(), MAX_SKILL_SCAN_ENTRIES + 1, "The scanner must stop reading at the first over-limit entry.");
  assert.ok(overEntryScan.list.errors.some((error) => error.code === "skill-scan-entry-limit-exceeded"));

  const nestedEntryRoot = makeTempDir("skill-entry-nested-limit-root-");
  const firstNestedDirectory = path.join(nestedEntryRoot, "directory-00000");
  const originalNestedOpendirSync = fs.opendirSync;
  let rootReadCount = 0;
  let childReadCount = 0;
  let closedDirectoryCount = 0;
  fs.opendirSync = function nestedBoundedEntryFixture(target, options) {
    const resolved = path.resolve(String(target));
    if (resolved === nestedEntryRoot || resolved === firstNestedDirectory) {
      const isRoot = resolved === nestedEntryRoot;
      const available = isRoot ? 6_000 : MAX_SKILL_SCAN_ENTRIES - 6_000 + 1;
      return {
        readSync() {
          const index = isRoot ? rootReadCount : childReadCount;
          if (index >= available) {
            return null;
          }
          if (isRoot) {
            rootReadCount += 1;
          } else {
            childReadCount += 1;
          }
          return {
            name: `${isRoot ? "directory" : "resource"}-${String(index).padStart(5, "0")}`,
            isSymbolicLink: () => false,
            isDirectory: () => isRoot,
            isFile: () => false
          };
        },
        closeSync() {
          closedDirectoryCount += 1;
        }
      };
    }
    return originalNestedOpendirSync.call(fs, target, options);
  };
  let nestedEntryList;
  try {
    nestedEntryList = createService(nestedEntryRoot, "skill-entry-nested-limit-state-").list();
  } finally {
    fs.opendirSync = originalNestedOpendirSync;
  }
  assert.equal(nestedEntryList.ok, false);
  assert.equal(rootReadCount + childReadCount, MAX_SKILL_SCAN_ENTRIES + 1);
  assert.equal(closedDirectoryCount, 2, "Every streamed directory handle must be closed on the over-limit path.");
  assert.ok(nestedEntryList.errors.some((error) => error.code === "skill-scan-entry-limit-exceeded"));

  const traversalRoot = makeTempDir("skill-traversal-issues-root-");
  const traversalTarget = makeTempDir("skill-traversal-issues-target-");
  for (let index = 0; index < MAX_SKILL_TRAVERSAL_ISSUES + 1; index += 1) {
    fs.symlinkSync(traversalTarget, path.join(traversalRoot, `linked-${String(index).padStart(3, "0")}`), "dir");
  }
  const traversalList = createService(traversalRoot, "skill-traversal-issues-state-").list();
  assert.equal(traversalList.ok, false);
  assert.equal(traversalList.errors.length, MAX_SKILL_TRAVERSAL_ISSUES);
  assert.ok(traversalList.errors.some((error) => error.code === "skill-traversal-issue-limit-exceeded"));

  const diagnosticRoot = makeTempDir("skill-public-issues-root-");
  for (let index = 0; index < MAX_SKILL_PUBLIC_ISSUES; index += 1) {
    const directory = path.join(diagnosticRoot, `invalid-${String(index).padStart(3, "0")}`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "SKILL.md"), "missing frontmatter\n");
  }
  const diagnosticService = createService(diagnosticRoot, "skill-public-issues-state-");
  const exactDiagnosticList = diagnosticService.list();
  assert.equal(exactDiagnosticList.ok, false);
  assert.equal(exactDiagnosticList.errors.length, MAX_SKILL_PUBLIC_ISSUES);
  assert.ok(!exactDiagnosticList.errors.some((error) => error.code === "skill-public-issue-limit-exceeded"));
  const overDiagnosticDirectory = path.join(diagnosticRoot, `invalid-${MAX_SKILL_PUBLIC_ISSUES}`);
  fs.mkdirSync(overDiagnosticDirectory, { recursive: true });
  fs.writeFileSync(path.join(overDiagnosticDirectory, "SKILL.md"), "missing frontmatter\n");
  const diagnosticList = diagnosticService.list();
  assert.equal(diagnosticList.ok, false);
  assert.equal(diagnosticList.errors.length, MAX_SKILL_PUBLIC_ISSUES);
  assert.equal(
    diagnosticList.errors.at(-1).code,
    "skill-public-issue-limit-exceeded",
    "Public diagnostics must use one bounded omission sentinel instead of returning an unbounded list."
  );
}

function testTotalSizeAndSerializedMetadataBoundaries() {
  const exactTotalRoot = makeTempDir("skill-total-exact-root-");
  writeSkillsWithExactTotalBytes(exactTotalRoot, MAX_SKILL_TOTAL_BYTES);
  const exactTotal = createService(exactTotalRoot, "skill-total-exact-state-").list();
  assert.equal(exactTotal.ok, true, JSON.stringify(exactTotal.errors));
  assert.ok(exactTotal.skillCount > 1);

  const oversizedTotalRoot = makeTempDir("skill-total-over-root-");
  writeSkillsWithExactTotalBytes(oversizedTotalRoot, MAX_SKILL_TOTAL_BYTES + 1);
  const oversizedTotal = createService(oversizedTotalRoot, "skill-total-over-state-").list();
  assert.equal(oversizedTotal.ok, false, "A catalog one byte over the aggregate limit must fail closed.");
  assert.equal(oversizedTotal.skillCount, 0);
  assert.ok(oversizedTotal.errors.some((error) => error.code === "skill-total-size-exceeded"));

  const plainMetadataRoot = makeTempDir("skill-metadata-plain-root-");
  writeManySkillsWithDescription(plainMetadataRoot, 500, "d".repeat(MAX_SKILL_DESCRIPTION_CHARS));
  const plainService = createService(plainMetadataRoot, "skill-metadata-plain-state-");
  const plainInternal = plainService.scan({ force: true });
  const plainActualChars = serializedPublicCatalogChars(plainInternal);
  assert.equal(plainInternal.catalogMetadataChars, plainActualChars, "The bound must measure the actual JSON sent to the extension.");
  assert.ok(plainActualChars <= MAX_SKILL_CATALOG_JSON_CHARS, `Expected ${plainActualChars} <= ${MAX_SKILL_CATALOG_JSON_CHARS}.`);
  const plainList = plainService.list();
  assert.equal(plainList.ok, true, JSON.stringify(plainList.errors));
  assert.equal(plainList.skills.length, 500, "A near-limit catalog must be returned completely.");

  const escapedMetadataRoot = makeTempDir("skill-metadata-escaped-root-");
  writeManySkillsWithDescription(escapedMetadataRoot, 500, "\\".repeat(MAX_SKILL_DESCRIPTION_CHARS));
  const escapedService = createService(escapedMetadataRoot, "skill-metadata-escaped-state-");
  const escapedInternal = escapedService.scan({ force: true });
  const escapedActualChars = serializedPublicCatalogChars(escapedInternal);
  assert.equal(escapedInternal.catalogMetadataChars, escapedActualChars);
  assert.ok(escapedActualChars > MAX_SKILL_CATALOG_JSON_CHARS, "JSON escaping must count toward the serialized catalog limit.");
  const escapedList = escapedService.list();
  assert.equal(escapedList.ok, false);
  assert.deepEqual(escapedList.skills, [], "An oversized metadata catalog must never expose a partial list.");
  assert.ok(escapedList.errors.some((error) => error.code === "skill-catalog-metadata-too-large"));
}

function testDescriptionAndExpandedLoadBoundaries() {
  const exactDescription = "d".repeat(MAX_SKILL_DESCRIPTION_CHARS);
  assert.equal(
    parseSkillFrontmatter(`---\nname: exact-description\ndescription: ${exactDescription}\n---\nbody`).description.length,
    MAX_SKILL_DESCRIPTION_CHARS,
    "A description exactly at the character limit must remain complete and valid."
  );
  assert.throws(
    () => parseSkillFrontmatter(`---\nname: over-description\ndescription: ${exactDescription}d\n---\nbody`),
    new RegExp(`exceeds ${MAX_SKILL_DESCRIPTION_CHARS}`),
    "A description over the character limit must fail instead of being silently truncated."
  );

  const exactExpanded = createExpansionBoundaryService(MAX_LOADED_SKILL_CHARS);
  const exactList = exactExpanded.service.list();
  assert.equal(exactList.ok, true, JSON.stringify(exactList.errors));
  const exactLoad = exactExpanded.service.load({
    skillId: "expanded-boundary",
    catalogSha: exactList.catalogSha
  });
  assert.equal(exactLoad.ok, true, JSON.stringify(exactLoad));
  assert.equal(
    exactLoad.content.length,
    MAX_LOADED_SKILL_CHARS,
    "Expanded Skill content exactly at the character limit must be returned in full."
  );

  const oversizedExpanded = createExpansionBoundaryService(MAX_LOADED_SKILL_CHARS + 1);
  const oversizedList = oversizedExpanded.service.list();
  assert.equal(oversizedList.ok, true, JSON.stringify(oversizedList.errors));
  const oversizedLoad = oversizedExpanded.service.load({
    skillId: "expanded-boundary",
    catalogSha: oversizedList.catalogSha
  });
  assert.equal(oversizedLoad.ok, false);
  assert.equal(
    oversizedLoad.errorCode,
    "expanded-skill-too-large",
    "Expanded Skill content over the limit must fail instead of being silently truncated."
  );
}

function testFormattedSkillLoadReplyBoundaries() {
  const root = makeTempDir("skill-formatted-reply-root-");
  const stateDir = makeTempDir("skill-formatted-reply-state-");
  const skillId = "formatted-fence";
  const placeholder = "${FENCE_VALUE}";
  const source = [
    "---",
    `name: ${skillId}`,
    "description: Environment-expanded fence serialization boundary",
    "---",
    placeholder
  ].join("\n");
  const fixedExpandedContentChars = source.length - placeholder.length;
  const sizingResponse = {
    ok: true,
    catalogSha: "a".repeat(64),
    skill: { id: skillId, sha: "b".repeat(64) },
    replacedVariables: ["FENCE_VALUE"],
    content: ""
  };
  const emptyReplyChars = formatSkillLoadReplyForSizing(sizingResponse).length;
  let expandedContentChars = MAX_LOADED_SKILL_CHARS;
  while ((MAX_SKILL_LOAD_REPLY_CHARS - emptyReplyChars - expandedContentChars) % 2 !== 0) {
    expandedContentChars -= 1;
  }
  const exactFenceRunChars = ((MAX_SKILL_LOAD_REPLY_CHARS - emptyReplyChars - expandedContentChars) / 2) + 3;
  const valueChars = expandedContentChars - fixedExpandedContentChars;
  assert.ok(exactFenceRunChars > 4 && exactFenceRunChars < valueChars);

  const directory = path.join(root, skillId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), source);
  const env = {
    AI_HELPER_SKILL_PATHS: root,
    AI_HELPER_SKILL_ENV_ALLOWLIST: "FENCE_VALUE",
    FENCE_VALUE: "`".repeat(exactFenceRunChars) + "x".repeat(valueChars - exactFenceRunChars)
  };
  const service = new SkillCatalogService({ stateDir, env, cwd: root, homeDir: root });
  const list = service.list();
  assert.equal(list.ok, true, JSON.stringify(list.errors));
  const exactLoad = service.load({ skillId, catalogSha: list.catalogSha });
  assert.equal(exactLoad.ok, true, JSON.stringify(exactLoad));
  assert.equal(exactLoad.content.length, expandedContentChars);
  assert.equal(exactLoad.replacedVariables.includes("FENCE_VALUE"), true);
  assert.equal(exactLoad.formattedReplyChars, MAX_SKILL_LOAD_REPLY_CHARS);
  assert.equal(formatSkillLoadReplyForSizing(exactLoad).length, MAX_SKILL_LOAD_REPLY_CHARS);

  env.FENCE_VALUE = "`".repeat(exactFenceRunChars + 1) + "x".repeat(valueChars - exactFenceRunChars - 1);
  const oversizedLoad = service.load({ skillId, catalogSha: list.catalogSha });
  assert.equal(oversizedLoad.ok, false);
  assert.equal(
    oversizedLoad.errorCode,
    "formatted-skill-too-large",
    "An allowlisted environment expansion that grows only the dynamic fence over 500k must fail closed."
  );
  assert.equal(oversizedLoad.content, undefined, "The rejected server response must not disclose the oversized expanded body.");
  assertNoLocalPathLeak(oversizedLoad, [root, stateDir], "Formatted Skill load failure");
}

function testEnvironmentExpansionIsAllowlistedAndSinglePass() {
  const env = {
    HOME: "/safe/home",
    CUSTOM_ALLOWED: "expanded-$SECRET",
    SECRET: "must-not-leak",
    AI_HELPER_SKILL_ENV_ALLOWLIST: "CUSTOM_ALLOWED MISSING_ALLOWED invalid-name"
  };
  assert.deepEqual(
    getSkillEnvironmentAllowlist(env).filter((name) => name.startsWith("CUSTOM") || name.startsWith("MISSING")),
    ["CUSTOM_ALLOWED", "MISSING_ALLOWED"]
  );
  const source = [
    "$HOME ${CUSTOM_ALLOWED}",
    "$SECRET ${UNKNOWN}",
    "$ARGUMENTS ${CLAUDE_SESSION_ID} ${CLAUDE_EFFORT} ${CLAUDE_PROJECT_DIR}",
    "$CLAUDE_SKILL_DIR",
    "\\$HOME $(printf unsafe) `printf unsafe`",
    "${MISSING_ALLOWED}"
  ].join("\n");
  const result = expandSkillEnvironment(source, {
    env,
    allowlist: getSkillEnvironmentAllowlist(env),
    skillDir: "/skills/example"
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingVariables, ["MISSING_ALLOWED"]);
  assert.ok(result.content.includes("/safe/home expanded-$SECRET"), "Replacement must be one pass only.");
  assert.ok(result.content.includes("$SECRET ${UNKNOWN}"), "Non-allowlisted values must remain placeholders.");
  assert.ok(result.content.includes("$ARGUMENTS ${CLAUDE_SESSION_ID} ${CLAUDE_EFFORT} ${CLAUDE_PROJECT_DIR}"));
  assert.ok(result.content.includes("/skills/example"));
  assert.ok(result.content.includes("\\$HOME $(printf unsafe) `printf unsafe`"), "Expansion must never execute shell-like text.");
  assert.ok(result.content.includes("${MISSING_ALLOWED}"));
  assert.ok(!result.content.includes("must-not-leak"));

  const runtimeRoot = makeTempDir("skill-runtime-root-");
  const runtimeVariables = getSkillRuntimeVariables({
    env: {
      AI_HELPER_SKILL_PATHS: runtimeRoot,
      AI_HELPER_SKILL_ROOTS_JSON: "attacker-controlled",
      AI_HELPER_SKILL_ROOT_SOURCE: "attacker-controlled"
    },
    cwd: runtimeRoot,
    homeDir: runtimeRoot
  });
  assert.deepEqual(JSON.parse(runtimeVariables.AI_HELPER_SKILL_ROOTS_JSON), [runtimeRoot]);
  assert.equal(runtimeVariables.AI_HELPER_SKILL_ROOT_SOURCE, "AI_HELPER_SKILL_PATHS");
  const runtimeExpanded = expandSkillEnvironment(
    "$AI_HELPER_SKILL_ROOTS_JSON\n$AI_HELPER_SKILL_ROOT_SOURCE",
    {
      env: {
        AI_HELPER_SKILL_ROOTS_JSON: "attacker-controlled",
        AI_HELPER_SKILL_ROOT_SOURCE: "attacker-controlled"
      },
      allowlist: ["AI_HELPER_SKILL_ROOTS_JSON", "AI_HELPER_SKILL_ROOT_SOURCE"],
      runtimeVariables
    }
  );
  assert.equal(runtimeExpanded.ok, true);
  assert.equal(runtimeExpanded.content, `${JSON.stringify([runtimeRoot])}\nAI_HELPER_SKILL_PATHS`);
  assert.deepEqual(runtimeExpanded.replacedVariables, [
    "AI_HELPER_SKILL_ROOTS_JSON",
    "AI_HELPER_SKILL_ROOT_SOURCE"
  ]);
  assert.ok(!runtimeExpanded.content.includes("attacker-controlled"));

  const repeatedRuntimePlaceholder = "$AI_HELPER_SKILL_ROOTS_JSON".repeat(14_000);
  assert.ok(repeatedRuntimePlaceholder.length < MAX_SKILL_FILE_BYTES);
  const boundedRuntimeExpansion = expandSkillEnvironment(repeatedRuntimePlaceholder, {
    runtimeVariables: {
      AI_HELPER_SKILL_ROOTS_JSON: JSON.stringify(["/configured/root/with/a/longer/path"])
    }
  });
  assert.equal(boundedRuntimeExpansion.ok, false);
  assert.equal(boundedRuntimeExpansion.tooLarge, true);
  assert.equal(boundedRuntimeExpansion.content, "", "An oversized expansion must not retain a large partial body.");
}

function testSkillLoadRequiresCurrentCatalog() {
  const root = makeTempDir("skill-load-root-");
  const stateDir = makeTempDir("skill-load-state-");
  const skillPath = writeSkill(root, "loader", {
    name: "loader",
    description: "Load test",
    body: [
      "home=$HOME",
      "custom=${CUSTOM_ALLOWED}",
      "secret=$SECRET",
      "arguments=$ARGUMENTS",
      "dir=$CLAUDE_SKILL_DIR"
    ].join("\n")
  });
  const service = new SkillCatalogService({
    stateDir,
    env: {
      AI_HELPER_SKILL_PATHS: root,
      AI_HELPER_SKILL_ENV_ALLOWLIST: "CUSTOM_ALLOWED",
      HOME: "/safe/home",
      CUSTOM_ALLOWED: "custom-value",
      SECRET: "hidden"
    },
    cwd: root,
    homeDir: root
  });
  const list = service.list();
  const loaded = service.load({ skillId: "loader", catalogSha: list.catalogSha });
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.ok(loaded.content.includes("home=/safe/home"));
  assert.ok(loaded.content.includes("custom=custom-value"));
  assert.ok(loaded.content.includes("secret=$SECRET"));
  assert.ok(loaded.content.includes("arguments=$ARGUMENTS"));
  assert.ok(loaded.content.includes(`dir=${path.dirname(skillPath)}`));
  assert.deepEqual(loaded.replacedVariables, ["CLAUDE_SKILL_DIR", "CUSTOM_ALLOWED", "HOME"]);
  assert.ok(loaded.preservedVariables.includes("ARGUMENTS"));
  assert.ok(loaded.preservedVariables.includes("SECRET"));

  service.env.HOME = "/different/home";
  service.env.CUSTOM_ALLOWED = "different-custom";
  const envOnlyRescan = service.rescan();
  assert.equal(envOnlyRescan.catalogSha, list.catalogSha, "Environment changes must not create an effective/catalog SHA.");
  assert.equal(envOnlyRescan.version, list.version, "Environment changes alone must not increment the Skill catalog version.");
  const envOnlyReload = service.load({ skillId: "loader", catalogSha: list.catalogSha });
  assert.equal(envOnlyReload.ok, true);
  assert.ok(envOnlyReload.content.includes("home=/different/home"));
  assert.ok(envOnlyReload.content.includes("custom=different-custom"));

  assert.equal(service.load({ skillId: "../loader", catalogSha: list.catalogSha }).errorCode, "invalid-skill-id");
  assert.equal(service.load({ skillId: "/loader", catalogSha: list.catalogSha }).errorCode, "invalid-skill-id");
  assert.equal(service.load({ skillId: "loader", catalogSha: "bad" }).errorCode, "invalid-catalog-sha");
  assert.equal(service.load({ skillId: "missing", catalogSha: list.catalogSha }).errorCode, "skill-not-found");

  fs.appendFileSync(skillPath, "\nchanged=true\n");
  const stale = service.load({ skillId: "loader", catalogSha: list.catalogSha });
  assert.equal(stale.ok, false);
  assert.equal(stale.errorCode, "stale-catalog");
  assert.notEqual(stale.catalogSha, list.catalogSha);

  const missingRoot = makeTempDir("skill-load-missing-env-root-");
  writeSkill(missingRoot, "missing-env", {
    name: "missing-env",
    description: "Missing allowed environment variable",
    body: "required=${REQUIRED_BUT_MISSING}"
  });
  const missingService = new SkillCatalogService({
    stateDir: makeTempDir("skill-load-missing-env-state-"),
    env: {
      AI_HELPER_SKILL_PATHS: missingRoot,
      AI_HELPER_SKILL_ENV_ALLOWLIST: "REQUIRED_BUT_MISSING"
    },
    cwd: missingRoot,
    homeDir: missingRoot
  });
  const missingList = missingService.list();
  const missingLoad = missingService.load({ skillId: "missing-env", catalogSha: missingList.catalogSha });
  assert.equal(missingLoad.ok, false);
  assert.equal(missingLoad.errorCode, "missing-skill-environment");
  assert.deepEqual(missingLoad.missingVariables, ["REQUIRED_BUT_MISSING"]);
}

function testCorruptStateIsRebuilt() {
  const root = makeTempDir("skill-state-root-");
  const stateDir = makeTempDir("skill-corrupt-state-");
  writeSkill(root, "state", { name: "state", description: "State", body: "body" });
  const statePath = path.join(stateDir, "skill-catalog-state.json");
  const damagedStates = [
    "not-json\n",
    JSON.stringify({ stateVersion: 999, version: 7, catalogSha: "a".repeat(64), updatedAt: new Date().toISOString() }),
    JSON.stringify({ stateVersion: 1, version: "7", catalogSha: "a".repeat(64), updatedAt: new Date().toISOString() }),
    JSON.stringify({ stateVersion: 1, version: 7, catalogSha: "short", updatedAt: new Date().toISOString() }),
    JSON.stringify({ stateVersion: 1, version: 7, catalogSha: "a".repeat(64), updatedAt: "not-a-date" })
  ];
  for (const damagedState of damagedStates) {
    fs.writeFileSync(statePath, damagedState);
    const list = new SkillCatalogService({
      stateDir,
      env: { AI_HELPER_SKILL_PATHS: root },
      cwd: root,
      homeDir: root
    }).list();
    assert.equal(list.ok, true);
    assert.equal(list.version, 1);
    const repaired = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(repaired.stateVersion, 1);
    assert.equal(repaired.catalogSha, list.catalogSha);
    assert.equal(repaired.version, list.version);
    assert.ok(Number.isFinite(Date.parse(repaired.updatedAt)));
  }
}

function writeSkill(root, relativeDirectory, { name, description, body = "" }) {
  const directory = path.join(root, relativeDirectory);
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, "SKILL.md");
  fs.writeFileSync(filePath, [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    body
  ].join("\n"));
  return filePath;
}

function writeSkillWithExactBytes(root, relativeDirectory, name, byteLength) {
  const directory = path.join(root, relativeDirectory);
  fs.mkdirSync(directory, { recursive: true });
  const prefix = Buffer.from([
    "---",
    `name: ${name}`,
    "description: Exact byte-size boundary coverage",
    "---",
    ""
  ].join("\n"), "utf8");
  assert.ok(prefix.length < byteLength);
  const raw = Buffer.concat([prefix, Buffer.alloc(byteLength - prefix.length, 0x78)]);
  assert.equal(raw.length, byteLength);
  fs.writeFileSync(path.join(directory, "SKILL.md"), raw);
}

function writeManySkills(root, count) {
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(3, "0");
    writeSkill(root, `skill-${suffix}`, {
      name: `skill-${suffix}`,
      description: `Skill number ${index}`,
      body: `body ${index}`
    });
  }
}

function writeManySkillsWithDescription(root, count, description) {
  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(3, "0");
    writeSkill(root, `metadata-${suffix}`, {
      name: `metadata-${suffix}`,
      description,
      body: `body ${index}`
    });
  }
}

function writeSkillsWithExactTotalBytes(root, totalBytes) {
  let remaining = totalBytes;
  let index = 0;
  while (remaining > 0) {
    const byteLength = Math.min(MAX_SKILL_FILE_BYTES, remaining);
    const suffix = String(index).padStart(3, "0");
    writeSkillWithExactBytes(root, `total-${suffix}`, `total-${suffix}`, byteLength);
    remaining -= byteLength;
    index += 1;
  }
}

function serializedPublicCatalogChars(catalog) {
  return JSON.stringify({
    catalogSha: catalog.catalogSha,
    version: catalog.version,
    skills: catalog.skills.map(({ id, name, description, sha }) => ({ id, name, description, sha }))
  }, null, 2).length;
}

function assertNoLocalPathLeak(value, localPaths, label) {
  const serialized = JSON.stringify(value);
  for (const localPath of localPaths) {
    assert.ok(!serialized.includes(String(localPath)), `${label} leaked absolute local path ${localPath}.`);
  }
}

function createService(root, statePrefix) {
  return new SkillCatalogService({
    stateDir: makeTempDir(statePrefix),
    env: { AI_HELPER_SKILL_PATHS: root },
    cwd: root,
    homeDir: root
  });
}

function createExpansionBoundaryService(targetLength) {
  const root = makeTempDir("skill-expanded-root-");
  const directory = path.join(root, "expanded-boundary");
  fs.mkdirSync(directory, { recursive: true });
  const placeholder = "${BOUNDARY_VALUE}";
  const source = [
    "---",
    "name: expanded-boundary",
    "description: Expanded content boundary coverage",
    "---",
    placeholder
  ].join("\n");
  const fixedLength = source.length - placeholder.length;
  assert.ok(targetLength > fixedLength);
  fs.writeFileSync(path.join(directory, "SKILL.md"), source);
  const service = new SkillCatalogService({
    stateDir: makeTempDir("skill-expanded-state-"),
    env: {
      AI_HELPER_SKILL_PATHS: root,
      AI_HELPER_SKILL_ENV_ALLOWLIST: "BOUNDARY_VALUE",
      BOUNDARY_VALUE: "x".repeat(targetLength - fixedLength)
    },
    cwd: root,
    homeDir: root
  });
  return { service };
}

function makeTempDir(prefix) {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(target);
  return target;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
