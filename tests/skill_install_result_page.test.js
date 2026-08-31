#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(repoRoot, "extension", "skill-install-result.html"), "utf8");
const source = fs.readFileSync(path.join(repoRoot, "extension", "src", "skill-install-result.js"), "utf8");
const css = fs.readFileSync(path.join(repoRoot, "extension", "skill-install-result.css"), "utf8");

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  assert.match(html, /role="alert"/);
  assert.match(html, /not written to the chat composer/i);
  assert.match(css, /\.hidden/);
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
    "Untrusted installer output must only be assigned as plain text in the extension-origin page.");

  const token = "a".repeat(32);
  const detail = {
    skillId: "unsafe-skill",
    skillName: "Unsafe <img src=x onerror=alert(1)>",
    error: "Installer exited with code 23.",
    exitCode: 23,
    signal: "",
    durationMs: 4250,
    idleTimeoutSeconds: null,
    installerOutput: {
      stderr: "literal <script>must-not-run()</script>",
      stdout: "setup tail",
      stderrTruncated: true,
      stdoutTruncated: false
    }
  };
  const rendered = createPageContext(token, { ok: true, detail });
  await rendered.settle();
  assert.deepEqual(rendered.messages, [{ type: "skill-install-failure-consume", token }]);
  assert.equal(rendered.historyPaths.at(-1), "/skill-install-result.html", "The one-use token must be removed from visible history.");
  assert.match(rendered.elements.summary.textContent, /Unsafe <img src=x onerror=alert\(1\)>/);
  assert.equal(rendered.elements.stderr.textContent, "literal <script>must-not-run()</script>");
  assert.equal(rendered.elements.stdout.textContent, "setup tail");
  assert.equal(rendered.elements["stderr-section"].classList.has("hidden"), false);
  assert.equal(rendered.elements["stdout-section"].classList.has("hidden"), false);
  assert.match(rendered.elements["stderr-title"].textContent, /captured tail/i);
  assert.equal(rendered.elements.result.classList.has("hidden"), false);
  assert.equal(rendered.elements.copy.classList.has("hidden"), false);
  await rendered.elements.copy.listeners.click();
  assert.match(rendered.copiedText.at(-1), /Exit code: 23/);
  assert.match(rendered.copiedText.at(-1), /literal <script>must-not-run\(\)<\/script>/);
  assert.equal(rendered.elements.copy.textContent, "Copied");
  rendered.elements.close.listeners.click();
  assert.equal(rendered.closeCount(), 1);

  const signaled = createPageContext("c".repeat(32), {
    ok: true,
    detail: {
      skillId: "signaled",
      error: "Installer terminated by a signal.",
      signal: "SIGTERM",
      durationMs: 800,
      installerOutput: { stderr: "terminated", stdout: "" }
    }
  });
  await signaled.settle();
  assert.match(signaled.elements.metadata.textContent, /Signal: SIGTERM/);
  assert.equal(signaled.elements.stderr.textContent, "terminated");

  const timedOutEmpty = createPageContext("d".repeat(32), {
    ok: true,
    detail: {
      skillId: "idle-timeout",
      error: "Installer produced no output for 600 seconds.",
      idleTimeoutSeconds: 600,
      installerOutput: { stderr: "", stdout: "" }
    }
  });
  await timedOutEmpty.settle();
  assert.match(timedOutEmpty.elements.metadata.textContent, /Output-idle limit: 600 s/);
  assert.equal(timedOutEmpty.elements["empty-output"].classList.has("hidden"), false,
    "A failure with no captured output must explicitly render the empty-output state.");

  const invalid = createPageContext("not-a-token", { ok: true, detail });
  await invalid.settle();
  assert.deepEqual(invalid.messages, [], "An invalid token must not contact the background result store.");
  assert.match(invalid.elements.loading.textContent, /missing or invalid/i);
  assert.equal(invalid.elements.loading.attributes.role, "alert");

  const expired = createPageContext("b".repeat(32), { ok: false, error: "expired" });
  await expired.settle();
  assert.match(expired.elements.loading.textContent, /expired/i);
  assert.equal(expired.elements.result.classList.has("hidden"), true);

  console.log("Skill install result page tests passed");
}

function createPageContext(token, response) {
  const ids = [
    "loading", "result", "summary", "metadata", "stderr-section", "stdout-section", "stderr", "stdout",
    "empty-output", "copy", "close", "stderr-title", "stdout-title"
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, element(id)]));
  for (const id of ["result", "metadata", "stderr-section", "stdout-section", "empty-output", "copy"]) {
    elements[id].classList.add("hidden");
  }
  const messages = [];
  const historyPaths = [];
  const copiedText = [];
  let closed = 0;
  const context = {
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          messages.push({ ...message });
          return response;
        }
      }
    },
    document: {
      getElementById(id) {
        return elements[id];
      }
    },
    history: {
      replaceState(_state, _title, pathname) {
        historyPaths.push(pathname);
      }
    },
    location: {
      hash: `#${token}`,
      pathname: "/skill-install-result.html"
    },
    navigator: {
      clipboard: { writeText: async (value) => { copiedText.push(value); } }
    },
    window: { close() { closed += 1; } },
    console,
    decodeURIComponent,
    Number,
    String
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "skill-install-result.js" });
  return {
    elements,
    historyPaths,
    messages,
    copiedText,
    closeCount: () => closed,
    settle: () => new Promise((resolve) => setTimeout(resolve, 0))
  };
}

function element(id) {
  const classes = new Set();
  return {
    id,
    attributes: {},
    classList: {
      add(value) { classes.add(value); },
      remove(value) { classes.delete(value); },
      has(value) { return classes.has(value); }
    },
    listeners: {},
    textContent: "",
    addEventListener(type, callback) { this.listeners[type] = callback; },
    focus() {},
    setAttribute(name, value) { this.attributes[name] = String(value); }
  };
}
