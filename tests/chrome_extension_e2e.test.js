#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { CdpPipeClient } = require("./helpers/cdp_pipe_client");

const ROOT_DIR = path.join(__dirname, "..");
const EXTENSION_DIR = path.join(ROOT_DIR, "extension");
const TEST_PAGE_URL = "https://localhost:17443/tmux-test-page.html";
const M365_TEST_PAGE_URL = "https://m365.cloud.microsoft:17443/tmux-test-page.html";
const EXTENSION_STATUS_ID = "ai-chat-shell-exec-status";
const DRAWIO_PREVIEW_ID = "ai-chat-shell-exec-drawio-preview";
const EXPECTED_EXTENSION_ORIGIN = "chrome-extension://lkmeogidbglhedgekjgbpbfjkpapnhke";
const E2E_TIMEOUT_MS = 45000;
const MIN_CHROMIUM_MAJOR = 116;
const FORCE_HEADLESS = process.env.AI_SHELL_E2E_HEADLESS === "1";
const SKILLS_ONLY = process.env.AI_SHELL_E2E_SKILLS_ONLY === "1";
const DRAWIO_ONLY = process.env.AI_SHELL_E2E_DRAWIO_ONLY === "1";
const STARTUP_SETTLE_MS = 4200;
const SCREENSHOT_DIR = process.env.AI_SHELL_E2E_SCREENSHOT_DIR || "";

const cleanup = [];

main()
  .then(() => {
    console.log("chrome extension e2e test passed");
  })
  .catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    while (cleanup.length > 0) {
      const fn = cleanup.pop();
      try {
        await fn();
      } catch {
        // Best-effort cleanup for browser, server, tmux, and temp directories.
      }
    }
  });

