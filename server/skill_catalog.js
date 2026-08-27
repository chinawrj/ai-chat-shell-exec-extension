const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { TextDecoder } = require("node:util");

const SKILL_FILE_NAME = "SKILL.md";
const SKILL_INSTALL_SCRIPT_NAME = "install.sh";
const SKILL_CATALOG_STATE_VERSION = 2;
const SKILL_CATALOG_STATE_FILE = "skill-catalog-state.json";
const SKILL_INSTALL_STATE_VERSION = 2;
const SKILL_INSTALL_STATE_FILE = "skill-install-state.json";
const SKILL_INSTALL_RECEIPT_KEY_FILE = "skill-install-receipt.key";
const DEFAULT_SKILL_ENV_ALLOWLIST = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR"];
const SKILL_ROOTS_RUNTIME_VARIABLE = "AI_HELPER_SKILL_ROOTS_JSON";
const SKILL_ROOT_SOURCE_RUNTIME_VARIABLE = "AI_HELPER_SKILL_ROOT_SOURCE";
const PRESERVED_CLAUDE_VARIABLES = new Set([
  "ARGUMENTS",
  "CLAUDE_SESSION_ID",
  "CLAUDE_EFFORT",
  "CLAUDE_PROJECT_DIR"
]);
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_FILES = 500;
const MAX_SKILL_DEPTH = 12;
// Keep complete catalog/load replies below the content script's 500k durable
// composer-delivery bound. Oversized Skills fail closed instead of being
// silently truncated after a successful server response.
const MAX_SKILL_FILE_BYTES = 384 * 1024;
const MAX_SKILL_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_SKILL_ROOTS = 64;
const MAX_SKILL_SCAN_ENTRIES = 10_000;
const MAX_SKILL_TRAVERSAL_ISSUES = 100;
const MAX_SKILL_PUBLIC_ISSUES = 100;
const MAX_LOADED_SKILL_CHARS = 450 * 1024;
const MAX_SKILL_LOAD_REPLY_CHARS = 500_000;
const MAX_SKILL_DESCRIPTION_CHARS = 512;
const MAX_SKILL_CATALOG_JSON_CHARS = 350_000;
const SKILL_CATALOG_CACHE_MS = 10_000;
const SKILL_INSTALL_TIMEOUT_MS = 120_000;
const MAX_SKILL_INSTALL_SCRIPT_BYTES = 256 * 1024;
const MAX_SKILL_INSTALL_OUTPUT_CHARS = 20_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

class SkillCatalogService {
  constructor(options = {}) {
    this.stateDir = path.resolve(String(options.stateDir || path.join(process.cwd(), ".state")));
    this.env = options.env || process.env;
    this.cwd = path.resolve(String(options.cwd || process.cwd()));
    this.homeDir = path.resolve(String(options.homeDir || this.env.HOME || os.homedir()));
    this.cacheMs = Math.max(0, Number(options.cacheMs ?? SKILL_CATALOG_CACHE_MS));
    this.runInstallScript = options.runInstallScript || runSkillInstallScript;
    this.current = null;
    this.installTail = Promise.resolve();
  }

  status({ force = false } = {}) {
    return catalogPublicStatus(this.scan({ force }));
  }

  list({ force = true } = {}) {
    const catalog = this.scan({ force });
    return {
      ...catalogPublicStatus(catalog),
      type: "skill-catalog-list",
      skills: catalog.catalogMetadataTooLarge
        ? []
        : catalog.skills.filter((skill) => skill.installed === true).map(publicCatalogSkillRecord)
    };
  }

  manage({ force = true } = {}) {
    const catalog = this.scan({ force });
    return {
      ...catalogPublicStatus(catalog),
      type: "skill-management-list",
      skills: catalog.catalogMetadataTooLarge ? [] : catalog.skills.map(publicManagedSkillRecord)
    };
  }

  rescan() {
    return {
      ...this.manage({ force: true }),
      type: "skill-catalog-rescan"
    };
  }

  install({ skillId, skillSha, installSha, catalogSha } = {}) {
    const task = this.installTail.catch(() => {}).then(() => this.installUnlocked({
      skillId,
      skillSha,
      installSha,
      catalogSha
    }));
    this.installTail = task.catch(() => {});
    return task;
  }

