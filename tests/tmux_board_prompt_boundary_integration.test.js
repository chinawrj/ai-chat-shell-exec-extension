#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-prompt-boundary-"));
const socketPath = path.join(tmpDir, "tmux.sock");
const serverPath = path.join(__dirname, "..", "server", "shell_server.js");
const context = {
  Buffer, clearTimeout, console, module: { exports: {} }, exports: {}, require, setTimeout,
  process: { ...process, env: { ...process.env, AI_CHAT_SHELL_STATE_DIR: path.join(tmpDir, "state"), AI_CHAT_SHELL_TMUX_SOCKET: socketPath } },
  __dirname: path.dirname(serverPath), __filename: serverPath
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(serverPath, "utf8"), context, { filename: serverPath });

main().then(() => console.log("tmux board prompt boundary integration tests passed")).catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
}).finally(() => {
  spawnSync("tmux", ["-S", socketPath, "kill-server"]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function main() {
  tmux(["-f", "/dev/null", "new-session", "-d", "-s", "boundary", "-x", "40", "-y", "3", "exec /bin/cat"]);
  for (const [name, content, expected, historyExpected] of [
    ["initial", "BOARD>", "BOARD>", false],
    ["wrapped", "x".repeat(1000) + ">", "", true],
    ["wrapped_then_prompt", "x".repeat(1000) + "\nBOARD>", "BOARD>", true],
    ["clear_screen", "old complete row\n".repeat(30) + "\x1b[2J\x1b[HBOARD>", "BOARD>", true]
  ]) {
    const file = path.join(tmpDir, `${name}.txt`);
    fs.writeFileSync(file, content);
    const paneId = tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "boundary", "-n", name,
      `cat ${quote(file)}; exec /bin/cat`]).trim();
    await waitForTail(paneId, ">");
    const historySize = Number(tmux(["display-message", "-p", "-t", paneId, "#{history_size}"]).trim());
    assert.equal(historySize > 0, historyExpected, `${name} must have the intended history boundary`);
    const screen = tmux(["capture-pane", "-p", "-J", "-S", "0", "-t", paneId]);
    if (name === "wrapped") {
      assert.ok(screen.trim().length < 200, "The visible suffix must fit the prompt budget despite the original line exceeding it.");
      assert.ok(!screen.trim().includes("\n"), "The clipped prompt-like suffix must be the first logical screen line.");
    }
    const pane = (await context.listTmuxPanes()).find((entry) => entry.id === paneId);
    assert.ok(pane);
    assert.equal(await context.readStableBoardPrompt(pane, { probeIdleMs: 100 }), expected, name);
    tmux(["kill-pane", "-t", paneId]);
  }
}

function tmux(args) {
  const result = spawnSync("tmux", ["-S", socketPath, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function quote(value) { return `'${value.replace(/'/g, "'\\''")}'`; }

async function waitForTail(paneId, tail) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (tmux(["capture-pane", "-p", "-J", "-S", "0", "-t", paneId]).trimEnd().endsWith(tail)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Fixture did not render its final screen text");
}
