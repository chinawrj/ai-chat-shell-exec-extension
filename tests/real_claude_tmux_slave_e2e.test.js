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
const TEST_PAGE_URL = process.env.AI_CHAT_SHELL_REAL_CLAUDE_TEST_URL || "https://localhost:17443/tmux-test-page.html";
const EXTENSION_STATUS_ID = "ai-chat-shell-exec-status";
const EXPECTED_SERVER_PROTOCOL = 4;
const DEFAULT_TIMEOUT_MS = Number(process.env.AI_CHAT_SHELL_REAL_CLAUDE_TIMEOUT_MS || 240000);
const ENABLED = process.env.AI_CHAT_SHELL_REAL_CLAUDE_E2E === "1";
const AUTO_APPROVE = process.env.AI_CHAT_SHELL_REAL_CLAUDE_AUTO_APPROVE !== "0";

const cleanup = [];

main()
  .then(() => {
    console.log(ENABLED ? "real Claude tmux slave e2e test passed" : "real Claude tmux slave e2e test skipped");
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
        // Best-effort cleanup for browser, server, and temp profile state.
      }
    }
  });

async function main() {
  if (!ENABLED) {
    console.log("Set AI_CHAT_SHELL_REAL_CLAUDE_E2E=1 to run the real Claude tmux slave e2e test.");
    return;
  }

  assert.ok(fs.existsSync(EXTENSION_DIR), `Missing extension directory: ${EXTENSION_DIR}`);
  assert.ok(commandExists("tmux"), "Real Claude e2e requires tmux on PATH.");
  assert.ok(commandExists("claude"), "Real Claude e2e requires claude on PATH.");
  const chromePath = findChrome();
  assert.ok(chromePath, "Real Claude e2e requires Chrome or Chromium.");

  const tmuxTarget = process.env.AI_CHAT_SHELL_REAL_CLAUDE_TARGET || findClaudeTmuxPane();
  assert.ok(tmuxTarget, "Could not find a tmux pane running Claude. Set AI_CHAT_SHELL_REAL_CLAUDE_TARGET, for example %1 or session:window.pane.");

  await ensureShellServerReady();
  await ensureTestPageReady();

  const browserEnv = await setupBrowserEnvironment(chromePath);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-chat-shell-real-claude-e2e-"));
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
  captureProcessOutput(chrome, "chrome-real-claude");
  cleanup.push(() => stopProcess(chrome));

  const debugPort = await waitForChromeDebugPort(profileDir);
  const pageWsUrl = await waitForChromePageWebSocket(debugPort, "about:blank");
  const page = await CdpClient.connect(pageWsUrl);
  cleanup.push(() => page.close());

  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Page.navigate", { url: TEST_PAGE_URL });
  await waitForEvaluate(page, "document.readyState === 'complete'", "test page load");
  try {
    await waitForEvaluate(page, `document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)})`, "extension panel");
  } catch (error) {
    throw new Error(`${error.message}\n\n${await collectDiagnostics(page, debugPort, { chrome, chromePath })}`);
  }
  await page.evaluate("new Promise((resolve) => setTimeout(resolve, 4500))");

  const suffix = `${process.pid}-${Date.now()}`;
  const masterId = `master-real-claude-${suffix}`.slice(0, 64);
  const slaveId = `slave-real-claude-${suffix}`.slice(0, 64);
  const token = `REAL_CLAUDE_TMUX_E2E_${Date.now()}`;
  const taskId = `task-${token}`;

  await registerMasterFromPanel(page, masterId);
  await registerTmuxAiSlaveFromPanel(page, slaveId, tmuxTarget);

  const approval = AUTO_APPROVE ? startClaudePermissionApprover(tmuxTarget) : null;
  try {
    const send = await sendLocalAgentRequest(page, {
      type: "agent-send",
      from: masterId,
      to: slaveId,
      taskId,
      messageId: `msg-${token}`,
      body: [
        "This is the ultimate E2E test for web master and real tmux Claude slave collaboration.",
        `Write exactly this token and a newline to the reply body file: ${token}`,
        "Then run the provided short reply command/script exactly once.",
        "Do not include extra text in the reply body file."
      ].join("\n")
    });
    assert.equal(send.ok, true, JSON.stringify(send));

    const text = await waitForValue(async () => {
      return page.evaluate(`(() => {
        const text = document.body.innerText || "";
        return text.includes(${JSON.stringify(`Message from ${slaveId} for task ${taskId}:`)}) &&
          text.includes(${JSON.stringify(token)}) ? text : "";
      })()`);
    }, "web master page received real Claude tmux reply", DEFAULT_TIMEOUT_MS);

    assert.ok(text.includes(token));
    console.log(JSON.stringify({
      ok: true,
      token,
      masterId,
      slaveId,
      tmuxTarget,
      receivedInWebMasterPage: true
    }, null, 2));
  } finally {
    approval?.stop();
  }
}