  async installUnlocked({ skillId, skillSha, installSha, catalogSha } = {}) {
    let catalog = this.scan({ force: true });
    const requestedSkillId = String(skillId || "").trim();
    const requestedSkillSha = String(skillSha || "").trim().toLowerCase();
    const requestedInstallSha = String(installSha || "").trim().toLowerCase();
    const requestedCatalogSha = String(catalogSha || "").trim().toLowerCase();
    if (!SKILL_ID_PATTERN.test(requestedSkillId)) {
      return skillError(catalog, "invalid-skill-id", "Skill installation requires a valid skill-id from the current local list.", {}, "skill-install");
    }
    if (!/^[a-f0-9]{64}$/.test(requestedSkillSha)) {
      return skillError(catalog, "invalid-skill-sha", "Skill installation requires the full current skill SHA.", {}, "skill-install");
    }
    if (!/^[a-f0-9]{64}$/.test(requestedCatalogSha)) {
      return skillError(catalog, "invalid-catalog-sha", "Skill installation requires the full current catalog SHA.", {}, "skill-install");
    }
    if (catalog.ok !== true) {
      return skillError(catalog, "catalog-invalid", "The local Skill catalog has validation errors. Rescan after fixing them.", {}, "skill-install");
    }
    if (requestedCatalogSha !== catalog.catalogSha) {
      return skillError(catalog, "stale-catalog", "The local Skill catalog changed before installation. Reopen the Skill list and retry.", {}, "skill-install");
    }
    const skill = catalog.skills.find((record) => record.id === requestedSkillId);
    if (!skill) {
      return skillError(catalog, "skill-not-found", `Skill ${requestedSkillId} is not present in the current local list.`, {}, "skill-install");
    }
    if (requestedSkillSha !== skill.sha) {
      return skillError(catalog, "stale-skill", `Skill ${requestedSkillId} changed before installation. Reopen the Skill list and retry.`, {}, "skill-install");
    }
    if (skill.installAvailable !== true || !skill.installScriptPath) {
      return skillError(catalog, "install-script-unavailable", `Skill ${requestedSkillId} does not provide a safe ${SKILL_INSTALL_SCRIPT_NAME}.`, {}, "skill-install");
    }
    if (!/^[a-f0-9]{64}$/.test(requestedInstallSha)) {
      return skillError(catalog, "invalid-install-sha", "Skill installation requires the full current install.sh SHA.", {}, "skill-install");
    }
    if (requestedInstallSha !== skill.installSha) {
      return skillError(catalog, "stale-installer", `Skill ${requestedSkillId} installer changed before installation. Reopen the Skill list and retry.`, {}, "skill-install");
    }
    if (skill.installed === true) {
      return {
        ok: true,
        type: "skill-install",
        catalogSha: catalog.catalogSha,
        version: catalog.version,
        skill: publicManagedSkillRecord(skill),
        alreadyInstalled: true,
        exitCode: 0
      };
    }

    const startedAt = Date.now();
    let result;
    let snapshot = null;
    try {
      snapshot = createSkillInstallSnapshot({
        stateDir: this.stateDir,
        scriptPath: skill.installScriptPath,
        skillDir: path.dirname(skill.filePath),
        rootPath: skill.rootPath,
        expectedInstallSha: requestedInstallSha
      });
      result = await this.runInstallScript({
        scriptPath: snapshot.scriptPath,
        skillDir: path.dirname(skill.filePath),
        env: buildSkillInstallEnvironment(this.env),
        timeoutMs: SKILL_INSTALL_TIMEOUT_MS,
        maxOutputChars: MAX_SKILL_INSTALL_OUTPUT_CHARS
      });
    } catch (error) {
      console.error(`[skill-install] ${requestedSkillId} launch failed: ${error.message || String(error)}`);
      return skillError(catalog, "installer-launch-failed", `Skill ${requestedSkillId} installer could not be started. Check the shell server console.`, {
        durationMs: Date.now() - startedAt
      }, "skill-install");
    } finally {
      snapshot?.cleanup();
    }
    if (result?.timedOut === true) {
      console.error(`[skill-install] ${requestedSkillId} timed out`);
      return skillError(catalog, "installer-timeout", `Skill ${requestedSkillId} installer exceeded ${SKILL_INSTALL_TIMEOUT_MS / 1000} seconds.`, {
        durationMs: Date.now() - startedAt
      }, "skill-install");
    }
    if (Number(result?.code) !== 0) {
      console.error(`[skill-install] ${requestedSkillId} exited ${String(result?.code)}`);
      return skillError(catalog, "installer-failed", `Skill ${requestedSkillId} installer exited with code ${Number.isInteger(result?.code) ? result.code : "unknown"}. Check the shell server console.`, {
        exitCode: Number.isInteger(result?.code) ? result.code : null,
        durationMs: Date.now() - startedAt
      }, "skill-install");
    }

    this.current = null;
    catalog = this.scan({ force: true });
    const revalidated = catalog.skills.find((record) => record.id === requestedSkillId);
    if (catalog.ok !== true || !revalidated || revalidated.sha !== requestedSkillSha ||
        revalidated.installSha !== requestedInstallSha || catalog.catalogSha !== requestedCatalogSha) {
      return skillError(catalog, "skill-changed-during-install", `Skill ${requestedSkillId} changed while its installer was running and remains uninstalled.`, {
        exitCode: 0,
        durationMs: Date.now() - startedAt
      }, "skill-install");
    }
    try {
      markSkillInstalled(this.stateDir, revalidated);
    } catch (error) {
      console.error(`[skill-install] ${requestedSkillId} state write failed: ${error.message || String(error)}`);
      return skillError(catalog, "install-state-write-failed", `Skill ${requestedSkillId} installer succeeded, but installed state could not be saved.`, {
        exitCode: 0,
        durationMs: Date.now() - startedAt
      }, "skill-install");
    }
    this.current = null;
    const installedCatalog = this.scan({ force: true });
    const installedSkill = installedCatalog.skills.find((record) => record.id === requestedSkillId);
    if (!installedSkill || installedSkill.installed !== true) {
      return skillError(installedCatalog, "install-state-unconfirmed", `Skill ${requestedSkillId} installed state could not be confirmed.`, {
        exitCode: 0,
        durationMs: Date.now() - startedAt
      }, "skill-install");
    }
    return {
      ok: true,
      type: "skill-install",
      catalogSha: installedCatalog.catalogSha,
      version: installedCatalog.version,
      skill: publicManagedSkillRecord(installedSkill),
      alreadyInstalled: false,
      exitCode: 0,
      durationMs: Date.now() - startedAt
    };
  }

  load({ skillId, catalogSha } = {}) {
    let catalog = this.scan({ force: true });
    const requestedSkillId = String(skillId || "").trim();
    const requestedCatalogSha = String(catalogSha || "").trim().toLowerCase();
    if (!SKILL_ID_PATTERN.test(requestedSkillId)) {
      return skillError(catalog, "invalid-skill-id", "Skill load requires a valid skill-id from the current catalog.");
    }
    if (!/^[a-f0-9]{64}$/.test(requestedCatalogSha)) {
      return skillError(catalog, "invalid-catalog-sha", "Skill load requires the full catalog-sha from the current memory catalog.");
    }
    if (catalog.ok !== true) {
      return skillError(catalog, "catalog-invalid", "The local Skill catalog has validation errors. Rescan after fixing them.");
    }
    if (requestedCatalogSha !== catalog.catalogSha) {
      return skillError(catalog, "stale-catalog", "The requested catalog-sha is stale. Request the latest Skill list before loading.");
    }

    let skill = catalog.skills.find((record) => record.id === requestedSkillId);
    if (!skill) {
      return skillError(catalog, "skill-not-found", `Skill ${requestedSkillId} is not present in the current catalog.`);
    }
    if (skill.installed !== true) {
      return skillError(catalog, "skill-not-installed", `Skill ${requestedSkillId} must be installed from the extension's local Skill list before it can be loaded.`);
    }

    let raw;
    try {
      raw = readSafeSkillFile(skill.filePath, skill.rootPath);
    } catch (_error) {
      this.current = null;
      catalog = this.scan({ force: true });
      return skillError(catalog, "skill-read-failed", `Skill ${skill.id} could not be safely revalidated. Rescan the catalog and retry.`);
    }
    const currentSkillSha = sha256(raw);
    if (currentSkillSha !== skill.sha) {
      this.current = null;
      catalog = this.scan({ force: true });
      return skillError(catalog, "stale-catalog", "The Skill changed while it was being loaded. Request the latest Skill list first.");
    }

    let source;
    try {
      source = decodeUtf8(raw, skill.filePath);
    } catch (_error) {
      return skillError(catalog, "invalid-skill-encoding", `Skill ${skill.id} is not valid UTF-8.`);
    }
    const expanded = expandSkillEnvironment(source, {
      env: this.env,
      allowlist: getSkillEnvironmentAllowlist(this.env),
      skillDir: path.dirname(skill.filePath),
      runtimeVariables: getSkillRuntimeVariables({
        env: this.env,
        cwd: this.cwd,
        homeDir: this.homeDir
      })
    });
    if (expanded.tooLarge) {
      return skillError(catalog, "expanded-skill-too-large", `Expanded Skill content exceeds ${MAX_LOADED_SKILL_CHARS} characters.`);
    }
    if (!expanded.ok) {
      return skillError(
        catalog,
        "missing-skill-environment",
        `Skill ${skill.id} requires missing allowed environment variable(s): ${expanded.missingVariables.join(", ")}.`,
        { missingVariables: expanded.missingVariables }
      );
    }
    if (expanded.content.length > MAX_LOADED_SKILL_CHARS) {
      return skillError(catalog, "expanded-skill-too-large", `Expanded Skill content exceeds ${MAX_LOADED_SKILL_CHARS} characters.`);
    }

    const response = {
      ok: true,
      type: "skill-load",
      catalogSha: catalog.catalogSha,
      version: catalog.version,
      skill: publicCatalogSkillRecord(skill),
      content: expanded.content,
      replacedVariables: expanded.replacedVariables,
      preservedVariables: expanded.preservedVariables
    };
    const formattedReplyChars = formatSkillLoadReplyForSizing(response).length;
    if (formattedReplyChars > MAX_SKILL_LOAD_REPLY_CHARS) {
      return skillError(
        catalog,
        "formatted-skill-too-large",
        `Formatted Skill load response exceeds ${MAX_SKILL_LOAD_REPLY_CHARS} characters.`
      );
    }
    return {
      ...response,
      formattedReplyChars
    };
  }

