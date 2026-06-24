#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT_DIR = path.join(__dirname, "..");
const EXTENSION_DIR = path.join(ROOT_DIR, "extension");
const TEST_PAGE_URL = "https://localhost:17443/tmux-test-page.html";
const EXTENSION_STATUS_ID = "ai-chat-shell-exec-status";
const EXPECTED_EXTENSION_ORIGIN = "chrome-extension://lkmeogidbglhedgekjgbpbfjkpapnhke";
const E2E_TIMEOUT_MS = 45000;
const FORCE_HEADLESS = process.env.AI_SHELL_E2E_HEADLESS === "1";
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
  assert.ok(chromePath, "Chrome e2e requires google-chrome, google-chrome-stable, chromium, or chromium-browser on PATH.");
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
      4,
      `Existing shell server protocol is ${serverProtocolVersion || "(missing)"}; restart the local shell server from this checkout before running e2e.`
    );
    assert.equal(
      serverHealth.helperProtocolVersion,
      2,
      `Existing shell helper protocol is ${serverHealth.helperProtocolVersion || "(missing)"}; restart the local shell server from this checkout before running e2e.`
    );
  }

  const sessionName = `ai_chat_shell_e2e_${process.pid}_${Date.now()}`;
  const paneId = startTmuxSession(socketPath, sessionName);
  cleanup.push(() => killTmuxSession(socketPath, sessionName));
  const tmuxAiSessionName = `ai_chat_shell_agent_e2e_${process.pid}_${Date.now()}`;
  startTmuxCatSession(socketPath, tmuxAiSessionName);
  cleanup.push(() => killTmuxSession(socketPath, tmuxAiSessionName));

  if (!serverHealth?.ok) {
    const server = spawnNode(["server/shell_server.js"], {
      AI_CHAT_SHELL_TMUX_SOCKET: socketPath,
      AI_CHAT_SHELL_RUNNER: fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh",
      AI_CHAT_SHELL_ALLOW_UNTRUSTED_ORIGINS: "1"
    });
    cleanup.push(() => stopProcess(server));
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
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    "--allow-insecure-localhost",
    "--ignore-certificate-errors",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,900",
    "about:blank"
  ];
  if (browserEnv.headless) {
    chromeArgs.unshift("--headless=new");
  }

  const chrome = spawn(chromePath, chromeArgs, {
    cwd: ROOT_DIR,
    env: browserEnv.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  captureProcessOutput(chrome, "chrome");
  cleanup.push(() => stopProcess(chrome));

  const debugPort = await waitForChromeDebugPort(profileDir);
  await waitForExtensionTarget(debugPort);
  const pageWsUrl = await waitForChromePageWebSocket(debugPort, "about:blank");
  const page = await CdpClient.connect(pageWsUrl);
  cleanup.push(() => page.close());

  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Page.navigate", { url: TEST_PAGE_URL });
  await waitForEvaluate(page, "document.readyState === 'complete'", "test page load");
  await waitForEvaluate(page, "document.body.innerText.includes('tmux ai-helper test')", "tmux test page content");
  await waitForEvaluate(page, `Boolean(document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)}))`, "extension status panel");
  await page.evaluate(`new Promise((resolve) => setTimeout(resolve, ${STARTUP_SETTLE_MS}))`);

  const agentTaskId = `task-e2e-${Date.now()}`;
  const agentBody = `agent hub local page message ${agentTaskId}`;
  await page.evaluate(`(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    panel.querySelector("[data-shell-agent-role]").value = "master";
    panel.querySelector("[data-shell-agent-id]").value = "master";
    panel.querySelector('[data-shell-tool-action="agent-register"]').click();
    return true;
  })()`);
  await waitForEvaluate(page, `document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)}).innerText.includes("Registered master master")`, "panel agent master registration");

  let agentResponse = await sendLocalAgentRequest(page, {
    type: "agent-register",
    agentId: "slave-a",
    role: "slave",
    origin: "https://localhost:17443",
    pathname: "/tmux-test-page.html"
  });
  assert.equal(agentResponse.ok, true);
  assert.ok(agentResponse.agents.some((agent) => agent.agentId === "master"));
  assert.ok(agentResponse.agents.some((agent) => agent.agentId === "slave-a"));

  agentResponse = await sendLocalAgentRequest(page, {
    type: "agent-send",
    from: "master",
    to: "slave-a",
    taskId: agentTaskId,
    body: agentBody
  });
  assert.equal(agentResponse.ok, true);
  const agentMessageId = agentResponse.message.messageId;
  assert.equal(agentResponse.message.to, "slave-a");

  agentResponse = await sendLocalAgentRequest(page, {
    type: "agent-poll",
    agentId: "slave-a"
  });
  assert.equal(agentResponse.ok, true);
  assert.equal(agentResponse.messages.length, 1);
  assert.equal(agentResponse.messages[0].body, agentBody);

  agentResponse = await sendLocalAgentRequest(page, {
    type: "agent-ack",
    agentId: "slave-a",
    messageId: agentMessageId
  });
  assert.equal(agentResponse.ok, true);

  agentResponse = await sendLocalAgentRequest(page, {
    type: "agent-poll",
    agentId: "slave-a"
  });
  assert.equal(agentResponse.ok, true);
  assert.equal(agentResponse.messages.length, 0);

  const helperAgentTaskId = `task-helper-e2e-${Date.now()}`;
  const helperAgentBody = `agent helper detected on local page ${helperAgentTaskId}`;
  await page.evaluate(`(() => {
    appendAssistantToolCall([
      "ai-helper-agent-message-start:agent-e2e",
      "to: master",
      ${JSON.stringify(`task-id: ${helperAgentTaskId}`)},
      "",
      ${JSON.stringify(helperAgentBody)},
      "ai-helper-agent-message-end"
    ].join("\\n"), "text");
    return true;
  })()`);

  const agentHelperText = await waitForEvaluateValue(page, `(() => {
    const text = document.body.innerText || "";
    return text.includes("Agent message result:") &&
      text.includes("to: master") &&
      text.includes(${JSON.stringify(`task-id: ${helperAgentTaskId}`)}) ? text : "";
  })()`, "agent-message helper result from extension");
  assert.match(agentHelperText, /Agent message result:/);

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

  const masterDeliveredText = await waitForEvaluateValue(masterPage, `(() => {
    const text = document.body.innerText || "";
    return text.includes(${JSON.stringify(`Message from slave-a for task ${helperAgentTaskId}:`)}) &&
      text.includes(${JSON.stringify(helperAgentBody)}) ? text : "";
  })()`, "slave reply delivered into master tab");
  assert.match(masterDeliveredText, new RegExp(escapeRegExp(helperAgentBody)));

  const rosterHelperId = `roster-e2e-${Date.now()}`;
  await masterPage.evaluate(`(() => {
    appendAssistantToolCall([
      ${JSON.stringify(`ai-helper-agent-roster-start:${rosterHelperId}`)},
      "role: slave",
      "ai-helper-agent-roster-end"
    ].join("\\n"), "text");
    return true;
  })()`);
  const rosterHelperText = await waitForEvaluateValue(masterPage, `(() => {
    const text = document.body.innerText || "";
    return text.includes("Agent roster result:") &&
      text.includes("filterRole: slave") &&
      text.includes("slave-a role=slave surface=web") ? text : "";
  })()`, "agent roster helper result from master tab");
  assert.match(rosterHelperText, /Agent roster result:/);

  const statusHelperId = `status-e2e-${Date.now()}`;
  await masterPage.evaluate(`(() => {
    appendAssistantToolCall([
      ${JSON.stringify(`ai-helper-agent-task-status-start:${statusHelperId}`)},
      ${JSON.stringify(`task-id: ${helperAgentTaskId}`)},
      "ai-helper-agent-task-status-end"
    ].join("\\n"), "text");
    return true;
  })()`);
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
    panel.querySelector("[data-shell-tmux-ai-id]").value = "slave-tmux-ai";
    const target = panel.querySelector("[data-shell-tmux-ai-target]");
    const option = document.createElement("option");
    option.value = ${JSON.stringify(`${tmuxAiSessionName}:0.0`)};
    option.textContent = option.value;
    target.appendChild(option);
    target.value = option.value;
    panel.querySelector('[data-shell-tool-action="tmux-ai-register"]').click();
    return true;
  })()`);
  await waitForEvaluate(masterPage, `document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)}).innerText.includes("Registered tmux-ai slave slave-tmux-ai")`, "master panel tmux-ai slave registration");
  agentResponse = await sendLocalAgentRequest(masterPage, {
    type: "agent-list"
  });
  assert.equal(agentResponse.ok, true, JSON.stringify(agentResponse));
  assert.ok(agentResponse.agents.some((agent) => agent.agentId === "slave-tmux-ai" && agent.surface === "tmux-ai"));
  await masterPage.evaluate(`(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    panel.querySelector('[data-shell-tool-action="agent-check"]').click();
    return true;
  })()`);
  await waitForEvaluate(masterPage, `(() => {
    const text = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)}).innerText || "";
    return text.includes("Agent setup check:") &&
      text.includes("tmux-ai slaves: slave-tmux-ai@") &&
      text.includes("Ready: delegate to slave-a, slave-tmux-ai. Tmux AI is optional.");
  })()`, "master panel agent setup check ready state");

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
  const deliveredText = await waitForEvaluateValue(page, `(() => {
    const text = document.body.innerText || "";
    return text.includes(${JSON.stringify(`Message from master for task ${deliveryTaskId}:`)}) &&
      text.includes(${JSON.stringify(deliveryBody)}) &&
      text.includes("You are slave-a") ? text : "";
  })()`, "agent message delivered into local page composer");
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

  const agentTmuxToken = `agent-tmux-e2e-${Date.now()}`;
  await page.evaluate(`(() => {
    document.getElementById("command").value = ${JSON.stringify(`printf ${agentTmuxToken}`)};
    appendAssistantToolCall([
      "ai-helper-shell-start:agent-tmux-e2e",
      ${JSON.stringify(`printf ${agentTmuxToken}`)},
      "ai-helper-shell-end"
    ].join("\\n"), "text");
    return true;
  })()`);
  const agentTmuxText = await waitForEvaluateValue(page, `(() => {
    const text = document.body.innerText || "";
    return text.includes("Shell call result:") &&
      text.includes("targetName: ForAI-slave-a") &&
      text.includes(${JSON.stringify(`stdout:\n${agentTmuxToken}`)}) ? text : "";
  })()`, "agent shell helper uses per-agent tmux");
  assert.match(agentTmuxText, /targetName: ForAI-slave-a/);

  agentResponse = await sendLocalAgentRequest(page, {
    type: "agent-unregister",
    agentId: "slave-a"
  });
  assert.equal(agentResponse.ok, true);

  const token = `ai-chat-shell-e2e-${Date.now()}`;
  const helperId = `shell-${Date.now()}`;
  const command = `printf ${token}`;
  await page.evaluate(`(() => {
    const composer = document.getElementById("composer");
    composer.focus();
    composer.click();
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("command").value = ${JSON.stringify(command)};
    appendAssistantToolCall([
      ${JSON.stringify(`ai-helper-shell-start:${helperId}`)},
      ${JSON.stringify(command)},
      "ai-helper-shell-end"
    ].join("\\n"), "text");
    return true;
  })()`);

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

  if (SCREENSHOT_DIR) {
    await saveScreenshot(page, path.join(SCREENSHOT_DIR, "shell-helper-result.png"));
  }

  const fileToken = `ai-chat-shell-file-e2e-${Date.now()}`;
  const filename = `${fileToken}.txt`;
  const fileContent = `file helper wrote ${fileToken}`;
  cleanup.push(() => {
    fs.rmSync(path.join(os.homedir(), "Downloads", filename), { force: true });
  });

  await page.evaluate(`(() => {
    const composer = document.getElementById("composer");
    composer.focus();
    composer.click();
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    appendAssistantToolCall([
      "ai-helper-file-start",
      ${JSON.stringify(filename)},
      ${JSON.stringify(fileContent)},
      "ai-helper-file-end"
    ].join("\\n"), "text");
    return true;
  })()`);

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
  assert.equal(fs.readFileSync(path.join(os.homedir(), "Downloads", filename), "utf8"), fileContent);

  if (SCREENSHOT_DIR) {
    await saveScreenshot(page, path.join(SCREENSHOT_DIR, "file-helper-result.png"));
  }
}

function findChrome() {
  const envPath = process.env.CHROME_BIN || process.env.GOOGLE_CHROME_BIN;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }
  const playwrightChromium = findPlaywrightChromium();
  if (playwrightChromium) {
    return playwrightChromium;
  }
  for (const command of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    const result = spawnSync("which", [command], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  }
  for (const appPath of [
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ]) {
    if (fs.existsSync(appPath)) {
      return appPath;
    }
  }
  return "";
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
  const child = spawn(process.execPath, args, {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ...extraEnv
    },
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

async function waitForEvaluate(page, expression, label) {
  await waitFor(async () => Boolean(await page.evaluate(expression)), label);
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
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${message.error.message || "CDP error"} (${message.error.code || "unknown"})`));
      } else {
        pending.resolve(message.result || {});
      }
    });
    ws.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
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
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return result.result?.value;
  }

  close() {
    this.ws.close();
  }
}