async function registerMasterFromPanel(page, masterId) {
  await page.evaluate(`(() => {
    const composer = document.getElementById("composer");
    composer.focus();
    composer.click();
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    panel.querySelector("[data-shell-agent-role]").value = "master";
    panel.querySelector("[data-shell-agent-id]").value = ${JSON.stringify(masterId)};
    panel.querySelector('[data-shell-tool-action="agent-register"]').click();
    return true;
  })()`);
  await waitForEvaluate(page, `document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)}).innerText.includes(${JSON.stringify(`Registered master ${masterId}`)})`, "master registration");
}

async function registerTmuxAiSlaveFromPanel(page, slaveId, tmuxTarget) {
  await page.evaluate(`(() => {
    const panel = document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)});
    panel.querySelector("[data-shell-tmux-ai-id]").value = ${JSON.stringify(slaveId)};
    const target = panel.querySelector("[data-shell-tmux-ai-target]");
    const option = document.createElement("option");
    option.value = ${JSON.stringify(tmuxTarget)};
    option.textContent = ${JSON.stringify(`${tmuxTarget} Claude`)};
    target.appendChild(option);
    target.value = option.value;
    panel.querySelector('[data-shell-tool-action="tmux-ai-register"]').click();
    return true;
  })()`);
  await waitForEvaluate(page, `document.getElementById(${JSON.stringify(EXTENSION_STATUS_ID)}).innerText.includes(${JSON.stringify(`Registered tmux-ai slave ${slaveId}`)})`, "tmux-ai registration");
}

function startClaudePermissionApprover(tmuxTarget) {
  let stopped = false;
  let approving = false;
  const timer = setInterval(() => {
    if (stopped || approving) {
      return;
    }
    approving = true;
    Promise.resolve()
      .then(() => captureTmuxPane(tmuxTarget))
      .then((text) => {
        if (
          /Do you want to proceed\?/i.test(text) &&
          (
            /agent-replies/i.test(text) && /Yes, and always allow access/i.test(text) ||
            /Run provided reply script/i.test(text) && /Yes, and don.t ask again for: sh \*/i.test(text)
          )
        ) {
          runTmux(["send-keys", "-t", tmuxTarget, "2", "Enter"]);
        }
      })
      .catch(() => {})
      .finally(() => {
        approving = false;
      });
  }, 1000);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}

async function ensureShellServerReady() {
  const health = await getShellServerHealth().catch(() => null);
  if (health?.ok) {
    const protocol = health.serverProtocolVersion ?? health.protocolVersion;
    assert.equal(protocol, EXPECTED_SERVER_PROTOCOL, `Existing shell server protocol is ${protocol}; restart from this checkout.`);
    return;
  }

  const server = spawnNode(["server/shell_server.js"], {});
  cleanup.push(() => stopProcess(server));
  await waitFor(async () => {
    const response = await getShellServerHealth().catch(() => null);
    return response?.ok && (response.serverProtocolVersion ?? response.protocolVersion) === EXPECTED_SERVER_PROTOCOL;
  }, "shell server to start", 15000);
}

async function ensureTestPageReady() {
  const existingPage = await fetchHttpsText(TEST_PAGE_URL).catch(() => "");
  if (existingPage.includes("tmux ai-helper test")) {
    return;
  }
  const pageServer = spawnNode(["scripts/start_tmux_test_page_https.js"], { TEST_PAGE_PORT: "17443" });
  cleanup.push(() => stopProcess(pageServer));
  await waitFor(async () => {
    const text = await fetchHttpsText(TEST_PAGE_URL).catch(() => "");
    return text.includes("tmux ai-helper test");
  }, "tmux HTTPS test page to start", 15000);
}

function findClaudeTmuxPane() {
  const result = spawnSync("tmux", [
    "list-panes",
    "-a",
    "-F",
    "#{pane_id}\t#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}\t#{pane_current_command}\t#{pane_current_path}"
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    return "";
  }
  const panes = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, session, windowIndex, windowName, paneIndex, command] = line.split("\t");
      return { id, session, windowIndex, windowName, paneIndex, command };
    });
  const matches = panes.filter((pane) =>
    /claude/i.test(`${pane.command || ""} ${pane.windowName || ""}`)
  );
  return matches[0]?.id || "";
}

