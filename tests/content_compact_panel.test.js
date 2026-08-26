#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "extension", "src", "content.js"), "utf8");

assert.match(source, /const CONTENT_SCRIPT_VERSION = "0\.11\.1";/);
assert.match(source, /width:min\(292px,calc\(100vw - 32px\)\)/);
assert.match(source, /statusText\.style\.cssText = "[^"]*text-overflow:ellipsis;white-space:nowrap/);
assert.match(source, /statusIndicator\.id = STATUS_INDICATOR_ID/);
assert.match(source, /statusDetail\.id = STATUS_DETAIL_ID/);

const commonActions = source.match(/actions\.dataset\.shellPanelGroup = "common";[\s\S]*?panel\.appendChild\(actions\);/)?.[0] || "";
assert.ok(commonActions, "Compact common action group must exist.");
for (const action of ["check", "force", "stop-helper", "more"]) {
  assert.match(commonActions, new RegExp(`mode: "${action}"`));
}
assert.match(commonActions, /action\.mode === "check"\) \{\s*button\.hidden = true;/);
assert.match(commonActions, /action\.mode === "force"\) \{\s*button\.hidden = true;/);
assert.match(commonActions, /action\.mode === "stop-helper"\) \{\s*button\.hidden = true;/);
for (const advancedOnlyAction of [
  "test",
  "reset-tmux",
  "site",
  "role-filter",
  "input",
  "send",
  "shell",
  "clear",
  "agent-register",
  "agent-list",
  "agent-check",
  "tmux-ai-refresh",
  "tmux-ai-register",
  "skill-view",
  "skill-rescan",
  "skill-force-sync"
]) {
  assert.doesNotMatch(commonActions, new RegExp(`mode: "${advancedOnlyAction}"`));
  assert.match(source, new RegExp(`mode: "${advancedOnlyAction}"`));
}
assert.match(source, /drawioContextAction\.id = DRAWIO_CONTEXT_ACTION_ID;\s*drawioContextAction\.hidden = true;/);
assert.match(source, /mode: "drawio-reopen",\s*label: "Draw\.io preview"/);
assert.match(source, /const hasArtifact = Boolean\(diagnostics\.currentArtifactId\)/);
assert.match(source, /button\.hidden = !hasArtifact && !hasErrors/);
const diagnosticSection = source.match(/const diagnosticSection = createPanelSection\("Tools & diagnostics", "tools-diagnostics"\);[\s\S]*?advancedControls\.appendChild\(diagnosticSection\.section\);/)?.[0] || "";
assert.ok(diagnosticSection, "Tools & diagnostics group must exist.");
assert.doesNotMatch(diagnosticSection, /drawio-reopen/, "Draw.io must be contextual instead of a permanent advanced action.");

assert.match(source, /advancedControls\.id = ADVANCED_CONTROLS_ID;\s*advancedControls\.hidden = true;/);
for (const [title, group] of [
  ["Setup & recovery", "setup-recovery"],
  ["Page binding", "page-binding"],
  ["Agent & tmux-ai", "agent-tmux-ai"],
  ["Skills", "skills"],
  ["Tools & diagnostics", "tools-diagnostics"]
]) {
  assert.match(source, new RegExp(`createPanelSection\\("${title.replace("&", "&")}", "${group}"\\)`));
}
assert.match(source, /button\.setAttribute\("aria-expanded", expanded \? "true" : "false"\)/);
assert.match(source, /advancedControls\.hidden = !expanded/);

assert.match(source, /button\.disabled = !panelShellHelperActive;/);
assert.match(source, /const backendBusy = Boolean\(activeCallId\);/);
assert.match(source, /const showCheck = !backendBusy && !panelShellHelperActive && panel\.dataset\.state === "error";/);
assert.match(source, /const showForce = !backendBusy && !panelShellHelperActive && panelForceRunAvailable;/);
assert.match(source, /activeCallToken = null;\s*updateContextualPanelActions\(\);/);
assert.match(source, /stop\.hidden = !panelShellHelperActive \|\| Boolean\(activeShellRunNotice\);/);
assert.match(source, /setPanelForceRunAvailable\(Boolean\(runnableCandidate\)\)/);
assert.match(source, /createPanelSection\("Setup & recovery", "setup-recovery"\)[\s\S]*?mode: "check", label: "Server Check"/);
assert.match(source, /choose Continue waiting or Stop helper/);
const awaitingUserControls = source.match(/shellRunControl\.innerHTML = \[[\s\S]*?\]\.join\(""\);/)?.[0] || "";
assert.ok(awaitingUserControls, "Output-idle decision controls must exist.");
assert.match(awaitingUserControls, /grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/);
assert.match(awaitingUserControls, /data-shell-tool-action="continue-helper"[^>]*>Continue waiting<\/button>/);
assert.match(awaitingUserControls, /data-shell-tool-action="stop-helper"[^>]*>Stop helper<\/button>/);
assert.doesNotMatch(source, /Force terminate/);
assert.doesNotMatch(source, />Quit<\/button>/);
assert.doesNotMatch(source, /data-shell-tool-action="terminate-helper"/);

assert.match(source, /skillStatusAction\.id = SKILL_STATUS_ACTION_ID/);
assert.match(source, /skillStatusAction\.dataset\.shellToolAction = "skill-sync"/);
assert.match(source, /action\.textContent = `Skills v\$\{version\}\$\{syncing \? " …" : updateAvailable \? " ↑" : ""\}`/);
assert.match(source, /action\.disabled = !updateAvailable \|\| syncing/);
assert.match(source, /action\.style\.background = updateAvailable \? "#065f46" : "#1f2937"/);
const skillsSection = source.match(/const skillsSection = createPanelSection\("Skills", "skills"\);[\s\S]*?advancedControls\.appendChild\(skillsSection\.section\);/)?.[0] || "";
assert.ok(skillsSection, "The complete Skills controls must live in a labelled advanced group.");
for (const [mode, label] of [
  ["skill-view", "View Skills"],
  ["skill-rescan", "Rescan"],
  ["skill-force-sync", "Force sync"]
]) {
  assert.match(skillsSection, new RegExp(`mode: "${mode}", label: "${label}"`));
}
const viewSkillCatalog = source.match(/async function viewSkillCatalog\(\) \{[\s\S]*?\n\}/)?.[0] || "";
assert.match(viewSkillCatalog, /type: "skill-catalog-list"/);
assert.doesNotMatch(viewSkillCatalog, /insertReply|rememberPendingHelperDelivery|attemptPendingHelperDelivery/, "View Skills must remain local and never write to the AI composer.");
assert.match(source, /type: "skill-sync-begin",\s*force/);
assert.match(source, /type: "skill-catalog-rescan"/);

console.log("content compact panel tests passed");
