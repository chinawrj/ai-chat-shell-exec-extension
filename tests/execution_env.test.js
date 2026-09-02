#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  EXECUTION_ENV_FILE_VARIABLE,
  MAX_EXECUTION_ENV_ENTRIES,
  MAX_EXECUTION_ENV_FILE_BYTES,
  MAX_EXECUTION_ENV_VALUE_BYTES,
  buildShellEnvironmentExports,
  loadExecutionEnvironment,
  mergeExecutionEnvironment,
  parseExecutionEnvironment
} = require("../server/execution_env");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ai-chat-shell-execution-env-"));

try {
  testNoConfiguration();
  testValidDotEnvSubsetAndShellQuoting();
  testPrototypeNamedVariablesRemainOrdinaryDeclarations();
  testFreshReadAndStableSha();
  testMalformedFilesFailClosedWithoutValuesInErrors();
  testEncodingAndDeclarationBounds();
  testUnsafeAndOversizedFilesFailClosed();
  console.log("execution environment tests passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function testEncodingAndDeclarationBounds() {
  assert.throws(
    () => parseExecutionEnvironment(Buffer.from([0xc3, 0x28])),
    (error) => error.code === "execution-env-file-invalid-utf8"
  );
  assert.throws(
    () => parseExecutionEnvironment(Buffer.from("A=one\0two", "utf8")),
    (error) => error.code === "execution-env-file-null-byte"
  );
  assert.throws(
    () => parseExecutionEnvironment(Array.from({ length: MAX_EXECUTION_ENV_ENTRIES + 1 }, (_, index) => `V${index}=x`).join("\n")),
    (error) => error.code === "execution-env-entry-limit-exceeded"
  );
  assert.throws(
    () => parseExecutionEnvironment(`TOO_BIG=${"x".repeat(MAX_EXECUTION_ENV_VALUE_BYTES + 1)}`),
    (error) => error.code === "execution-env-file-malformed" && /larger/.test(error.message)
  );
}

function testNoConfiguration() {
  assert.deepEqual(loadExecutionEnvironment({ env: {}, cwd: tempRoot }), {
    configured: false,
    sha: "",
    variables: {}
  });
}

function testValidDotEnvSubsetAndShellQuoting() {
  const variables = parseExecutionEnvironment(Buffer.from([
    "# local runtime values",
    "PLAIN=value",
    "export SPACED=two words",
    "SINGLE='literal # value'",
    "DOUBLE=\"line\\nquote\\\" tab\\t slash\\\\\"",
    "EMPTY=",
    "UNICODE=环境",
    ""
  ].join("\n")));
  assert.deepEqual(variables, {
    PLAIN: "value",
    SPACED: "two words",
    SINGLE: "literal # value",
    DOUBLE: "line\nquote\" tab\t slash\\",
    EMPTY: "",
    UNICODE: "环境"
  });
  assert.deepEqual(mergeExecutionEnvironment({ PATH: "/base", PLAIN: "old" }, { variables }), {
    PATH: "/base",
    ...variables
  });
  assert.deepEqual(buildShellEnvironmentExports({ variables: { TOKEN: "a'b", EMPTY: "" } }), [
    "export TOKEN='a'\"'\"'b'",
    "export EMPTY=''"
  ]);
}

function testPrototypeNamedVariablesRemainOrdinaryDeclarations() {
  const variables = parseExecutionEnvironment("__proto__=prototype value\nconstructor=constructor value\n");
  assert.equal(Object.prototype.hasOwnProperty.call(variables, "__proto__"), true);
  assert.equal(variables.__proto__, "prototype value");
  assert.equal(Object.prototype.hasOwnProperty.call(variables, "constructor"), true);
  assert.equal(variables.constructor, "constructor value");
  assert.deepEqual(buildShellEnvironmentExports({ variables }), [
    "export __proto__='prototype value'",
    "export constructor='constructor value'"
  ]);
}

function testFreshReadAndStableSha() {
  const envPath = path.join(tempRoot, "runtime.env");
  fs.writeFileSync(envPath, "VALUE=one\n", { mode: 0o600 });
  const env = { [EXECUTION_ENV_FILE_VARIABLE]: envPath };
  const first = loadExecutionEnvironment({ env, cwd: "/" });
  const repeated = loadExecutionEnvironment({ env, cwd: "/" });
  assert.equal(first.configured, true);
  assert.equal(first.variables.VALUE, "one");
  assert.match(first.sha, /^[a-f0-9]{64}$/);
  assert.equal(repeated.sha, first.sha);

  fs.writeFileSync(envPath, "VALUE=two\n", { mode: 0o600 });
  const changed = loadExecutionEnvironment({ env, cwd: "/" });
  assert.equal(changed.variables.VALUE, "two");
  assert.notEqual(changed.sha, first.sha, "Each operation must reread the configured file.");
}

function testMalformedFilesFailClosedWithoutValuesInErrors() {
  for (const [name, source, expectedCode] of [
    ["empty-path", null, "execution-env-file-empty"],
    ["missing-equals", "SECRET_VALUE_SHOULD_NOT_LEAK\n", "execution-env-file-malformed"],
    ["invalid-name", "1BAD=SECRET_VALUE_SHOULD_NOT_LEAK\n", "execution-env-file-malformed"],
    ["duplicate", "SECRET_CUSTOMER_ACME=SECRET_VALUE_SHOULD_NOT_LEAK\nSECRET_CUSTOMER_ACME=two\n", "execution-env-file-malformed"],
    ["quote", "A=\"SECRET_VALUE_SHOULD_NOT_LEAK\n", "execution-env-file-malformed"],
    ["escape", "A=\"SECRET_VALUE_SHOULD_NOT_LEAK\\q\"\n", "execution-env-file-malformed"]
  ]) {
    const env = {};
    if (source === null) {
      env[EXECUTION_ENV_FILE_VARIABLE] = "";
    } else {
      const filePath = path.join(tempRoot, `${name}.env`);
      fs.writeFileSync(filePath, source, { mode: 0o600 });
      env[EXECUTION_ENV_FILE_VARIABLE] = filePath;
    }
    assert.throws(
      () => loadExecutionEnvironment({ env, cwd: tempRoot }),
      (error) => {
        assert.equal(error.code, expectedCode);
        assert.ok(!String(error.message).includes("SECRET_VALUE_SHOULD_NOT_LEAK"));
        assert.ok(!String(error.message).includes("SECRET_CUSTOMER_ACME"), "Environment variable names must not enter parser errors.");
        return true;
      }
    );
  }
}

function testUnsafeAndOversizedFilesFailClosed() {
  const realPath = path.join(tempRoot, "real.env");
  const linkPath = path.join(tempRoot, "linked.env");
  fs.writeFileSync(realPath, "A=1\n", { mode: 0o600 });
  fs.symlinkSync(realPath, linkPath);
  assert.throws(
    () => loadExecutionEnvironment({ env: { [EXECUTION_ENV_FILE_VARIABLE]: linkPath }, cwd: tempRoot }),
    (error) => error.code === "execution-env-file-unavailable"
  );

  const largePath = path.join(tempRoot, "large.env");
  fs.writeFileSync(largePath, Buffer.alloc(MAX_EXECUTION_ENV_FILE_BYTES + 1, 0x41));
  assert.throws(
    () => loadExecutionEnvironment({ env: { [EXECUTION_ENV_FILE_VARIABLE]: largePath }, cwd: tempRoot }),
    (error) => error.code === "execution-env-file-too-large"
  );
}