async function main() {
  const chromePath = findChrome();
  assert.ok(chromePath, `Chrome e2e requires a Chromium-family browser version ${MIN_CHROMIUM_MAJOR}+.`);
  const chromeMajor = getChromiumMajor(chromePath);
  assert.ok(commandExists("tmux"), "Chrome e2e requires tmux on PATH.");
  assert.ok(fs.existsSync(EXTENSION_DIR), `Missing extension directory: ${EXTENSION_DIR}`);
  const browserEnv = await setupBrowserEnvironment(chromePath);

  const serverHealth = await getShellServerHealth().catch(() => null);
  const socketPath = serverHealth?.ok ? String(serverHealth.tmuxSocket || "") : createTempTmuxSocketPath();
  const expectedDefaultSession = String(serverHealth?.tmuxDefaultSession || "ForAI");
  const expectedDefaultHostWindow = String(serverHealth?.tmuxDefaultHostWindow || "host");
  if (serverHealth?.ok) {
    assert.ok(
      serverHealth.allowUntrustedOrigins === true || serverHealth.allowedOrigin === EXPECTED_EXTENSION_ORIGIN,
      `Existing shell server has unexpected allowed origin: ${serverHealth.allowedOrigin || "(unknown)"}`
    );
    const serverProtocolVersion = serverHealth.serverProtocolVersion ?? serverHealth.protocolVersion;
    assert.equal(
      serverProtocolVersion,
      11,
      `Existing shell server protocol is ${serverProtocolVersion || "(missing)"}; restart the local shell server from this checkout before running e2e.`
    );
    assert.equal(
      serverHealth.helperProtocolVersion,
      4,
      `Existing shell helper protocol is ${serverHealth.helperProtocolVersion || "(missing)"}; restart the local shell server from this checkout before running e2e.`
    );
    assert.equal(
      serverHealth.skillProtocolVersion,
      4,
      `Existing Skill protocol is ${serverHealth.skillProtocolVersion || "(missing)"}; restart the local shell server from this checkout before running e2e.`
    );
  }

  const sessionName = `ai_chat_shell_e2e_${process.pid}_${Date.now()}`;
  const paneId = startTmuxSession(socketPath, sessionName);
  cleanup.push(() => killTmuxSession(socketPath, sessionName));
  const tmuxAiSessionName = `ai_chat_shell_agent_e2e_${process.pid}_${Date.now()}`;
  startTmuxCatSession(socketPath, tmuxAiSessionName);
  cleanup.push(() => killTmuxSession(socketPath, tmuxAiSessionName));

  const helperFileTestHome = fs.mkdtempSync(path.join(os.tmpdir(), "ai-chat-shell-file-home-e2e-"));
  const helperFileOverrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-chat-shell-file-override-e2e-"));
  const shellStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-chat-shell-state-e2e-"));
  const skillRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-chat-shell-skills-e2e-"));
  const skillDirectory = path.join(skillRootDir, "e2e-skill");
  const skillPath = path.join(skillDirectory, "SKILL.md");
  const skillInstallPath = path.join(skillDirectory, "install.sh");
  const skillInstallRunPath = path.join(skillDirectory, "install-runs.txt");
  const skillAllowedValue = `skill-allowed-${Date.now()}`;
  const skillSecretValue = `skill-secret-${Date.now()}`;
  fs.mkdirSync(skillDirectory, { recursive: true });
  cleanup.push(() => fs.rmSync(helperFileTestHome, { recursive: true, force: true }));
  cleanup.push(() => fs.rmSync(helperFileOverrideDir, { recursive: true, force: true }));
  cleanup.push(() => fs.rmSync(shellStateDir, { recursive: true, force: true }));
  cleanup.push(() => fs.rmSync(skillRootDir, { recursive: true, force: true }));

  let managedShellServer = null;
  const managedShellServerEnv = {
    AI_CHAT_SHELL_TMUX_SOCKET: socketPath,
    AI_CHAT_SHELL_RUNNER: fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh",
    AI_CHAT_SHELL_ALLOW_UNTRUSTED_ORIGINS: "1",
    AI_CHAT_SHELL_STATE_DIR: shellStateDir,
    AI_HELPER_SKILL_PATHS: skillRootDir,
    AI_HELPER_SKILL_ENV_ALLOWLIST: "E2E_SKILL_ALLOWED",
    E2E_SKILL_ALLOWED: skillAllowedValue,
    E2E_SKILL_SECRET: skillSecretValue,
    HOME: helperFileTestHome
  };
  if (!serverHealth?.ok) {
    managedShellServer = spawnNode(["server/shell_server.js"], {
      ...managedShellServerEnv,
      AI_HELPER_FILE_PATH: null
    });
    cleanup.push(() => stopProcess(managedShellServer));
    await waitForShellServer();
  }

  const existingPage = await fetchHttpsText(TEST_PAGE_URL).catch(() => "");
  if (existingPage) {
    assert.ok(existingPage.includes("tmux ai-helper test"), `${TEST_PAGE_URL} is reachable but is not the repo tmux test page.`);
  } else {
    const pageServer = spawnNode(["scripts/start_tmux_test_page_https.js"], { TEST_PAGE_PORT: "17443" });
    cleanup.push(() => stopProcess(pageServer));
    await waitFor(async () => {
      const text = await fetchHttpsText(TEST_PAGE_URL).catch(() => "");
      return text.includes("tmux ai-helper test");
    }, "tmux HTTPS test page to start");
  }

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-chat-shell-chrome-e2e-"));
  cleanup.push(() => fs.rmSync(profileDir, { recursive: true, force: true }));

  const chromeArgs = [
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--test-type",
    "--enable-automation",
    `--user-data-dir=${profileDir}`,
    "--allow-insecure-localhost",
    "--ignore-certificate-errors",
    "--host-resolver-rules=MAP m365.cloud.microsoft 127.0.0.1",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,900"
  ];
  const useModernExtensionLoader = chromeMajor >= 137;
  if (useModernExtensionLoader) {
    chromeArgs.push(
      "--remote-debugging-pipe",
      "--enable-unsafe-extension-debugging"
    );
  } else {
    chromeArgs.push(
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`
    );
  }
  if (SCREENSHOT_DIR) {
    chromeArgs.push("--force-device-scale-factor=2");
  }
  chromeArgs.push("about:blank");
  if (browserEnv.headless) {
    chromeArgs.unshift("--headless=new");
  }

  const chrome = spawn(chromePath, chromeArgs, {
    cwd: ROOT_DIR,
    env: browserEnv.env,
    stdio: useModernExtensionLoader
      ? ["ignore", "pipe", "pipe", "pipe", "pipe"]
      : ["ignore", "pipe", "pipe"]
  });
  captureProcessOutput(chrome, "chrome");
  cleanup.push(() => stopProcess(chrome));

  if (useModernExtensionLoader) {
    const pipe = CdpPipeClient.fromProcess(chrome, { timeoutMs: E2E_TIMEOUT_MS });
    const loaded = await pipe.send("Extensions.loadUnpacked", {
      path: path.resolve(EXTENSION_DIR)
    });
    assert.equal(
      loaded.id,
      "lkmeogidbglhedgekjgbpbfjkpapnhke",
      `Unexpected unpacked extension id: ${loaded.id || "(missing)"}`
    );
  }
  const debugPort = await waitForChromeDebugPort(profileDir);
  const pageWsUrl = await waitForChromePageWebSocket(debugPort, "about:blank");
  const page = await CdpClient.connect(pageWsUrl);
  cleanup.push(() => page.close());

  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Page.navigate", { url: TEST_PAGE_URL });
  await waitForEvaluate(page, "document.readyState === 'complete'", "test page load");
  await waitForEvaluate(page, "document.body.innerText.includes('tmux ai-helper test')", "tmux test page content");
  await waitForEvaluate(page, `Boolean(document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)}))`, "extension status panel");
  // MV3 service workers start lazily in a clean profile. Loading the matched
  // page first wakes this extension without relying on an already-installed
  // copy in the user's normal browser profile.
  await waitForExtensionTarget(debugPort);
  await page.evaluate(`new Promise((resolve) => setTimeout(resolve, ${STARTUP_SETTLE_MS}))`);

  const compactPanelState = await page.evaluate(`(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    const common = panel?.querySelector('[data-shell-panel-group="common"]');
    const advanced = panel?.querySelector('#ai-chat-shell-exec-advanced-controls');
    const binding = advanced?.querySelector('[data-shell-panel-group="page-binding"]');
    const roleBadge = panel?.querySelector('#ai-chat-shell-exec-agent-role-badge');
    const skillChip = panel?.querySelector('#ai-chat-shell-exec-skill-status');
    const visibleCommonActions = Array.from(common?.querySelectorAll('[data-shell-tool-action]') || [])
      .filter((button) => getComputedStyle(button).display !== "none")
      .map((button) => button.dataset.shellToolAction);
    return {
      width: panel?.getBoundingClientRect().width || 0,
      advancedHidden: advanced?.hidden === true,
      advancedOpen: panel?.dataset.advancedOpen || "",
      visibleCommonActions,
      stopDisabled: panel?.querySelector('[data-shell-tool-action="stop-helper"]')?.disabled === true,
      stopHidden: panel?.querySelector('[data-shell-tool-action="stop-helper"]')?.hidden === true,
      advancedActionsPresent: [
        "check", "test", "site", "reset-tmux", "role-filter",
        "input", "send", "shell", "clear",
        "agent-register", "agent-list", "agent-check",
        "tmux-ai-refresh", "tmux-ai-register",
        "skill-view", "skill-rescan", "skill-force-sync"
      ].every((action) => Boolean(advanced?.querySelector('[data-shell-tool-action="' + action + '"]'))),
      drawioHidden: panel?.querySelector('#ai-chat-shell-exec-drawio-action')?.hidden === true,
      drawioInAdvanced: Boolean(advanced?.querySelector('[data-shell-tool-action="drawio-reopen"]')),
      bindingTag: binding?.tagName || "",
      bindingOpen: binding?.open === true,
      roleText: roleBadge?.textContent || "",
      roleState: roleBadge?.dataset.agentRole || "",
      roleAria: roleBadge?.getAttribute("aria-label") || "",
      roleOverlapsSkill: !skillChip?.hidden && roleBadge && skillChip
        ? roleBadge.getBoundingClientRect().right > skillChip.getBoundingClientRect().left
        : false,
      groups: Array.from(panel?.querySelectorAll('[data-shell-panel-group]') || [])
        .map((element) => element.dataset.shellPanelGroup)
    };
  })()`);
  assert.ok(compactPanelState.width > 0 && compactPanelState.width <= 300, JSON.stringify(compactPanelState));
  assert.equal(compactPanelState.advancedHidden, true, JSON.stringify(compactPanelState));
  assert.equal(compactPanelState.advancedOpen, "", JSON.stringify(compactPanelState));
  assert.deepEqual(compactPanelState.visibleCommonActions, ["more"]);
  assert.equal(compactPanelState.stopDisabled, true, JSON.stringify(compactPanelState));
  assert.equal(compactPanelState.stopHidden, true, JSON.stringify(compactPanelState));
  assert.equal(compactPanelState.advancedActionsPresent, true, JSON.stringify(compactPanelState));
  assert.equal(compactPanelState.drawioHidden, true, JSON.stringify(compactPanelState));
  assert.equal(compactPanelState.drawioInAdvanced, false, JSON.stringify(compactPanelState));
  assert.equal(compactPanelState.bindingTag, "DETAILS", JSON.stringify(compactPanelState));
  assert.equal(compactPanelState.bindingOpen, false, JSON.stringify(compactPanelState));
  assert.equal(compactPanelState.roleText, "None", JSON.stringify(compactPanelState));
  assert.equal(compactPanelState.roleState, "none", JSON.stringify(compactPanelState));
  assert.match(compactPanelState.roleAria, /Page role: None; shell target ForAI:host/);
  assert.equal(compactPanelState.roleOverlapsSkill, false, JSON.stringify(compactPanelState));
  assert.deepEqual(compactPanelState.groups, [
    "common",
    "setup-recovery",
    "agent-tmux-ai",
    "skills",
    "tools-diagnostics",
    "page-binding"
  ]);
  await page.evaluate(`document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-tool-action="more"]')?.click()`);
  await waitForEvaluate(page, `(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    const advanced = panel?.querySelector('#ai-chat-shell-exec-advanced-controls');
    const more = panel?.querySelector('[data-shell-tool-action="more"]');
    return advanced?.hidden === false && more?.getAttribute("aria-expanded") === "true";
  })()`, "compact panel advanced controls to expand");
  const unsavedRoleBadge = await page.evaluate(`(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    const select = panel?.querySelector('[data-shell-agent-role]');
    select.value = "master";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const result = panel?.querySelector('#ai-chat-shell-exec-agent-role-badge')?.textContent || "";
    select.value = "none";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return result;
  })()`);
  assert.equal(unsavedRoleBadge, "None", "An unsaved role draft must not change the active role badge.");
  if (SCREENSHOT_DIR) {
    await savePanelScreenshot(page, path.join(SCREENSHOT_DIR, "extension-panel-advanced.png"));
    await page.evaluate(`(() => {
      const advanced = document.querySelector('#${EXTENSION_STATUS_ID} #ai-chat-shell-exec-advanced-controls');
      advanced.scrollTop = advanced.scrollHeight;
      return true;
    })()`);
    await savePanelScreenshot(page, path.join(SCREENSHOT_DIR, "extension-panel-page-binding.png"));
  }
  await page.evaluate(`document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-panel-group="page-binding"] > summary')?.click(); true`);
  await waitForEvaluate(page, `document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-panel-group="page-binding"]')?.open === true`, "Page binding native details expansion");
  await page.evaluate(`document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-panel-group="page-binding"] > summary')?.click(); true`);
  await waitForEvaluate(page, `document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-panel-group="page-binding"]')?.open === false`, "Page binding to collapse again");
  await page.evaluate(`document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-tool-action="more"]')?.click()`);
  await waitForEvaluate(page, `document.querySelector('#${EXTENSION_STATUS_ID} #ai-chat-shell-exec-advanced-controls')?.hidden === true`, "compact panel advanced controls to collapse");

  if (DRAWIO_ONLY) {
    await page.send("Page.bringToFront");
    await waitForEvaluate(page, "document.visibilityState === 'visible'", "Draw.io-only preview page to become visible");
    await runDrawioPreviewE2E(page);
    return;
  }

  if (managedShellServer) {
    await runEmptySkillCatalogE2E(page, { skillPath, skillInstallPath, skillInstallRunPath, shellStateDir });
    const skillE2eState = await runSkillE2E(page, debugPort, {
      skillPath,
      skillInstallRunPath,
      shellStateDir,
      expectedHome: helperFileTestHome,
      allowedValue: skillAllowedValue,
      secretValue: skillSecretValue
    });
    await runIsolatedSkillLoadDispatchE2E(debugPort, skillE2eState.catalogSha);
  } else {
    console.log("Deterministic Skill browser E2E skipped because the fixed shell-server port is owned by an existing foreground server.");
  }
  if (SKILLS_ONLY) {
    assert.ok(managedShellServer, "Skills-only Chrome E2E requires the isolated managed shell server.");
    return;
  }

  // A developer may rerun this E2E against an already-running foreground
  // server after a prior browser process crashed before unregistering. Clear
  // the fixed test identities so stale mailbox/roster state cannot make the
  // current clean-profile assertions timing-dependent.
  for (const agentId of ["slave-a", "master", "slave-tmux-ai"]) {
    await sendLocalAgentRequest(page, {
      type: "agent-unregister",
      agentId
    });
  }

  await page.evaluate(`(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    panel.querySelector("[data-shell-agent-role]").value = "slave";
    panel.querySelector("[data-shell-agent-id]").value = "slave-a";
    panel.querySelector('[data-shell-tool-action="agent-register"]').click();
    return true;
  })()`);
  await waitForEvaluate(page, `document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)}).innerText.includes("Registered slave slave-a")`, "panel agent slave registration");
  await waitForEvaluate(page, `(() => {
    const badge = document.querySelector('#${EXTENSION_STATUS_ID} #ai-chat-shell-exec-agent-role-badge');
    return badge?.textContent === "Slave" && badge?.dataset.agentRole === "slave" &&
      /agent slave-a; shell target ForAI-slave-a:host/.test(badge?.getAttribute("aria-label") || "") &&
      getComputedStyle(badge).borderColor === "rgb(167, 139, 250)";
  })()`, "saved Slave role badge");

  let agentResponse = await sendLocalAgentRequest(page, {
    type: "agent-list"
  });
  assert.equal(agentResponse.ok, true);
  assert.ok(agentResponse.agents.some((agent) => agent.agentId === "slave-a" && agent.role === "slave"));

  // The multi-page agent setup leaves this page backgrounded. Draw.io timeout
  // budgets intentionally pause while hidden, so make the preview page visible
  // before asserting bounded renderer-failure recovery.
  await page.send("Page.bringToFront");
  await waitForEvaluate(page, "document.visibilityState === 'visible'", "Draw.io preview page to become visible");
  await runDrawioPreviewE2E(page);

  const agentTmuxToken = `agent-tmux-e2e-${Date.now()}`;
  await page.evaluate(`(() => {
    document.getElementById("command").value = ${JSON.stringify(`printf ${agentTmuxToken}`)};
    document.getElementById("insertCall").click();
    return true;
  })()`);
  const agentTmuxText = await waitForEvaluateValue(page, `(() => {
    const text = document.body.innerText || "";
    return text.includes("Shell call result:") &&
      text.includes("targetName: ForAI-slave-a") &&
      text.includes(${JSON.stringify(`stdout:\n${agentTmuxToken}`)}) ? text : "";
  })()`, "agent shell helper uses per-agent tmux");
  assert.match(agentTmuxText, /targetName: ForAI-slave-a/);
  try {
    await waitForEvaluate(page, `(() => {
      const composer = document.getElementById("composer");
      const submitted = Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
        .some((node) => (node.innerText || "").includes(${JSON.stringify(agentTmuxToken)}));
      return submitted && !(composer?.innerText || "").trim();
    })()`, "agent shell output to be submitted before agent delivery tests");
  } catch (error) {
    const deliveryState = await page.evaluate(`(() => ({
      composer: document.getElementById("composer")?.innerText || "",
      panel: document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)})?.innerText || "",
      users: Array.from(document.querySelectorAll('[data-message-author-role="user"]')).map((node) => node.innerText || "")
    }))()`);
    const isolatedWorlds = await page.evaluateAcrossContexts(`(() => {
      if (typeof activeOriginalSendActuatorGuard === "undefined") {
        return null;
      }
      const candidates = typeof getVisibleReplyInputCandidates === "function"
        ? getVisibleReplyInputCandidates()
        : [];
      return {
        guardCurrent: typeof isOriginalSendActuatorGuardCurrent === "function"
          ? isOriginalSendActuatorGuardCurrent(activeOriginalSendActuatorGuard)
          : null,
        guardExpected: activeOriginalSendActuatorGuard?.expectedText || "",
        guardActual: typeof getComposerText === "function"
          ? getComposerText(activeOriginalSendActuatorGuard?.composer)
          : "",
        guardComposerId: activeOriginalSendActuatorGuard?.composer?.id || "",
        guardConnected: activeOriginalSendActuatorGuard?.composer?.isConnected,
        lastComposerId: lastComposerElement?.id || "",
        currentComposerId: typeof findCurrentReplyInputSynchronously === "function"
          ? findCurrentReplyInputSynchronously()?.id || ""
          : "",
        activeElementId: document.activeElement?.id || "",
        candidates: candidates.map((candidate) => ({
          id: candidate.id || "",
          tagName: candidate.tagName || "",
          text: typeof getComposerText === "function" ? getComposerText(candidate) : "",
          likely: typeof isLikelyReplyComposerCandidate === "function"
            ? isLikelyReplyComposerCandidate(candidate)
            : null,
          score: typeof editableScore === "function" ? editableScore(candidate) : null
        }))
      };
    })()`);
    deliveryState.isolatedWorlds = isolatedWorlds;
    throw new Error(`${error.message}; deliveryState=${JSON.stringify(deliveryState)}`);
  }

  const defaultPaneBeforeRoleReset = getTmuxWindowPaneId(
    socketPath,
    expectedDefaultSession,
    expectedDefaultHostWindow
  );
  const agentPaneBeforeRoleReset = getTmuxWindowPaneId(socketPath, "ForAI-slave-a", "host");
  await page.evaluate("window.sessionStorage.clear(); true");
  await page.send("Page.reload", { ignoreCache: true });
  await waitForEvaluate(page, "document.readyState === 'complete'", "role refresh page load");
  await waitForEvaluate(page, `(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    const badge = panel?.querySelector("#ai-chat-shell-exec-agent-role-badge");
    return panel?.querySelector("[data-shell-agent-role]")?.value === "slave" &&
      panel?.querySelector("[data-shell-agent-id]")?.value === "slave-a" &&
      badge?.textContent === "Slave" && badge?.dataset.agentRole === "slave";
  })()`, "per-tab role restoration after page session storage was cleared");
  await waitFor(async () => {
    const states = await page.evaluateAcrossContexts(`(() =>
      typeof initialThreadSettled === "boolean" ? initialThreadSettled : null
    )()`);
    return states.some((entry) => entry.value === true);
  }, "content script baseline scan after role refresh");

  const refreshedAgentTmuxToken = `agent-tmux-refresh-e2e-${Date.now()}`;
  await appendLiveAssistantHelper(page, [
    "ai-helper-shell-start:agent-tmux-refresh-e2e",
    `printf ${refreshedAgentTmuxToken}`,
    "ai-helper-shell-end"
  ].join("\n"));
  const refreshedAgentTmuxText = await waitForEvaluateValue(page, `(() => {
    const text = document.body.innerText || "";
    return text.includes("targetName: ForAI-slave-a") &&
      text.includes(${JSON.stringify(`stdout:\n${refreshedAgentTmuxToken}`)}) ? text : "";
  })()`, "refreshed role shell helper uses per-agent tmux");
  assert.match(refreshedAgentTmuxText, /targetName: ForAI-slave-a/);

  const resetResults = await page.evaluateAcrossContexts(`(async () => {
    if (typeof resetForAiTmux !== "function") {
      return null;
    }
    window.confirm = () => true;
    await resetForAiTmux();
    return document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)})?.innerText || "";
  })()`);
  assert.ok(
    resetResults.some((entry) => entry.value.includes("Reset ForAI-slave-a tmux")),
    `Role-scoped Reset tmux did not report the agent session: ${JSON.stringify(resetResults)}`
  );
  const defaultPaneAfterRoleReset = getTmuxWindowPaneId(
    socketPath,
    expectedDefaultSession,
    expectedDefaultHostWindow
  );
  const agentPaneAfterRoleReset = getTmuxWindowPaneId(socketPath, "ForAI-slave-a", "host");
  assert.equal(
    defaultPaneAfterRoleReset,
    defaultPaneBeforeRoleReset,
    "Reset tmux from a slave role must not replace the default ForAI session."
  );
  assert.notEqual(
    agentPaneAfterRoleReset,
    agentPaneBeforeRoleReset,
    "Reset tmux from a slave role must replace only ForAI-slave-a."
  );

  const masterPage = await openChromePage(debugPort, TEST_PAGE_URL);
  cleanup.push(() => masterPage.close());
  await masterPage.send("Page.enable");
  await masterPage.send("Runtime.enable");
  await waitForEvaluate(masterPage, "document.readyState === 'complete'", "master test page load");
  await waitForEvaluate(masterPage, `Boolean(document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)}))`, "master extension status panel");
  await masterPage.evaluate(`new Promise((resolve) => setTimeout(resolve, ${STARTUP_SETTLE_MS}))`);
  await masterPage.evaluate(`(() => {
    const composer = document.getElementById("composer");
    composer.focus();
    composer.click();
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    panel.querySelector("[data-shell-agent-role]").value = "master";
    panel.querySelector("[data-shell-agent-id]").value = "master";
    panel.querySelector('[data-shell-tool-action="agent-register"]').click();
    return true;
  })()`);
  await waitForEvaluate(masterPage, `document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)}).innerText.includes("Registered master master")`, "master panel agent registration");
  await waitForEvaluate(masterPage, `(() => {
    const badge = document.querySelector('#${EXTENSION_STATUS_ID} #ai-chat-shell-exec-agent-role-badge');
    return badge?.textContent === "Master" && badge?.dataset.agentRole === "master" &&
      /agent master; shell target ForAI-master:host/.test(badge?.getAttribute("aria-label") || "") &&
      getComputedStyle(badge).borderColor === "rgb(96, 165, 250)";
  })()`, "saved Master role badge");
  await masterPage.evaluate(`(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    panel.querySelector('[data-shell-tool-action="agent-check"]').click();
    return true;
  })()`);
  await waitForEvaluate(masterPage, `(() => {
    const text = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)}).innerText || "";
    return text.includes("Agent setup check:") &&
      text.includes("web slaves: slave-a") &&
      text.includes("tmux-ai slaves: none") &&
      text.includes("Ready: delegate to slave-a. Tmux AI is optional.");
  })()`, "master panel agent setup check browser-only ready state");

  const helperAgentTaskId = `task-helper-e2e-${Date.now()}`;
  const helperAgentBody = `master helper delegated to slave page ${helperAgentTaskId}`;
  await masterPage.evaluate(`(() => {
    document.getElementById("agentTo").value = "slave-a";
    document.getElementById("agentTaskId").value = ${JSON.stringify(helperAgentTaskId)};
    document.getElementById("agentBody").value = ${JSON.stringify(helperAgentBody)};
    document.getElementById("insertAgentMessage").click();
    return true;
  })()`);

  const agentHelperText = await waitForEvaluateValue(masterPage, `(() => {
    const text = document.body.innerText || "";
    return text.includes("Agent message result:") &&
      text.includes("to: slave-a") &&
      text.includes(${JSON.stringify(`task-id: ${helperAgentTaskId}`)}) ? text : "";
  })()`, "agent-message helper result from master tab");
  assert.match(agentHelperText, /Agent message result:/);

  const slaveDeliveredText = await waitForEvaluateValue(page, `(() => {
    const text = document.body.innerText || "";
    return text.includes(${JSON.stringify(`Message from master for task ${helperAgentTaskId}:`)}) &&
      text.includes(${JSON.stringify(helperAgentBody)}) ? text : "";
  })()`, "master helper task delivered into slave tab");
  assert.match(slaveDeliveredText, new RegExp(escapeRegExp(helperAgentBody)));

  const rosterHelperId = `roster-e2e-${Date.now()}`;
  await appendLiveAssistantHelper(masterPage, [
    `ai-helper-agent-roster-start:${rosterHelperId}`,
    "role: slave",
    "ai-helper-agent-roster-end"
  ].join("\n"));
  const rosterHelperText = await waitForEvaluateValue(masterPage, `(() => {
    const text = document.body.innerText || "";
    return text.includes("Agent roster result:") &&
      text.includes("filterRole: slave") &&
      text.includes("slave-a role=slave surface=web") ? text : "";
  })()`, "agent roster helper result from master tab");
  assert.match(rosterHelperText, /Agent roster result:/);

  const statusHelperId = `status-e2e-${Date.now()}`;
  await appendLiveAssistantHelper(masterPage, [
    `ai-helper-agent-task-status-start:${statusHelperId}`,
    `task-id: ${helperAgentTaskId}`,
    "ai-helper-agent-task-status-end"
  ].join("\n"));
  const statusHelperText = await waitForEvaluateValue(masterPage, `(() => {
    const text = document.body.innerText || "";
    return text.includes("Agent task status result:") &&
      text.includes(${JSON.stringify(`task-id: ${helperAgentTaskId}`)}) ? text : "";
  })()`, "agent task-status helper result from master tab");
  assert.match(statusHelperText, /Agent task status result:/);

  const tmuxAiTaskId = `task-tmux-ai-e2e-${Date.now()}`;
  const tmuxAiBody = `tmux AI agent task delivered from browser e2e ${tmuxAiTaskId}`;
  await masterPage.evaluate(`(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    panel.querySelector('[data-shell-tool-action="tmux-ai-refresh"]').click();
    return true;
  })()`);
  await waitForEvaluate(masterPage, `(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    const target = panel.querySelector("[data-shell-tmux-ai-target]");
    return Array.from(target.options).some((option) => option.value === ${JSON.stringify(`${tmuxAiSessionName}:0.0`)});
  })()`, "tmux-ai refresh lists real tmux pane");
  await masterPage.evaluate(`(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    panel.querySelector("[data-shell-tmux-ai-id]").value = "slave-tmux-ai";
    const target = panel.querySelector("[data-shell-tmux-ai-target]");
    target.value = ${JSON.stringify(`${tmuxAiSessionName}:0.0`)};
    panel.querySelector('[data-shell-tool-action="tmux-ai-register"]').click();
    return true;
  })()`);
  agentResponse = await waitForValue(async () => {
    const response = await sendLocalAgentRequest(masterPage, {
      type: "agent-list"
    });
    return response?.agents?.some((agent) => agent.agentId === "slave-tmux-ai" && agent.surface === "tmux-ai")
      ? response
      : null;
  }, "master panel tmux-ai slave registration");
  assert.equal(agentResponse.ok, true, JSON.stringify(agentResponse));
  assert.ok(agentResponse.agents.some((agent) => agent.agentId === "slave-tmux-ai" && agent.surface === "tmux-ai"));

  agentResponse = await sendLocalAgentRequest(masterPage, {
    type: "agent-send",
    from: "master",
    to: "slave-tmux-ai",
    taskId: tmuxAiTaskId,
    body: tmuxAiBody,
    messageId: `msg-${tmuxAiTaskId}`
  });
  assert.equal(agentResponse.ok, true, JSON.stringify(agentResponse));
  assert.equal(agentResponse.message.deliverySurface, "tmux-ai");
  assert.equal(agentResponse.delivery.status, "delivered");
  assert.match(agentResponse.delivery.replyCommand, /^sh '/);
  assert.match(agentResponse.delivery.replyScriptFile, /reply\.sh$/);
  const tmuxAiPaneText = runTmux(socketPath, ["capture-pane", "-p", "-J", "-S", "-200", "-t", `${tmuxAiSessionName}:0.0`]).stdout;
  assert.match(tmuxAiPaneText, new RegExp(escapeRegExp(tmuxAiBody)));
  assert.match(tmuxAiPaneText, /Reply command \(short\):/);
  assert.match(tmuxAiPaneText, /reply\.sh/);

  const tmuxAiReplyBody = `tmux AI CLI reply delivered to master ${tmuxAiTaskId}`;
  fs.mkdirSync(path.dirname(agentResponse.delivery.replyBodyFile), { recursive: true });
  fs.writeFileSync(agentResponse.delivery.replyBodyFile, tmuxAiReplyBody, "utf8");
  const cliReply = spawnSync("sh", [agentResponse.delivery.replyScriptFile], {
    cwd: ROOT_DIR,
    encoding: "utf8"
  });
  assert.equal(cliReply.status, 0, `agent reply CLI failed:\nstdout:\n${cliReply.stdout}\nstderr:\n${cliReply.stderr}`);
  const cliReplyJson = JSON.parse(cliReply.stdout);
  assert.equal(cliReplyJson.ok, true, JSON.stringify(cliReplyJson));

  const tmuxAiDeliveredText = await waitForEvaluateValue(masterPage, `(() => {
    const text = document.body.innerText || "";
    return text.includes(${JSON.stringify(`Message from slave-tmux-ai for task ${tmuxAiTaskId}:`)}) &&
      text.includes(${JSON.stringify(tmuxAiReplyBody)}) ? text : "";
  })()`, "tmux AI CLI reply delivered into master tab");
  assert.match(tmuxAiDeliveredText, new RegExp(escapeRegExp(tmuxAiReplyBody)));

  const deliveryTaskId = `task-delivery-e2e-${Date.now()}`;
  const deliveryBody = `deliver this task into the slave composer ${deliveryTaskId}`;
  agentResponse = await sendLocalAgentRequest(page, {
    type: "agent-send",
    from: "master",
    to: "slave-a",
    taskId: deliveryTaskId,
    body: deliveryBody
  });
  assert.equal(agentResponse.ok, true);
  await waitForEvaluate(page, `(() => {
    const composer = document.getElementById("composer");
    composer.focus();
    composer.click();
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`, "focus composer for agent delivery");
  let deliveredText;
  try {
    deliveredText = await waitForEvaluateValue(page, `(() => {
      const text = document.body.innerText || "";
      return text.includes(${JSON.stringify(`Message from master for task ${deliveryTaskId}:`)}) &&
        text.includes(${JSON.stringify(deliveryBody)}) &&
        text.includes("You are slave-a") ? text : "";
    })()`, "agent message delivered into local page composer");
  } catch (error) {
    const deliveryState = await page.evaluate(`(() => ({
      composer: document.getElementById("composer")?.innerText || "",
      panel: document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)})?.innerText || "",
      users: Array.from(document.querySelectorAll('[data-message-author-role="user"]')).map((node) => node.innerText || "")
    }))()`);
    throw new Error(`${error.message}; deliveryState=${JSON.stringify(deliveryState)}`);
  }
  assert.match(deliveredText, new RegExp(escapeRegExp(deliveryBody)));
  assert.match(deliveredText, /> ai-helper-agent-message-start/);
  assert.doesNotMatch(deliveredText, /^ai-helper-agent-message-start$/m);

  await page.evaluate(`(() => {
    appendMessage("user", [
      ${JSON.stringify(`Message from master for task ${deliveryTaskId}:`)},
      "",
      ${JSON.stringify(deliveryBody)},
      "",
      "You are slave-a. Complete the task in this chat. When finished, reply to master with this exact helper format:",
      "",
      "> ai-helper-agent-message-start",
      "> to: master",
      ${JSON.stringify(`> task-id: ${deliveryTaskId}`)},
      ${JSON.stringify(`> reply-to: ${agentResponse.message.messageId}`)},
      ">",
      "> <your result>",
      "> ai-helper-agent-message-end",
      "",
      "Remove the leading > quote markers when you send the final helper reply."
    ].join("\\n"));
    const composer = document.getElementById("composer");
    composer.replaceChildren();
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await page.evaluate("new Promise((resolve) => setTimeout(resolve, 4000))");
  agentResponse = await sendLocalAgentRequest(masterPage, {
    type: "agent-task-status",
    agentId: "master",
    taskId: deliveryTaskId
  });
  assert.equal(agentResponse.ok, true, JSON.stringify(agentResponse));
  assert.ok(!String(agentResponse.status || "").includes("replied"), JSON.stringify(agentResponse));
  const masterAfterDeliveryText = await masterPage.evaluate("document.body.innerText || ''");
  assert.ok(!masterAfterDeliveryText.includes("<your result>"), "browser slave reply template must not auto-send placeholder result to master");

  await page.evaluate(`(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    panel.querySelector("[data-shell-agent-role]").value = "none";
    panel.querySelector('[data-shell-tool-action="agent-register"]').click();
    return true;
  })()`);
  await waitForEvaluate(page, `document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)}).innerText.includes("Agent mode disabled")`, "page agent mode to disable before non-agent refresh tests");
  await waitForEvaluate(page, `(() => {
    const badge = document.querySelector('#${EXTENSION_STATUS_ID} #ai-chat-shell-exec-agent-role-badge');
    return badge?.textContent === "None" && badge?.dataset.agentRole === "none" &&
      /shell target ForAI:host/.test(badge?.getAttribute("aria-label") || "") &&
      getComputedStyle(badge).borderColor === "rgb(75, 85, 99)";
  })()`, "disabled agent None role badge");

  const deletedComposerMarkerPath = path.join(os.tmpdir(), `ai-chat-shell-deleted-composer-e2e-${process.pid}-${Date.now()}.txt`);
  const deletedComposerToken = `ai-chat-shell-deleted-composer-${Date.now()}`;
  const afterDeletionToken = `ai-chat-shell-after-deletion-${Date.now()}`;
  cleanup.push(() => fs.rmSync(deletedComposerMarkerPath, { force: true }));
  const deletedComposerCommand = [
    `printf 'executed\\n' >> ${shellQuote(deletedComposerMarkerPath)}`,
    `printf '${deletedComposerToken}'`
  ].join("; ");
  await page.evaluate(`(() => {
    const composer = document.getElementById("composer");
    const form = document.getElementById("composerForm");
    const send = document.getElementById("send");
    window.__aiShellDeletionGuard?.abort();
    window.__aiShellDeletionGuard = new AbortController();
    const options = { capture: true, signal: window.__aiShellDeletionGuard.signal };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    }, options);
    composer.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, options);
    send.disabled = true;
    composer.focus();
    composer.click();
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await appendLiveAssistantHelper(page, [
    "ai-helper-shell-start:deleted-composer-e2e",
    deletedComposerCommand,
    "ai-helper-shell-end"
  ].join("\n"));
  await waitForEvaluate(page, `(() => {
    const text = document.getElementById("composer")?.innerText || "";
    return text.includes(${JSON.stringify(deletedComposerToken)}) && text.includes("Shell call result:");
  })()`, "pending shell output to be inserted before intentional deletion");
  const deletionUserCountBefore = await page.evaluate("document.querySelectorAll('[data-message-author-role=\"user\"]').length");
  await page.evaluate(`(() => {
    const composer = document.getElementById("composer");
    composer.replaceChildren();
    composer.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      composed: true,
      inputType: "deleteContentBackward",
      data: null
    }));
    composer.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "deleteContentBackward",
      data: null
    }));
    composer.dispatchEvent(new Event("change", { bubbles: true }));
    return !(composer.innerText || "").trim();
  })()`);
  await page.evaluate("new Promise((resolve) => setTimeout(resolve, 6500))");
  const deletionState = await page.evaluate(`(() => ({
    composer: document.getElementById("composer")?.innerText || "",
    userCount: document.querySelectorAll('[data-message-author-role="user"]').length,
    userText: Array.from(document.querySelectorAll('[data-message-author-role="user"]')).map((node) => node.innerText || "").join("\\n")
  }))()`);
  assert.equal(deletionState.composer, "", "Intentionally deleted helper output must remain absent across multiple retry intervals.");
  assert.equal(deletionState.userCount, deletionUserCountBefore, "Deleted helper output must not be submitted after cancellation.");
  assert.ok(!deletionState.userText.includes(deletedComposerToken));
  assert.equal(fs.readFileSync(deletedComposerMarkerPath, "utf8"), "executed\n", "Composer cancellation must not re-execute the shell command.");

  await page.evaluate(`(() => {
    window.__aiShellDeletionGuard?.abort();
    const send = document.getElementById("send");
    send.disabled = false;
    return true;
  })()`);
  await appendLiveAssistantHelper(page, [
    "ai-helper-shell-start:after-deleted-composer-e2e",
    `printf '${afterDeletionToken}'`,
    "ai-helper-shell-end"
  ].join("\n"));
  try {
    await waitForEvaluate(page, `(() => {
      const composer = document.getElementById("composer");
      const submitted = Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
        .some((node) => (node.innerText || "").includes(${JSON.stringify(afterDeletionToken)}));
      return submitted && !(composer?.innerText || "").trim();
    })()`, "new helper to deliver normally after user-cancelled composer output");
  } catch (error) {
    const isolatedWorlds = await page.evaluateAcrossContexts(`(() => {
      if (typeof pendingHelperDeliveries === "undefined") {
        return null;
      }
      const composer = document.getElementById("composer");
      const candidate = typeof findSendButton === "function" ? findSendButton(composer, false) : null;
      return {
        savedSendSelector,
        pageLifecycleGeneration,
        observedPageIdentity,
        activeComposerDeliveryToken,
        guardCurrent: typeof isOriginalSendActuatorGuardCurrent === "function"
          ? isOriginalSendActuatorGuardCurrent(activeOriginalSendActuatorGuard)
          : null,
        guardExpectedText: activeOriginalSendActuatorGuard?.expectedText || "",
        guardActualText: typeof getComposerText === "function"
          ? getComposerText(activeOriginalSendActuatorGuard?.composer)
          : "",
        currentComposerText: typeof getComposerText === "function" ? getComposerText(composer) : "",
        candidateId: candidate?.id || "",
        candidateText: candidate?.innerText || candidate?.textContent || "",
        candidateDisabled: candidate?.disabled,
        formId: composer?.closest?.("form")?.id || "",
        pending: Array.from(pendingHelperDeliveries.values()).map((entry) => ({
          callId: entry.callId,
          phase: entry.phase,
          sendActuatorGeneration: entry.sendActuatorGeneration,
          deliveryInFlight: entry.deliveryInFlight,
          lastError: entry.lastError
        }))
      };
    })()`);
    const deletionDiagnostics = await page.evaluate(`(() => ({
      composer: document.getElementById("composer")?.innerText || "",
      status: document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)})?.innerText || "",
      helperDebug: document.getElementById("ai-chat-shell-exec-debug-body")?.textContent || "",
      sendButton: {
        disabled: document.getElementById("send")?.disabled,
        ariaDisabled: document.getElementById("send")?.getAttribute("aria-disabled")
      },
      body: document.body.innerText || "",
      users: Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
        .map((node) => node.innerText || "")
    }))()`);
    deletionDiagnostics.isolatedWorlds = isolatedWorlds;
    throw new Error(`${error.message}; deletionDiagnostics=${JSON.stringify(deletionDiagnostics)}`);
  }

  const refreshMarkerPath = path.join(os.tmpdir(), `ai-chat-shell-refresh-e2e-${process.pid}-${Date.now()}.txt`);
  const refreshOldToken = `ai-chat-shell-refresh-old-${Date.now()}`;
  const refreshNewToken = `ai-chat-shell-refresh-new-${Date.now()}`;
  cleanup.push(() => fs.rmSync(refreshMarkerPath, { force: true }));
  const refreshOldCommand = [
    `printf 'started\\n' > ${shellQuote(refreshMarkerPath)}`,
    `printf '${refreshOldToken}\\n'`,
    "sleep 12",
    `printf 'done\\n' >> ${shellQuote(refreshMarkerPath)}`
  ].join("; ");
  await page.evaluate(`(() => {
    const composer = document.getElementById("composer");
    composer.focus();
    composer.click();
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await appendLiveAssistantHelper(page, [
    "ai-helper-shell-start:refresh-old-page",
    refreshOldCommand,
    "ai-helper-shell-end"
  ].join("\n"));
  try {
    await waitFor(
      () => fs.existsSync(refreshMarkerPath) && fs.readFileSync(refreshMarkerPath, "utf8").includes("started"),
      "long helper to start before page refresh"
    );
  } catch (error) {
    const diagnostics = await collectDiagnostics(page, debugPort, {
      chrome,
      token: refreshOldToken,
      paneId,
      command: refreshOldCommand,
      sessionName
    });
    throw new Error(`${error.message}\n\n${diagnostics}`);
  }

  const refreshedUrl = `${TEST_PAGE_URL}?refresh=${Date.now()}`;
  await page.send("Page.navigate", { url: refreshedUrl });
  await waitForEvaluate(page, `location.href === ${JSON.stringify(refreshedUrl)}`, "refreshed test page navigation");
  await waitForEvaluate(page, "document.readyState === 'complete'", "refreshed test page load");
  await waitForEvaluate(page, `Boolean(document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)}))`, "extension status after refresh");
  await page.evaluate(`new Promise((resolve) => setTimeout(resolve, ${STARTUP_SETTLE_MS}))`);

  const refreshNewCommand = `printf '${refreshNewToken}'`;
  await page.evaluate(`(() => {
    const composer = document.getElementById("composer");
    composer.focus();
    composer.click();
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await appendLiveAssistantHelper(page, [
    "ai-helper-shell-start:refresh-new-page",
    refreshNewCommand,
    "ai-helper-shell-end"
  ].join("\n"));
  const refreshText = await waitForEvaluateValue(page, `(() => {
    const text = document.body.innerText || "";
    return text.includes("Shell call result:") &&
      text.includes("queued: true") &&
      text.includes("queuedMs:") &&
      text.includes(${JSON.stringify(`stdout:\n${refreshNewToken}`)}) ? text : "";
  })()`, "new helper result after refreshing during a long shell command");
  assert.match(refreshText, /^queued: true$/m);
  assert.match(refreshText, /^queuedMs: \d+$/m);
  assert.equal(fs.readFileSync(refreshMarkerPath, "utf8"), "started\ndone\n");
  await waitForEvaluate(page, `(() => {
    const composer = document.getElementById("composer");
    const submitted = Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
      .some((node) => (node.innerText || "").includes(${JSON.stringify(refreshNewToken)}));
    return submitted && !(composer?.innerText || "").trim();
  })()`, "queued post-refresh shell result to be submitted before duplicate recovery checks");

  const refreshMarkerMtimeMs = fs.statSync(refreshMarkerPath).mtimeMs;
  const refreshDuplicateUiBefore = await page.evaluate(`(() => ({
    userCount: document.querySelectorAll('[data-message-author-role="user"]').length,
    composer: document.getElementById("composer")?.innerText || ""
  }))()`);
  await appendLiveAssistantHelper(page, [
    "ai-helper-shell-start:refresh-old-output-replay",
    refreshOldCommand,
    "ai-helper-shell-end"
  ].join("\n"));
  await waitForEvaluate(page, `(() => {
    const composer = document.getElementById("composer");
    const submitted = Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
      .some((node) => (node.innerText || "").includes(${JSON.stringify(refreshOldToken)}));
    return submitted && !(composer?.innerText || "").trim();
  })()`, "unpresented pre-refresh execution result to be cleanly recovered without re-execution");
  const refreshDuplicateUiAfter = await page.evaluate(`(() => ({
    userCount: document.querySelectorAll('[data-message-author-role="user"]').length,
    composer: document.getElementById("composer")?.innerText || "",
    userText: Array.from(document.querySelectorAll('[data-message-author-role="user"]')).map((node) => node.innerText || "").join("\\n")
  }))()`);
  assert.equal(refreshDuplicateUiAfter.userCount, refreshDuplicateUiBefore.userCount + 1, "An executed result that was never presented must be recovered exactly once after refresh");
  assert.equal(refreshDuplicateUiAfter.composer, "", "The cleanly recovered result must finish leaving the composer");
  assert.ok(refreshDuplicateUiAfter.userText.includes(refreshOldToken));
  assert.ok(!refreshDuplicateUiAfter.userText.includes("duplicate: true"));
  assert.ok(!refreshDuplicateUiAfter.userText.includes("skipped: true"));
  assert.ok(!refreshDuplicateUiAfter.userText.includes("reason: already-executed-on-target"));
  assert.ok(!refreshDuplicateUiAfter.userText.includes("replayedOutput: true"));
  assert.equal(fs.statSync(refreshMarkerPath).mtimeMs, refreshMarkerMtimeMs, "duplicate adjudication must not execute the old command again");

  const settingsPage = await openChromePage(debugPort, `${EXPECTED_EXTENSION_ORIGIN}/popup.html`);
  cleanup.push(() => settingsPage.close());
  await settingsPage.send("Runtime.enable");
  await waitForEvaluate(settingsPage, "document.readyState === 'complete'", "extension settings page load");
  await settingsPage.evaluate("chrome.storage.sync.set({ defaultTimeoutMs: 1000 })");

  const idleControlToken = `ai-chat-shell-idle-control-${Date.now()}`;
  const idleControlCommand = `printf '${idleControlToken}\\n'; sleep 60; printf 'IDLE_CONTROL_SHOULD_NOT_FINISH\\n'`;
  assert.equal(
    await page.evaluate(`document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-tool-action="stop-helper"]')?.disabled === true`),
    true,
    "Stop helper must be disabled while no helper is active."
  );
  await appendLiveAssistantHelper(page, [
    "ai-helper-shell-start:idle-control-e2e",
    idleControlCommand,
    "ai-helper-shell-end"
  ].join("\n"));
  await waitForEvaluate(page, `(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    const stop = panel?.querySelector('[data-shell-panel-group="common"] [data-shell-tool-action="stop-helper"]');
    const force = panel?.querySelector('[data-shell-panel-group="common"] [data-shell-tool-action="force"]');
    return stop?.hidden === false && stop.disabled === false && force?.hidden === true;
  })()`, "Stop helper to replace Force run while a helper is active");
  if (SCREENSHOT_DIR) {
    await savePanelScreenshot(page, path.join(SCREENSHOT_DIR, "extension-panel-running.png"));
  }
  await waitForEvaluate(page, `(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    const control = document.getElementById("ai-chat-shell-exec-run-control");
    const commonStop = panel?.querySelector('[data-shell-panel-group="common"] [data-shell-tool-action="stop-helper"]');
    const continueButton = control?.querySelector('[data-shell-tool-action="continue-helper"]');
    const contextualStop = control?.querySelector('[data-shell-tool-action="stop-helper"]');
    return control?.hidden === false &&
      control.innerText.includes("No output update") &&
      commonStop?.hidden === true &&
      continueButton?.disabled === false &&
      contextualStop?.disabled === false;
  })()`, "idle timeout decision prompt with adjacent Continue waiting and Stop helper controls");
  if (SCREENSHOT_DIR) {
    await savePanelScreenshot(page, path.join(SCREENSHOT_DIR, "extension-panel-awaiting-user.png"));
  }
  await page.evaluate(`(() => {
    document.querySelector('[data-shell-tool-action="continue-helper"]')?.click();
    return true;
  })()`);
  await waitForEvaluate(page, `document.getElementById("ai-chat-shell-exec-run-control")?.hidden === true`, "idle timeout continue acknowledgement");
  await waitForEvaluate(page, `(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    const control = document.getElementById("ai-chat-shell-exec-run-control");
    const commonStop = panel?.querySelector('[data-shell-panel-group="common"] [data-shell-tool-action="stop-helper"]');
    const contextualStop = control?.querySelector('[data-shell-tool-action="stop-helper"]');
    return control?.hidden === false &&
      control.innerText.includes("No output update") &&
      commonStop?.hidden === true &&
      contextualStop?.disabled === false;
  })()`, "idle timeout prompt with contextual Stop helper after continued wait");
  await page.evaluate(`(() => {
    document.querySelector('#${EXTENSION_STATUS_ID} #ai-chat-shell-exec-run-control [data-shell-tool-action="stop-helper"]')?.click();
    return true;
  })()`, { acceptDialogs: true });
  const idleTerminatedText = await waitForEvaluateValue(page, `(() => {
    const text = document.body.innerText || "";
    return text.includes(${JSON.stringify(`stdout:\n${idleControlToken}`)}) &&
      text.includes("exitCode: 130") ? text : "";
  })()`, "idle helper result after panel termination");
  assert.match(idleTerminatedText, /^interrupted: true$/m);
  assert.match(idleTerminatedText, /^interruptSignal: INT$/m);
  await settingsPage.evaluate("chrome.storage.sync.set({ defaultTimeoutMs: 180000 })");

  const heartbeatToken = `ai-chat-shell-heartbeat-${Date.now()}`;
  const heartbeatCommand = `sleep 32; printf '${heartbeatToken}'`;
  await appendLiveAssistantHelper(page, [
    "ai-helper-shell-start:mv3-heartbeat-long-run",
    heartbeatCommand,
    "ai-helper-shell-end"
  ].join("\n"));
  const heartbeatText = await waitForEvaluateValue(page, `(() => {
    const text = document.body.innerText || "";
    return text.includes("Shell call result:") &&
      text.includes(${JSON.stringify(`stdout:\n${heartbeatToken}`)}) ? text : "";
  })()`, "shell helper result after a long MV3 service-worker interval");
  assert.ok(heartbeatText.includes(`stdout:\n${heartbeatToken}`));
  await page.evaluate(`(() => {
    document.getElementById("send")?.click();
    return true;
  })()`);
  await waitForEvaluate(page, `(() => {
    const composer = document.getElementById("composer");
    const submitted = Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
      .some((node) => (node.innerText || "").includes(${JSON.stringify(heartbeatToken)}));
    return submitted && !(composer?.innerText || "").trim();
  })()`, "heartbeat shell result to be submitted before the next helper");
  await page.send("Page.reload", { ignoreCache: true });
  await waitForEvaluate(page, "document.readyState === 'complete'", "test page reload after heartbeat");
  await waitForEvaluate(page, `Boolean(document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)}))`, "extension status after heartbeat reload");
  await page.evaluate(`new Promise((resolve) => setTimeout(resolve, ${STARTUP_SETTLE_MS}))`);

  const largeCommandToken = `ai-chat-shell-large-command-${Date.now()}`;
  const largeCommand = `# ${"x".repeat(9000)}\nprintf '${largeCommandToken}'`;
  assert.ok(largeCommand.length > 8000, "The long-command e2e fixture must exceed the removed legacy limit.");
  await appendLiveAssistantHelper(page, [
    "ai-helper-shell-start:large-command-e2e",
    largeCommand,
    "ai-helper-shell-end"
  ].join("\n"));
  const largeCommandText = await waitForEvaluateValue(page, `(() => {
    const text = document.body.innerText || "";
    return text.includes("Shell call result:") &&
      text.includes("cmdHash:") &&
      text.includes(${JSON.stringify(`stdout:\n${largeCommandToken}`)}) ? text : "";
  })()`, "shell helper command longer than the legacy 8000-character limit");
  assert.ok(largeCommandText.includes(`stdout:\n${largeCommandToken}`));
  await waitForEvaluate(page, `(() => {
    const composer = document.getElementById("composer");
    const submitted = Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
      .some((node) => (node.innerText || "").includes(${JSON.stringify(largeCommandToken)}));
    return submitted && !(composer?.innerText || "").trim();
  })()`, "large shell result to be submitted before the next helper");

  const opaqueCommandToken = `ai-chat-shell-opaque-command-${Date.now()}`;
  const opaquePayloadPath = path.join(shellStateDir, `${opaqueCommandToken}.txt`);
  cleanup.push(() => fs.rmSync(opaquePayloadPath, { force: true }));
  const opaqueCommand = [
    `cat > ${shellQuote(opaquePayloadPath)} <<'AI_HELPER_OPAQUE_TEXT'`,
    "shell call result: documentation",
    "shell call failed: documentation",
    "```shell-output",
    "stdout:",
    "cwd: documentation",
    "ai-helper-shell-start",
    "AI_HELPER_OPAQUE_TEXT",
    `printf '${opaqueCommandToken}'`
  ].join("\n");
  await appendLiveAssistantHelper(page, [
    "ai-helper-shell-start:opaque-command-e2e",
    opaqueCommand,
    "ai-helper-shell-end"
  ].join("\n"));
  await waitForEvaluate(page, `(() => {
    const text = document.body.innerText || "";
    return text.includes(${JSON.stringify(`stdout:\n${opaqueCommandToken}`)});
  })()`, "keyword-heavy shell body to execute as opaque command text");
  assert.equal(
    fs.readFileSync(opaquePayloadPath, "utf8"),
    [
      "shell call result: documentation",
      "shell call failed: documentation",
      "```shell-output",
      "stdout:",
      "cwd: documentation",
      "ai-helper-shell-start",
      ""
    ].join("\n"),
    "The real browser/server path must preserve command text formerly misclassified as copied output."
  );
  await waitForEvaluate(page, `(() => {
    const composer = document.getElementById("composer");
    const submitted = Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
      .some((node) => (node.innerText || "").includes(${JSON.stringify(opaqueCommandToken)}));
    return submitted && !(composer?.innerText || "").trim();
  })()`, "opaque command result to be submitted before Force run coverage");
  try {
    await waitFor(async () => {
      const states = await page.evaluateAcrossContexts(`(() =>
        typeof pendingHelperDeliveries === "object" ? pendingHelperDeliveries.size : null
      )()`);
      return states.some((entry) => entry.value === 0);
    }, "opaque command result delivery receipt before Force run coverage");
  } catch (error) {
    const deliveryState = await page.evaluateAcrossContexts(`(() => {
      if (typeof pendingHelperDeliveries === "undefined") {
        return null;
      }
      return {
        panel: document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)})?.innerText || "",
        composer: document.getElementById("composer")?.innerText || "",
        pending: Array.from(pendingHelperDeliveries.values()).map((entry) => ({
          callId: entry.callId,
          helperId: entry.call?.helperId || "",
          phase: entry.phase,
          attempts: entry.attempts,
          sendAttemptRounds: entry.sendAttemptRounds,
          deliveryInFlight: entry.deliveryInFlight,
          lastError: entry.lastError,
          submittedMessageCountBefore: entry.submittedMessageCountBefore,
          submittedMessageRootIdsBefore: entry.submittedMessageRootIdsBefore,
          matchingRoots: typeof getSubmittedMessageRootsMatching === "function"
            ? getSubmittedMessageRootsMatching(entry.reply).map((node) => ({
                id: typeof getSubmittedMessageRootIdentity === "function"
                  ? getSubmittedMessageRootIdentity(node)
                  : "",
                text: node.innerText || node.textContent || ""
              }))
            : []
        }))
      };
    })()`);
    throw new Error(`${error.message}; deliveryState=${JSON.stringify(deliveryState)}`);
  }

  const forceOpaqueToken = `ai-chat-shell-force-opaque-${Date.now()}`;
  const forceOpaqueMarkerPath = path.join(shellStateDir, `${forceOpaqueToken}.txt`);
  cleanup.push(() => fs.rmSync(forceOpaqueMarkerPath, { force: true }));
  const forceOpaqueCommand = [
    `cat > ${shellQuote(forceOpaqueMarkerPath)} <<'AI_HELPER_FORCE_OPAQUE_TEXT'`,
    "shell call result: Force must still execute this text",
    "stdout:",
    "cwd: force documentation",
    "AI_HELPER_FORCE_OPAQUE_TEXT",
    `printf '${forceOpaqueToken}'`
  ].join("\n");
  await page.evaluate(`(() => {
    appendAssistantToolCall([
      "ai-helper-shell-start:force-opaque-e2e",
      ${JSON.stringify(forceOpaqueCommand)},
      "ai-helper-shell-end"
    ].join("\\n"), "shell-output");
    return true;
  })()`);
  await waitForEvaluate(page, `(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    return (panel?.innerText || "").includes("Suppressed helper inside shell-output");
  })()`, "structured shell-output helper to remain auto-suppressed");
  await waitForEvaluate(page, `(() => {
    const force = document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-panel-group="common"] [data-shell-tool-action="force"]');
    const stop = document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-panel-group="common"] [data-shell-tool-action="stop-helper"]');
    return force?.hidden === false && stop?.hidden === true;
  })()`, "Force run to appear only when a rendered helper is actionable");
  if (SCREENSHOT_DIR) {
    await savePanelScreenshot(page, path.join(SCREENSHOT_DIR, "extension-panel-force.png"));
  }
  await page.evaluate(`new Promise((resolve) => setTimeout(resolve, 750))`);
  assert.equal(
    fs.existsSync(forceOpaqueMarkerPath),
    false,
    "A helper structurally rendered inside shell-output must not execute automatically."
  );
  await page.evaluate(`(() => {
    document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-tool-action="force"]')?.click();
    return true;
  })()`);
  await waitFor(() => fs.existsSync(forceOpaqueMarkerPath), "Force run to execute a structurally suppressed keyword-heavy helper");
  await waitForEvaluate(page, `(() => {
    const text = document.body.innerText || "";
    return text.includes(${JSON.stringify(`stdout:\n${forceOpaqueToken}`)});
  })()`, "Force run result for keyword-heavy shell body");

  const token = `ai-chat-shell-e2e-${Date.now()}`;
  const helperId = `shell-${Date.now()}`;
  const command = `printf ${token}`;
  await page.evaluate(`(() => {
    const composer = document.getElementById("composer");
    composer.focus();
    composer.click();
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("command").value = ${JSON.stringify(command)};
    return true;
  })()`);
  await appendLiveAssistantHelper(page, [
    `ai-helper-shell-start:${helperId}`,
    command,
    "ai-helper-shell-end"
  ].join("\n"));

  let finalText = "";
  try {
    finalText = await waitForEvaluateValue(page, `(() => {
      const text = document.body.innerText || "";
      return text.includes("Shell call result:") &&
        text.includes("exitCode: 0") &&
        text.includes(${JSON.stringify(`stdout:\n${token}`)}) ? text : "";
    })()`, "shell-output from extension");
  } catch (error) {
    const diagnostics = await collectDiagnostics(page, debugPort, {
      chrome,
      token,
      paneId,
      command,
      sessionName
    });
    throw new Error(`${error.message}\n\n${diagnostics}`);
  }

  assert.match(finalText, /Shell call result:/);
  assert.match(finalText, /```shell-output/);
  assert.match(finalText, new RegExp(`targetName: ${escapeRegExp(expectedDefaultSession)}:.* ${escapeRegExp(expectedDefaultHostWindow)}`));
  assert.match(finalText, new RegExp(escapeRegExp(`stdout:\n${token}`)));
  await waitForEvaluate(page, `(() => {
    const composer = document.getElementById("composer");
    const submitted = Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
      .some((node) => (node.innerText || "").includes(${JSON.stringify(token)}));
    return submitted && !(composer?.innerText || "").trim();
  })()`, "shell result to be submitted before duplicate adjudication");

  const duplicateUiBefore = await page.evaluate(`(() => ({
    userCount: document.querySelectorAll('[data-message-author-role="user"]').length,
    composer: document.getElementById("composer")?.innerText || ""
  }))()`);
  await appendLiveAssistantHelper(page, [
    `ai-helper-shell-start:${helperId}`,
    command,
    "ai-helper-shell-end"
  ].join("\n"));
  await waitForEvaluate(page, `(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    const text = panel?.innerText || "";
    return text.includes("Server confirmed duplicate shell command") ||
      text.includes("lastSkippedReason: server already-executed-on-target");
  })()`, "new identical helper to receive authoritative local-only duplicate adjudication");
  const duplicateUiAfter = await page.evaluate(`(() => ({
    userCount: document.querySelectorAll('[data-message-author-role="user"]').length,
    composer: document.getElementById("composer")?.innerText || "",
    userText: Array.from(document.querySelectorAll('[data-message-author-role="user"]')).map((node) => node.innerText || "").join("\\n")
  }))()`);
  assert.equal(duplicateUiAfter.userCount, duplicateUiBefore.userCount, "authoritative duplicate metadata must not be submitted to the model");
  assert.equal(duplicateUiAfter.composer, duplicateUiBefore.composer, "authoritative duplicate metadata must not enter the composer");
  assert.ok(!duplicateUiAfter.userText.includes("duplicate: true"));
  assert.ok(!duplicateUiAfter.userText.includes("reason: already-executed-on-target"));

  if (SCREENSHOT_DIR) {
    await saveScreenshot(page, path.join(SCREENSHOT_DIR, "shell-helper-result.png"));
  }

  const fileToken = `ai-chat-shell-file-e2e-${Date.now()}`;
  const filename = `${fileToken}.txt`;
  const fileContent = `file helper wrote ${fileToken}`;
  const defaultHelperFileDir = managedShellServer
    ? path.join(helperFileTestHome, "Downloads")
    : path.join(os.homedir(), "Downloads");
  await masterPage.send("Page.bringToFront");
  await waitForEvaluate(
    page,
    "document.visibilityState === 'hidden'",
    "primary helper page to become a hidden tab before send-actuator timing coverage"
  );
  cleanup.push(() => {
    fs.rmSync(path.join(defaultHelperFileDir, filename), { force: true });
  });

  await page.evaluate(`(() => {
    const composer = document.getElementById("composer");
    window.__aiShellComposerRedrawnForFileResult = false;
    window.__aiShellComposerTextRestoredForFileResult = false;
    window.__aiShellRouteChangedForFileResult = false;
    window.__aiShellFileComposerWriteSnapshot = "";
    window.__aiShellFileUserCountBefore = document.querySelectorAll('[data-message-author-role="user"]').length;
    const redrawAfterPluginWrite = () => {
      const text = (composer.innerText || composer.textContent || "").trim();
      if (!text.includes("File write result:")) {
        return;
      }
      composer.removeEventListener("input", redrawAfterPluginWrite);
      window.__aiShellFileComposerWriteSnapshot = text;
      const sendButton = document.getElementById("send");
      sendButton.disabled = true;
      window.setTimeout(() => {
        const replacement = composer.cloneNode(false);
        composer.replaceWith(replacement);
        window.__aiShellComposerRedrawnForFileResult = true;
        window.setTimeout(() => {
          replacement.innerText = text;
          replacement.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            composed: true,
            inputType: "insertText",
            data: text
          }));
          sendButton.disabled = false;
          window.__aiShellComposerTextRestoredForFileResult = true;
        }, 350);
      }, 100);
      window.setTimeout(() => {
        history.pushState({}, "", location.pathname + "?file-result-route=" + Date.now());
        window.__aiShellRouteChangedForFileResult = true;
      }, 900);
    };
    composer.addEventListener("input", redrawAfterPluginWrite);
    composer.focus();
    composer.click();
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await appendLiveAssistantHelper(page, [
    "ai-helper-file-start",
    filename,
    fileContent,
    "ai-helper-file-end"
  ].join("\n"));

  let fileText = "";
  try {
    fileText = await waitForEvaluateValue(page, `(() => {
      const text = document.body.innerText || "";
      return text.includes("File write result:") &&
        text.includes(${JSON.stringify(`file: ${filename}`)}) &&
        text.includes("bytes:") ? text : "";
    })()`, "file helper shell-output from extension");
  } catch (error) {
    const diagnostics = await collectDiagnostics(page, debugPort, {
      chrome,
      token: fileToken,
      paneId,
      command: `write ${filename}`,
      sessionName
    });
    throw new Error(`${error.message}\n\n${diagnostics}`);
  }

  assert.match(fileText, /File write result:/);
  assert.match(fileText, new RegExp(escapeRegExp(`file: ${filename}`)));
  assert.equal(fs.readFileSync(path.join(defaultHelperFileDir, filename), "utf8"), fileContent);
  let fileDeliveryState;
  try {
    fileDeliveryState = await waitForEvaluateValue(page, `(() => {
      const composer = document.getElementById("composer");
      const userMessages = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
      const newMessages = userMessages.slice(Number(window.__aiShellFileUserCountBefore || 0));
      if (window.__aiShellComposerRedrawnForFileResult !== true ||
          window.__aiShellComposerTextRestoredForFileResult !== true ||
          window.__aiShellRouteChangedForFileResult !== true ||
          !window.__aiShellFileComposerWriteSnapshot ||
          newMessages.length !== 1 ||
          (composer?.innerText || "").trim()) {
        return null;
      }
      const submittedText = newMessages[0].querySelector("pre code")?.textContent || "";
      return {
        writtenText: window.__aiShellFileComposerWriteSnapshot,
        submittedText,
        newMessageCount: newMessages.length,
        composerText: composer?.innerText || "",
        visibilityState: document.visibilityState
      };
    })()`, "file result to follow exact text across a composer redraw and submit");
  } catch (error) {
    const pageState = await page.evaluate(`(() => ({
      href: location.href,
      composer: document.getElementById("composer")?.innerText || "",
      redraw: window.__aiShellComposerRedrawnForFileResult,
      textRestored: window.__aiShellComposerTextRestoredForFileResult,
      routeChanged: window.__aiShellRouteChangedForFileResult,
      snapshot: window.__aiShellFileComposerWriteSnapshot || "",
      userCountBefore: window.__aiShellFileUserCountBefore,
      users: Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
        .map((node) => node.innerText || ""),
      status: document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)})?.innerText || ""
    }))()`);
    const isolatedWorlds = await page.evaluateAcrossContexts(`(() => {
      if (typeof pendingHelperDeliveries === "undefined") {
        return null;
      }
      const composer = document.getElementById("composer");
      const candidate = findSendButton(composer, false);
      return {
        href: location.href,
        pageLifecycleGeneration,
        observedPageIdentity,
        activeComposerDeliveryToken,
        guardCurrent: isOriginalSendActuatorGuardCurrent(activeOriginalSendActuatorGuard),
        currentComposerText: getComposerText(composer),
        candidateId: candidate?.id || "",
        candidateDisabled: candidate?.disabled,
        pending: Array.from(pendingHelperDeliveries.values()).map((entry) => ({
          callId: entry.callId,
          phase: entry.phase,
          pageIdentity: entry.pageIdentity,
          restored: entry.restored,
          sendActuatorGeneration: entry.sendActuatorGeneration,
          deliveryInFlight: entry.deliveryInFlight,
          lastError: entry.lastError
        }))
      };
    })()`);
    throw new Error(`${error.message}; filePageState=${JSON.stringify(pageState)}; fileIsolatedWorlds=${JSON.stringify(isolatedWorlds)}`);
  }
  assert.equal(fileDeliveryState.newMessageCount, 1, "File delivery must append exactly one new user message.");
  assert.equal(fileDeliveryState.submittedText, fileDeliveryState.writtenText, "Submitted file output must exactly match the plugin-owned composer snapshot.");
  assert.equal(fileDeliveryState.composerText, "", "The current visible composer must be empty after file output submission.");
  assert.equal(fileDeliveryState.visibilityState, "hidden", "The original v0.8.9 send loop must finish while its page is backgrounded.");
  await page.send("Page.bringToFront");

  if (managedShellServer) {
    await stopProcess(managedShellServer);
    await waitForShellServerToStop();
    managedShellServer = spawnNode(["server/shell_server.js"], {
      ...managedShellServerEnv,
      AI_HELPER_FILE_PATH: helperFileOverrideDir
    });
    await waitForShellServer();

    const overrideFileToken = `ai-chat-shell-file-override-e2e-${Date.now()}`;
    const overrideFilename = `${overrideFileToken}.txt`;
    const overrideFileContent = `file helper used AI_HELPER_FILE_PATH ${overrideFileToken}`;
    const overrideUserCountBefore = await page.evaluate("document.querySelectorAll('[data-message-author-role=\"user\"]').length");
    await appendLiveAssistantHelper(page, [
      "ai-helper-file-start:file-path-override-e2e",
      overrideFilename,
      overrideFileContent,
      "ai-helper-file-end"
    ].join("\n"));
    const overrideFileText = await waitForEvaluateValue(page, `(() => {
      const text = document.body.innerText || "";
      return text.includes("File write result:") &&
        text.includes(${JSON.stringify(`file: ${overrideFilename}`)}) ? text : "";
    })()`, "file helper result with AI_HELPER_FILE_PATH override");
    assert.match(overrideFileText, new RegExp(escapeRegExp(`file: ${overrideFilename}`)));
    assert.equal(
      fs.readFileSync(path.join(helperFileOverrideDir, overrideFilename), "utf8"),
      overrideFileContent,
      "The overridden E2E file must be written under AI_HELPER_FILE_PATH"
    );
    assert.equal(
      fs.existsSync(path.join(helperFileTestHome, "Downloads", overrideFilename)),
      false,
      "The overridden E2E file must not also be written under Downloads"
    );
    await waitForEvaluate(page, `(() => {
      const composer = document.getElementById("composer");
      const userMessages = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
      const submitted = userMessages.slice(${overrideUserCountBefore})
        .some((node) => (node.innerText || "").includes(${JSON.stringify(overrideFileToken)}));
      return submitted && !(composer?.innerText || "").trim();
    })()`, "overridden file result to be submitted exactly once");
  } else {
    console.log("AI_HELPER_FILE_PATH browser E2E restart skipped because the fixed shell-server port is owned by an existing foreground server.");
  }

  if (SCREENSHOT_DIR) {
    await saveScreenshot(page, path.join(SCREENSHOT_DIR, "file-helper-result.png"));
  }
}