  scan({ force = false } = {}) {
    if (!force && this.current && Date.now() - this.current.scannedAt < this.cacheMs) {
      return this.current;
    }
    const rootsConfig = getConfiguredSkillRoots({
      env: this.env,
      cwd: this.cwd,
      homeDir: this.homeDir
    });
    const scan = scanSkillRoots(rootsConfig);
    let installState;
    try {
      installState = reconcileSkillInstallState(this.stateDir, scan.skills);
    } catch (error) {
      scan.errors.push({
        code: "skill-install-state-unavailable",
        message: "The local Skill installation state could not be read or saved."
      });
      installState = emptySkillInstallState();
    }
    for (const skill of scan.skills) {
      const record = installState.skills[skill.id];
      skill.installed = Boolean(record?.installed === true && record.sha === skill.sha &&
        record.installSha === String(skill.installSha || ""));
    }
    const installedSkillIds = scan.skills.filter((skill) => skill.installed).map((skill) => skill.id);
    const catalogSha = aggregateSkillShas(scan.observedShas);
    const previousState = loadCatalogState(this.stateDir);
    const changed = previousState.catalogSha !== catalogSha ||
      installState.stateChanged === true ||
      !sameStringArray(previousState.installedSkillIds, installedSkillIds);
    const version = changed
      ? Math.max(0, Number(previousState.version || 0)) + 1
      : Math.max(1, Number(previousState.version || 1));
    const updatedAt = changed || !previousState.updatedAt
      ? new Date().toISOString()
      : String(previousState.updatedAt);
    const catalogMetadataChars = JSON.stringify({
      catalogSha,
      version,
      skills: scan.skills.map(publicCatalogSkillRecord)
    }, null, 2).length;
    const catalogMetadataTooLarge = catalogMetadataChars > MAX_SKILL_CATALOG_JSON_CHARS;
    if (catalogMetadataTooLarge) {
      scan.errors.push({
        code: "skill-catalog-metadata-too-large",
        message: `Serialized Skill catalog metadata exceeds ${MAX_SKILL_CATALOG_JSON_CHARS} characters.`
      });
    }
    if (changed || previousState.stateVersion !== SKILL_CATALOG_STATE_VERSION) {
      saveCatalogState(this.stateDir, {
        stateVersion: SKILL_CATALOG_STATE_VERSION,
        version,
        catalogSha,
        installedSkillIds,
        updatedAt
      });
    }

    this.current = {
      ok: scan.errors.length === 0,
      type: "skill-catalog",
      catalogSha,
      version,
      updatedAt,
      skillCount: installedSkillIds.length,
      discoveredSkillCount: scan.skills.length,
      installableSkillCount: scan.skills.filter((skill) => skill.installAvailable).length,
      rootCount: rootsConfig.roots.length,
      configuredBy: rootsConfig.source,
      skills: scan.skills,
      errors: scan.errors,
      warnings: scan.warnings,
      catalogMetadataChars,
      catalogMetadataTooLarge,
      scannedAt: Date.now()
    };
    return this.current;
  }
}

function getConfiguredSkillRoots({ env = process.env, cwd = process.cwd(), homeDir = os.homedir() } = {}) {
  const hasPlural = Object.prototype.hasOwnProperty.call(env, "AI_HELPER_SKILL_PATHS");
  const hasSingular = Object.prototype.hasOwnProperty.call(env, "AI_HELPER_SKILL_PATH");
  const raw = hasPlural
    ? String(env.AI_HELPER_SKILL_PATHS || "")
    : hasSingular
      ? String(env.AI_HELPER_SKILL_PATH || "")
      : path.join(homeDir, ".claude", "skills");
  const source = hasPlural ? "AI_HELPER_SKILL_PATHS" : hasSingular ? "AI_HELPER_SKILL_PATH" : "default";
  const pieces = raw
    .split(new RegExp(`[\\r\\n${escapeRegExp(path.delimiter)}]+`))
    .map((value) => value.trim())
    .filter(Boolean);
  const roots = Array.from(new Set(pieces.map((value) => {
    const expanded = value.replace(/^~(?=$|[\\/])/, homeDir);
    return path.resolve(cwd, expanded);
  })));
  return {
    roots,
    source,
    explicitlyConfigured: hasPlural || hasSingular,
    emptyConfiguration: (hasPlural || hasSingular) && roots.length === 0
  };
}

