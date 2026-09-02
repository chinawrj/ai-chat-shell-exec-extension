const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const EXECUTION_ENV_FILE_VARIABLE = "AI_CHAT_SHELL_ENV_FILE";
const MAX_EXECUTION_ENV_FILE_BYTES = 256 * 1024;
const MAX_EXECUTION_ENV_ENTRIES = 512;
const MAX_EXECUTION_ENV_NAME_CHARS = 128;
const MAX_EXECUTION_ENV_VALUE_BYTES = 64 * 1024;
const EXECUTION_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

class ExecutionEnvironmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExecutionEnvironmentError";
    this.code = code;
  }
}

function loadExecutionEnvironment({ env = process.env, cwd = process.cwd() } = {}) {
  if (!Object.prototype.hasOwnProperty.call(env, EXECUTION_ENV_FILE_VARIABLE)) {
    return {
      configured: false,
      sha: "",
      variables: {}
    };
  }
  const configuredPath = String(env[EXECUTION_ENV_FILE_VARIABLE] ?? "").trim();
  if (!configuredPath) {
    throw executionEnvironmentError(
      "execution-env-file-empty",
      `${EXECUTION_ENV_FILE_VARIABLE} is configured but empty.`
    );
  }
  const resolvedPath = path.resolve(String(cwd || process.cwd()), configuredPath);
  const content = readSafeExecutionEnvironmentFile(resolvedPath);
  return {
    configured: true,
    sha: crypto.createHash("sha256").update(content).digest("hex"),
    variables: parseExecutionEnvironment(content)
  };
}

function readSafeExecutionEnvironmentFile(filePath) {
  const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const openedStat = fs.fstatSync(fd);
    if (!openedStat.isFile()) {
      throw executionEnvironmentError(
        "execution-env-file-not-regular",
        "The configured execution environment file must be a real regular file."
      );
    }
    if (openedStat.size > MAX_EXECUTION_ENV_FILE_BYTES) {
      throw executionEnvironmentError(
        "execution-env-file-too-large",
        `The configured execution environment file exceeds ${MAX_EXECUTION_ENV_FILE_BYTES} bytes.`
      );
    }
    const content = fs.readFileSync(fd);
    const finalStat = fs.fstatSync(fd);
    if (!finalStat.isFile() || finalStat.dev !== openedStat.dev || finalStat.ino !== openedStat.ino ||
        finalStat.size !== openedStat.size || finalStat.mtimeMs !== openedStat.mtimeMs ||
        content.length !== finalStat.size) {
      throw executionEnvironmentError(
        "execution-env-file-changed",
        "The configured execution environment file changed while it was being read. Retry the operation."
      );
    }
    return content;
  } catch (error) {
    if (error instanceof ExecutionEnvironmentError) {
      throw error;
    }
    throw executionEnvironmentError(
      "execution-env-file-unavailable",
      "The configured execution environment file could not be opened safely."
    );
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function parseExecutionEnvironment(content) {
  let text;
  try {
    text = UTF8_DECODER.decode(Buffer.isBuffer(content) ? content : Buffer.from(String(content || ""), "utf8"));
  } catch (_error) {
    throw executionEnvironmentError(
      "execution-env-file-invalid-utf8",
      "The configured execution environment file must contain valid UTF-8 text."
    );
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  if (text.includes("\0")) {
    throw executionEnvironmentError(
      "execution-env-file-null-byte",
      "The configured execution environment file contains a null byte."
    );
  }

  const variables = {};
  const seen = new Set();
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const declaration = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed;
    const separator = declaration.indexOf("=");
    if (separator <= 0) {
      throw invalidLine(index, "must use NAME=VALUE syntax");
    }
    const name = declaration.slice(0, separator).trim();
    if (!EXECUTION_ENV_NAME_PATTERN.test(name) || name.length > MAX_EXECUTION_ENV_NAME_CHARS) {
      throw invalidLine(index, "contains an invalid environment variable name");
    }
    if (seen.has(name)) {
      throw invalidLine(index, "declares an environment variable more than once");
    }
    if (seen.size >= MAX_EXECUTION_ENV_ENTRIES) {
      throw executionEnvironmentError(
        "execution-env-entry-limit-exceeded",
        `The configured execution environment file exceeds ${MAX_EXECUTION_ENV_ENTRIES} entries.`
      );
    }
    const value = parseExecutionEnvironmentValue(declaration.slice(separator + 1), index);
    if (Buffer.byteLength(value, "utf8") > MAX_EXECUTION_ENV_VALUE_BYTES) {
      throw invalidLine(index, `contains a value larger than ${MAX_EXECUTION_ENV_VALUE_BYTES} bytes`);
    }
    seen.add(name);
    Object.defineProperty(variables, name, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return variables;
}

function parseExecutionEnvironmentValue(rawValue, lineIndex) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return "";
  }
  const quote = value[0];
  if (quote !== "\"" && quote !== "'") {
    return value;
  }
  if (value.length < 2 || value[value.length - 1] !== quote) {
    throw invalidLine(lineIndex, "contains an unterminated quoted value");
  }
  const body = value.slice(1, -1);
  if (quote === "'") {
    return body;
  }
  let decoded = "";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    index += 1;
    if (index >= body.length) {
      throw invalidLine(lineIndex, "ends with an incomplete escape sequence");
    }
    const escaped = body[index];
    const replacements = { n: "\n", r: "\r", t: "\t", "\\": "\\", "\"": "\"" };
    if (!Object.prototype.hasOwnProperty.call(replacements, escaped)) {
      throw invalidLine(lineIndex, "contains an unsupported escape sequence");
    }
    decoded += replacements[escaped];
  }
  return decoded;
}

function mergeExecutionEnvironment(baseEnvironment = {}, loadedEnvironment = {}) {
  return {
    ...baseEnvironment,
    ...(loadedEnvironment?.variables || {})
  };
}

function buildShellEnvironmentExports(loadedEnvironment = {}) {
  return Object.entries(loadedEnvironment?.variables || {})
    .map(([name, value]) => `export ${name}=${shellQuote(value)}`);
}

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'"'"'`)}'`;
}

function invalidLine(index, detail) {
  return executionEnvironmentError(
    "execution-env-file-malformed",
    `The configured execution environment file is invalid at line ${Number(index) + 1}: ${detail}.`
  );
}

function executionEnvironmentError(code, message) {
  return new ExecutionEnvironmentError(code, message);
}

module.exports = {
  EXECUTION_ENV_FILE_VARIABLE,
  EXECUTION_ENV_NAME_PATTERN,
  MAX_EXECUTION_ENV_ENTRIES,
  MAX_EXECUTION_ENV_FILE_BYTES,
  MAX_EXECUTION_ENV_NAME_CHARS,
  MAX_EXECUTION_ENV_VALUE_BYTES,
  ExecutionEnvironmentError,
  buildShellEnvironmentExports,
  loadExecutionEnvironment,
  mergeExecutionEnvironment,
  parseExecutionEnvironment,
  readSafeExecutionEnvironmentFile
};