async function runEmptySkillCatalogE2E(page, { skillPath, skillInstallPath, skillInstallRunPath, shellStateDir }) {
  const startMarker = "ai-helper-skill-start";
  const endMarker = "ai-helper-skill-end";
  const memoryEntry = "AI_CHAT_SHELL_SKILLS_CATALOG";

  await waitForEvaluate(page, `(() => {
    const chip = document.getElementById("ai-chat-shell-exec-skill-status");
    const detail = document.getElementById("ai-chat-shell-exec-skill-detail");
    return chip && !chip.hidden && !chip.disabled && chip.textContent.includes("↑") &&
      /not been acknowledged/i.test(chip.title || "") &&
      /Installed: 0/.test(detail?.innerText || detail?.textContent || "") &&
      /Discovered: 0/.test(detail?.innerText || detail?.textContent || "") &&
      /Acknowledged: \\(never\\)/.test(detail?.innerText || detail?.textContent || "") &&
      /Sync: update required/.test(detail?.innerText || detail?.textContent || "");
  })()`, "never-acknowledged empty Skill catalog to require synchronization");

  const beforePrompt = await pageUserMessageCount(page);
  await page.evaluate(`document.getElementById("ai-chat-shell-exec-skill-status")?.click(); true`);
  const prompt = await waitForNewUserMessage(
    page,
    beforePrompt,
    "The local SKILLS catalog has changed.",
    "empty Skill catalog synchronization prompt"
  );
  assertNoCompleteSkillMarkerLines(prompt, "Empty Skill catalog update prompt");
  const challenge = requireMessageField(prompt, "challenge", /^[a-f0-9]{32}$/);
  const emptyCatalogSha = requireMessageField(prompt, "Local catalog SHA", /^[a-f0-9]{64}$/);

  const beforeList = await pageUserMessageCount(page);
  await appendAssistantSkillHelper(page, [
    `${startMarker}:empty-list-e2e`,
    "cmd: list",
    `challenge: ${challenge}`,
    endMarker
  ]);
  const catalogReply = await waitForNewUserMessage(
    page,
    beforeList,
    "Local SKILLS catalog synchronization response:",
    "empty Skill catalog response"
  );
  assert.match(catalogReply, /"skills": \[\]/);
  assert.match(catalogReply, /Remove entries for Skills that are not in this complete list/);
  assert.equal(requireMessageField(catalogReply, "catalog-sha", /^[a-f0-9]{64}$/), emptyCatalogSha);
  const emptyCatalogVersion = requireMessageField(catalogReply, "catalog-version", /^[1-9][0-9]*$/);

  const beforeAck = await pageUserMessageCount(page);
  await appendAssistantSkillHelper(page, [
    `${startMarker}:empty-ack-e2e`,
    "cmd: list-updated",
    `challenge: ${challenge}`,
    `catalog-sha: ${emptyCatalogSha}`,
    `catalog-version: ${emptyCatalogVersion}`,
    `memory-entry: ${memoryEntry}`,
    endMarker
  ]);
  await waitForEvaluate(page, `(() => {
    const chip = document.getElementById("ai-chat-shell-exec-skill-status");
    const detail = document.getElementById("ai-chat-shell-exec-skill-detail");
    return chip && !chip.disabled && !chip.textContent.includes("↑") &&
      /View local Skills v[0-9]+ catalog/i.test(chip.title || "") &&
      /Installed: 0/.test(detail?.innerText || detail?.textContent || "") &&
      /Discovered: 0/.test(detail?.innerText || detail?.textContent || "") &&
      /Acknowledged: ${emptyCatalogSha}/.test(detail?.innerText || detail?.textContent || "") &&
      /Sync: current/.test(detail?.innerText || detail?.textContent || "");
  })()`, "acknowledged empty Skill catalog to become current");
  await assertUserMessageCountStable(page, beforeAck, "A successful empty-catalog ACK must remain silent");
  await page.evaluate(`document.getElementById("ai-chat-shell-exec-skill-status")?.click(); true`);
  await waitForEvaluate(page, `(() => {
    const dialog = document.getElementById("ai-chat-shell-exec-skill-dialog");
    return dialog && /Installed 0 \\/ Discovered 0/.test(dialog.innerText || "");
  })()`, "current empty Skill chip to open the zero-item local catalog");
  await assertUserMessageCountStable(page, beforeAck, "Viewing an acknowledged empty catalog must not write to the AI chat");
  await page.evaluate(`document.querySelector('#ai-chat-shell-exec-skill-dialog button')?.click(); true`);

  fs.writeFileSync(skillPath, buildE2eSkillSource({ revision: 1 }));
  fs.writeFileSync(skillInstallPath, [
    "#!/bin/sh",
    "set -eu",
    "printf 'run\\n' >> install-runs.txt",
    "test -f \"$PWD/SKILL.md\"",
    ""
  ].join("\n"), { mode: 0o700 });
  await page.evaluate(`document.querySelector('[data-shell-tool-action="skill-rescan"]')?.click(); true`);
  await waitForEvaluate(page, `(() => {
    const chip = document.getElementById("ai-chat-shell-exec-skill-status");
    const detail = document.getElementById("ai-chat-shell-exec-skill-detail");
    return chip && !chip.disabled && chip.textContent.includes("↑") && /changed/i.test(chip.title || "") &&
      /Installed: 0/.test(detail?.innerText || detail?.textContent || "") &&
      /Discovered: 1/.test(detail?.innerText || detail?.textContent || "");
  })()`, "adding the first Skill after an empty ACK to require synchronization");
  const statePath = path.join(shellStateDir, "skill-install-state.json");
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).skills["e2e-skill"].installed, false);
  const beforeInstall = await pageUserMessageCount(page);
  await installSkillThroughDialog(page, "e2e-skill");
  await assertUserMessageCountStable(page, beforeInstall, "Installing a local Skill must not write or auto-sync the AI composer");
  assert.equal(fs.readFileSync(skillInstallRunPath, "utf8"), "run\n", "A double-click must execute install.sh exactly once.");
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).skills["e2e-skill"].installed, true);
}