function scanSkillRoots(config) {
  const candidates = [];
  const errors = [];
  const warnings = [];
  if (config.emptyConfiguration) {
    errors.push({ code: "empty-skill-paths", message: `${config.source} is configured but empty.` });
  }
  if (config.roots.length > MAX_SKILL_ROOTS) {
    errors.push({
      code: "skill-root-count-exceeded",
      message: `Skill scan exceeds ${MAX_SKILL_ROOTS} configured roots.`
    });
    return { skills: [], observedShas: [], errors, warnings };
  }

  const scanState = {
    stop: false,
    countErrorAdded: false,
    entriesVisited: 0,
    entryLimitAdded: false,
    traversalIssueCount: 0,
    traversalIssueLimitAdded: false
  };
  for (let rootIndex = 0; rootIndex < config.roots.length; rootIndex += 1) {
    if (scanState.stop) {
      break;
    }
    const rootPath = config.roots[rootIndex];
    if (!fs.existsSync(rootPath)) {
      const issue = { code: "skill-root-missing", rootIndex, message: `Skill root does not exist: ${rootPath}` };
      (config.explicitlyConfigured ? errors : warnings).push(issue);
      continue;
    }
    let rootStat;
    try {
      rootStat = fs.lstatSync(rootPath);
    } catch (error) {
      errors.push({ code: "skill-root-unreadable", rootIndex, message: error.message || String(error) });
      continue;
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      errors.push({ code: "invalid-skill-root", rootIndex, message: `Skill root must be a real directory, not a symlink: ${rootPath}` });
      continue;
    }
    walkSkillRoot(rootPath, rootPath, rootIndex, candidates, errors, 0, scanState);
  }

  const observedShas = [];
  const parsed = [];
  let totalSkillBytes = 0;
  for (const candidate of candidates) {
    try {
      const stat = fs.lstatSync(candidate.filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Skill file must be a real regular file: ${candidate.filePath}`);
      }
      totalSkillBytes += stat.size;
    } catch (error) {
      errors.push({ code: "unsafe-skill-file", file: candidate.relativePath, message: error.message || String(error) });
    }
  }
  if (totalSkillBytes > MAX_SKILL_TOTAL_BYTES) {
    errors.push({
      code: "skill-total-size-exceeded",
      message: `Skill scan exceeds ${MAX_SKILL_TOTAL_BYTES} total bytes.`
    });
    return { skills: [], observedShas: [], errors, warnings };
  }
  for (const candidate of candidates) {
    let raw;
    try {
      raw = readSafeSkillFile(candidate.filePath, candidate.rootPath);
    } catch (error) {
      errors.push({ code: "unsafe-skill-file", file: candidate.relativePath, message: error.message || String(error) });
      continue;
    }
    const skillSha = sha256(raw);
    observedShas.push(skillSha);
    if (raw.length > MAX_SKILL_FILE_BYTES) {
      errors.push({ code: "skill-too-large", file: candidate.relativePath, sha: skillSha, message: `${candidate.relativePath} exceeds ${MAX_SKILL_FILE_BYTES} bytes.` });
      continue;
    }
    let source;
    try {
      source = decodeUtf8(raw, candidate.filePath);
    } catch (error) {
      errors.push({ code: "invalid-skill-encoding", file: candidate.relativePath, sha: skillSha, message: error.message || String(error) });
      continue;
    }
    let metadata;
    try {
      metadata = parseSkillFrontmatter(source);
    } catch (error) {
      errors.push({ code: "invalid-skill-frontmatter", file: candidate.relativePath, sha: skillSha, message: error.message || String(error) });
      continue;
    }
    parsed.push({
      id: metadata.name,
      name: metadata.name,
      description: metadata.description,
      sha: skillSha,
      filePath: candidate.filePath,
      rootPath: candidate.rootPath,
      relativePath: candidate.relativePath,
      rootIndex: candidate.rootIndex,
      ...inspectSkillInstallScript(path.dirname(candidate.filePath), candidate.rootPath)
    });
  }

  const byId = new Map();
  for (const skill of parsed) {
    const list = byId.get(skill.id) || [];
    list.push(skill);
    byId.set(skill.id, list);
  }
  const duplicateIds = new Set();
  for (const [id, list] of byId) {
    if (list.length > 1) {
      duplicateIds.add(id);
      errors.push({
        code: "duplicate-skill-id",
        skillId: id,
        message: `Duplicate Skill name ${id} appears in ${list.map((skill) => skill.relativePath).join(", ")}.`
      });
    }
  }
  const skills = parsed
    .filter((skill) => !duplicateIds.has(skill.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { skills, observedShas, errors, warnings };
}

function walkSkillRoot(rootPath, currentPath, rootIndex, candidates, errors, depth = 0, scanState = { stop: false, countErrorAdded: false }) {
  if (scanState.stop) {
    return;
  }
  if (depth > MAX_SKILL_DEPTH) {
    addTraversalIssue(errors, { code: "skill-depth-exceeded", message: `Skill scan exceeded depth ${MAX_SKILL_DEPTH} under ${rootPath}.` }, scanState);
    return;
  }
  const entries = readSkillDirectoryEntriesBounded(currentPath, errors, scanState);
  if (!entries) {
    return;
  }
  for (const entry of entries) {
    const entryPath = path.join(currentPath, entry.name);
    if (entry.isSymbolicLink()) {
      let pointsToDirectory = false;
      try {
        pointsToDirectory = fs.statSync(entryPath).isDirectory();
      } catch (_error) {
        // A broken non-SKILL.md resource symlink is outside the catalog.
      }
      if (entry.name === SKILL_FILE_NAME || pointsToDirectory) {
        addTraversalIssue(errors, { code: "skill-symlink-rejected", message: `Symlinked Skill files and directories are not allowed: ${entryPath}` }, scanState);
        if (scanState.stop) {
          return;
        }
      }
      continue;
    }
    if (entry.isDirectory()) {
      walkSkillRoot(rootPath, entryPath, rootIndex, candidates, errors, depth + 1, scanState);
      if (scanState.stop) {
        return;
      }
      continue;
    }
    if (entry.isFile() && entry.name === SKILL_FILE_NAME) {
      if (candidates.length >= MAX_SKILL_FILES) {
        if (!scanState.countErrorAdded) {
          errors.push({ code: "skill-count-exceeded", message: `Skill scan exceeded ${MAX_SKILL_FILES} SKILL.md files.` });
          scanState.countErrorAdded = true;
        }
        scanState.stop = true;
        return;
      }
      candidates.push({
        filePath: entryPath,
        rootPath,
        rootIndex,
        relativePath: path.relative(rootPath, entryPath).split(path.sep).join("/")
      });
    }
  }
}

function readSkillDirectoryEntriesBounded(currentPath, errors, scanState) {
  const entries = [];
  let directory;
  try {
    directory = fs.opendirSync(currentPath);
    while (true) {
      const entry = directory.readSync();
      if (!entry) {
        break;
      }
      if (Number(scanState.entriesVisited || 0) >= MAX_SKILL_SCAN_ENTRIES) {
        if (!scanState.entryLimitAdded) {
          errors.push({
            code: "skill-scan-entry-limit-exceeded",
            message: `Skill scan exceeds ${MAX_SKILL_SCAN_ENTRIES} directory entries.`
          });
          scanState.entryLimitAdded = true;
        }
        scanState.stop = true;
        return null;
      }
      entries.push(entry);
      scanState.entriesVisited = Number(scanState.entriesVisited || 0) + 1;
    }
  } catch (error) {
    addTraversalIssue(errors, { code: "skill-directory-unreadable", message: error.message || String(error) }, scanState);
    return null;
  } finally {
    try {
      directory?.closeSync();
    } catch (_error) {
      // The scan already has all entries it will use; close is best-effort.
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function addTraversalIssue(errors, issue, scanState) {
  scanState.traversalIssueCount = Number(scanState.traversalIssueCount || 0);
  if (scanState.traversalIssueCount < MAX_SKILL_TRAVERSAL_ISSUES - 1) {
    errors.push(issue);
    scanState.traversalIssueCount += 1;
    return;
  }
  if (!scanState.traversalIssueLimitAdded) {
    errors.push({
      code: "skill-traversal-issue-limit-exceeded",
      message: `Skill scan stopped after ${MAX_SKILL_TRAVERSAL_ISSUES} traversal diagnostics.`
    });
    scanState.traversalIssueLimitAdded = true;
    scanState.traversalIssueCount += 1;
  }
  scanState.stop = true;
}

function readSafeSkillFile(filePath, rootPath) {
  const rootRealPath = fs.realpathSync(rootPath);
  const fileStat = fs.lstatSync(filePath);
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error(`Skill file must be a real regular file: ${filePath}`);
  }
  const fileRealPath = fs.realpathSync(filePath);
  const relative = path.relative(rootRealPath, fileRealPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Skill file escapes its configured root: ${filePath}`);
  }
  return fs.readFileSync(fileRealPath);
}

function inspectSkillInstallScript(skillDir, rootPath) {
  const scriptPath = path.join(skillDir, SKILL_INSTALL_SCRIPT_NAME);
  try {
    const inspected = readSafeSkillInstallScript(scriptPath, skillDir, rootPath);
    return {
      installAvailable: true,
      installScriptPath: inspected.scriptPath,
      installSha: inspected.installSha
    };
  } catch (_error) {
    return { installAvailable: false, installScriptPath: "", installSha: "" };
  }
}

function readSafeSkillInstallScript(scriptPath, skillDir, rootPath) {
  const rootRealPath = fs.realpathSync(rootPath);
  const skillDirRealPath = fs.realpathSync(skillDir);
  const relativeSkillDir = path.relative(rootRealPath, skillDirRealPath);
  if (relativeSkillDir.startsWith("..") || path.isAbsolute(relativeSkillDir)) {
    throw new Error("Skill install directory escapes its configured root.");
  }
  const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fs.openSync(scriptPath, fs.constants.O_RDONLY | noFollow);
    const openedStat = fs.fstatSync(fd);
    if (!openedStat.isFile() || openedStat.size > MAX_SKILL_INSTALL_SCRIPT_BYTES) {
      throw new Error("Skill install script must be a bounded regular file.");
    }
    const scriptRealPath = fs.realpathSync(scriptPath);
    const relativeScript = path.relative(skillDirRealPath, scriptRealPath);
    if (!relativeScript || relativeScript.startsWith("..") || path.isAbsolute(relativeScript)) {
      throw new Error("Skill install script escapes its Skill directory.");
    }
    const currentStat = fs.statSync(scriptRealPath);
    if (!currentStat.isFile() || currentStat.dev !== openedStat.dev || currentStat.ino !== openedStat.ino) {
      throw new Error("Skill install script changed while it was opened.");
    }
    const content = fs.readFileSync(fd);
    const finalStat = fs.fstatSync(fd);
    if (!finalStat.isFile() || finalStat.dev !== openedStat.dev || finalStat.ino !== openedStat.ino ||
        finalStat.size !== openedStat.size || content.length !== finalStat.size ||
        finalStat.size > MAX_SKILL_INSTALL_SCRIPT_BYTES) {
      throw new Error("Skill install script changed while it was read.");
    }
    return {
      scriptPath: scriptRealPath,
      content,
      installSha: sha256(content)
    };
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function createSkillInstallSnapshot({ stateDir, scriptPath, skillDir, rootPath, expectedInstallSha } = {}) {
  const inspected = readSafeSkillInstallScript(scriptPath, skillDir, rootPath);
  if (inspected.installSha !== expectedInstallSha) {
    throw new Error("Skill install script changed before its execution snapshot was created.");
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const snapshotDir = fs.mkdtempSync(path.join(stateDir, "skill-install-run-"));
  fs.chmodSync(snapshotDir, 0o700);
  const snapshotPath = path.join(snapshotDir, SKILL_INSTALL_SCRIPT_NAME);
  try {
    fs.writeFileSync(snapshotPath, inspected.content, { flag: "wx", mode: 0o400 });
    fs.chmodSync(snapshotPath, 0o400);
  } catch (error) {
    fs.rmSync(snapshotDir, { recursive: true, force: true });
    throw error;
  }
  let cleaned = false;
  return {
    scriptPath: snapshotPath,
    installSha: inspected.installSha,
    cleanup() {
      if (cleaned) {
        return;
      }
      cleaned = true;
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    }
  };
}

function buildSkillInstallEnvironment(env = process.env) {
  const result = {
    PATH: String(env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin")
  };
  for (const name of ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"]) {
    if (Object.prototype.hasOwnProperty.call(env, name) && env[name] !== undefined) {
      result[name] = String(env[name]);
    }
  }
  return result;
}

function runSkillInstallScript({
  scriptPath,
  skillDir,
  env = {},
  timeoutMs = SKILL_INSTALL_TIMEOUT_MS,
  maxOutputChars = MAX_SKILL_INSTALL_OUTPUT_CHARS
} = {}) {
  let safeScriptPath;
  let safeSkillDir;
  try {
    const stat = fs.lstatSync(scriptPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_SKILL_INSTALL_SCRIPT_BYTES) {
      throw new Error("Skill install snapshot failed safety validation.");
    }
    safeScriptPath = fs.realpathSync(scriptPath);
    safeSkillDir = fs.realpathSync(skillDir);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", [safeScriptPath], {
      cwd: safeSkillDir,
      env: { ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    const appendBounded = (current, chunk) => {
      if (current.length >= maxOutputChars) {
        return current;
      }
      return (current + String(chunk || "")).slice(0, maxOutputChars);
    };
    child.stdout?.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch (_error) {
        child.kill("SIGKILL");
      }
    }, Math.max(1, Number(timeoutMs || SKILL_INSTALL_TIMEOUT_MS)));
    timeout.unref?.();
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ code, signal: signal || "", timedOut, stdout, stderr });
    });
  });
}

