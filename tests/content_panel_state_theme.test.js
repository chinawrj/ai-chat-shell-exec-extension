#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "extension", "src", "content.js"), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing ${name}.`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  throw new Error(`Unterminated ${name}.`);
}

const themeStart = source.indexOf("const PANEL_STATE_THEME = Object.freeze(");
const themeEnd = source.indexOf("const DRAWIO_HELPER_MAX_SCAN_CHARS", themeStart);
assert.ok(themeStart >= 0 && themeEnd > themeStart, "Panel theme constants must be declared together.");

const context = {};
vm.createContext(context);
vm.runInContext([
  source.slice(themeStart, themeEnd),
  extractFunction("applyPanelStateTheme"),
  extractFunction("pendingHelperDeliveryAppearance"),
  extractFunction("buildSkillRunningStatus"),
  extractFunction("shouldUpdateDrawioPanelOutcome"),
  "globalThis.exports = { PANEL_STATE_THEME, PANEL_STATE_ARIA_LABEL, applyPanelStateTheme, pendingHelperDeliveryAppearance, buildSkillRunningStatus, shouldUpdateDrawioPanelOutcome };"
].join("\n"), context);

const {
  PANEL_STATE_THEME,
  PANEL_STATE_ARIA_LABEL,
  applyPanelStateTheme,
  pendingHelperDeliveryAppearance,
  buildSkillRunningStatus,
  shouldUpdateDrawioPanelOutcome
} = context.exports;

assert.deepEqual(JSON.parse(JSON.stringify(PANEL_STATE_THEME)), {
  idle: { background: "#111827", border: "#39455c", dot: "#64748b", ring: "rgba(100,116,139,.16)" },
  running: { background: "#102a43", border: "#3b82f6", dot: "#60a5fa", ring: "rgba(96,165,250,.18)" },
  ok: { background: "#12372a", border: "#34d399", dot: "#34d399", ring: "rgba(52,211,153,.16)" },
  error: { background: "#431d2b", border: "#fb7185", dot: "#fb7185", ring: "rgba(251,113,133,.18)" }
});
assert.deepEqual(JSON.parse(JSON.stringify(PANEL_STATE_ARIA_LABEL)), {
  idle: "Idle",
  running: "In progress",
  ok: "Completed",
  error: "Error"
});

for (const state of ["idle", "running", "ok", "error"]) {
  const panel = { dataset: {}, style: {}, childStyle: { background: "unchanged" } };
  const theme = applyPanelStateTheme(panel, state);
  assert.equal(panel.dataset.appearanceState, state);
  assert.equal(panel.style.background, PANEL_STATE_THEME[state].background);
  assert.equal(panel.style.borderColor, PANEL_STATE_THEME[state].border);
  assert.equal(theme.dot, PANEL_STATE_THEME[state].dot);
  assert.equal(panel.childStyle.background, "unchanged", "Semantic panel theming must not recolor controls or cards.");
}

const unknownPanel = { dataset: {}, style: {} };
applyPanelStateTheme(unknownPanel, "unexpected");
assert.equal(unknownPanel.dataset.appearanceState, "idle", "Unknown visual states must fail back to the unchanged idle theme.");
assert.equal(unknownPanel.style.background, "#111827");
assert.equal(unknownPanel.style.borderColor, "#39455c");

assert.equal(pendingHelperDeliveryAppearance({ kind: "shell", response: { ok: true } }), "running",
  "A successful backend result still awaiting visible composer delivery remains in progress.");
assert.equal(pendingHelperDeliveryAppearance({ kind: "shell", phase: "inserted", response: { ok: true } }), "running");
assert.equal(pendingHelperDeliveryAppearance({ kind: "shell", phase: "submitted-unconfirmed", response: { ok: true } }), "running",
  "A cleared composer without fresh submitted-message proof is not completion.");
assert.equal(pendingHelperDeliveryAppearance({ kind: "shell", phase: "submitted", response: { ok: true } }), "ok",
  "Fresh user-visible submission proof remains green while only the server receipt is pending.");
assert.equal(pendingHelperDeliveryAppearance({ kind: "shell", phase: "presented", response: { ok: true } }), "ok");
assert.equal(pendingHelperDeliveryAppearance({ kind: "shell", response: { ok: false } }), "error",
  "A failed backend result must be red even while its error reply is pending.");
assert.equal(pendingHelperDeliveryAppearance({ kind: "shell", phase: "submitted", response: { ok: false } }), "error",
  "A failed helper stays red after its diagnostic reply is submitted.");
assert.equal(pendingHelperDeliveryAppearance({ kind: "skill-error", response: { ok: true } }), "error",
  "A Skill protocol error must never be disguised as a running blue operation.");
assert.equal(pendingHelperDeliveryAppearance(null), "running");

assert.equal(buildSkillRunningStatus({ cmd: "list" }), "Processing Skill catalog request");
assert.equal(buildSkillRunningStatus({ cmd: "load", skillId: "creator" }), "Loading Skill creator");
assert.equal(buildSkillRunningStatus({ cmd: "list-updated" }), "Validating Skill catalog acknowledgement");
assert.equal(buildSkillRunningStatus({ cmd: "list-update-failed" }), "Recording Skill synchronization failure");

assert.equal(shouldUpdateDrawioPanelOutcome(null, "a"), true);
assert.equal(shouldUpdateDrawioPanelOutcome({ pendingArtifactId: "a" }, "a"), false,
  "A repeated scan of the currently staging artifact must not rewrite panel state.");