async function runSkillE2E(page, debugPort, {
  skillPath,
  skillInstallRunPath,
  shellStateDir,
  expectedHome,
  allowedValue,
  secretValue
}) {
  const startMarker = "ai-helper-skill-start";
  const endMarker = "ai-helper-skill-end";
  const memoryEntry = "AI_CHAT_SHELL_SKILLS_CATALOG";

  await waitForEvaluate(page, `(() => {
    const chip = document.getElementById("ai-chat-shell-exec-skill-status");
    return chip && !chip.hidden && !chip.disabled && chip.textContent.includes("↑");
  })()`, "initial local Skill update chip");
  if (SCREENSHOT_DIR) {
    await savePanelScreenshot(page, path.join(SCREENSHOT_DIR, "extension-panel-skills-update.png"));
  }
  const initialUserCount = await pageUserMessageCount(page);
  await page.evaluate(`(() => {
    const composer = document.getElementById("composer");
    composer.focus();
    composer.click();
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("ai-chat-shell-exec-skill-status").click();
    return true;
  })()`);
  const initialPrompt = await waitForNewUserMessage(
    page,
    initialUserCount,
    "The local SKILLS catalog has changed.",
    "Skill update prompt to be submitted"
  );
  assertNoCompleteSkillMarkerLines(initialPrompt, "Skill update prompt");
  assert.match(initialPrompt, /single memory entry named AI_CHAT_SHELL_SKILLS_CATALOG/);
  assert.match(initialPrompt, /cmd: list/);
  const initialChallenge = requireMessageField(initialPrompt, "challenge", /^[a-f0-9]{32}$/);
  const initialCatalogSha = requireMessageField(initialPrompt, "Local catalog SHA", /^[a-f0-9]{64}$/);
  await assertUserMessageCountStable(page, initialUserCount + 1, "Skill update prompt must not trigger itself");

  const competingPage = await openChromePage(debugPort, TEST_PAGE_URL);
  cleanup.push(() => competingPage.close());
  await competingPage.send("Page.enable");
  await competingPage.send("Runtime.enable");
  await waitForEvaluate(competingPage, "document.readyState === 'complete'", "competing Skill tab load");
  await waitForEvaluate(competingPage, `(() => {
    const chip = document.getElementById("ai-chat-shell-exec-skill-status");
    return chip && !chip.hidden && chip.disabled && /another tab/i.test(chip.title || "");
  })()`, "competing tab to observe the Skill owner lock");
  const competingUserCount = await pageUserMessageCount(competingPage);
  await competingPage.evaluate(`(() => {
    document.querySelector('[data-shell-tool-action="skill-force-sync"]')?.click();
    return true;
  })()`);
  await waitForEvaluate(competingPage, `(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    return /another tab/i.test(panel?.innerText || "");
  })()`, "competing tab force sync to be rejected by the owner lock");
  assert.equal(await pageUserMessageCount(competingPage), competingUserCount, "A non-owner tab must not send a competing Skill prompt.");

  const explicitUserBlock = [
    `${startMarker}:explicit-user-e2e`,
    "cmd: list",
    `challenge: ${initialChallenge}`,
    endMarker
  ].join("\n");
  const beforeExplicitUser = await pageUserMessageCount(page);
  await page.evaluate(`(() => {
    const article = document.createElement("article");
    article.className = "message";
    article.dataset.messageAuthorRole = "user";
    article.innerHTML = '<div class="role">User</div><pre><code class="language-text"></code></pre>';
    article.querySelector("code").textContent = ${JSON.stringify(explicitUserBlock)};
    document.getElementById("thread").appendChild(article);
    return true;
  })()`);
  await waitForEvaluate(page, `(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    return /explicitly identified user message/i.test(panel?.innerText || "");
  })()`, "explicit user Skill helper to be ignored");
  await assertUserMessageCountStable(page, beforeExplicitUser + 1, "Explicit user Skill helper must not receive a plugin reply");

  const beforeCatalog = await pageUserMessageCount(page);
  await appendAssistantSkillHelper(page, [
    `${startMarker}:list-e2e-v1`,
    "cmd: list",
    `challenge: ${initialChallenge}`,
    endMarker
  ]);
  const initialCatalogReply = await waitForNewUserMessage(
    page,
    beforeCatalog,
    "Local SKILLS catalog synchronization response:",
    "initial Skill catalog response"
  );
  assertNoCompleteSkillMarkerLines(initialCatalogReply, "Skill catalog response");
  assert.match(initialCatalogReply, /Replace that entry entirely; do not append/);
  assert.match(initialCatalogReply, /Remove entries for Skills that are not in this complete list/);
  assert.match(initialCatalogReply, /e2e-skill/);
  assert.match(initialCatalogReply, /E2E Skill browser coverage/);
  assert.match(initialCatalogReply, new RegExp(`memory-entry: ${memoryEntry}`));
  assert.equal(requireMessageField(initialCatalogReply, "catalog-sha", /^[a-f0-9]{64}$/), initialCatalogSha);
  const initialCatalogVersion = requireMessageField(initialCatalogReply, "catalog-version", /^[1-9][0-9]*$/);
  await assertUserMessageCountStable(page, beforeCatalog + 1, "Catalog response must not trigger its own indirect instructions");

  const beforeWrongMemory = await pageUserMessageCount(page);
  await appendAssistantSkillHelper(page, [
    `${startMarker}:wrong-memory-e2e`,
    "cmd: list-updated",
    `challenge: ${initialChallenge}`,
    `catalog-sha: ${initialCatalogSha}`,
    `catalog-version: ${initialCatalogVersion}`,
    "memory-entry: WRONG_MEMORY_ENTRY",
    endMarker
  ]);
  const wrongMemoryReply = await waitForNewUserMessage(
    page,
    beforeWrongMemory,
    "Local Skill helper response:",
    "wrong Skill memory entry rejection"
  );
  assert.match(wrongMemoryReply, /fixed memory entry/i);
  await waitForEvaluate(page, `(() => {
    const chip = document.getElementById("ai-chat-shell-exec-skill-status");
    return chip && chip.textContent.includes("…") && /waiting for this AI tab/i.test(chip.title || "");
  })()`, "active Skill sync to remain pending after wrong memory ACK");

  fs.writeFileSync(skillPath, buildE2eSkillSource({ revision: 2 }));
  const beforeReinstall = await pageUserMessageCount(page);
  await installSkillThroughDialog(page, "e2e-skill");
  await assertUserMessageCountStable(page, beforeReinstall, "Reinstalling a changed Skill must remain local while sync is active");
  assert.equal(fs.readFileSync(skillInstallRunPath, "utf8"), "run\nrun\n", "A changed Skill must require one fresh successful install.");
  const beforeStaleAck = await pageUserMessageCount(page);
  await appendAssistantSkillHelper(page, [
    `${startMarker}:stale-ack-e2e`,
    "cmd: list-updated",
    `challenge: ${initialChallenge}`,
    `catalog-sha: ${initialCatalogSha}`,
    `catalog-version: ${initialCatalogVersion}`,
    `memory-entry: ${memoryEntry}`,
    endMarker
  ]);
  const staleReply = await waitForNewUserMessage(
    page,
    beforeStaleAck,
    "stale-skill-sync-ack",
    "stale Skill ACK rejection"
  );
  assert.match(staleReply, /changed after it was listed/i);
  const changedCatalogSha = requireMessageField(staleReply, "latest catalog-sha", /^[a-f0-9]{64}$/);
  assert.notEqual(changedCatalogSha, initialCatalogSha);
  await waitForEvaluate(page, `(() => {
    const chip = document.getElementById("ai-chat-shell-exec-skill-status");
    return chip && chip.textContent.includes("…") && /waiting for this AI tab/i.test(chip.title || "");
  })()`, "active Skill sync to remain pending after stale ACK");

  const beforeLatestCatalog = await pageUserMessageCount(page);
  await appendAssistantSkillHelper(page, [
    `${startMarker}:list-e2e-v2`,
    "cmd: list",
    `challenge: ${initialChallenge}`,
    endMarker
  ]);
  const latestCatalogReply = await waitForNewUserMessage(
    page,
    beforeLatestCatalog,
    "Local SKILLS catalog synchronization response:",
    "latest accumulated Skill catalog response"
  );
  const latestCatalogSha = requireMessageField(latestCatalogReply, "catalog-sha", /^[a-f0-9]{64}$/);
  const latestCatalogVersion = requireMessageField(latestCatalogReply, "catalog-version", /^[1-9][0-9]*$/);
  assert.equal(latestCatalogSha, changedCatalogSha);
  assert.match(latestCatalogReply, /revision 2/);

  const beforeValidAck = await pageUserMessageCount(page);
  const canonicalSplitAck = [
    `${startMarker}:valid-ack-e2e-v2`,
    "cmd: list-updated",
    `challenge:${initialChallenge}`,
    `catalog-sha:${latestCatalogSha}`,
    `catalog-version:${latestCatalogVersion}`,
    `memory-entry:${memoryEntry}`,
    endMarker
  ].join("\n");
  const splitAckDom = await page.evaluate(`(async () => {
    const canonical = ${JSON.stringify(canonicalSplitAck)};
    const version = ${JSON.stringify(latestCatalogVersion)};
    const token = "catalog-version:" + version;
    const index = canonical.indexOf(token);
    const stop = document.createElement("button");
    stop.type = "button";
    stop.setAttribute("aria-label", "Stop generating");
    stop.textContent = "Stop generating";
    document.querySelector("main").appendChild(stop);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const article = document.createElement("article");
    article.className = "message";
    article.dataset.messageAuthorRole = "assistant";
    article.innerHTML = '<div class="role">Assistant</div><pre><code class="language-text"></code></pre>';
    const code = article.querySelector("code");
    code.textContent = canonical.split("\\n").slice(0, 2).join("\\n");
    document.getElementById("thread").appendChild(article);
    await new Promise((resolve) => setTimeout(resolve, 80));
    code.textContent = "";
    code.appendChild(document.createTextNode(canonical.slice(0, index) + "catalog-version:"));
    const splitValue = document.createElement("span");
    splitValue.style.display = "block";
    splitValue.textContent = version;
    code.appendChild(splitValue);
    code.appendChild(document.createTextNode(canonical.slice(index + token.length)));
    await new Promise((resolve) => setTimeout(resolve, 80));
    stop.remove();
    return { innerText: code.innerText, textContent: code.textContent };
  })()`);
  assert.equal(splitAckDom.textContent, canonicalSplitAck, "The simulated host code DOM must preserve the canonical Skill ACK in textContent.");
  assert.match(splitAckDom.innerText, new RegExp(`catalog-version:\\s*\\n\\s*${escapeRegExp(latestCatalogVersion)}`),
    "The simulated host layout must split catalog-version from its numeric value in innerText.");
  await waitForEvaluate(page, `(() => {
    const chip = document.getElementById("ai-chat-shell-exec-skill-status");
    return chip && !chip.hidden && !chip.disabled && !chip.textContent.includes("↑") && /View local Skills/i.test(chip.title || "");
  })()`, "valid Skill ACK to clear the green chip");
  await assertUserMessageCountStable(page, beforeValidAck, "A successful Skill ACK must not create a composer reply");
  await waitForEvaluate(competingPage, `(() => {
    const chip = document.getElementById("ai-chat-shell-exec-skill-status");
    return chip && !chip.disabled && !chip.textContent.includes("↑") && /View local Skills/i.test(chip.title || "");
  })()`, "valid Skill ACK to clear other tabs in the same scope");

  const beforeMalformedRecovery = await pageUserMessageCount(page);
  await page.evaluate(`(() => {
    const form = document.getElementById("composerForm");
    window.__heldSkillComposerForm = form;
    form.remove();
    const weakInput = document.getElementById("command");
    weakInput.value = "";
    weakInput.focus();
    weakInput.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    weakInput.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await appendAssistantSkillHelper(page, [
    `${startMarker}:true-malformed-numeric-e2e`,
    "cmd: list",
    "2",
    endMarker
  ]);
  try {
    await waitForEvaluate(page, `(() => {
      const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
      return /Skill protocol response is cached locally and waiting for the chat composer/i.test(panel?.innerText || "");
    })()`, "malformed Skill response to remain queued while the composer is absent");
  } catch (error) {
    const diagnostics = await page.evaluateAcrossContexts(`(() => {
      if (typeof assistantGenerationEpoch === "undefined") return null;
      const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
      const thread = getConversationRoot();
      const candidates = extractShellCallCandidates(thread);
      const latest = candidates.at(-1);
      return {
        contentWorld: true,
        panel: panel?.innerText || "",
        settled: initialThreadSettled,
        pending: Array.from(pendingHelperDeliveries.values()).map((entry) => ({ kind: entry.kind, phase: entry.phase })),
        epoch: Boolean(assistantGenerationEpoch),
        bound: assistantGenerationEpoch?.responseMessageRoot === latest?.node,
        live: latest ? isLiveGeneratedHelperCandidate(latest) : false,
        baseline: latest ? isBaselineIgnoredHelperCandidate(latest) : false,
        role: latest ? getMessageAuthorRole(latest.node) : "",
        candidateCount: candidates.length
      };
    })()`);
    throw new Error(`${error.message}\nmalformed diagnostics=${JSON.stringify(diagnostics)}`);
  }
  assert.equal(await pageUserMessageCount(page), beforeMalformedRecovery,
    "A queued malformed Skill response must not fabricate submission proof while no composer exists.");
  assert.equal(await page.evaluate("document.activeElement?.id"), "command",
    "The recovery case must keep a weak tool input focused so it can compete with the restored strong composer.");
  await page.evaluate(`(() => {
    const main = document.querySelector("main");
    main.appendChild(window.__heldSkillComposerForm);
    delete window.__heldSkillComposerForm;
    return true;
  })()`);
  let malformedRecoveryReply;
  try {
    malformedRecoveryReply = await waitForNewUserMessage(
      page,
      beforeMalformedRecovery,
      "Malformed Skill helper line: 2",
      "queued malformed Skill response to recover after the composer returns"
    );
  } catch (error) {
    const diagnostics = await page.evaluateAcrossContexts(`(() => {
      const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
      const composer = document.getElementById("composer");
      const freshComposer = typeof findCurrentReplyInputSynchronously === "function"
        ? findCurrentReplyInputSynchronously()
        : null;
      return {
        hasPendingState: typeof pendingHelperDeliveries !== "undefined",
        pending: typeof pendingHelperDeliveries === "undefined" ? [] : Array.from(pendingHelperDeliveries.values()).map((entry) => ({
          callId: entry.callId,
          kind: entry.kind,
          phase: entry.phase,
          attempts: entry.attempts,
          lastError: entry.lastError,
          inFlight: entry.deliveryInFlight === true,
          sendRounds: entry.sendAttemptRounds || 0
        })),
        panelText: panel?.innerText || "",
        composerConnected: composer?.isConnected === true,
        composerText: composer?.innerText || composer?.textContent || "",
        composerVisible: composer ? Boolean(composer.getClientRects().length) : false,
        composerEditable: typeof isEditableElement === "function" ? isEditableElement(composer) : null,
        composerLikely: typeof isLikelyReplyComposerCandidate === "function" ? isLikelyReplyComposerCandidate(composer) : null,
        composerInsidePanel: typeof isInsideShellToolPanel === "function" ? isInsideShellToolPanel(composer) : null,
        freshComposerId: freshComposer?.id || "",
        lastComposerId: typeof lastComposerElement === "undefined" ? "" : lastComposerElement?.id || "",
        lastComposerConnected: typeof lastComposerElement === "undefined" ? null : lastComposerElement?.isConnected === true,
        activeDeliveryKind: typeof activeComposerDeliveryToken === "undefined" ? "" : activeComposerDeliveryToken?.kind || "",
        pageGeneration: typeof pageLifecycleGeneration === "undefined" ? null : pageLifecycleGeneration,
        userCount: document.querySelectorAll('[data-message-author-role="user"]').length
      };
    })()`);
    throw new Error(`${error.message}; skillRecovery=${JSON.stringify(diagnostics)}`);
  }
  assert.match(malformedRecoveryReply, /Local Skill helper response:/);
  await assertUserMessageCountStable(page, beforeMalformedRecovery + 1,
    "Malformed Skill recovery must write and submit exactly once.");
  await waitForEvaluate(page, `(() => {
    const chip = document.getElementById("ai-chat-shell-exec-skill-status");
    return chip && !chip.textContent.includes("↑") && /View local Skills/i.test(chip.title || "");
  })()`, "malformed Skill helper to leave the acknowledged catalog unchanged");
  if (SCREENSHOT_DIR) {
    await savePanelScreenshot(page, path.join(SCREENSHOT_DIR, "extension-panel-idle.png"));
  }

  const beforeView = await pageUserMessageCount(page);
  await page.evaluate(`document.getElementById("ai-chat-shell-exec-skill-status")?.click(); true`);
  await waitForEvaluate(page, `Boolean(document.getElementById("ai-chat-shell-exec-skill-dialog"))`, "local Skill catalog dialog");
  await assertUserMessageCountStable(page, beforeView, "The acknowledged Skills chip must open the local catalog without creating a sync challenge or AI message.");
  await page.evaluate(`document.querySelector('#ai-chat-shell-exec-skill-dialog button')?.click(); true`);
  await waitForEvaluate(page, `!document.getElementById("ai-chat-shell-exec-skill-dialog")`, "local Skill catalog dialog to close");
  await page.evaluate(`document.querySelector('[data-shell-tool-action="skill-rescan"]')?.click(); true`);
  await waitForEvaluate(page, `(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    return /Rescanned 1 Skills/i.test(panel?.innerText || "");
  })()`, "local Skill rescan");
  assert.equal(await pageUserMessageCount(page), beforeView, "Rescan Skills must remain local.");

  await page.evaluate(`document.querySelector('[data-shell-tool-action="skill-force-sync"]')?.click(); true`);
  const forcedPrompt = await waitForNewUserMessage(
    page,
    beforeView,
    "The local SKILLS catalog has changed.",
    "forced Skill sync prompt"
  );
  const forcedChallenge = requireMessageField(forcedPrompt, "challenge", /^[a-f0-9]{32}$/);
  assert.notEqual(forcedChallenge, initialChallenge);
  assert.equal(requireMessageField(forcedPrompt, "Local catalog SHA", /^[a-f0-9]{64}$/), latestCatalogSha);
  const beforeForcedList = await pageUserMessageCount(page);
  await appendAssistantSkillHelper(page, [
    `${startMarker}:force-list-e2e`,
    "cmd: list",
    `challenge: ${forcedChallenge}`,
    endMarker
  ]);
  const forcedCatalogReply = await waitForNewUserMessage(page, beforeForcedList, "Local SKILLS catalog synchronization response:", "forced catalog response");
  const forcedCatalogVersion = requireMessageField(forcedCatalogReply, "catalog-version", /^[1-9][0-9]*$/);
  const beforeFailure = await pageUserMessageCount(page);
  await appendAssistantSkillHelper(page, [
    `${startMarker}:force-failed-e2e`,
    "cmd: list-update-failed",
    `challenge: ${forcedChallenge}`,
    `catalog-sha: ${latestCatalogSha}`,
    `catalog-version: ${forcedCatalogVersion}`,
    "reason: memory intentionally unavailable in E2E",
    endMarker
  ]);
  await waitForEvaluate(page, `(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    const chip = document.getElementById("ai-chat-shell-exec-skill-status");
    return /memory intentionally unavailable in E2E/i.test(panel?.innerText || "") &&
      chip && !chip.disabled && chip.textContent.includes("↑");
  })()`, "failed forced Skill sync to remain highlighted");
  await assertUserMessageCountStable(page, beforeFailure, "A handled list-update-failed report must not create another AI reply");

  await page.evaluate(`document.getElementById("ai-chat-shell-exec-skill-status")?.click(); true`);
  const retryPrompt = await waitForNewUserMessage(
    page,
    beforeFailure,
    "The local SKILLS catalog has changed.",
    "Skill retry prompt after memory failure"
  );
  const retryChallenge = requireMessageField(retryPrompt, "challenge", /^[a-f0-9]{32}$/);
  assert.notEqual(retryChallenge, forcedChallenge);
  await waitForSkillPromptLifecycleSettled(page, retryChallenge, "retry Skill prompt lifecycle to settle before the AI reply");
  const beforeRetryList = await pageUserMessageCount(page);
  await appendAssistantSkillHelper(page, [
    `${startMarker}:retry-list-e2e`,
    "cmd: list",
    `challenge: ${retryChallenge}`,
    endMarker
  ]);
  let retryCatalog;
  try {
    retryCatalog = await waitForNewUserMessage(page, beforeRetryList, "Local SKILLS catalog synchronization response:", "retry Skill catalog response");
  } catch (error) {
    const domState = await page.evaluate(`(() => ({
      composer: document.getElementById("composer")?.innerText || "",
      panel: document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)})?.innerText || "",
      assistants: Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')).slice(-6).map((node) => node.innerText || ""),
      users: Array.from(document.querySelectorAll('[data-message-author-role="user"]')).slice(-6).map((node) => node.innerText || "")
    }))()`);
    const isolatedState = await page.evaluateAcrossContexts(`(() => {
      if (typeof skillHelperInFlight === "undefined") {
        return null;
      }
      return {
        skillHelperInFlight,
        chainCallCount,
        lastUserMessageText,
        skillPanelState,
        pending: Array.from(pendingHelperDeliveries.values()).map((entry) => ({
          callId: entry.callId,
          kind: entry.kind,
          phase: entry.phase,
          attempts: entry.attempts,
          lastError: entry.lastError,
          challenge: entry.call?.challenge || ""
        }))
      };
    })()`);
    throw new Error(`${error.message}; retrySkillState=${JSON.stringify({ domState, isolatedState })}`);
  }
  const retryCatalogSha = requireMessageField(retryCatalog, "catalog-sha", /^[a-f0-9]{64}$/);
  const retryCatalogVersion = requireMessageField(retryCatalog, "catalog-version", /^[1-9][0-9]*$/);
  const beforeRetryAck = await pageUserMessageCount(page);
  await appendAssistantSkillHelper(page, [
    `${startMarker}:retry-ack-e2e`,
    "cmd: list-updated",
    `challenge: ${retryChallenge}`,
    `catalog-sha: ${retryCatalogSha}`,
    `catalog-version: ${retryCatalogVersion}`,
    `memory-entry: ${memoryEntry}`,
    endMarker
  ]);
  await waitForEvaluate(page, `(() => {
    const chip = document.getElementById("ai-chat-shell-exec-skill-status");
    return chip && !chip.disabled && !chip.textContent.includes("↑") && /View local Skills/i.test(chip.title || "");
  })()`, "Skill retry ACK");
  await assertUserMessageCountStable(page, beforeRetryAck, "Successful retry ACK must remain silent");

  const beforeStaleLoad = await pageUserMessageCount(page);
  await appendAssistantSkillHelper(page, [
    `${startMarker}:stale-load-e2e`,
    "cmd: load",
    "skill-id: e2e-skill",
    `catalog-sha: ${initialCatalogSha}`,
    endMarker
  ]);
  const staleLoadReply = await waitForNewUserMessage(page, beforeStaleLoad, "stale-catalog", "stale Skill load rejection");
  assert.match(staleLoadReply, /latest catalog-sha/i);

  const beforeLoad = await pageUserMessageCount(page);
  await appendAssistantSkillHelper(page, [
    `${startMarker}:valid-load-e2e`,
    "cmd: load",
    "skill-id: e2e-skill",
    `catalog-sha: ${retryCatalogSha}`,
    endMarker
  ]);
  const loadReply = await waitForNewUserMessage(page, beforeLoad, "Local Skill load result:", "valid Skill body load");
  assert.match(loadReply, new RegExp(escapeRegExp(`home=${expectedHome}`)));
  assert.match(loadReply, new RegExp(escapeRegExp(`allowed=${allowedValue}`)));
  assert.match(loadReply, /secret=\$\{E2E_SKILL_SECRET\}/);
  assert.match(loadReply, /arguments=\$ARGUMENTS/);
  assert.match(loadReply, /ai-helper-skill-start/);
  assert.match(loadReply, /ai-helper-skill-end/);
  assert.ok(!loadReply.includes(secretValue), "A non-allowlisted local environment variable must not leak to the AI.");
  await assertUserMessageCountStable(page, beforeLoad + 1, "Loaded Skill helper examples must stay inert inside skill-output provenance");

  const failingSkillId = "e2e-failing-skill";
  const failingSkillDir = path.join(path.dirname(path.dirname(skillPath)), failingSkillId);
  fs.mkdirSync(failingSkillDir, { recursive: true });
  fs.writeFileSync(path.join(failingSkillDir, "SKILL.md"), [
    "---",
    `name: ${failingSkillId}`,
    "description: E2E failing Skill installer diagnostics",
    "---",
    "failure coverage",
    ""
  ].join("\n"));
  fs.writeFileSync(path.join(failingSkillDir, "install.sh"), [
    "#!/bin/sh",
    "printf 'installer stdout tail\\n'",
    "printf '\\033[31minstaller stderr <script>plain-text-only</script>\\033[0m\\n' >&2",
    "exit 23",
    ""
  ].join("\n"), { mode: 0o700 });
  const beforeFailedInstall = await pageUserMessageCount(page);
  const composerBeforeFailedInstall = await page.evaluate(`document.getElementById("composer")?.innerText || ""`);
  await page.evaluate(`document.querySelector('[data-shell-tool-action="skill-rescan"]')?.click(); true`);
  await waitForEvaluate(page, `(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    return /Rescanned 2 Skills/i.test(panel?.innerText || "");
  })()`, "failing Skill to appear after rescan");
  await page.evaluate(`(() => {
    document.getElementById("ai-chat-shell-exec-skill-dialog")?.remove();
    document.querySelector('[data-shell-tool-action="skill-view"]')?.click();
    return true;
  })()`);
  await waitForEvaluate(page, `Boolean(document.querySelector(${JSON.stringify(`#ai-chat-shell-exec-skill-dialog [data-skill-id="${failingSkillId}"] [data-skill-install]`)}))`,
    "failing Skill install action");
  await trustedDoubleClick(page, `#ai-chat-shell-exec-skill-dialog [data-skill-id="${failingSkillId}"] [data-skill-install]`);
  const failureTarget = await waitForValue(async () => {
    const targets = await fetchHttpJson(`http://127.0.0.1:${debugPort}/json/list`).catch(() => []);
    return targets.find((target) => target.type === "page" &&
      String(target.url || "").startsWith(`${EXPECTED_EXTENSION_ORIGIN}/skill-install-result.html`)) || null;
  }, "extension-owned Skill install failure result window");
  const failurePage = await CdpClient.connect(failureTarget.webSocketDebuggerUrl);
  cleanup.push(() => failurePage.close());
  await failurePage.send("Page.enable");
  await failurePage.send("Runtime.enable");
  const failureText = await waitForEvaluateValue(failurePage, `(() => {
    const text = document.body?.innerText || "";
    return text.includes("Exit code: 23") && text.includes("installer stderr") ? text : "";
  })()`, "Skill install failure details to render in the extension window");
  assert.match(failureText, /Skill installation failed/);
  assert.match(failureText, /Exit code: 23/);
  assert.match(failureText, /installer stderr <script>plain-text-only<\/script>/);
  assert.doesNotMatch(failureText, /\x1b\[/, "ANSI controls must not survive into the result window.");
  await waitForEvaluate(page, `(() => {
    const row = document.querySelector(${JSON.stringify(`#ai-chat-shell-exec-skill-dialog [data-skill-id="${failingSkillId}"]`)});
    return row && /Retry/.test(row.querySelector('[data-skill-install]')?.textContent || "");
  })()`, "failed Skill row to remain retryable");
  assert.equal(JSON.parse(fs.readFileSync(path.join(shellStateDir, "skill-install-state.json"), "utf8")).skills[failingSkillId].installed, false);
  assert.equal(await page.evaluate(`document.getElementById("composer")?.innerText || ""`), composerBeforeFailedInstall,
    "Installer diagnostics must not alter the chat composer.");
  const chatPageTextAfterFailure = await page.evaluate(`document.body?.innerText || ""`);
  assert.doesNotMatch(chatPageTextAfterFailure, /installer stderr|installer stdout tail/,
    "Raw installer diagnostics must not enter any DOM owned by the AI chat page.");
  await assertUserMessageCountStable(page, beforeFailedInstall,
    "A failed Skill installer and its local result window must not write to the AI chat");
  await failurePage.evaluate(`document.getElementById("close")?.click(); true`).catch(() => null);
  const skillWorlds = await page.evaluateAcrossContexts(`(() => {
    if (typeof skillPanelState === "undefined") return null;
    return { contentWorld: true, catalogSha: String(skillPanelState?.catalogSha || "") };
  })()`);
  const currentCatalogSha = skillWorlds.find((entry) => entry.value?.contentWorld)?.value?.catalogSha || "";
  assert.match(currentCatalogSha, /^[a-f0-9]{64}$/, "The isolated Skill dispatch pages require the current catalog SHA.");
  return { catalogSha: currentCatalogSha };
}

async function runIsolatedSkillLoadDispatchE2E(debugPort, catalogSha) {
  const startMarker = "ai-helper-skill-start";
  const endMarker = "ai-helper-skill-end";
  const makeLoad = (id) => [
    `${startMarker}:${id}`,
    "cmd: load",
    "skill-id: e2e-skill",
    `catalog-sha: ${catalogSha}`,
    endMarker
  ].join("\n");

  await withFreshSkillCasePage(debugPort, "m365-copilot-sync-chain", async (page, nonce) => {
    const beforeSync = await pageUserMessageCount(page);
    await page.evaluate(`(() => {
      window.__m365DomMode = true;
      window.__flattenSubmittedPluginText = true;
      window.__m365LexicalComposerMode = true;
      document.getElementById("composer")?.setAttribute("aria-label", "Message Copilot");
      document.querySelector('[data-shell-tool-action="skill-force-sync"]')?.click();
      return true;
    })()`);
    const flattenedPrompt = await waitForNewUserMessage(
      page,
      beforeSync,
      "The local SKILLS catalog has changed.",
      "M365-flattened Skill sync prompt"
    );
    assert.doesNotMatch(flattenedPrompt.replace(/^You said:\n/, ""), /\n/,
      "The isolated compatibility page must reproduce M365's irreversible prompt line collapse.");
    const syncChallenge = /challenge: ([a-f0-9]{32})/.exec(flattenedPrompt)?.[1] || "";
    assert.match(syncChallenge, /^[a-f0-9]{32}$/);
    assert.match(flattenedPrompt, new RegExp(`Local catalog SHA: ${catalogSha}`));

    await waitForValue(async () => {
      const worlds = await page.evaluateAcrossContexts(`(() => {
        if (typeof pendingHelperDeliveries === "undefined") return null;
        return {
          contentWorld: true,
          matching: Array.from(pendingHelperDeliveries.values()).filter((entry) =>
            entry.kind === "skill-sync-prompt" && entry.call?.challenge === ${JSON.stringify(syncChallenge)}
          ).length,
          activeKind: activeComposerDeliveryToken?.kind || ""
        };
      })()`);
      const state = worlds.find((entry) => entry.value?.contentWorld)?.value;
      return state && state.matching === 0 && state.activeKind !== "skill-sync-prompt" ? state : undefined;
    }, "flattened M365 Skill sync prompt to finalize exactly once before the helper reply");

    await page.evaluate(`(() => {
      const composer = document.getElementById("composer");
      composer.setAttribute("aria-label", "Message Copilot");
      window.__m365CorruptedSkillCatalogInsertions = 0;
      composer.addEventListener("input", () => {
        if (window.__m365CorruptedSkillCatalogInsertions !== 0) return;
        const current = composer.innerText || composer.textContent || "";
        if (!current.startsWith("Local SKILLS catalog synchronization response:")) return;
        if (!/(?:^|\\n)\\{\\n/.test(current) || !/\\n\\}(?:\\n|$)/.test(current)) return;
        const flattened = current.replace(/\\r?\\n/g, "");
        const corrupted = flattened
          .replace("\`\`\`\`skill-output{", "\`\`\`\`skill-output")
          .replace("}\`\`\`\`After the memory entry", "\`\`\`\`After the memory entry");
        if (corrupted === flattened) return;
        window.__m365CorruptedSkillCatalogInsertions += 1;
        const text = document.createElement("span");
        text.setAttribute("data-lexical-text", "true");
        text.textContent = corrupted;
        const sentinel = document.createElement("span");
        sentinel.setAttribute("aria-hidden", "true");
        sentinel.setAttribute("data-lexical-text", "true");
        sentinel.textContent = "\u200b\u200c";
        composer.replaceChildren(text, sentinel);
      });
      return true;
    })()`);

    const listHelper = [
      `${startMarker}:m365-copilot-list-${nonce}`,
      "cmd: list",
      `challenge: ${syncChallenge}`,
      endMarker
    ].join("\n");
    const beforeCatalog = await pageUserMessageCount(page);
    await page.evaluate(`(() => {
      const article = document.createElement("div");
      article.className = "fai-CopilotMessage";
      article.setAttribute("role", "article");
      const content = document.createElement("div");
      content.className = "fai-CopilotMessage__content";
      content.style.whiteSpace = "normal";
      content.textContent = ${JSON.stringify(`${listHelper}\n`)};
      article.appendChild(content);
      // Reproduce M365's late-final response: by the time the complete
      // Copilot article is observable, the generation control is already gone.
      document.getElementById("thread").appendChild(article);
      return {
        innerText: content.innerText,
        textContent: content.textContent,
        hasExplicitDataRole: article.hasAttribute("data-message-author-role")
      };
    })()`);
    const m365Dom = await page.evaluate(`(() => {
      const content = document.querySelector('.fai-CopilotMessage:last-of-type .fai-CopilotMessage__content') ||
        Array.from(document.querySelectorAll('.fai-CopilotMessage__content')).at(-1);
      const article = content?.closest('.fai-CopilotMessage[role="article"]');
      return {
        innerText: content?.innerText || "",
        textContent: content?.textContent || "",
        hasExplicitDataRole: article?.hasAttribute("data-message-author-role") === true
      };
    })()`);
    assert.equal(m365Dom.textContent, `${listHelper}\n`);
    assert.equal(m365Dom.innerText, listHelper.replace(/\n/g, " "));
    assert.equal(m365Dom.hasExplicitDataRole, false,
      "The M365 compatibility case must rely on the exact Copilot class and role, not a generic data-role shortcut.");
    const scanWorlds = await page.evaluateAcrossContexts(`(() => {
      if (typeof extractShellCallCandidates !== "function") return null;
      const candidates = extractShellCallCandidates(getConversationRoot()).filter((candidate) =>
        candidate.call?.helperId === ${JSON.stringify(`m365-copilot-list-${nonce}`)}
      );
      return {
        contentWorld: true,
        count: candidates.length,
        role: candidates[0] ? getMessageAuthorRole(candidates[0].node) : "",
        valid: candidates[0] ? validateHelperCall(candidates[0].call).ok : false
      };
    })()`);
    const scanState = scanWorlds.find((entry) => entry.value?.contentWorld)?.value;
    assert.deepEqual(scanState, { contentWorld: true, count: 1, role: "assistant", valid: true },
      "The real Chrome DOM scan must recover exactly one valid helper from collapsed M365 Copilot content.");
    const flattenedCatalog = await waitForNewUserMessage(
      page,
      beforeCatalog,
      "Local SKILLS catalog synchronization response:",
      "catalog response after the current M365 Copilot helper"
    );
    assert.doesNotMatch(flattenedCatalog.replace(/^You said:\n/, ""), /\n/,
      "The catalog response must also survive M365's one-line submitted-message serialization.");
    assert.match(flattenedCatalog, /````skill-output\{/,
      "The pre-projected M365 write must preserve the opening catalog JSON brace.");
    assert.match(flattenedCatalog, /\}````After the memory entry/,
      "The pre-projected M365 write must preserve the closing catalog JSON brace before submission.");
    assert.equal(await page.evaluate(`window.__m365CorruptedSkillCatalogInsertions`), 0,
      "The host-mapped page must prove the vulnerable standalone-brace insertion never reaches M365's corrupting path.");
    const recoveryWorlds = await page.evaluateAcrossContexts(`(() => {
      if (typeof lastOwnedSkillSyncRecoveryStatus === "undefined") return null;
      const candidate = extractShellCallCandidates(getConversationRoot()).find((entry) =>
        entry.call?.helperId === ${JSON.stringify(`m365-copilot-list-${nonce}`)}
      );
      return {
        contentWorld: true,
        skillLive: candidate ? isLiveGeneratedHelperCandidate(candidate) : null,
        baselineIgnored: candidate ? isBaselineIgnoredHelperCandidate(candidate) : null,
        recoveryStatus: lastOwnedSkillSyncRecoveryStatus,
        syncPhase: skillPanelState?.syncPhase || ""
      };
    })()`);
    const recoveryState = recoveryWorlds.find((entry) => entry.value?.contentWorld)?.value;
    assert.deepEqual(recoveryState, {
      contentWorld: true,
      skillLive: false,
      baselineIgnored: false,
      recoveryStatus: "used",
      syncPhase: "ack"
    }, "The no-Stop M365 fixture must exercise exact owner-turn recovery rather than ordinary live-generation dispatch.");

    const beforeListRedraw = await pageUserMessageCount(page);
    await page.evaluate(`(() => {
      const helperId = ${JSON.stringify(`m365-copilot-list-${nonce}`)};
      const oldArticle = Array.from(document.querySelectorAll('.fai-CopilotMessage[role="article"]'))
        .find((article) => (article.textContent || "").includes(helperId));
      if (!oldArticle) return false;
      const replacement = document.createElement("div");
      replacement.className = "fai-CopilotMessage";
      replacement.setAttribute("role", "article");
      const content = document.createElement("div");
      content.className = "fai-CopilotMessage__content";
      content.style.whiteSpace = "normal";
      content.textContent = ${JSON.stringify(`${listHelper}\n`)};
      replacement.appendChild(content);
      oldArticle.replaceWith(replacement);
      return true;
    })()`);
    const listRedrawWorlds = await waitForValue(async () => {
      const worlds = await page.evaluateAcrossContexts(`(() => {
        if (typeof getHandledHelperReason !== "function") return null;
        const candidate = extractShellCallCandidates(getConversationRoot()).find((entry) =>
          entry.call?.helperId === ${JSON.stringify(`m365-copilot-list-${nonce}`)}
        );
        if (!candidate) return null;
        const semantic = buildSemanticCallKey(candidate.call);
        return {
          contentWorld: true,
          handled: getHandledHelperReason(candidate, "redraw", semantic, candidate.call),
          baselineIgnored: isBaselineIgnoredHelperCandidate(candidate, semantic)
        };
      })()`);
      return worlds.find((entry) => entry.value?.contentWorld)?.value || undefined;
    }, "committed M365 list helper replacement root to become inert");
    assert.deepEqual(listRedrawWorlds, {
      contentWorld: true,
      handled: "committed owner-sync helper",
      baselineIgnored: false
    });
    await assertUserMessageCountStable(page, beforeListRedraw,
      "A committed M365 list helper replacement root must not send a second catalog.");
    const catalogVersion = /catalog-version: ([1-9][0-9]*)/.exec(flattenedCatalog)?.[1] || "";
    assert.match(catalogVersion, /^[1-9][0-9]*$/);

    const beforeAck = await pageUserMessageCount(page);
    const ackHelper = [
      `${startMarker}:m365-copilot-ack-${nonce}`,
      "cmd: list-updated",
      `challenge: ${syncChallenge}`,
      `catalog-sha: ${catalogSha}`,
      `catalog-version: ${catalogVersion}`,
      "memory-entry: AI_CHAT_SHELL_SKILLS_CATALOG",
      endMarker
    ].join("\n");
    await page.evaluate(`(() => {
      const article = document.createElement("div");
      article.className = "fai-CopilotMessage";
      article.setAttribute("role", "article");
      const content = document.createElement("div");
      content.className = "fai-CopilotMessage__content";
      content.style.whiteSpace = "normal";
      content.textContent = ${JSON.stringify(`${ackHelper}\n`)};
      article.appendChild(content);
      // The exact owner challenge, not a broad generation flag, must recover
      // this late-final ACK and keep it silent.
      document.getElementById("thread").appendChild(article);
      return true;
    })()`);
    await waitForEvaluate(page, `(() => {
      const chip = document.getElementById("ai-chat-shell-exec-skill-status");
      return chip && !chip.disabled && !chip.textContent.includes("↑") && /View local Skills/i.test(chip.title || "");
    })()`, "M365 Copilot ACK to make the Skill catalog current");
    await assertUserMessageCountStable(page, beforeAck,
      "A valid M365 Copilot Skill ACK must remain silent.");
    await page.evaluate(`(() => {
      const helperId = ${JSON.stringify(`m365-copilot-ack-${nonce}`)};
      const oldArticle = Array.from(document.querySelectorAll('.fai-CopilotMessage[role="article"]'))
        .find((article) => (article.textContent || "").includes(helperId));
      if (!oldArticle) return false;
      const replacement = document.createElement("div");
      replacement.className = "fai-CopilotMessage";
      replacement.setAttribute("role", "article");
      const content = document.createElement("div");
      content.className = "fai-CopilotMessage__content";
      content.style.whiteSpace = "normal";
      content.textContent = ${JSON.stringify(`${ackHelper}\n`)};
      replacement.appendChild(content);
      oldArticle.replaceWith(replacement);
      return true;
    })()`);
    const ackRedrawWorlds = await waitForValue(async () => {
      const worlds = await page.evaluateAcrossContexts(`(() => {
        if (typeof getHandledHelperReason !== "function") return null;
        const candidate = extractShellCallCandidates(getConversationRoot()).find((entry) =>
          entry.call?.helperId === ${JSON.stringify(`m365-copilot-ack-${nonce}`)}
        );
        if (!candidate) return null;
        const semantic = buildSemanticCallKey(candidate.call);
        return {
          contentWorld: true,
          handled: getHandledHelperReason(candidate, "redraw", semantic, candidate.call),
          baselineIgnored: isBaselineIgnoredHelperCandidate(candidate, semantic)
        };
      })()`);
      return worlds.find((entry) => entry.value?.contentWorld)?.value || undefined;
    }, "committed M365 ACK replacement root to become inert");
    assert.deepEqual(ackRedrawWorlds, {
      contentWorld: true,
      handled: "committed owner-sync helper",
      baselineIgnored: false
    });
    await assertUserMessageCountStable(page, beforeAck,
      "A committed M365 ACK replacement root must remain silent and must not report no-active-sync to the AI.");
  }, { baseUrl: M365_TEST_PAGE_URL });

  await withFreshSkillCasePage(debugPort, "m365-owned-sync-wrong-prompt", async (page, nonce) => {
    const beforeSync = await pageUserMessageCount(page);
    await page.evaluate(`(() => {
      window.__m365DomMode = true;
      window.__flattenSubmittedPluginText = true;
      window.__m365LexicalComposerMode = true;
      document.getElementById("composer")?.setAttribute("aria-label", "Message Copilot");
      document.querySelector('[data-shell-tool-action="skill-force-sync"]')?.click();
      return true;
    })()`);
    const prompt = await waitForNewUserMessage(
      page,
      beforeSync,
      "The local SKILLS catalog has changed.",
      "M365 negative exact sync prompt"
    );
    const challenge = /challenge: ([a-f0-9]{32})/.exec(prompt)?.[1] || "";
    assert.match(challenge, /^[a-f0-9]{32}$/);
    await waitForSkillPromptLifecycleSettled(page, challenge, "M365 negative prompt finalization");
    const helperId = `m365-wrong-prompt-${nonce}`;
    const helper = [
      `${startMarker}:${helperId}`,
      "cmd: list",
      `challenge: ${challenge}`,
      endMarker
    ].join("\n");
    const beforeCatalog = await pageUserMessageCount(page);
    await page.evaluate(`(() => {
      const users = Array.from(document.querySelectorAll('.fai-UserMessage[role="article"]'));
      users.at(-1)?.append(document.createTextNode("unexpected suffix"));
      const article = document.createElement("div");
      article.className = "fai-CopilotMessage";
      article.setAttribute("role", "article");
      const content = document.createElement("div");
      content.className = "fai-CopilotMessage__content";
      content.style.whiteSpace = "normal";
      content.textContent = ${JSON.stringify(helper)};
      article.appendChild(content);
      document.getElementById("thread").appendChild(article);
      return true;
    })()`);
    const state = await waitForValue(async () => {
      const worlds = await page.evaluateAcrossContexts(`(() => {
        if (typeof isBaselineIgnoredHelperCandidate !== "function") return null;
        const candidate = extractShellCallCandidates(getConversationRoot()).find((entry) =>
          entry.call?.helperId === ${JSON.stringify(helperId)}
        );
        return candidate && isBaselineIgnoredHelperCandidate(candidate) && !skillHelperInFlight ? {
          contentWorld: true,
          live: isLiveGeneratedHelperCandidate(candidate),
          recovery: isActiveOwnedSkillSyncCandidate(candidate),
          recoveryStatus: lastOwnedSkillSyncRecoveryStatus,
          processVisible: document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-tool-action="skill-recovery"]')?.hidden === false
        } : null;
      })()`);
      return worlds.find((entry) => entry.value?.contentWorld)?.value || undefined;
    }, "tampered M365 sync prompt to remain baseline-only");
    assert.deepEqual(state, {
      contentWorld: true,
      live: false,
      recovery: false,
      recoveryStatus: "none",
      processVisible: true
    });
    await assertUserMessageCountStable(page, beforeCatalog,
      "A near-match M365 prompt must not authorize an automatic catalog response.");
  }, { baseUrl: M365_TEST_PAGE_URL });

  await withFreshSkillCasePage(debugPort, "m365-owned-sync-later-user", async (page, nonce) => {
    const beforeSync = await pageUserMessageCount(page);
    await page.evaluate(`(() => {
      window.__m365DomMode = true;
      window.__flattenSubmittedPluginText = true;
      window.__m365LexicalComposerMode = true;
      document.getElementById("composer")?.setAttribute("aria-label", "Message Copilot");
      document.querySelector('[data-shell-tool-action="skill-force-sync"]')?.click();
      return true;
    })()`);
    const prompt = await waitForNewUserMessage(
      page,
      beforeSync,
      "The local SKILLS catalog has changed.",
      "M365 later-user sync prompt"
    );
    const challenge = /challenge: ([a-f0-9]{32})/.exec(prompt)?.[1] || "";
    assert.match(challenge, /^[a-f0-9]{32}$/);
    await waitForSkillPromptLifecycleSettled(page, challenge, "M365 later-user prompt finalization");
    const helperId = `m365-later-user-${nonce}`;
    const helper = [
      `${startMarker}:${helperId}`,
      "cmd: list",
      `challenge: ${challenge}`,
      endMarker
    ].join("\n");
    await page.evaluate(`(() => {
      appendMessage("user", "A real later user message owns the next turn.");
      const article = document.createElement("div");
      article.className = "fai-CopilotMessage";
      article.setAttribute("role", "article");
      const content = document.createElement("div");
      content.className = "fai-CopilotMessage__content";
      content.style.whiteSpace = "normal";
      content.textContent = ${JSON.stringify(helper)};
      article.appendChild(content);
      document.getElementById("thread").appendChild(article);
      return true;
    })()`);
    const afterManualUser = await pageUserMessageCount(page);
    const state = await waitForValue(async () => {
      const worlds = await page.evaluateAcrossContexts(`(() => {
        if (typeof isBaselineIgnoredHelperCandidate !== "function") return null;
        const candidate = extractShellCallCandidates(getConversationRoot()).find((entry) =>
          entry.call?.helperId === ${JSON.stringify(helperId)}
        );
        return candidate && isBaselineIgnoredHelperCandidate(candidate) && !skillHelperInFlight ? {
          contentWorld: true,
          recovery: isActiveOwnedSkillSyncCandidate(candidate),
          processVisible: document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-tool-action="skill-recovery"]')?.hidden === false
        } : null;
      })()`);
      return worlds.find((entry) => entry.value?.contentWorld)?.value || undefined;
    }, "later M365 user turn to keep old sync helper inert");
    assert.deepEqual(state, { contentWorld: true, recovery: false, processVisible: true });
    await assertUserMessageCountStable(page, afterManualUser,
      "A Skill helper after a later ordinary user turn must not reuse the plugin sync prompt.");
  }, { baseUrl: M365_TEST_PAGE_URL });

  await withFreshSkillCasePage(debugPort, "new-chat-live-load", async (page, nonce) => {
    const helper = makeLoad(`new-chat-live-${nonce}`);
    await page.evaluate(`(async () => {
      history.pushState({}, "", "/tmux-test-page.html?skill-case=new-chat-live&route=${nonce}");
      document.getElementById("thread").innerHTML = "";
      appendMessage("user", "Load the E2E Skill in this newly created chat.");
      const stop = document.createElement("button");
      stop.id = "skill-case-stop-generating";
      stop.type = "button";
      stop.setAttribute("aria-label", "Stop generating");
      stop.textContent = "Stop generating";
      document.querySelector("main").appendChild(stop);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const article = document.createElement("article");
      article.className = "message";
      article.dataset.messageAuthorRole = "assistant";
      article.innerHTML = '<div class="role">Assistant</div><pre><code class="language-text"></code></pre>';
      article.querySelector("code").textContent = "ai-helper-skill-start:new-chat-live-${nonce}\\ncmd: load";
      document.getElementById("thread").appendChild(article);
      await new Promise((resolve) => setTimeout(resolve, 80));
      article.querySelector("code").textContent = ${JSON.stringify(helper)};
      await new Promise((resolve) => setTimeout(resolve, 80));
      stop.remove();
      return true;
    })()`);
    const reply = await waitForEvaluateValue(page, `(() => {
      const messages = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
      const matches = messages.filter((node) => (node.innerText || node.textContent || "").includes("Local Skill load result:"));
      return matches.length === 1 ? (matches[0].innerText || matches[0].textContent || "") : "";
    })()`, "new-chat live Skill load response on its isolated page");
    assert.match(reply, /revision 2/);
    await assertIsolatedSkillDispatchState(page, { expectedLoadReplies: 1, expectForce: false });
  });

  await withFreshSkillCasePage(debugPort, "atomic-current-response-load", async (page, nonce) => {
    const helper = makeLoad(`atomic-current-${nonce}`);
    await page.evaluate(`(() => {
      document.getElementById("thread").innerHTML = "";
      appendMessage("user", "Load the E2E Skill from one atomic assistant response batch.");
      const stop = document.createElement("button");
      stop.type = "button";
      stop.setAttribute("data-ai-chat-shell-generation-control", "true");
      stop.setAttribute("aria-label", "応答を生成中");
      stop.textContent = "応答を生成中";
      const article = document.createElement("article");
      article.className = "message";
      article.dataset.messageAuthorRole = "assistant";
      article.innerHTML = '<div class="role">Assistant</div><pre><code class="language-text"></code></pre>';
      article.querySelector("code").textContent = ${JSON.stringify(helper)};
      document.querySelector("main").appendChild(stop);
      document.getElementById("thread").appendChild(article);
      queueMicrotask(() => stop.remove());
      return true;
    })()`);
    const reply = await waitForEvaluateValue(page, `(() => {
      const matches = Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
        .filter((node) => (node.innerText || node.textContent || "").includes("Local Skill load result:"));
      return matches.length === 1 ? (matches[0].innerText || matches[0].textContent || "") : "";
    })()`, "atomic same-batch Skill load response on its isolated page");
    assert.match(reply, /revision 2/);
    await assertIsolatedSkillDispatchState(page, { expectedLoadReplies: 1, expectForce: false });
  });

  await withFreshSkillCasePage(debugPort, "historical-partial-during-generation-negative", async (page, nonce) => {
    const helper = makeLoad(`historical-partial-${nonce}`);
    await page.evaluate(`(async () => {
      document.getElementById("thread").innerHTML = "";
      const history = document.createElement("article");
      history.className = "message";
      history.dataset.messageAuthorRole = "assistant";
      history.innerHTML = '<div class="role">Assistant</div><pre><code class="language-text"></code></pre>';
      history.querySelector("code").textContent = "ai-helper-skill-start:historical-partial-${nonce}\\ncmd: load";
      document.getElementById("thread").appendChild(history);
      appendMessage("user", "Generate an unrelated ordinary response now.");
      const current = document.createElement("article");
      current.className = "message";
      current.dataset.messageAuthorRole = "assistant";
      current.textContent = "This current response contains no helper.";
      document.getElementById("thread").appendChild(current);
      const stop = document.createElement("button");
      stop.type = "button";
      stop.setAttribute("data-ai-chat-shell-generation-control", "true");
      stop.textContent = "Generating response";
      document.querySelector("main").appendChild(stop);
      await new Promise((resolve) => setTimeout(resolve, 100));
      history.querySelector("code").textContent = ${JSON.stringify(helper)};
      await new Promise((resolve) => setTimeout(resolve, 100));
      stop.remove();
      return true;
    })()`);
    await page.evaluate("new Promise((resolve) => setTimeout(resolve, 2800))");
    assert.equal(await countSkillLoadReplies(page), 0,
      "A historical partial helper before the current user turn must not borrow unrelated generation evidence.");
    const recoveryVisible = await page.evaluate(`(() => {
      const recovery = document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-tool-action="skill-recovery"]');
      return recovery && !recovery.hidden;
    })()`);
    assert.equal(recoveryVisible, true,
      "The historical helper must remain available only through explicit Process Skill recovery.");
  });

  await withFreshSkillCasePage(debugPort, "route-completion-live-load", async (page, nonce) => {
    const helper = makeLoad(`route-completion-${nonce}`);
    await page.evaluate(`(async () => {
      document.getElementById("thread").innerHTML = "";
      appendMessage("user", "Load the E2E Skill while this new chat receives its permanent URL.");
      const article = document.createElement("article");
      article.className = "message";
      article.dataset.messageAuthorRole = "assistant";
      article.innerHTML = '<div class="role">Assistant</div><pre><code class="language-text"></code></pre>';
      article.querySelector("code").textContent = "ai-helper-skill-start:route-completion-${nonce}\\ncmd: load";
      document.getElementById("thread").appendChild(article);
      const stop = document.createElement("button");
      stop.type = "button";
      stop.setAttribute("aria-label", "Stop generating");
      stop.textContent = "Stop generating";
      document.querySelector("main").appendChild(stop);
      await new Promise((resolve) => setTimeout(resolve, 120));
      history.pushState({}, "", "/tmux-test-page.html?skill-case=route-completion&route=${nonce}");
      article.querySelector("code").textContent = ${JSON.stringify(helper)};
      stop.remove();
      return true;
    })()`);
    const reply = await waitForEvaluateValue(page, `(() => {
      const matches = Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
        .filter((node) => (node.innerText || node.textContent || "").includes("Local Skill load result:"));
      return matches.length === 1 ? (matches[0].innerText || matches[0].textContent || "") : "";
    })()`, "route-assigned Skill completion response on its isolated page");
    assert.match(reply, /revision 2/);
    await assertIsolatedSkillDispatchState(page, { expectedLoadReplies: 1, expectForce: false });
  });

  await withFreshSkillCasePage(debugPort, "slow-route-carried-root-load", async (page, nonce) => {
    const helper = makeLoad(`slow-route-${nonce}`);
    await page.evaluate(`(() => {
      document.getElementById("thread").innerHTML = "";
      appendMessage("user", "Load the E2E Skill after this chat receives its permanent URL slowly.");
      const article = document.createElement("article");
      article.id = "slow-route-assistant";
      article.className = "message";
      article.dataset.messageAuthorRole = "assistant";
      article.innerHTML = '<div class="role">Assistant</div><pre><code class="language-text"></code></pre>';
      article.querySelector("code").textContent = "ai-helper-skill-start:slow-route-${nonce}\\ncmd: load";
      document.getElementById("thread").appendChild(article);
      const stop = document.createElement("button");
      stop.id = "slow-route-stop";
      stop.type = "button";
      stop.setAttribute("data-ai-chat-shell-generation-control", "true");
      stop.textContent = "Generating response";
      document.querySelector("main").appendChild(stop);
      return true;
    })()`);
    await page.evaluate("new Promise((resolve) => setTimeout(resolve, 120))");
    await page.evaluate(`history.pushState({}, "", "/tmux-test-page.html?skill-case=slow-route&route=${nonce}"); true`);
    await new Promise((resolve) => setTimeout(resolve, 3400));
    await page.evaluate(`(() => {
      document.querySelector("#slow-route-assistant code").textContent = ${JSON.stringify(helper)};
      document.getElementById("slow-route-stop")?.remove();
      return true;
    })()`);
    const reply = await waitForEvaluateValue(page, `(() => {
      const matches = Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
        .filter((node) => (node.innerText || node.textContent || "").includes("Local Skill load result:"));
      return matches.length === 1 ? (matches[0].innerText || matches[0].textContent || "") : "";
    })()`, "slow route-carried Skill completion response");
    assert.match(reply, /revision 2/);
    await assertIsolatedSkillDispatchState(page, { expectedLoadReplies: 1, expectForce: false });
  });

  await withFreshSkillCasePage(debugPort, "old-route-stop-new-root-negative", async (page, nonce) => {
    const helper = makeLoad(`old-route-new-root-${nonce}`);
    await page.evaluate(`(() => {
      document.getElementById("thread").innerHTML = "";
      appendMessage("user", "Begin the provisional response.");
      const oldAssistant = document.createElement("article");
      oldAssistant.className = "message";
      oldAssistant.dataset.messageAuthorRole = "assistant";
      oldAssistant.textContent = "ai-helper-skill-start:old-route-incomplete-${nonce}\\ncmd: load";
      document.getElementById("thread").appendChild(oldAssistant);
      const stop = document.createElement("button");
      stop.id = "retained-old-route-stop";
      stop.type = "button";
      stop.setAttribute("data-ai-chat-shell-generation-control", "true");
      stop.textContent = "Generating response";
      document.querySelector("main").appendChild(stop);
      return true;
    })()`);
    await page.evaluate("new Promise((resolve) => setTimeout(resolve, 120))");
    await page.evaluate(`(async () => {
      history.pushState({}, "", "/tmux-test-page.html?skill-case=old-route-new-root&route=${nonce}");
      appendMessage("user", "This is a different current response root.");
      const replacement = document.createElement("article");
      replacement.className = "message";
      replacement.dataset.messageAuthorRole = "assistant";
      replacement.innerHTML = '<div class="role">Assistant</div><pre><code class="language-text"></code></pre>';
      replacement.querySelector("code").textContent = "ai-helper-skill-start:old-route-new-root-${nonce}\\ncmd: load";
      document.getElementById("thread").appendChild(replacement);
      await new Promise((resolve) => setTimeout(resolve, 100));
      replacement.querySelector("code").textContent = ${JSON.stringify(helper)};
      await new Promise((resolve) => setTimeout(resolve, 100));
      return true;
    })()`);
    await page.evaluate("new Promise((resolve) => setTimeout(resolve, 2800))");
    assert.equal(await countSkillLoadReplies(page), 0,
      "A Stop retained from the old route must not authorize a new response root.");
    const recoveryVisible = await page.evaluate(`(() => {
      const recovery = document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-tool-action="skill-recovery"]');
      return recovery && !recovery.hidden;
    })()`);
    assert.equal(recoveryVisible, true);
    await page.evaluate("document.getElementById('retained-old-route-stop')?.remove(); true");
  });

  await withFreshSkillCasePage(debugPort, "pending-load-route-recovery", async (page, nonce) => {
    const helper = makeLoad(`pending-route-${nonce}`);
    await page.evaluate(`(async () => {
      history.pushState({}, "", "/tmux-test-page.html?skill-case=pending-load&route=${nonce}");
      document.getElementById("thread").innerHTML = "";
      appendMessage("user", "Load the E2E Skill while the composer is temporarily unavailable.");
      const form = document.getElementById("composerForm");
      window.__heldPendingSkillForm = form;
      form.remove();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await appendLiveAssistantToolCall(${JSON.stringify(helper)}, "text");
      return true;
    })()`);
    await waitForEvaluate(page, `(() => {
      const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
      return /result cached locally and waiting for the chat composer/i.test(panel?.innerText || "");
    })()`, "Skill load result to remain queued without a composer");
    assert.equal(await countSkillLoadReplies(page), 0);
    await page.evaluate(`(() => {
      history.pushState({}, "", "/tmux-test-page.html?skill-case=pending-load-restored&route=${nonce}");
      document.querySelector("main").appendChild(window.__heldPendingSkillForm);
      delete window.__heldPendingSkillForm;
      return true;
    })()`);
    const reply = await waitForEvaluateValue(page, `(() => {
      const matches = Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
        .filter((node) => (node.innerText || node.textContent || "").includes("Local Skill load result:"));
      return matches.length === 1 ? (matches[0].innerText || matches[0].textContent || "") : "";
    })()`, "queued Skill load result to recover exactly once after a proven retained-root route assignment");
    assert.match(reply, /revision 2/);
    await assertIsolatedSkillDispatchState(page, { expectedLoadReplies: 1, expectForce: false });
  });

  await withFreshSkillCasePage(debugPort, "pending-load-cross-chat-negative", async (page, nonce) => {
    const helper = makeLoad(`pending-cross-chat-${nonce}`);
    await page.evaluate(`(async () => {
      history.pushState({}, "", "/tmux-test-page.html?skill-case=pending-cross-chat-a&route=${nonce}");
      document.getElementById("thread").innerHTML = "";
      appendMessage("user", "Load the E2E Skill in chat A while its composer is unavailable.");
      const form = document.getElementById("composerForm");
      window.__heldCrossChatSkillForm = form;
      form.remove();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await appendLiveAssistantToolCall(${JSON.stringify(helper)}, "text");
      return true;
    })()`);
    await waitForEvaluate(page, `(() => {
      const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
      return /result cached locally and waiting for the chat composer/i.test(panel?.innerText || "");
    })()`, "chat A Skill result to remain queued without a composer");
    await page.evaluate(`(() => {
      history.pushState({}, "", "/tmux-test-page.html?skill-case=pending-cross-chat-b&route=${nonce}");
      document.getElementById("thread").innerHTML = "";
      appendMessage("user", "This is unrelated chat B and must not receive chat A local Skill content.");
      document.querySelector("main").appendChild(window.__heldCrossChatSkillForm);
      delete window.__heldCrossChatSkillForm;
      return true;
    })()`);
    await waitForValue(async () => {
      const worlds = await page.evaluateAcrossContexts(`(() =>
        typeof pendingHelperDeliveries === "undefined"
          ? null
          : Array.from(pendingHelperDeliveries.values()).filter((entry) => entry.kind === "skill-load").length
      )()`);
      return worlds.some((entry) => entry.value === 0) ? true : undefined;
    }, "chat A queued Skill result to be discarded after chat B settles", 12_000);
    const state = await page.evaluateAcrossContexts(`(() => {
      if (typeof pendingHelperDeliveries === "undefined") return null;
      return {
        contentWorld: true,
        pending: Array.from(pendingHelperDeliveries.values()).filter((entry) => entry.kind === "skill-load").length,
        composer: document.getElementById("composer")?.innerText || ""
      };
    })()`);
    const content = state.find((entry) => entry.value?.contentWorld)?.value;
    assert.deepEqual(content, { contentWorld: true, pending: 0, composer: "" },
      "A queued local Skill result from chat A must be discarded before chat B composer delivery.");
    assert.equal(await countSkillLoadReplies(page), 0,
      "Unrelated chat B must receive no Skill load result from chat A.");
  });

  await withFreshSkillCasePage(debugPort, "late-history-manual-recovery", async (page, nonce) => {
    await page.evaluate(`(() => {
      document.getElementById("thread").innerHTML = "";
      return true;
    })()`);
    await waitForIsolatedEmptySkillLifecycle(page, "late history page to finish its empty initial baseline");

    const helper = makeLoad(`late-history-${nonce}`);
    await page.evaluate(`(async () => {
      appendMessage("user", "This user and assistant pair belongs to late-hydrated history.");
      const article = document.createElement("article");
      article.className = "message";
      article.dataset.messageAuthorRole = "assistant";
      article.innerHTML = '<div class="role">Assistant</div><pre><code class="language-text"></code></pre>';
      article.querySelector("code").textContent = "ai-helper-skill-start:late-history-${nonce}\\ncmd: load";
      document.getElementById("thread").appendChild(article);
      await new Promise((resolve) => setTimeout(resolve, 100));
      article.querySelector("code").textContent = ${JSON.stringify(helper)};
      return true;
    })()`);
    const settled = await waitForValue(async () => {
      const worlds = await page.evaluateAcrossContexts(`(() => {
        if (typeof pendingHelperDeliveries === "undefined") return null;
        const thread = getConversationRoot();
        const candidates = extractShellCallCandidates(thread);
        const skill = getLastEligibleSkillCandidate(candidates, thread);
        const semanticKey = skill ? buildSemanticCallKey(skill.call) : "";
        const replies = Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
          .filter((node) => (node.innerText || node.textContent || "").includes("Local Skill load result:")).length;
        return {
          contentWorld: true,
          replies,
          baselineIgnored: Boolean(skill && isBaselineIgnoredHelperCandidate(skill, semanticKey)),
          skillHelperInFlight,
          pendingLoads: Array.from(pendingHelperDeliveries.values()).filter((entry) => entry.kind === "skill-load").length,
          chainCallCount,
          recoveryVisible: document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-tool-action="skill-recovery"]')?.hidden === false,
          composerText: document.getElementById("composer")?.innerText || document.getElementById("composer")?.textContent || ""
        };
      })()`);
      const content = worlds.find((entry) => entry.value?.contentWorld)?.value;
      return content && !content.skillHelperInFlight && (content.baselineIgnored || content.replies > 0)
        ? content
        : undefined;
    }, "late history Skill to reach an inert baseline or expose an erroneous automatic dispatch");
    assert.deepEqual(
      {
        replies: settled.replies,
        baselineIgnored: settled.baselineIgnored,
        pendingLoads: settled.pendingLoads,
        chainCallCount: settled.chainCallCount,
        recoveryVisible: settled.recoveryVisible,
        composerText: settled.composerText
      },
      {
        replies: 0,
        baselineIgnored: true,
        pendingLoads: 0,
        chainCallCount: 0,
        recoveryVisible: true,
        composerText: ""
      },
      "A late hydrated historical Skill must not auto-load or write the composer."
    );
    await page.evaluate(`document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-tool-action="skill-recovery"]')?.click(); true`);
    await waitForEvaluate(page, `(${countSkillLoadRepliesExpression()})() === 1`, "late history manual Skill recovery response");
    await assertIsolatedSkillDispatchState(page, { expectedLoadReplies: 1, expectForce: false });
  });

  await withFreshSkillCasePage(debugPort, "history-load-manual-recovery", async (page, nonce) => {
    const helper = makeLoad(`history-recovery-${nonce}`);
    await page.evaluate(`(() => {
      history.pushState({}, "", "/tmux-test-page.html?skill-case=history-recovery&route=${nonce}");
      document.getElementById("thread").innerHTML = "";
      appendAssistantToolCall(${JSON.stringify(helper)}, "text");
      return true;
    })()`);
    await waitForEvaluate(page, `(() => {
      const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
      const recovery = panel?.querySelector('[data-shell-tool-action="skill-recovery"]');
      const debug = document.getElementById("ai-chat-shell-exec-debug-body")?.textContent || "";
      return recovery && !recovery.hidden && /validated Skill protocol/i.test(recovery.title || "") &&
        debug.includes("kind=skill") && debug.includes("baseline=settled");
    })()`, "ignored history Skill to expose validated manual recovery");
    assert.equal(await countSkillLoadReplies(page), 0, "History rendered without live generation proof must not auto-load.");
    await page.evaluate(`(() => {
      const unrelated = document.createElement("div");
      unrelated.id = "unrelated-history-mutation-${nonce}";
      unrelated.textContent = "unrelated sidebar redraw";
      document.querySelector("aside")?.appendChild(unrelated);
      return true;
    })()`);
    await page.evaluate("new Promise((resolve) => setTimeout(resolve, 2400))");
    assert.equal(await countSkillLoadReplies(page), 0,
      "An unrelated post-baseline mutation must not auto-dispatch an ignored historical Skill.");
    await page.evaluate(`(() => {
      const code = document.querySelector('#thread [data-message-author-role="assistant"] code');
      const unchanged = code?.textContent || "";
      if (code) {
        code.textContent = "";
        code.textContent = unchanged;
      }
      return true;
    })()`);
    await page.evaluate("new Promise((resolve) => setTimeout(resolve, 2400))");
    assert.equal(await countSkillLoadReplies(page), 0,
      "A same-root React redraw without generation proof must preserve the cold-history baseline.");
    await page.evaluate(`(async () => {
      const stop = document.createElement("button");
      stop.type = "button";
      stop.setAttribute("aria-label", "Stop generating");
      stop.textContent = "Stop generating";
      document.querySelector("main").appendChild(stop);
      await new Promise((resolve) => setTimeout(resolve, 120));
      const code = document.querySelector('#thread [data-message-author-role="assistant"] code');
      const unchanged = code?.textContent || "";
      if (code) {
        code.textContent = "";
        await new Promise((resolve) => setTimeout(resolve, 180));
        code.textContent = unchanged;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
      stop.remove();
      return true;
    })()`);
    await page.evaluate("new Promise((resolve) => setTimeout(resolve, 2400))");
    assert.equal(await countSkillLoadReplies(page), 0,
      "A known historical Skill cleared and restored across observer batches during unrelated generation must not become live.");
    await page.evaluate(`document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-tool-action="skill-recovery"]')?.click(); true`);
    await waitForEvaluate(page, `(${countSkillLoadRepliesExpression()})() === 1`, "manual Skill recovery response");
    await assertIsolatedSkillDispatchState(page, { expectedLoadReplies: 1, expectForce: false });
  });

  await withFreshSkillCasePage(debugPort, "old-route-stop-negative", async (page, nonce) => {
    const helper = makeLoad(`old-route-stop-${nonce}`);
    await page.evaluate(`(async () => {
      const stop = document.createElement("button");
      stop.id = "old-route-stop-generating";
      stop.type = "button";
      stop.setAttribute("aria-label", "Stop generating");
      stop.textContent = "Stop generating";
      document.querySelector("main").appendChild(stop);
      await new Promise((resolve) => setTimeout(resolve, 80));
      history.pushState({}, "", "/tmux-test-page.html?skill-case=old-route-stop&route=${nonce}");
      document.getElementById("thread").innerHTML = "";
      appendAssistantToolCall(${JSON.stringify(helper)}, "text");
      return true;
    })()`);
    await waitForEvaluate(page, `(() => {
      const recovery = document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-tool-action="skill-recovery"]');
      const debug = document.getElementById("ai-chat-shell-exec-debug-body")?.textContent || "";
      return recovery && !recovery.hidden && debug.includes("skillLive=no") && debug.includes("kind=skill");
    })()`, "old-route Stop removal not to prove generation in the new lifecycle");
    await page.evaluate("new Promise((resolve) => setTimeout(resolve, 2400))");
    assert.equal(await countSkillLoadReplies(page), 0,
      "A Stop control retained from the previous route must not auto-dispatch new-route history.");
    await page.evaluate(`document.getElementById("old-route-stop-generating")?.remove(); true`);
  });

  await withFreshSkillCasePage(debugPort, "user-skill-load-negative", async (page, nonce) => {
    const helper = makeLoad(`user-negative-${nonce}`);
    await page.evaluate(`(() => {
      history.pushState({}, "", "/tmux-test-page.html?skill-case=user-negative&route=${nonce}");
      document.getElementById("thread").innerHTML = "";
      appendAssistantToolCall(${JSON.stringify(helper)}, "text");
      const message = document.querySelector('#thread [data-message-author-role="assistant"]:last-child');
      message.dataset.messageAuthorRole = "user";
      const role = message.querySelector(".role");
      if (role) role.textContent = "User";
      return true;
    })()`);
    await page.evaluate("new Promise((resolve) => setTimeout(resolve, 3500))");
    const state = await page.evaluate(`(() => ({
      replies: (${countSkillLoadRepliesExpression()})(),
      forceHidden: document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-tool-action="force"]')?.hidden === true,
      recoveryHidden: document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-tool-action="skill-recovery"]')?.hidden === true,
      debug: document.getElementById("ai-chat-shell-exec-debug-body")?.textContent || ""
    }))()`);
    assert.equal(state.replies, 0, JSON.stringify(state));
    assert.equal(state.forceHidden, true, JSON.stringify(state));
    assert.equal(state.recoveryHidden, true, JSON.stringify(state));
    assert.match(state.debug, /kind=skill/);
  });
}

