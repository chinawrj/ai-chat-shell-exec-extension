const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const SKILL_FILE_NAME = "SKILL.md";
const SKILL_CATALOG_STATE_VERSION = 1;
const SKILL_CATALOG_STATE_FILE = "skill-catalog-state.json";
const DEFAULT_SKILL_ENV_ALLOWLIST = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR"];
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
const MAX_LOADED_SKILL_CHARS = 450 * 1024;
const MAX_SKILL_LOAD_REPLY_CHARS = 500_000;
const MAX_SKILL_DESCRIPTION_CHARS = 512;
const MAX_SKILL_CATALOG_JSON_CHARS = 350_000;
const SKILL_CATALOG_CACHE_MS = 10_000;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

class SkillCatalogService {
  constructor(options = {}) {
    this.stateDir = path.resolve(String(options.stateDir || path.join(process.cwd(), ".state")));
    this.env = options.env || process.env;
    this.cwd = path.resolve(String(options.cwd || process.cwd()));
    this.homeDir = path.resolve(String(options.homeDir || this.env.HOME || os.homedir()));
    this.cacheMs = Math.max(0, Number(options.cacheMs ?? SKILL_CATALOG_CACHE_MS));
    this.current = null;
  }

  status({ force = false } = {}) {
    return catalogPublicStatus(this.scan({ force }));
  }

  list({ force = true } = {}) {
    const catalog = this.scan({ force });
    return {
      ...catalogPublicStatus(catalog),
      type: "skill-catalog-list",
      skills: catalog.catalogMetadataTooLarge ? [] : catalog.skills.map(publicSkillRecord)
    };
  }

  rescan() {
    return {
      ...this.list({ force: true }),
      type: "skill-catalog-rescan"
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
      skillDir: path.dirname(skill.filePath)
    });
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
      skill: publicSkillRecord(skill),
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
    const catalogSha = aggregateSkillShas(scan.observedShas);
    const previousState = loadCatalogState(this.stateDir);
    const changed = previousState.catalogSha !== catalogSha;
    const version = changed
      ? Math.max(0, Number(previousState.version || 0)) + 1
      : Math.max(1, Number(previousState.version || 1));
    const updatedAt = changed || !previousState.updatedAt
      ? new Date().toISOString()
      : String(previousState.updatedAt);
    const catalogMetadataChars = JSON.stringify({
      catalogSha,
      version,
      skills: scan.skills.map(publicSkillRecord)
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
        updatedAt
      });
    }

    this.current = {
      ok: scan.errors.length === 0,
      type: "skill-catalog",
      catalogSha,
      version,
      updatedAt,
      skillCount: scan.skills.length,
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

  config.roots.forEach((rootPath, rootIndex) => {
    if (!fs.existsSync(rootPath)) {
      const issue = { code: "skill-root-missing", rootIndex, message: `Skill root does not exist: ${rootPath}` };
      (config.explicitlyConfigured ? errors : warnings).push(issue);
      return;
    }
    let rootStat;
    try {
      rootStat = fs.lstatSync(rootPath);
    } catch (error) {
      errors.push({ code: "skill-root-unreadable", rootIndex, message: error.message || String(error) });
      return;
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      errors.push({ code: "invalid-skill-root", rootIndex, message: `Skill root must be a real directory, not a symlink: ${rootPath}` });
      return;
    }
    walkSkillRoot(rootPath, rootPath, rootIndex, candidates, errors, 0, { stop: false, countErrorAdded: false });
  });

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
      rootIndex: candidate.rootIndex
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
    errors.push({ code: "skill-depth-exceeded", message: `Skill scan exceeded depth ${MAX_SKILL_DEPTH} under ${rootPath}.` });
    return;
  }
  let entries;
  try {
    entries = fs.readdirSync(currentPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    errors.push({ code: "skill-directory-unreadable", message: error.message || String(error) });
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
        errors.push({ code: "skill-symlink-rejected", message: `Symlinked Skill files and directories are not allowed: ${entryPath}` });
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

function expandSkillEnvironment(source, { env = process.env, allowlist = [], skillDir = "" } = {}) {
  const allowed = new Set(Array.from(allowlist || []).map((value) => String(value || "").trim()).filter(Boolean));
  const missing = new Set();
  const replaced = new Set();
  const preserved = new Set();
  const content = String(source || "").replace(/\\?\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (match, braced, bare) => {
    if (match.startsWith("\\$")) {
      return match;
    }
    const name = braced || bare;
    if (name === "CLAUDE_SKILL_DIR") {
      replaced.add(name);
      return skillDir;
    }
    if (PRESERVED_CLAUDE_VARIABLES.has(name) || !allowed.has(name)) {
      preserved.add(name);
      return match;
    }
    if (!Object.prototype.hasOwnProperty.call(env, name) || env[name] === undefined) {
      missing.add(name);
      return match;
    }
    replaced.add(name);
    return String(env[name]);
  });
  return {
    ok: missing.size === 0,
    content,
    missingVariables: Array.from(missing).sort(),
    replacedVariables: Array.from(replaced).sort(),
    preservedVariables: Array.from(preserved).sort()
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
      parsed.stateVersion === SKILL_CATALOG_STATE_VERSION &&
      Number.isSafeInteger(parsed.version) &&
      parsed.version >= 1 &&
      /^[a-f0-9]{64}$/.test(String(parsed.catalogSha || "")) &&
      typeof parsed.updatedAt === "string" &&
      Number.isFinite(Date.parse(parsed.updatedAt));
    return valid ? parsed : {};
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

function catalogPublicStatus(catalog) {
  return {
    ok: catalog.ok,
    type: "skill-catalog-status",
    catalogSha: catalog.catalogSha,
    version: catalog.version,
    updatedAt: catalog.updatedAt,
    skillCount: catalog.skillCount,
    rootCount: catalog.rootCount,
    configuredBy: catalog.configuredBy,
    catalogMetadataChars: catalog.catalogMetadataChars,
    errors: catalog.errors.map(publicCatalogIssue),
    warnings: catalog.warnings.map(publicCatalogIssue)
  };
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
    "skill-total-size-exceeded": `Skill scan exceeded ${MAX_SKILL_TOTAL_BYTES} total bytes.`,
    "skill-catalog-metadata-too-large": `Serialized Skill catalog metadata exceeds ${MAX_SKILL_CATALOG_JSON_CHARS} characters.`
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

function publicSkillRecord(skill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    sha: skill.sha
  };
}

function skillError(catalog, errorCode, error, extra = {}) {
  return {
    ok: false,
    type: "skill-load",
    errorCode,
    error,
    catalogSha: catalog.catalogSha,
    version: catalog.version,
    skillCount: catalog.skillCount,
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
  MAX_SKILL_TOTAL_BYTES,
  SKILL_CATALOG_CACHE_MS,
  SKILL_ID_PATTERN,
  SkillCatalogService,
  aggregateSkillShas,
  expandSkillEnvironment,
  formatSkillLoadReplyForSizing,
  getConfiguredSkillRoots,
  getSkillEnvironmentAllowlist,
  parseSkillFrontmatter,
  scanSkillRoots
};