assert.equal(shouldUpdateDrawioPanelOutcome({ pendingArtifactId: "", state: "ready", currentArtifactId: "a" }, "a"), false,
  "A repeated scan of the currently rendered artifact must not overwrite another operation's panel state.");
assert.equal(shouldUpdateDrawioPanelOutcome({
  pendingArtifactId: "",
  currentArtifactId: "",
  state: "error",
  errors: [{ artifactId: "a" }]
}, "a"), false, "A stable cached failure must not repeatedly overwrite the panel.");
assert.equal(shouldUpdateDrawioPanelOutcome({
  pendingArtifactId: "newer",
  currentArtifactId: "a",
  state: "staging",
  errors: []
}, "a"), true, "Restoring the latest already-rendered artifact over a superseded stage is a new outcome decision.");

const statusCalls = [];
const ownedPanel = { dataset: { statusOwner: "drawio-render", statusOwnerKey: "a" } };
const drawioContext = {
  STATUS_ID: "panel",
  document: { getElementById: () => ownedPanel },
  setStatus: (...args) => statusCalls.push(args),
  summarizeCommand: (value) => String(value)
};
vm.createContext(drawioContext);
vm.runInContext([
  extractFunction("isPanelStatusOwnedBy"),
  extractFunction("updateDrawioPanelStatus"),
  "globalThis.updateDrawioPanelStatusForTest = updateDrawioPanelStatus;"
].join("\n"), drawioContext);
const updateDrawioPanelStatusForTest = drawioContext.updateDrawioPanelStatusForTest;
updateDrawioPanelStatusForTest({ getDiagnostics: () => ({ currentArtifactId: "a", errors: [] }) }, "a", { ok: true, rendered: true }, true);
assert.equal(statusCalls.length, 1);
assert.equal(statusCalls[0][1], "ok");
updateDrawioPanelStatusForTest({ getDiagnostics: () => ({ pendingArtifactId: "", currentArtifactId: "a", errors: [] }) }, "a", { ok: true, unchanged: true }, true);
assert.equal(statusCalls.length, 2);
assert.equal(statusCalls[1][1], "ok", "Restoring the latest existing artifact over a cancelled stage must finish green.");
updateDrawioPanelStatusForTest({ getDiagnostics: () => ({ pendingArtifactId: "b", currentArtifactId: "a", errors: [] }) }, "a", { ok: true, unchanged: true }, true);
assert.equal(statusCalls.length, 2, "An unchanged result may not turn green while another artifact still stages.");
ownedPanel.dataset.statusOwner = "shell-helper";
updateDrawioPanelStatusForTest({ getDiagnostics: () => ({ currentArtifactId: "a", errors: [] }) }, "a", { ok: true, rendered: true }, true);
assert.equal(statusCalls.length, 2, "A completed Draw.io promise must not overwrite a newer non-Draw.io panel owner.");
ownedPanel.dataset.statusOwner = "drawio-render";
updateDrawioPanelStatusForTest({ getDiagnostics: () => ({ currentArtifactId: "", errors: [{ artifactId: "a" }] }) }, "a", { ok: false, error: "failed" }, false);
assert.equal(statusCalls.length, 2, "A stable cached Draw.io failure must not overwrite a newer status on repeated scans.");
updateDrawioPanelStatusForTest({ getDiagnostics: () => ({ currentArtifactId: "", errors: [{ artifactId: "a" }] }) }, "a", { ok: false, error: "failed" }, true);
assert.equal(statusCalls.length, 3);
assert.equal(statusCalls[2][1], "error");
updateDrawioPanelStatusForTest({ getDiagnostics: () => ({ currentArtifactId: "a", errors: [] }) }, "a", { ok: false, cancelled: true }, true);
assert.equal(statusCalls.length, 3, "A cancelled renderer must never write a terminal panel state.");

assert.match(source, /panel\.dataset\.appearanceState = "idle";/,
  "The newly injected panel must start from the exact unchanged idle theme.");
assert.match(source, /setStatus\("Checking shell server and ForAI tmux session", "running", \{ appearance: "idle" \}\)/,
  "The automatic startup probe must not make the default panel look like a user helper is running.");
assert.match(source, /Shell tool ready[\s\S]*?"ok",\s*\{ appearance: "idle" \}/,
  "A successful automatic startup probe must return to the exact default appearance.");
assert.match(source, /const requestedAppearance = extensionVersionWarning \? "error" : options\.appearance \|\| effectiveState;/);
assert.match(source, /PANEL_STATE_ARIA_LABEL\[appearanceState\]/,
  "Status text must expose the semantic state without relying on color alone.");
assert.match(source, /skillHelperInFlight = true;[\s\S]*?setStatus\(buildSkillRunningStatus\(call\), "running"/,
  "Validated Skill helpers must turn blue only when their real dispatch starts.");
assert.match(source, /result\.ok === true && !diagnostics\?\.pendingArtifactId && diagnostics\?\.currentArtifactId === artifactId/,
  "A Draw.io render or exact current-artifact restore may turn green only after staging is clear.");
assert.match(source, /result\.ok === false && latestError\?\.artifactId === artifactId/,
  "A Draw.io failure may turn red only when it still owns the latest error.");
assert.match(source, /!result \|\| result\.cancelled === true \|\|\s*!isPanelStatusOwnedBy/,
  "Cancelled or superseded Draw.io work must not overwrite a newer panel state.");
assert.match(source, /!isPanelStatusOwnedBy\("drawio-render", artifactId\)/,
  "An asynchronous Draw.io result must not overwrite a newer helper or user-operation status.");

console.log("content panel state theme tests passed");