async function waitForIsolatedEmptySkillLifecycle(page, description) {
  await waitForValue(async () => {
    const worlds = await page.evaluateAcrossContexts(`(() => {
      if (typeof initialThreadSettled === "undefined") return null;
      const thread = getConversationRoot();
      const currentThreadText = normalizeText(thread?.innerText || thread?.textContent || "");
      return {
        contentWorld: true,
        settled: initialThreadSettled === true &&
          extractShellCallCandidates(thread).length === 0 &&
          currentThreadText === lastThreadText &&
          Date.now() - lastThreadTextAt >= 1200 &&
          !assistantGenerationObservedForLifecycle &&
          !assistantGenerationEpoch
      };
    })()`);
    return worlds.find((entry) => entry.value?.contentWorld)?.value?.settled || undefined;
  }, description);
}

async function withFreshSkillCasePage(debugPort, caseName, task, options = {}) {
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const baseUrl = String(options.baseUrl || TEST_PAGE_URL);
  const url = `${baseUrl}?isolated-skill-case=${encodeURIComponent(caseName)}&run=${encodeURIComponent(nonce)}`;
  const page = await openChromePage(debugPort, url);
  try {
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await waitForEvaluate(page, "document.readyState === 'complete'", `${caseName} page load`);
    await waitForEvaluate(page, `Boolean(document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)}))`, `${caseName} extension panel`);
    await page.evaluate("new Promise((resolve) => setTimeout(resolve, 2600))");
    await task(page, nonce.replace(/[^a-z0-9]/gi, "").slice(-24));
  } finally {
    await page.send("Page.close").catch(() => null);
    page.close();
  }
}

