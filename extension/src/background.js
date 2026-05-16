const SHELL_SERVER_URL = "ws://127.0.0.1:17371/shell";
const SHELL_SERVER_HEALTH_URL = "http://127.0.0.1:17371/health";
const DEFAULT_SETTINGS = {
  enabled: true,
  requireApproval: false,
  autoSend: true,
  defaultTimeoutMs: 30000,
  maxOutputChars: 20000,
  maxChainCalls: 5
};

chrome.runtime.onInstalled.addListener(() => {
  ensureDefaultSettings();
});

chrome.runtime.onStartup.addListener(() => {
  ensureDefaultSettings();
});

ensureDefaultSettings();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === "shell-health") {
    checkShellServerHealth()
      .then(sendResponse)
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || String(error)
      }));
    return true;
  }

  if (message.type !== "run-shell") {
    return false;
  }

  chrome.storage.sync.get(
    ["defaultTimeoutMs", "maxOutputChars"],
    (settings) => {
      const payload = {
        type: "run",
        id: message.id,
        cmd: message.cmd,
        cwd: message.cwd,
        timeoutMs: message.timeoutMs || settings.defaultTimeoutMs || 30000,
        maxOutputChars: message.maxOutputChars || settings.maxOutputChars || 20000
      };

      runShellViaWebSocket(payload)
        .then(sendResponse)
        .catch((error) => sendResponse({
          ok: false,
          error: error.message || String(error)
        }));
    }
  );

  return true;
});

async function checkShellServerHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(SHELL_SERVER_HEALTH_URL, {
      cache: "no-store",
      signal: controller.signal
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }

    return {
      ok: response.ok && body?.ok === true,
      status: response.status,
      url: SHELL_SERVER_HEALTH_URL,
      ...body
    };
  } finally {
    clearTimeout(timer);
  }
}

function ensureDefaultSettings() {
  chrome.storage.sync.get(Object.keys(DEFAULT_SETTINGS), (current) => {
    const missing = {};
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (current[key] === undefined) {
        missing[key] = value;
      }
    }

    if (Object.keys(missing).length > 0) {
      chrome.storage.sync.set(missing);
    }
  });
}

function runShellViaWebSocket(payload) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(SHELL_SERVER_URL);
    const timeout = setTimeout(() => {
      finish(reject, new Error("Shell server timed out."));
      tryClose(socket);
    }, Math.max(5000, Number(payload.timeoutMs || 30000) + 5000));

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(payload));
    });

    socket.addEventListener("message", (event) => {
      try {
        finish(resolve, JSON.parse(event.data));
      } catch (error) {
        finish(reject, error);
      } finally {
        clearTimeout(timeout);
        tryClose(socket);
      }
    });

    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      finish(reject, new Error("Cannot connect to shell server at ws://127.0.0.1:17371/shell."));
    });

    socket.addEventListener("close", () => {
      clearTimeout(timeout);
      if (!settled) {
        finish(reject, new Error("Shell server closed the connection before returning a response."));
      }
    });

    function finish(callback, value) {
      if (settled) {
        return;
      }
      settled = true;
      callback(value);
    }
  });
}

function tryClose(socket) {
  try {
    socket.close();
  } catch {
    // Ignore close races.
  }
}