function runTmux(args) {
  const result = spawnSync("tmux", args, {
    cwd: ROOT_DIR,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`tmux ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout || "";
}

function captureTmuxPane(target) {
  return runTmux(["capture-pane", "-p", "-J", "-S", "-120", "-t", target]);
}

async function sendLocalAgentRequest(page, payload) {
  const requestId = `agent-real-claude-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const result = await page.evaluate(`new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("Timed out waiting for local agent response"));
    }, 15000);
    function onMessage(event) {
      if (event.source !== window) return;
      const data = event.data || {};
      if (data.type !== "ai-chat-shell-exec:agent-response" || data.requestId !== ${JSON.stringify(requestId)}) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(data.response);
    }
    window.addEventListener("message", onMessage);
    window.postMessage({
      type: "ai-chat-shell-exec:agent-request",
      requestId: ${JSON.stringify(requestId)},
      payload: ${JSON.stringify(payload)}
    }, "*");
  })`);
  return result;
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
  const candidates = [
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser"
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes("/") && fs.existsSync(candidate)) {
      return candidate;
    }
    if (!candidate.includes("/") && commandExists(candidate)) {
      return candidate;
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

async function setupBrowserEnvironment(chromePath) {
  const headless = process.env.AI_SHELL_E2E_HEADLESS === "1" || !process.env.DISPLAY && process.platform !== "darwin";
  return {
    headless,
    env: {
      ...process.env,
      CHROME_BIN: chromePath
    }
  };
}

function commandExists(command) {
  return spawnSync("which", [command], { encoding: "utf8" }).status === 0;
}

function spawnNode(args, extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT_DIR,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
  captureProcessOutput(child, args.join(" "));
  return child;
}

function captureProcessOutput(child, label) {
  child.stdoutText = "";
  child.stderrText = "";
  child.stdout?.on("data", (chunk) => {
    child.stdoutText += chunk.toString();
    if (process.env.AI_SHELL_E2E_VERBOSE === "1") {
      process.stdout.write(`[${label}] ${chunk}`);
    }
  });
  child.stderr?.on("data", (chunk) => {
    child.stderrText += chunk.toString();
    if (process.env.AI_SHELL_E2E_VERBOSE === "1") {
      process.stderr.write(`[${label}] ${chunk}`);
    }
  });
}

function stopProcess(child) {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 2000).unref();
  });
}

async function getShellServerHealth() {
  return fetchJson("http://127.0.0.1:17371/health");
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}

function fetchHttpsText(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { rejectUnauthorized: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve(body));
    });
    request.on("error", reject);
    request.setTimeout(5000, () => {
      request.destroy(new Error("HTTPS request timed out"));
    });
  });
}

async function waitForChromeDebugPort(profileDir) {
  const activePortPath = path.join(profileDir, "DevToolsActivePort");
  return waitForValue(async () => {
    if (!fs.existsSync(activePortPath)) {
      return "";
    }
    return fs.readFileSync(activePortPath, "utf8").split(/\r?\n/)[0].trim();
  }, "Chrome DevTools port", 15000);
}

async function waitForChromePageWebSocket(debugPort, url) {
  return waitForValue(async () => {
    const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`).catch(() => []);
    const target = targets.find((item) => item.type === "page" && item.url === url) ||
      targets.find((item) => item.type === "page");
    return target?.webSocketDebuggerUrl || "";
  }, `Chrome page target ${url}`, 15000);
}

async function collectDiagnostics(page, debugPort, details) {
  const bodyText = await page.evaluate("(document.body && document.body.innerText || '').slice(0, 6000)").catch((error) => `body unavailable: ${error.message}`);
  const targets = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`).catch((error) => [{ error: error.message }]);
  const targetUrls = Array.isArray(targets) ? targets.map((target) => `${target.type || "?"} ${target.url || target.error || ""}`).join("\n") : String(targets);
  return [
    "Real Claude tmux slave e2e diagnostics:",
    `chromePath: ${details.chromePath}`,
    `testPageUrl: ${TEST_PAGE_URL}`,
    `chrome targets:\n${targetUrls || "(empty)"}`,
    `chrome stdout:\n${details.chrome.stdoutText || "(empty)"}`,
    `chrome stderr:\n${details.chrome.stderrText || "(empty)"}`,
    `page text:\n${bodyText || "(empty)"}`
  ].join("\n\n");
}

async function waitForEvaluate(page, expression, label, timeoutMs = 45000) {
  await waitFor(() => page.evaluate(expression), label, timeoutMs);
}

async function waitFor(check, label, timeoutMs = 45000) {
  await waitForValue(async () => await check() ? true : "", label, timeoutMs);
}

async function waitForValue(check, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
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

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.socket.addEventListener("message", (event) => {
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
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("CDP websocket closed"));
      }
      this.pending.clear();
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(new CdpClient(socket)));
      socket.addEventListener("error", () => reject(new Error(`Could not connect to ${url}`)));
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
    this.socket.close();
  }
}