function countSkillLoadRepliesExpression() {
  return `() => Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
    .filter((node) => (node.innerText || node.textContent || "").includes("Local Skill load result:")).length`;
}

function countSkillLoadReplies(page) {
  return page.evaluate(`(${countSkillLoadRepliesExpression()})()`);
}

async function assertIsolatedSkillDispatchState(page, { expectedLoadReplies, expectForce }) {
  await page.evaluate("new Promise((resolve) => setTimeout(resolve, 2200))");
  const state = await page.evaluateAcrossContexts(`(() => {
    if (typeof pendingHelperDeliveries === "undefined") return null;
    return {
      contentWorld: true,
      pending: Array.from(pendingHelperDeliveries.values()).filter((entry) => entry.kind === "skill-load").length,
      skillHelperInFlight,
      forceVisible: document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-tool-action="force"]')?.hidden === false,
      recoveryVisible: document.querySelector('#${EXTENSION_STATUS_ID} [data-shell-tool-action="skill-recovery"]')?.hidden === false
    };
  })()`);
  const content = state.find((entry) => entry.value?.contentWorld)?.value;
  assert.ok(content, "Missing isolated content-world Skill state.");
  assert.equal(await countSkillLoadReplies(page), expectedLoadReplies);
  assert.equal(content.pending, 0, JSON.stringify(content));
  assert.equal(content.skillHelperInFlight, false, JSON.stringify(content));
  assert.equal(content.forceVisible, expectForce, JSON.stringify(content));
  assert.equal(content.recoveryVisible, false, JSON.stringify(content));
}