function parseSkillFrontmatter(source) {
  const lines = String(source || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  if (lines[0] !== "---") {
    throw new Error("SKILL.md must start with YAML frontmatter delimited by ---. ");
  }
  const endIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (endIndex < 0) {
    throw new Error("SKILL.md YAML frontmatter is missing its closing --- line.");
  }
  const values = {};
  for (let index = 1; index < endIndex; index += 1) {
    const line = lines[index];
    if (!line || /^\s/.test(line) || line.trimStart().startsWith("#")) {
      continue;
    }
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (!match) {
      continue;
    }
    const key = match[1];
    const rawValue = match[2] || "";
    if (rawValue === "|" || rawValue === ">" || rawValue.startsWith("|-") || rawValue.startsWith(">-")) {
      const block = [];
      let next = index + 1;
      while (next < endIndex && (!lines[next] || /^\s/.test(lines[next]))) {
        block.push(lines[next]);
        next += 1;
      }
      index = next - 1;
      const normalized = dedentYamlBlock(block);
      values[key] = rawValue.startsWith(">")
        ? normalized.split("\n").map((value) => value.trim()).filter(Boolean).join(" ")
        : normalized.trim();
    } else {
      values[key] = parseYamlScalar(rawValue);
    }
  }
  const name = String(values.name || "").trim();
  const description = String(values.description || "").trim();
  if (!SKILL_ID_PATTERN.test(name)) {
    throw new Error(`Skill name must match ${SKILL_ID_PATTERN.source}.`);
  }
  if (!description) {
    throw new Error("Skill description is required in YAML frontmatter.");
  }
  if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
    throw new Error(`Skill description exceeds ${MAX_SKILL_DESCRIPTION_CHARS} characters.`);
  }
  return { name, description };
}