async function installSkillThroughDialog(page, skillId) {
  await page.evaluate(`(() => {
    document.getElementById("ai-chat-shell-exec-skill-dialog")?.remove();
    document.querySelector('[data-shell-tool-action="skill-view"]')?.click();
    return true;
  })()`);
  await waitForEvaluate(page, `(() => {
    const row = document.querySelector(${JSON.stringify(`#ai-chat-shell-exec-skill-dialog [data-skill-id="${skillId}"]`)});
    const button = row?.querySelector('[data-skill-install]');
    return button && !button.disabled && /^(Install|Retry)$/.test(button.textContent || "");
  })()`, `Skill ${skillId} Install action`);
  await trustedDoubleClick(page, `#ai-chat-shell-exec-skill-dialog [data-skill-id="${skillId}"] [data-skill-install]`);
  await waitForEvaluate(page, `(() => {
    const row = document.querySelector(${JSON.stringify(`#ai-chat-shell-exec-skill-dialog [data-skill-id="${skillId}"]`)});
    return row && /Installed/.test(row.querySelector('[role="status"]')?.textContent || "");
  })()`, `Skill ${skillId} installation success`);
  await page.evaluate(`document.querySelector('#ai-chat-shell-exec-skill-dialog > section > div:first-child button')?.click(); true`);
  await waitForEvaluate(page, `!document.getElementById("ai-chat-shell-exec-skill-dialog")`, `Skill ${skillId} dialog to close after installation`);
}

async function trustedDoubleClick(page, selector) {
  const point = await page.evaluate(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  assert.ok(point && Number.isFinite(point.x) && Number.isFinite(point.y), `Missing click target: ${selector}`);
  page.acceptNextDialog = true;
  try {
    for (let clickCount = 1; clickCount <= 2; clickCount += 1) {
      await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount });
      await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount });
    }
  } finally {
    page.acceptNextDialog = false;
  }
}

function buildE2eSkillSource({ revision }) {
  return [
    "---",
    "name: e2e-skill",
    `description: E2E Skill browser coverage revision ${revision}`,
    "---",
    `revision ${revision}`,
    "home=$HOME",
    "allowed=${E2E_SKILL_ALLOWED}",
    "secret=${E2E_SKILL_SECRET}",
    "arguments=$ARGUMENTS",
    "Embedded helper documentation must remain inert:",
    "ai-helper-skill-start",
    "cmd: list",
    "ai-helper-skill-end",
    ""
  ].join("\n");
}

async function appendAssistantSkillHelper(page, lines) {
  return appendLiveAssistantHelper(page, lines.join("\n"));
}

async function appendLiveAssistantHelper(page, complete) {
  await page.evaluate(`appendLiveAssistantToolCall(${JSON.stringify(String(complete || ""))}, "text")`);
}

function pageUserMessageCount(page) {
  return page.evaluate(`document.querySelectorAll('[data-message-author-role="user"], .fai-UserMessage[role="article"]').length`);
}

function waitForNewUserMessage(page, previousCount, includedText, description) {
  return waitForEvaluateValue(page, `(() => {
    const messages = Array.from(document.querySelectorAll('[data-message-author-role="user"], .fai-UserMessage[role="article"]'))
      .slice(${Number(previousCount)});
    const matched = messages.find((node) => (node.innerText || node.textContent || "").includes(${JSON.stringify(includedText)}));
    return matched ? (matched.innerText || matched.textContent || "") : "";
  })()`, description);
}

async function waitForSkillPromptLifecycleSettled(page, challenge, description) {
  await waitForValue(async () => {
    const worlds = await page.evaluateAcrossContexts(`(() => {
      if (typeof pendingHelperDeliveries === "undefined" || typeof skillHelperInFlight === "undefined") {
        return null;
      }
      const matchingPrompt = Array.from(pendingHelperDeliveries.values()).find((entry) =>
        entry.kind === "skill-sync-prompt" && entry.call?.challenge === ${JSON.stringify(challenge)}
      );
      const composer = document.getElementById("composer");
      const thread = typeof getConversationRoot === "function" ? getConversationRoot() : null;
      const currentThreadText = typeof normalizeText === "function"
        ? normalizeText(thread?.innerText || thread?.textContent || "")
        : "";
      const scanQuiet = currentThreadText === lastThreadText && Date.now() - lastThreadTextAt >= 1200;
      return {
        contentWorld: true,
        settled: !matchingPrompt && !skillHelperInFlight && !activeComposerDeliveryToken &&
          !(composer?.innerText || composer?.textContent || "").trim() && scanQuiet,
        matchingPhase: matchingPrompt?.phase || "",
        matchingInFlight: matchingPrompt?.deliveryInFlight === true,
        skillHelperInFlight,
        activeDeliveryKind: activeComposerDeliveryToken?.kind || "",
        composerText: composer?.innerText || composer?.textContent || "",
        scanQuiet
      };
    })()`);
    const contentState = worlds.find((entry) => entry.value?.contentWorld)?.value;
    return contentState?.settled ? contentState : undefined;
  }, description);
}

async function assertUserMessageCountStable(page, expectedCount, message) {
  await page.evaluate("new Promise((resolve) => setTimeout(resolve, 2000))");
  assert.equal(await pageUserMessageCount(page), expectedCount, message);
}

function assertNoCompleteSkillMarkerLines(text, label) {
  assert.ok(!String(text || "").includes("ai-helper-skill-start"), `${label} contains the complete Skill start marker substring.`);
  assert.ok(!String(text || "").includes("ai-helper-skill-end"), `${label} contains the complete Skill end marker substring.`);
  const lines = String(text || "").split(/\r?\n/);
  assert.ok(!lines.includes("ai-helper-skill-start"), `${label} contains a complete Skill start marker line.`);
  assert.ok(!lines.includes("ai-helper-skill-end"), `${label} contains a complete Skill end marker line.`);
}

function requireMessageField(text, field, pattern) {
  const expression = new RegExp(`(?:^|\\s)${escapeRegExp(field)}:\\s*(\\S+)`, "i");
  const value = expression.exec(String(text || ""))?.[1] || "";
  assert.match(value, pattern, `Missing or invalid ${field} in message:\n${text}`);
  return value;
}

function findChrome() {
  const envPath = process.env.CHROME_BIN || process.env.GOOGLE_CHROME_BIN;
  if (envPath && fs.existsSync(envPath) && isSupportedChromiumBinary(envPath)) {
    return envPath;
  }
  const playwrightChromium = findPlaywrightChromium();
  if (playwrightChromium && isSupportedChromiumBinary(playwrightChromium)) {
    return playwrightChromium;
  }
  for (const command of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    const result = spawnSync("which", [command], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim() && isSupportedChromiumBinary(result.stdout.trim())) {
      return result.stdout.trim();
    }
  }
  for (const appPath of [
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ]) {
    if (fs.existsSync(appPath) && isSupportedChromiumBinary(appPath)) {
      return appPath;
    }
  }
  return "";
}

function getChromiumMajor(binaryPath) {
  const result = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
    timeout: 3000
  });
  const match = `${result.stdout || ""} ${result.stderr || ""}`.match(/\b(\d+)\./);
  return result.status === 0 ? Number(match?.[1] || 0) : 0;
}

function isSupportedChromiumBinary(binaryPath) {
  return getChromiumMajor(binaryPath) >= MIN_CHROMIUM_MAJOR;
}

function findPlaywrightChromium() {
  const cacheRoot = path.join(os.homedir(), ".cache", "ms-playwright");
  if (!fs.existsSync(cacheRoot)) {
    return "";
  }

  const candidates = [];
  for (const entry of fs.readdirSync(cacheRoot)) {
    if (!entry.startsWith("chromium-")) {
      continue;
    }
    candidates.push(
      path.join(cacheRoot, entry, "chrome-linux64", "chrome"),
      path.join(cacheRoot, entry, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      path.join(cacheRoot, entry, "chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium")
    );
  }

  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function commandExists(command) {
  return spawnSync("which", [command], { encoding: "utf8" }).status === 0;
}

async function setupBrowserEnvironment(chromePath) {
  const env = { ...process.env };
  if (FORCE_HEADLESS) {
    return { env, headless: true };
  }
  if (process.platform !== "linux" || env.DISPLAY) {
    return { env, headless: false };
  }

  const defaultDisplay = detectDefaultDisplay();
  if (defaultDisplay) {
    env.DISPLAY = defaultDisplay;
    return { env, headless: false };
  }

  if (chromePath.includes(`${path.sep}.cache${path.sep}ms-playwright${path.sep}`)) {
    return { env, headless: true };
  }

  const xvfbPath = findExecutable("Xvfb");
  assert.ok(
    xvfbPath,
    "Chrome extension e2e on Ubuntu/Linux requires DISPLAY or Xvfb. Install xvfb, run under xvfb-run, or set AI_SHELL_E2E_HEADLESS=1 to try Chrome headless."
  );

  const display = `:${90 + (process.pid % 1000)}`;
  const xvfb = spawn(xvfbPath, [
    display,
    "-screen",
    "0",
    "1280x900x24",
    "-nolisten",
    "tcp"
  ], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  captureProcessOutput(xvfb, "Xvfb");
  cleanup.push(() => stopProcess(xvfb));
  env.DISPLAY = display;
  await sleep(500);
  return { env, headless: false };
}

function findExecutable(command) {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function detectDefaultDisplay() {
  const socketDir = "/tmp/.X11-unix";
  if (!fs.existsSync(socketDir)) {
    return "";
  }
  const socket = fs.readdirSync(socketDir).find((entry) => /^X\d+$/.test(entry));
  return socket ? `:${socket.slice(1)}` : "";
}

function createTempTmuxSocketPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-chat-shell-tmux-e2e-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "tmux.sock");
}

function startTmuxSession(socketPath, sessionName) {
  runTmux(socketPath, ["new-session", "-d", "-s", sessionName, "-n", "build", "/bin/sh"]);
  const result = runTmux(socketPath, ["list-panes", "-t", sessionName, "-F", "#{pane_id}"]);
  const [paneId] = result.stdout.trim().split(/\r?\n/);
  assert.ok(paneId, "Could not determine e2e tmux pane id.");
  return paneId;
}

function startTmuxCatSession(socketPath, sessionName) {
  runTmux(socketPath, ["new-session", "-d", "-s", sessionName, "-n", "ai", "/bin/cat"]);
  const result = runTmux(socketPath, ["list-panes", "-t", sessionName, "-F", "#{pane_id}"]);
  const [paneId] = result.stdout.trim().split(/\r?\n/);
  assert.ok(paneId, "Could not determine e2e tmux-ai pane id.");
  return paneId;
}

function killTmuxSession(socketPath, sessionName) {
  spawnSync("tmux", [...tmuxSocketArgs(socketPath), "kill-session", "-t", sessionName], { encoding: "utf8" });
}

function getTmuxWindowPaneId(socketPath, sessionName, windowName) {
  const result = runTmux(socketPath, [
    "list-panes",
    "-t",
    `=${sessionName}`,
    "-F",
    "#{window_name}\t#{pane_id}"
  ]);
  const matches = String(result.stdout || "")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split("\t"))
    .filter(([name, paneId]) => name === windowName && paneId);
  assert.equal(matches.length, 1, `Expected one ${sessionName}:${windowName} pane, got ${result.stdout}`);
  return matches[0][1];
}

function runTmux(socketPath, args) {
  const result = spawnSync("tmux", [...tmuxSocketArgs(socketPath), ...args], {
    cwd: ROOT_DIR,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, `tmux ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result;
}

function tmuxSocketArgs(socketPath) {
  return socketPath ? ["-S", socketPath] : [];
}

function spawnNode(args, extraEnv) {
  const env = {
    ...process.env,
    ...extraEnv
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === null || value === undefined) {
      delete env[key];
    }
  }
  const child = spawn(process.execPath, args, {
    cwd: ROOT_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  captureProcessOutput(child, args[0]);
  return child;
}

function captureProcessOutput(child, label) {
  child.stdoutText = "";
  child.stderrText = "";
  child.stdout?.on("data", (chunk) => {
    child.stdoutText += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    child.stderrText += chunk.toString();
  });
  child.on("exit", (code, signal) => {
    child.exitSummary = `${label} exited code=${code} signal=${signal || ""}\n${child.stdoutText}${child.stderrText}`;
  });
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(2000).then(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    })
  ]);
}

async function waitForShellServer() {
  await waitFor(async () => {
    const health = await getShellServerHealth().catch(() => null);
    return health?.ok === true;
  }, "shell server health");
}

async function waitForShellServerToStop() {
  await waitFor(async () => {
    const health = await getShellServerHealth().catch(() => null);
    return health?.ok !== true;
  }, "shell server to stop");
}

function getShellServerHealth() {
  return fetchHttpJson("http://127.0.0.1:17371/health");
}

function fetchHttpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}

function fetchHttpsText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => resolve(text));
    }).on("error", reject);
  });
}

async function waitForChromeDebugPort(profileDir) {
  const portFile = path.join(profileDir, "DevToolsActivePort");
  await waitFor(() => fs.existsSync(portFile), "Chrome DevToolsActivePort");
  const [port] = fs.readFileSync(portFile, "utf8").trim().split(/\r?\n/);
  assert.ok(port, "Chrome did not write a remote debugging port.");
  return Number(port);
}

async function waitForExtensionTarget(debugPort) {
  await waitForValue(async () => {
    const targets = await fetchHttpJson(`http://127.0.0.1:${debugPort}/json/list`).catch(() => []);
    const target = targets.find((item) =>
      item.url?.startsWith("chrome-extension://") &&
      (item.url.includes("/src/background.js") ||
        item.url.endsWith("/service_worker.js") ||
        item.title?.includes("AI Chat Shell Exec"))
    );
    return target?.url || "";
  }, "AI Chat Shell Exec extension target");
}

async function collectDiagnostics(page, debugPort, details) {
  const bodyText = await page.evaluate("(document.body && document.body.innerText || '').slice(0, 6000)").catch((error) => `body unavailable: ${error.message}`);
  const statusText = await page.evaluate(`document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)})?.innerText || ""`).catch((error) => `status unavailable: ${error.message}`);
  const helperDebugText = await page.evaluate(`document.getElementById("ai-chat-shell-exec-debug-body")?.textContent || ""`).catch((error) => `helper debug unavailable: ${error.message}`);
  const targets = await fetchHttpJson(`http://127.0.0.1:${debugPort}/json/list`).catch((error) => [{ error: error.message }]);
  const health = await getShellServerHealth().catch((error) => ({ error: error.message }));
  const tmuxPanes = runTmuxBestEffort(["list-panes", "-a", "-F", "#{pane_id} #{session_name}:#{window_index}.#{pane_index} #{window_name} #{pane_current_command}"]);
  const targetUrls = Array.isArray(targets) ? targets.map((target) => `${target.type || "?"} ${target.url || target.error || ""}`).join("\n") : String(targets);
  return [
    "Chrome extension e2e diagnostics:",
    `token: ${details.token}`,
    `paneId: ${details.paneId}`,
    `command: ${details.command}`,
    `session: ${details.sessionName}`,
    `extension status: ${statusText || "(empty)"}`,
    `helper scanner debug: ${helperDebugText || "(empty)"}`,
    `shell server health: ${JSON.stringify(health)}`,
    `tmux panes:\n${tmuxPanes || "(unavailable)"}`,
    `chrome targets:\n${targetUrls}`,
    `chrome stdout:\n${details.chrome.stdoutText || "(empty)"}`,
    `chrome stderr:\n${details.chrome.stderrText || "(empty)"}`,
    `page text:\n${bodyText}`
  ].join("\n\n");
}

function runTmuxBestEffort(args) {
  const result = spawnSync("tmux", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : (result.stderr || result.stdout || "").trim();
}

async function waitForChromePageWebSocket(debugPort, url) {
  return waitForValue(async () => {
    const targets = await fetchHttpJson(`http://127.0.0.1:${debugPort}/json/list`).catch(() => []);
    const page = targets.find((target) => target.type === "page" && target.url === url);
    return page?.webSocketDebuggerUrl || "";
  }, "Chrome page websocket");
}

async function openChromePage(debugPort, url) {
  const target = await createChromePageTarget(debugPort, url);
  const wsUrl = target.webSocketDebuggerUrl || await waitForChromePageWebSocket(debugPort, url);
  return CdpClient.connect(wsUrl);
}

function createChromePageTarget(debugPort, url) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: debugPort,
      path: `/json/new?${encodeURIComponent(url)}`,
      method: "PUT"
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

async function saveScreenshot(page, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await page.evaluate(`(() => {
    const thread = document.getElementById("thread");
    if (thread) {
      thread.scrollTop = thread.scrollHeight;
    }
  })()`);
  await sleep(300);
  const result = await page.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false
  });
  fs.writeFileSync(filePath, Buffer.from(result.data || "", "base64"));
  assert.ok(fs.statSync(filePath).size > 1000, `Screenshot was not written: ${filePath}`);
}

async function savePanelScreenshot(page, filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const clip = await page.evaluate(`(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    if (!panel) {
      return null;
    }
    document.getElementById("ai-chat-shell-exec-screenshot-stage")?.remove();
    const padding = 18;
    const stage = document.createElement("div");
    stage.id = "ai-chat-shell-exec-screenshot-stage";
    stage.style.cssText = [
      "position:absolute",
      "left:" + window.scrollX + "px",
      "top:" + window.scrollY + "px",
      "z-index:2147483647",
      "padding:" + padding + "px",
      "background:#f5f6f8",
      "box-sizing:border-box"
    ].join(";");
    const clone = panel.cloneNode(true);
    clone.id = "ai-chat-shell-exec-screenshot-panel";
    clone.style.position = "relative";
    clone.style.inset = "auto";
    clone.style.right = "auto";
    clone.style.bottom = "auto";
    clone.style.opacity = "1";
    clone.style.transform = "none";
    stage.appendChild(clone);
    document.documentElement.appendChild(stage);
    const sourceAdvanced = panel.querySelector("#ai-chat-shell-exec-advanced-controls");
    const cloneAdvanced = clone.querySelector("#ai-chat-shell-exec-advanced-controls");
    if (sourceAdvanced && cloneAdvanced) {
      cloneAdvanced.scrollTop = sourceAdvanced.scrollTop;
    }
    const rect = stage.getBoundingClientRect();
    return {
      x: window.scrollX,
      y: window.scrollY,
      width: rect.width,
      height: rect.height,
      scale: 1
    };
  })()`);
  assert.ok(clip?.width > 0 && clip?.height > 0, "Extension panel screenshot clip was not available.");
  try {
    const result = await page.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      clip
    });
    fs.writeFileSync(filePath, Buffer.from(result.data || "", "base64"));
    assert.ok(fs.statSync(filePath).size > 1000, `Panel screenshot was not written: ${filePath}`);
  } finally {
    await page.evaluate(`document.getElementById("ai-chat-shell-exec-screenshot-stage")?.remove()`);
  }
}

async function waitForEvaluate(page, expression, label, timeoutMs = E2E_TIMEOUT_MS) {
  await waitFor(async () => Boolean(await page.evaluate(expression)), label, timeoutMs);
}

async function waitForEvaluateValue(page, expression, label) {
  return waitForValue(() => page.evaluate(expression), label);
}

async function waitFor(check, label, timeoutMs = E2E_TIMEOUT_MS) {
  const value = await waitForValue(async () => (await check()) ? true : undefined, label, timeoutMs);
  return value === true;
}

async function waitForValue(check, label, timeoutMs = E2E_TIMEOUT_MS) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function drawioXml(name, label = name) {
  return [
    '<mxfile host="app.diagrams.net" version="24.7.17">',
    `  <diagram id="${name.replace(/[^A-Za-z0-9_-]/g, "-")}" name="${name}">`,
    '    <mxGraphModel dx="900" dy="600" grid="1" gridSize="10" page="1" pageWidth="827" pageHeight="1169">',
    "      <root>",
    '        <mxCell id="0"/>',
    '        <mxCell id="1" parent="0"/>',
    `        <mxCell id="2" value="${label}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">`,
    '          <mxGeometry x="120" y="100" width="220" height="80" as="geometry"/>',
    "        </mxCell>",
    "      </root>",
    "    </mxGraphModel>",
    "  </diagram>",
    "</mxfile>"
  ].join("\n");
}

function drawioHelper(xml, identity) {
  return [
    `ai-helper-drawio-start:${identity}`,
    xml,
    "ai-helper-drawio-end"
  ].join("\n");
}

async function runDrawioPreviewE2E(page) {
  await ensureDrawioPageVisible(page);
  const keepVisibleTimer = setInterval(() => {
    page.send("Page.bringToFront").catch(() => {});
  }, 750);
  keepVisibleTimer.unref?.();
  const baseline = await page.evaluate(`(() => ({
    composer: document.getElementById("composer")?.innerText || "",
    userCount: document.querySelectorAll('[data-message-author-role="user"]').length,
    shellResults: (document.body.innerText.match(/Shell call result:/g) || []).length
  }))()`);
  const firstXml = drawioXml("Draw.io E2E v1", "Last valid helper v1");
  await page.evaluate(`appendAssistantToolCall(${JSON.stringify(drawioHelper(firstXml, "drawio-e2e-v1"))}, "text")`);
  await waitForEvaluate(page, `(() => {
    const host = document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)});
    return host?.dataset.state === "ready" &&
      host.dataset.currentTitle === "Draw.io E2E v1" &&
      host.shadowRoot?.querySelector(".drawio-frame-current iframe");
  })()`, "first draw.io SVG preview");
  await waitForEvaluate(page, `(() => {
    const button = document.querySelector('#${EXTENSION_STATUS_ID} #ai-chat-shell-exec-drawio-action');
    return button?.hidden === false && button.textContent === "Draw.io preview";
  })()`, "contextual Draw.io panel action to appear after an artifact exists");
  await page.evaluate(`(() => {
    const host = document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)});
    host?.shadowRoot?.querySelector('[data-action="close"]')?.click();
    return host?.hidden === true;
  })()`);
  assert.equal(
    await page.evaluate(`document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)})?.hidden === true`),
    true,
    "Closing the Draw.io window must retain the contextual reopen action."
  );
  await page.evaluate(`document.querySelector('#${EXTENSION_STATUS_ID} #ai-chat-shell-exec-drawio-action')?.click()`);
  await waitForEvaluate(page, `document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)})?.hidden === false`, "contextual Draw.io action to reopen the preview");

  const normalPreviewRect = await page.evaluate(`(() => {
    const windowNode = document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)})?.shadowRoot?.querySelector(".window");
    const rect = windowNode?.getBoundingClientRect();
    return rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
  })()`);
  assert.ok(normalPreviewRect?.width > 400 && normalPreviewRect.width < 900);
  await page.evaluate(`document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)})?.shadowRoot?.querySelector('[data-action="maximize"]')?.click()`);
  const maximizedPreview = await page.evaluate(`(() => {
    const host = document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)});
    const button = host?.shadowRoot?.querySelector('[data-action="maximize"]');
    const rect = host?.shadowRoot?.querySelector(".window")?.getBoundingClientRect();
    return rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, label: button?.textContent, pressed: button?.getAttribute("aria-pressed"), maximized: host?.dataset.maximized } : null;
  })()`);
  assert.ok(maximizedPreview.left <= 9 && maximizedPreview.top <= 9);
  assert.ok(Math.abs(maximizedPreview.right - (maximizedPreview.viewportWidth - 8)) <= 2, "Maximized preview should reach the browser viewport width.");
  assert.ok(Math.abs(maximizedPreview.bottom - (maximizedPreview.viewportHeight - 8)) <= 2, "Maximized preview should reach the browser viewport height.");
  assert.equal(maximizedPreview.label, "Restore");
  assert.equal(maximizedPreview.pressed, "true");
  assert.equal(maximizedPreview.maximized, "true");
  await page.evaluate(`document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)})?.shadowRoot?.querySelector('[data-action="maximize"]')?.click()`);
  const restoredPreviewRect = await page.evaluate(`(() => {
    const rect = document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)})?.shadowRoot?.querySelector(".window")?.getBoundingClientRect();
    return rect ? { width: rect.width, height: rect.height } : null;
  })()`);
  assert.ok(Math.abs(restoredPreviewRect.width - normalPreviewRect.width) <= 2);
  assert.ok(Math.abs(restoredPreviewRect.height - normalPreviewRect.height) <= 2);

  const firstState = await page.evaluate(`(() => {
    const host = document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)});
    return { renderCount: Number(host.dataset.renderCount), artifactId: host.dataset.currentArtifactId };
  })()`);
  assert.equal(firstState.renderCount, 1);
  assert.ok(firstState.artifactId);

  const streamingXml = drawioXml("Draw.io E2E v2", "Streaming must not flicker");
  const streamingPrefix = `ai-helper-drawio-start:drawio-e2e-v2\n${streamingXml.slice(0, Math.floor(streamingXml.length / 2))}`;
  await page.evaluate(`appendAssistantToolCall(${JSON.stringify(streamingPrefix)}, "text")`);
  await page.evaluate("new Promise((resolve) => setTimeout(resolve, 3200))");
  let state = await page.evaluate(`(() => {
    const host = document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)});
    return { title: host.dataset.currentTitle, renderCount: Number(host.dataset.renderCount), state: host.dataset.state };
  })()`);
  assert.equal(state.title, "Draw.io E2E v1", "An incomplete streamed helper must keep the old SVG visible.");
  assert.equal(state.renderCount, 1, "An incomplete streamed helper must not mount a renderer.");

  await ensureDrawioPageVisible(page);
  await page.evaluate(`(() => {
    const code = document.querySelector("#thread article:last-child code");
    code.textContent = ${JSON.stringify(drawioHelper(streamingXml, "drawio-e2e-v2"))};
  })()`);
  try {
    await waitForEvaluate(page, `(() => {
      const host = document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)});
      return host?.dataset.state === "ready" && host.dataset.currentTitle === "Draw.io E2E v2";
    })()`, "completed streamed draw.io SVG preview", E2E_TIMEOUT_MS * 2);
  } catch (error) {
    const diagnostics = await page.evaluate(`(() => {
      const host = document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)});
      const code = document.querySelector("#thread article:last-child code");
      return {
        hostState: host?.dataset.state || "",
        currentTitle: host?.dataset.currentTitle || "",
        renderCount: Number(host?.dataset.renderCount || 0),
        errorCount: Number(host?.dataset.errorCount || 0),
        lastError: host?.dataset.lastError || "",
        frameCount: host?.shadowRoot?.querySelectorAll("iframe")?.length || 0,
        status: host?.shadowRoot?.querySelector(".status")?.innerText || "",
        latestCodeStart: (code?.textContent || "").slice(0, 160),
        helperDebug: document.getElementById("ai-chat-shell-exec-debug-body")?.textContent || ""
      };
    })()`);
    const frameDiagnostics = await page.evaluateAcrossContexts(`(() => ({
      url: location.href,
      hidden: document.hidden,
      visibility: document.visibilityState,
      viewerText: document.getElementById("viewer")?.innerText || "",
      svgCount: document.querySelectorAll("svg").length,
      graphCount: document.querySelectorAll(".mxgraph").length,
      errorCount: document.querySelectorAll(".render-error").length,
      graphViewer: typeof globalThis.GraphViewer?.processElements
    }))()`);
    throw new Error(`${error.message}; drawioState=${JSON.stringify(diagnostics)}; frames=${JSON.stringify(frameDiagnostics)}; console=${JSON.stringify(page.consoleMessages.slice(-20))}`);
  }
  state = await page.evaluate(`(() => {
    const host = document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)});
    return { renderCount: Number(host.dataset.renderCount), errorCount: Number(host.dataset.errorCount) };
  })()`);
  assert.equal(state.renderCount, 2);

  const rapidV3 = drawioHelper(drawioXml("Draw.io E2E v3"), "drawio-e2e-v3");
  const rapidV4Xml = drawioXml("Draw.io E2E v4", "Only this rapid helper should render");
  const rapidV4 = drawioHelper(rapidV4Xml, "drawio-e2e-v4");
  await ensureDrawioPageVisible(page);
  await page.evaluate(`(() => {
    appendAssistantToolCall(${JSON.stringify(rapidV3)}, "text");
    appendAssistantToolCall(${JSON.stringify(rapidV4)}, "text");
  })()`);
  await waitForEvaluate(page, `(() => {
    const host = document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)});
    return host?.dataset.state === "ready" && host.dataset.currentTitle === "Draw.io E2E v4";
  })()`, "last of two rapid draw.io helpers");
  state = await page.evaluate(`(() => {
    const host = document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)});
    return { renderCount: Number(host.dataset.renderCount), artifactId: host.dataset.currentArtifactId };
  })()`);
  assert.equal(state.renderCount, 3, "Two helpers added within one debounce window must produce one renderer mount.");
  const v4ArtifactId = state.artifactId;

  const malformed = [
    "ai-helper-drawio-start:drawio-e2e-malformed",
    '<mxfile><diagram name="Malformed"><mxGraphModel></diagram></mxfile>',
    "ai-helper-drawio-end"
  ].join("\n");
  const errorCountBeforeMalformed = Number((await page.evaluate(`document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)}).dataset.errorCount`)) || 0);
  await ensureDrawioPageVisible(page);
  await page.evaluate(`appendAssistantToolCall(${JSON.stringify(malformed)}, "text")`);
  await waitForEvaluate(page, `(() => {
    const host = document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)});
    return Number(host?.dataset.errorCount || 0) > ${errorCountBeforeMalformed} &&
      host.dataset.state === "error" &&
      host.dataset.currentArtifactId === "" &&
      !host.shadowRoot?.querySelector(".drawio-frame-current") &&
      host.shadowRoot?.querySelector('[data-action="download"]')?.disabled === true &&
      /malformed/i.test(host.dataset.lastError || "") &&
      /helper rejected/i.test(host.shadowRoot?.querySelector("details pre")?.innerText || "");
  })()`, "malformed latest draw.io helper replacing the old render with an error-only state");
  await waitForEvaluate(page, `(() => {
    const users = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
    return users.length === ${baseline.userCount + 1} && /Draw\.io helper failed:/.test(users.at(-1)?.innerText || "") && /drawio-e2e-malformed/.test(users.at(-1)?.innerText || "");
  })()`, "malformed Draw.io error to be sent once to the AI");

  const brokenRendererXml = '<mxfile><diagram name="Broken renderer">definitely-not-valid-compressed-drawio-data</diagram></mxfile>';
  const errorCountBeforeRenderFailure = Number((await page.evaluate(`document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)}).dataset.errorCount`)) || 0);
  await ensureDrawioPageVisible(page);
  await page.evaluate(`appendAssistantToolCall(${JSON.stringify(drawioHelper(brokenRendererXml, "drawio-e2e-render-fail"))}, "text")`);
  try {
    await waitForEvaluate(page, `(() => {
      const host = document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)});
      return Number(host?.dataset.errorCount || 0) > ${errorCountBeforeRenderFailure} &&
        host.dataset.state === "error" &&
        host.dataset.currentArtifactId === "" &&
        /render failed/i.test(host.dataset.lastError || "") &&
        !/malformed/i.test(host.shadowRoot?.querySelector("details pre")?.innerText || "");
    })()`, "latest draw.io renderer failure replacing the previous error log");
  } catch (error) {
    const diagnostics = await page.evaluate(`(() => {
      const host = document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)});
      return {
        hostState: host?.dataset.state || "",
        currentTitle: host?.dataset.currentTitle || "",
        currentArtifactId: host?.dataset.currentArtifactId || "",
        pendingArtifactId: host?.dataset.pendingArtifactId || "",
        renderCount: Number(host?.dataset.renderCount || 0),
        errorCount: Number(host?.dataset.errorCount || 0),
        lastError: host?.dataset.lastError || "",
        frameCount: host?.shadowRoot?.querySelectorAll("iframe")?.length || 0,
        status: host?.shadowRoot?.querySelector(".status")?.innerText || "",
        errorLog: host?.shadowRoot?.querySelector("details pre")?.innerText || "",
        visibility: document.visibilityState,
        latestArticles: Array.from(document.querySelectorAll("#thread article")).slice(-3).map((node) => node.innerText)
      };
    })()`);
    throw new Error(`${error.message}; drawioState=${JSON.stringify(diagnostics)}; console=${JSON.stringify(page.consoleMessages.slice(-30))}`);
  }
  await waitForEvaluate(page, `(() => {
    const users = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
    return users.length === ${baseline.userCount + 2} && /Draw\.io helper failed:/.test(users.at(-1)?.innerText || "") && /drawio-e2e-render-fail/.test(users.at(-1)?.innerText || "");
  })()`, "render failure to be sent once to the AI");
  assert.ok(
    page.consoleMessages.some((entry) => entry.text.includes("[AI Chat Draw.io]") && /render failed/i.test(entry.text)),
    "A renderer failure must be emitted to the browser console as well as the preview log."
  );

  await ensureDrawioPageVisible(page);
  await page.evaluate(`appendAssistantToolCall(${JSON.stringify(rapidV4)}, "text")`);
  await waitForEvaluate(page, `(() => {
    const host = document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)});
    return host?.dataset.state === "ready" && host.dataset.currentArtifactId === ${JSON.stringify(v4ArtifactId)} &&
      host.shadowRoot?.querySelector("details")?.hidden === true &&
      (host.shadowRoot?.querySelector("details pre")?.innerText || "") === "";
  })()`, "successful latest Draw.io helper to clear the prior error without replying");
  state = await page.evaluate(`(() => {
    const host = document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)});
    return { renderCount: Number(host.dataset.renderCount), artifactId: host.dataset.currentArtifactId, userCount: document.querySelectorAll('[data-message-author-role="user"]').length };
  })()`);
  assert.equal(state.renderCount, 4, "The latest success after an error must produce a fresh render.");
  assert.equal(state.artifactId, v4ArtifactId);
  assert.equal(state.userCount, baseline.userCount + 2, "A successful Draw.io helper must not send a reply.");

  await ensureDrawioPageVisible(page);
  await page.evaluate(`appendAssistantToolCall(${JSON.stringify(rapidV4)}, "text")`);
  await page.evaluate("new Promise((resolve) => setTimeout(resolve, 3200))");
  state = await page.evaluate(`(() => {
    const host = document.getElementById(${JSON.stringify(DRAWIO_PREVIEW_ID)});
    return { renderCount: Number(host.dataset.renderCount), artifactId: host.dataset.currentArtifactId, userCount: document.querySelectorAll('[data-message-author-role="user"]').length };
  })()`);
  assert.equal(state.renderCount, 4, "A redrawn helper with the same XML artifact must not remount or flicker.");
  assert.equal(state.userCount, baseline.userCount + 2, "A successful redraw must not send any reply.");

  await runDrawioSupersedeE2E(page, rapidV4Xml, v4ArtifactId);

  const finalPageState = await page.evaluate(`(() => ({
    composer: document.getElementById("composer")?.innerText || "",
    userCount: document.querySelectorAll('[data-message-author-role="user"]').length,
    shellResults: (document.body.innerText.match(/Shell call result:/g) || []).length
  }))()`);
  assert.equal(finalPageState.composer, baseline.composer);
  assert.equal(finalPageState.shellResults, baseline.shellResults, "Draw.io previews must never call the shell backend.");
  assert.equal(finalPageState.userCount, baseline.userCount + 2, "Only the two latest-helper failures should be sent to the AI.");
  if (SCREENSHOT_DIR) {
    await savePanelScreenshot(page, path.join(SCREENSHOT_DIR, "extension-panel-drawio.png"));
  }
  clearInterval(keepVisibleTimer);
}

async function ensureDrawioPageVisible(page) {
  await page.send("Page.bringToFront");
  await waitForEvaluate(page, "document.visibilityState === 'visible'", "Draw.io E2E page to be visible");
}

async function runDrawioSupersedeE2E(page, currentXml, currentArtifactId) {
  const validB = drawioXml("Draw.io superseded B", "This staging result must never become current");
  const invalidXml = '<mxfile><diagram name="Cached invalid"><mxGraphModel></diagram></mxfile>';
  const results = await page.evaluateAcrossContexts(`(async () => {
    if (!globalThis.AiChatDrawioPreview?.consider) {
      return null;
    }
    const currentXml = ${JSON.stringify(currentXml)};
    const currentArtifactId = ${JSON.stringify(currentArtifactId)};
    const validB = ${JSON.stringify(validB)};
    const invalidXml = ${JSON.stringify(invalidXml)};
    const preview = globalThis.AiChatDrawioPreview;

    const stagingB = preview.consider({
      xml: validB,
      candidateKey: "drawio-supersede-current-b"
    });
    const pendingBeforeCurrentRestore = preview.getDiagnostics().pendingArtifactId;
    const currentRestore = await preview.consider({
      xml: currentXml,
      candidateKey: "drawio-supersede-current-a"
    });
    const cancelledB = await stagingB;
    const afterCurrentRestore = preview.getDiagnostics();

    const firstInvalid = await preview.consider({
      xml: invalidXml,
      candidateKey: "drawio-supersede-cached-invalid"
    });
    const firstInvalidState = preview.getDiagnostics();
    await preview.consider({
      xml: currentXml,
      candidateKey: "drawio-supersede-current-after-invalid"
    });

    const stagingAfterCachedInvalid = preview.consider({
      xml: validB,
      candidateKey: "drawio-supersede-cached-invalid-b"
    });
    const cachedInvalid = await preview.consider({
      xml: invalidXml,
      candidateKey: "drawio-supersede-cached-invalid"
    });
    const cancelledAfterCachedInvalid = await stagingAfterCachedInvalid;
    const afterCachedInvalid = preview.getDiagnostics();

    await preview.consider({
      xml: currentXml,
      candidateKey: "drawio-supersede-final-current"
    });
    return {
      currentArtifactId,
      pendingBeforeCurrentRestore,
      currentRestore,
      cancelledB,
      afterCurrentRestore,
      firstInvalid,
      firstInvalidState,
      cachedInvalid,
      cancelledAfterCachedInvalid,
      afterCachedInvalid,
      finalState: preview.getDiagnostics()
    };
  })()`);
  const outcome = results.find((entry) => entry.value?.currentArtifactId)?.value;
  assert.ok(outcome, `Draw.io supersede test did not run in the extension context: ${JSON.stringify(results)}`);
  assert.ok(outcome.pendingBeforeCurrentRestore && outcome.pendingBeforeCurrentRestore !== currentArtifactId,
    "The regression must first prove that a different artifact is staging.");
  assert.equal(outcome.currentRestore.unchanged, true);
  assert.equal(outcome.cancelledB.cancelled, true,
    "Re-selecting the already-rendered latest artifact must cancel a different staging renderer.");
  assert.equal(outcome.afterCurrentRestore.currentArtifactId, currentArtifactId);
  assert.equal(outcome.afterCurrentRestore.pendingArtifactId, "");
  assert.equal(outcome.firstInvalid.newError, true);
  assert.equal(outcome.cachedInvalid.newError, false,
    "A repeated invalid candidate must restore its cached local outcome without generating another AI error.");
  assert.equal(outcome.cancelledAfterCachedInvalid.cancelled, true,
    "A cached invalid outcome must still supersede a newer staging renderer.");
  assert.equal(outcome.afterCachedInvalid.state, "error");
  assert.equal(outcome.afterCachedInvalid.currentArtifactId, "");
  assert.equal(outcome.afterCachedInvalid.pendingArtifactId, "");
  assert.equal(outcome.afterCachedInvalid.renderErrorCount, outcome.firstInvalidState.renderErrorCount,
    "Restoring a cached invalid outcome must not count or report the same error again.");
  assert.equal(outcome.finalState.state, "ready");
  assert.equal(outcome.finalState.currentArtifactId, currentArtifactId);
}

async function sendLocalAgentRequest(page, payload) {
  const expression = `new Promise((resolve, reject) => {
    const requestId = "agent-e2e-" + Date.now() + "-" + Math.random().toString(16).slice(2);
    const timeout = setTimeout(() => {
      window.removeEventListener("message", handler);
      reject(new Error("Timed out waiting for local agent response"));
    }, 5000);
    function handler(event) {
      if (event.source !== window || event.origin !== window.location.origin) {
        return;
      }
      const data = event.data || {};
      if (data.type !== "ai-chat-shell-exec:agent-response" || data.requestId !== requestId) {
        return;
      }
      clearTimeout(timeout);
      window.removeEventListener("message", handler);
      resolve(data.response || {});
    }
    window.addEventListener("message", handler);
    window.postMessage({
      type: "ai-chat-shell-exec:agent-request",
      requestId,
      payload: ${JSON.stringify(payload)}
    }, window.location.origin);
  })`;
  return page.evaluate(expression);
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.executionContexts = new Map();
    this.consoleMessages = [];
    this.acceptNextDialog = false;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        if (message.method === "Runtime.executionContextCreated" && message.params?.context?.id) {
          this.executionContexts.set(message.params.context.id, message.params.context);
        } else if (message.method === "Runtime.executionContextDestroyed") {
          this.executionContexts.delete(message.params?.executionContextId);
        } else if (message.method === "Runtime.executionContextsCleared") {
          this.executionContexts.clear();
        } else if (message.method === "Runtime.consoleAPICalled") {
          const text = (message.params?.args || [])
            .map((arg) => arg.value === undefined ? arg.description || "" : String(arg.value))
            .filter(Boolean)
            .join(" ");
          this.consoleMessages.push({ type: message.params?.type || "", text });
          this.consoleMessages = this.consoleMessages.slice(-200);
        } else if (message.method === "Page.javascriptDialogOpening" && this.acceptNextDialog) {
          this.acceptNextDialog = false;
          this.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(`${message.error.message || "CDP error"} (${message.error.code || "unknown"})`));
      } else {
        pending.resolve(message.result || {});
      }
    });
    ws.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("CDP websocket closed"));
      }
      this.pending.clear();
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return new CdpClient(ws);
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const operation = method === "Runtime.evaluate"
          ? `: ${String(params.expression || "").replace(/\s+/g, " ").slice(0, 240)}`
          : "";
        reject(new Error(`CDP ${method} timed out${operation}`));
      }, E2E_TIMEOUT_MS);
      timeout.unref?.();
      this.pending.set(id, { resolve, reject, timeout });
      this.ws.send(payload);
    });
  }

  async evaluate(expression, options = {}) {
    if (options.acceptDialogs === true) {
      this.acceptNextDialog = true;
    }
    let result;
    try {
      result = await this.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true
      });
    } finally {
      this.acceptNextDialog = false;
    }
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return result.result?.value;
  }

  async evaluateAcrossContexts(expression) {
    const values = [];
    for (const context of this.executionContexts.values()) {
      try {
        const result = await this.send("Runtime.evaluate", {
          expression,
          contextId: context.id,
          awaitPromise: true,
          returnByValue: true
        });
        if (!result.exceptionDetails && result.result?.value !== null && result.result?.value !== undefined) {
          values.push({
            context: {
              id: context.id,
              name: context.name || "",
              origin: context.origin || "",
              auxData: context.auxData || null
            },
            value: result.result.value
          });
        }
      } catch (_unused) {
        // A navigation may destroy a context while diagnostics are collected.
      }
    }
    return values;
  }

  close() {
    this.ws.close();
  }
}