function parseYamlScalar(value) {
  const text = String(value || "").trim();
  if ((text.startsWith('"') || text.endsWith('"')) && !(text.startsWith('"') && text.endsWith('"'))) {
    throw new Error("Unterminated double-quoted YAML scalar in Skill frontmatter.");
  }
  if ((text.startsWith("'") || text.endsWith("'")) && !(text.startsWith("'") && text.endsWith("'"))) {
    throw new Error("Unterminated single-quoted YAML scalar in Skill frontmatter.");
  }
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch (_error) {
      throw new Error("Invalid double-quoted YAML scalar in Skill frontmatter.");
    }
  }
  if (text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

function dedentYamlBlock(lines) {
  const nonEmpty = lines.filter((line) => String(line).trim());
  const indent = nonEmpty.length
    ? Math.min(...nonEmpty.map((line) => /^\s*/.exec(line)?.[0].length || 0))
    : 0;
  return lines.map((line) => String(line).slice(indent)).join("\n");
}

function expandSkillEnvironment(source, {
  env = process.env,
  allowlist = [],
  skillDir = "",
  runtimeVariables = {},
  maxChars = MAX_LOADED_SKILL_CHARS
} = {}) {
  const allowed = new Set(Array.from(allowlist || []).map((value) => String(value || "").trim()).filter(Boolean));
  const missing = new Set();
  const replaced = new Set();
  const preserved = new Set();
  const input = String(source || "");
  const limit = Math.max(0, Number.isFinite(Number(maxChars)) ? Math.floor(Number(maxChars)) : MAX_LOADED_SKILL_CHARS);
  if (input.length > limit) {
    return {
      ok: false,
      tooLarge: true,
      content: "",
      missingVariables: [],
      replacedVariables: [],
      preservedVariables: []
    };
  }

  const chunks = [];
  let outputChars = 0;
  let cursor = 0;
  let tooLarge = false;
  const placeholderPattern = /\\?\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
  let placeholder;
  while ((placeholder = placeholderPattern.exec(input)) !== null) {
    const [match, braced, bare] = placeholder;
    const literal = input.slice(cursor, placeholder.index);
    let replacement;
    if (match.startsWith("\\$")) {
      replacement = match;
    } else {
      const name = braced || bare;
      if (name === "CLAUDE_SKILL_DIR") {
        replaced.add(name);
        replacement = String(skillDir);
      } else if (Object.prototype.hasOwnProperty.call(runtimeVariables, name)) {
        replaced.add(name);
        replacement = String(runtimeVariables[name]);
      } else if (PRESERVED_CLAUDE_VARIABLES.has(name) || !allowed.has(name)) {
        preserved.add(name);
        replacement = match;
      } else if (!Object.prototype.hasOwnProperty.call(env, name) || env[name] === undefined) {
        missing.add(name);
        replacement = match;
      } else {
        replaced.add(name);
        replacement = String(env[name]);
      }
    }
    if (outputChars + literal.length + replacement.length > limit) {
      tooLarge = true;
      break;
    }
    chunks.push(literal, replacement);
    outputChars += literal.length + replacement.length;
    cursor = placeholderPattern.lastIndex;
  }
  if (!tooLarge) {
    const trailing = input.slice(cursor);
    if (outputChars + trailing.length > limit) {
      tooLarge = true;
    } else {
      chunks.push(trailing);
    }
  }
  return {
    ok: missing.size === 0 && !tooLarge,
    tooLarge,
    content: tooLarge ? "" : chunks.join(""),
    missingVariables: Array.from(missing).sort(),
    replacedVariables: Array.from(replaced).sort(),
    preservedVariables: Array.from(preserved).sort()
  };
}

function getSkillRuntimeVariables({ env = process.env, cwd = process.cwd(), homeDir = os.homedir() } = {}) {
  const config = getConfiguredSkillRoots({ env, cwd, homeDir });
  return {
    [SKILL_ROOTS_RUNTIME_VARIABLE]: JSON.stringify(config.roots),
    [SKILL_ROOT_SOURCE_RUNTIME_VARIABLE]: config.source
  };
}

function getSkillEnvironmentAllowlist(env = process.env) {
  const configured = String(env.AI_HELPER_SKILL_ENV_ALLOWLIST || "")
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter((value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value));
  return Array.from(new Set([...DEFAULT_SKILL_ENV_ALLOWLIST, ...configured]));
}

function aggregateSkillShas(shas) {
  const hash = crypto.createHash("sha256");
  const sorted = Array.from(shas || []).map(String).sort();
  for (const sha of sorted) {
    hash.update(`${Buffer.byteLength(sha, "utf8")}:`);
    hash.update(sha);
  }
  return hash.digest("hex");
}

function formatSkillLoadReplyForSizing(response) {
  const skill = response?.skill || {};
  const replaced = Array.isArray(response?.replacedVariables) && response.replacedVariables.length > 0
    ? response.replacedVariables.join(", ")
    : "none";
  return [
    "Local Skill load result:",
    `skill-id: ${String(skill.id || "")}`,
    `skill-sha: ${String(skill.sha || "")}`,
    `catalog-sha: ${String(response?.catalogSha || "")}`,
    `environment variables replaced: ${replaced}`,
    "",
    wrapSkillOutputForSizing(String(response?.content || "")),
    "",
    "Use the loaded instructions only for the current task. The fixed memory entry remains a catalog, not a copy of this body."
  ].join("\n");
}

function wrapSkillOutputForSizing(content) {
  const text = String(content || "");
  const fence = "`".repeat(Math.max(4, maxBacktickRunLength(text) + 1));
  return `${fence}skill-output\n${text}\n${fence}`;
}

function maxBacktickRunLength(text) {
  let maximum = 0;
  const pattern = /`+/g;
  let match;
  while ((match = pattern.exec(String(text || ""))) !== null) {
    maximum = Math.max(maximum, match[0].length);
  }
  return maximum;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function decodeUtf8(buffer, filePath) {
  try {
    return UTF8_DECODER.decode(buffer);
  } catch (_error) {
    throw new Error(`Skill file is not valid UTF-8: ${filePath}`);
  }
}

function loadCatalogState(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, SKILL_CATALOG_STATE_FILE), "utf8"));
    const valid = parsed &&
      typeof parsed === "object" &&
      [1, SKILL_CATALOG_STATE_VERSION].includes(parsed.stateVersion) &&
      Number.isSafeInteger(parsed.version) &&
      parsed.version >= 1 &&
      /^[a-f0-9]{64}$/.test(String(parsed.catalogSha || "")) &&
      typeof parsed.updatedAt === "string" &&
      Number.isFinite(Date.parse(parsed.updatedAt));
    if (!valid) {
      return {};
    }
    return {
      ...parsed,
      installedSkillIds: Array.isArray(parsed.installedSkillIds) &&
        parsed.installedSkillIds.every((value) => SKILL_ID_PATTERN.test(String(value)))
        ? Array.from(new Set(parsed.installedSkillIds.map(String))).sort()
        : []
    };
  } catch (_error) {
    return {};
  }
}

function saveCatalogState(stateDir, state) {
  fs.mkdirSync(stateDir, { recursive: true });
  const statePath = path.join(stateDir, SKILL_CATALOG_STATE_FILE);
  const tempPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, statePath);
}

function emptySkillInstallState() {
  return {
    schemaVersion: SKILL_INSTALL_STATE_VERSION,
    updatedAt: "",
    skills: {}
  };
}

function loadSkillInstallState(stateDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(stateDir, SKILL_INSTALL_STATE_FILE), "utf8"));
    if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== SKILL_INSTALL_STATE_VERSION ||
        typeof parsed.skills !== "object" || !parsed.skills || Array.isArray(parsed.skills)) {
      return { ...emptySkillInstallState(), valid: false };
    }
    const skills = {};
    for (const [id, value] of Object.entries(parsed.skills).sort(([left], [right]) => left.localeCompare(right))) {
      if (!SKILL_ID_PATTERN.test(id) || !value || typeof value !== "object" ||
          !/^[a-f0-9]{64}$/.test(String(value.sha || "")) ||
          !/^(?:[a-f0-9]{64})?$/.test(String(value.installSha || "")) ||
          typeof value.installed !== "boolean" ||
          (value.installed === true && (!/^[a-f0-9]{64}$/.test(String(value.installSha || "")) ||
            !/^[a-f0-9]{64}$/.test(String(value.receipt || "")) ||
            typeof value.installedAt !== "string" || !Number.isFinite(Date.parse(value.installedAt))))) {
        return { ...emptySkillInstallState(), valid: false };
      }
      skills[id] = {
        sha: String(value.sha),
        installSha: String(value.installSha || ""),
        installed: value.installed === true,
        installedAt: value.installed === true && typeof value.installedAt === "string" && Number.isFinite(Date.parse(value.installedAt))
          ? value.installedAt
          : "",
        receipt: value.installed === true ? String(value.receipt || "") : ""
      };
    }
    return {
      schemaVersion: SKILL_INSTALL_STATE_VERSION,
      updatedAt: typeof parsed.updatedAt === "string" && Number.isFinite(Date.parse(parsed.updatedAt)) ? parsed.updatedAt : "",
      skills,
      valid: true
    };
  } catch (_error) {
    return { ...emptySkillInstallState(), valid: false };
  }
}

function reconcileSkillInstallState(stateDir, skills) {
  const previous = loadSkillInstallState(stateDir);
  let receiptKey = null;
  if (Object.entries(previous.skills).some(([, record]) => record.installed === true)) {
    try {
      receiptKey = loadSkillInstallReceiptKey(stateDir, { create: false });
    } catch (_error) {
      receiptKey = null;
    }
  }
  const nextSkills = {};
  for (const skill of Array.from(skills || []).sort((a, b) => a.id.localeCompare(b.id))) {
    const previousRecord = previous.skills[skill.id];
    const unchanged = previousRecord?.sha === skill.sha &&
      previousRecord?.installSha === String(skill.installSha || "");
    const installed = Boolean(unchanged && skill.installAvailable === true && previousRecord.installed === true &&
      receiptKey && verifySkillInstallReceipt(receiptKey, skill.id, previousRecord));
    nextSkills[skill.id] = {
      sha: skill.sha,
      installSha: String(skill.installSha || ""),
      installed,
      installedAt: installed ? String(previousRecord.installedAt || "") : "",
      receipt: installed ? String(previousRecord.receipt || "") : ""
    };
  }
  const changed = previous.valid !== true || JSON.stringify(previous.skills) !== JSON.stringify(nextSkills);
  const next = {
    schemaVersion: SKILL_INSTALL_STATE_VERSION,
    updatedAt: changed || !previous.updatedAt ? new Date().toISOString() : previous.updatedAt,
    skills: nextSkills
  };
  if (changed) {
    saveSkillInstallState(stateDir, next);
  }
  return { ...next, stateChanged: changed };
}

function markSkillInstalled(stateDir, skill) {
  if (!SKILL_ID_PATTERN.test(String(skill?.id || "")) ||
      !/^[a-f0-9]{64}$/.test(String(skill?.sha || "")) ||
      !/^[a-f0-9]{64}$/.test(String(skill?.installSha || "")) ||
      skill?.installAvailable !== true) {
    throw new Error("Cannot record an installed Skill without exact Skill and installer proofs.");
  }
  const previous = loadSkillInstallState(stateDir);
  const receiptKey = loadSkillInstallReceiptKey(stateDir, { create: true });
  const now = new Date().toISOString();
  const record = {
    sha: skill.sha,
    installSha: skill.installSha,
    installed: true,
    installedAt: now
  };
  record.receipt = createSkillInstallReceipt(receiptKey, skill.id, record);
  const next = {
    schemaVersion: SKILL_INSTALL_STATE_VERSION,
    updatedAt: now,
    skills: {
      ...previous.skills,
      [skill.id]: record
    }
  };
  saveSkillInstallState(stateDir, next);
  return next;
}

function loadSkillInstallReceiptKey(stateDir, { create = false } = {}) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(stateDir, SKILL_INSTALL_RECEIPT_KEY_FILE);
  const readExisting = () => {
    const stat = fs.lstatSync(keyPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Skill install receipt key must be a regular file.");
    }
    const encoded = fs.readFileSync(keyPath, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(encoded)) {
      throw new Error("Skill install receipt key is invalid.");
    }
    fs.chmodSync(keyPath, 0o600);
    return Buffer.from(encoded, "hex");
  };
  try {
    return readExisting();
  } catch (error) {
    if (!create || error?.code !== "ENOENT") {
      throw error;
    }
  }
  const encoded = crypto.randomBytes(32).toString("hex");
  let fd;
  try {
    fd = fs.openSync(keyPath, "wx", 0o600);
    fs.writeFileSync(fd, `${encoded}\n`, "utf8");
  } catch (error) {
    if (error?.code === "EEXIST") {
      return readExisting();
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
  fs.chmodSync(keyPath, 0o600);
  return Buffer.from(encoded, "hex");
}

function createSkillInstallReceipt(key, skillId, record) {
  return crypto.createHmac("sha256", key).update([
    "skill-install-v1",
    String(skillId || ""),
    String(record?.sha || ""),
    String(record?.installSha || ""),
    String(record?.installedAt || "")
  ].join("\0")).digest("hex");
}

function verifySkillInstallReceipt(key, skillId, record) {
  const actual = String(record?.receipt || "");
  if (!/^[a-f0-9]{64}$/.test(actual)) {
    return false;
  }
  const expected = createSkillInstallReceipt(key, skillId, record);
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function saveSkillInstallState(stateDir, state) {
  fs.mkdirSync(stateDir, { recursive: true });
  const statePath = path.join(stateDir, SKILL_INSTALL_STATE_FILE);
  const tempPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, statePath);
    fs.chmodSync(statePath, 0o600);
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch (_error) {
      // Atomic rename may already have consumed the temporary path.
    }
  }
}

function sameStringArray(left, right) {
  const a = Array.isArray(left) ? left.map(String) : [];
  const b = Array.isArray(right) ? right.map(String) : [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function catalogPublicStatus(catalog) {
  return {
    ok: catalog.ok,
    type: "skill-catalog-status",
    catalogSha: catalog.catalogSha,
    version: catalog.version,
    updatedAt: catalog.updatedAt,
    skillCount: catalog.skillCount,
    discoveredSkillCount: catalog.discoveredSkillCount,
    installableSkillCount: catalog.installableSkillCount,
    rootCount: catalog.rootCount,
    configuredBy: catalog.configuredBy,
    catalogMetadataChars: catalog.catalogMetadataChars,
    errors: boundedPublicCatalogIssues(catalog.errors),
    warnings: boundedPublicCatalogIssues(catalog.warnings)
  };
}

function boundedPublicCatalogIssues(issues) {
  const input = Array.isArray(issues) ? issues : [];
  if (input.length <= MAX_SKILL_PUBLIC_ISSUES) {
    return input.map(publicCatalogIssue);
  }
  const visible = input.slice(0, MAX_SKILL_PUBLIC_ISSUES - 1).map(publicCatalogIssue);
  if (input.length > MAX_SKILL_PUBLIC_ISSUES) {
    visible.push(publicCatalogIssue({ code: "skill-public-issue-limit-exceeded" }));
  }
  return visible;
}

function publicCatalogIssue(issue = {}) {
  const code = String(issue.code || "skill-catalog-error");
  const file = safeRelativeSkillPath(issue.file);
  const rootIndex = Number.isInteger(issue.rootIndex) && issue.rootIndex >= 0 ? issue.rootIndex : undefined;
  const safeDetails = {
    code,
    ...(rootIndex === undefined ? {} : { rootIndex }),
    ...(file ? { file } : {}),
    ...(SKILL_ID_PATTERN.test(String(issue.skillId || "")) ? { skillId: String(issue.skillId) } : {}),
    ...(/^[a-f0-9]{64}$/.test(String(issue.sha || "")) ? { sha: String(issue.sha) } : {})
  };
  const fileLabel = file || "a Skill file";
  const rootLabel = rootIndex === undefined ? "A configured Skill root" : `Configured Skill root ${rootIndex + 1}`;
  const messages = {
    "empty-skill-paths": "The configured Skill path list is empty.",
    "skill-root-missing": `${rootLabel} does not exist.`,
    "skill-root-unreadable": `${rootLabel} is unreadable.`,
    "invalid-skill-root": `${rootLabel} must be a real directory and not a symlink.`,
    "skill-directory-unreadable": "A directory inside a configured Skill root is unreadable.",
    "skill-symlink-rejected": `Symlinked Skill content is not allowed: ${fileLabel}.`,
    "unsafe-skill-file": `Skill file safety validation failed: ${fileLabel}.`,
    "skill-too-large": `Skill file exceeds ${MAX_SKILL_FILE_BYTES} bytes: ${fileLabel}.`,
    "invalid-skill-encoding": `Skill file is not valid UTF-8: ${fileLabel}.`,
    "invalid-skill-frontmatter": `Skill frontmatter is invalid: ${fileLabel}.`,
    "duplicate-skill-id": `Skill name ${safeDetails.skillId || "(invalid)"} is duplicated.`,
    "skill-depth-exceeded": `Skill scan exceeded directory depth ${MAX_SKILL_DEPTH}.`,
    "skill-count-exceeded": `Skill scan exceeded ${MAX_SKILL_FILES} SKILL.md files.`,
    "skill-root-count-exceeded": `Skill scan exceeded ${MAX_SKILL_ROOTS} configured roots.`,
    "skill-scan-entry-limit-exceeded": `Skill scan exceeded ${MAX_SKILL_SCAN_ENTRIES} directory entries.`,
    "skill-traversal-issue-limit-exceeded": `Skill scan stopped after ${MAX_SKILL_TRAVERSAL_ISSUES} traversal diagnostics.`,
    "skill-public-issue-limit-exceeded": "Additional Skill catalog diagnostics were omitted.",
    "skill-total-size-exceeded": `Skill scan exceeded ${MAX_SKILL_TOTAL_BYTES} total bytes.`,
    "skill-catalog-metadata-too-large": `Serialized Skill catalog metadata exceeds ${MAX_SKILL_CATALOG_JSON_CHARS} characters.`,
    "skill-install-state-unavailable": "The local Skill installation state is unavailable."
  };
  return {
    ...safeDetails,
    message: messages[code] || "The local Skill catalog failed validation."
  };
}

function safeRelativeSkillPath(value) {
  const text = String(value || "").replace(/\\/g, "/");
  return text &&
    !text.startsWith("/") &&
    !/^[A-Za-z]:\//.test(text) &&
    !text.split("/").includes("..")
    ? text.slice(0, 512)
    : "";
}

function publicCatalogSkillRecord(skill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    sha: skill.sha
  };
}

function publicManagedSkillRecord(skill) {
  return {
    ...publicCatalogSkillRecord(skill),
    installed: skill.installed === true,
    installAvailable: skill.installAvailable === true,
    installSha: skill.installAvailable === true ? String(skill.installSha || "") : ""
  };
}

function skillError(catalog, errorCode, error, extra = {}, type = "skill-load") {
  return {
    ok: false,
    type,
    errorCode,
    error,
    catalogSha: catalog.catalogSha,
    version: catalog.version,
    skillCount: catalog.skillCount,
    discoveredSkillCount: catalog.discoveredSkillCount,
    ...extra
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  DEFAULT_SKILL_ENV_ALLOWLIST,
  MAX_LOADED_SKILL_CHARS,
  MAX_SKILL_LOAD_REPLY_CHARS,
  MAX_SKILL_CATALOG_JSON_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  MAX_SKILL_DEPTH,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_INSTALL_OUTPUT_CHARS,
  MAX_SKILL_INSTALL_SCRIPT_BYTES,
  MAX_SKILL_PUBLIC_ISSUES,
  MAX_SKILL_ROOTS,
  MAX_SKILL_SCAN_ENTRIES,
  MAX_SKILL_TRAVERSAL_ISSUES,
  MAX_SKILL_TOTAL_BYTES,
  SKILL_CATALOG_CACHE_MS,
  SKILL_ID_PATTERN,
  SKILL_INSTALL_SCRIPT_NAME,
  SKILL_INSTALL_STATE_FILE,
  SKILL_INSTALL_TIMEOUT_MS,
  SKILL_ROOTS_RUNTIME_VARIABLE,
  SKILL_ROOT_SOURCE_RUNTIME_VARIABLE,
  SkillCatalogService,
  aggregateSkillShas,
  buildSkillInstallEnvironment,
  createSkillInstallSnapshot,
  expandSkillEnvironment,
  formatSkillLoadReplyForSizing,
  getConfiguredSkillRoots,
  getSkillEnvironmentAllowlist,
  getSkillRuntimeVariables,
  inspectSkillInstallScript,
  loadSkillInstallState,
  parseSkillFrontmatter,
  reconcileSkillInstallState,
  runSkillInstallScript,
  scanSkillRoots
};
