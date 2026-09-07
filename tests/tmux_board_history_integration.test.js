#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-history-"));
const socketPath = path.join(tmpDir, "tmux.sock");
process.env.AI_CHAT_SHELL_TMUX_SOCKET = socketPath;
process.env.AI_CHAT_SHELL_STATE_DIR = path.join(tmpDir, "state");
process.env.AI_CHAT_SHELL_BOARD_PROBE_IDLE_MS = "100";
process.env.AI_CHAT_SHELL_BOARD_PROMPT_IDLE_MS = "50";
process.env.AI_CHAT_SHELL_BOARD_POLL_MS = "50";
const { listTmuxPanes, runTmuxBoard } = require("../server/shell_server.js");

main().then(() => console.log("tmux board history integration tests passed")).catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  spawnSync("tmux", ["-S", socketPath, "kill-server"]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function main() {
  tmux(["-f", "/dev/null", "new-session", "-d", "-s", "history", "-x", "160", "-y", "24"]);
  tmux(["set-option", "-g", "history-limit", "30000"]);
  for (const [name, lineCount, threshold] of [["medium", 2000, 80000], ["large", 18000, 1000000]]) {
    const historyPath = path.join(tmpDir, `${name}.txt`);
    fs.writeFileSync(historyPath, "old-log-data-without-prompt ".padEnd(95, ".").concat("\n").repeat(lineCount));
    const paneId = tmux(["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "history", "-n", name,
      `cat ${quote(historyPath)}; exec env PS1='CURRENT_BOARD> ' /bin/sh -i`]).trim();
    await waitForPrompt(paneId);
    const history = tmux(["capture-pane", "-p", "-J", "-S", "-20000", "-t", paneId]);
    assert.ok(history.length > threshold, `${name} fixture must exceed the old ${threshold}-character prefix limit`);
    assert.match(history.trimEnd(), /CURRENT_BOARD>$/);
    console.log(`${name}: ${history.length} captured characters; current prompt is beyond ${threshold}`);
    const pane = (await listTmuxPanes()).find((entry) => entry.id === paneId);
    const marker = path.join(tmpDir, `${name}.executed`);
    const result = await runTmuxBoard({
      cmd: `printf 'executed\\n' >> ${quote(marker)}; printf 'fresh-board-output\\n'`,
      pane, timeoutMs: 10000, maxOutputChars: 20000
    });
    assert.equal(result.executed, true, JSON.stringify(result));
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.match(result.stdout, /fresh-board-output/);
    assert.match(result.stdout, /CURRENT_BOARD>/);
    assert.doesNotMatch(result.stdout, /old-log-data/);
    assert.equal(fs.readFileSync(marker, "utf8"), "executed\n");

    const limited = await runTmuxBoard({
      cmd: "printf 'a-new-result-longer-than-the-requested-budget\\n'",
      pane, timeoutMs: 10000, maxOutputChars: 16
    });
    assert.equal(limited.executed, true, JSON.stringify(limited));
    assert.equal(limited.exitCode, 0, JSON.stringify(limited));
    assert.equal(limited.stdout.length, 16);
    assert.equal(limited.truncated, true, "Result limits must not truncate prompt detection");
    tmux(["kill-pane", "-t", paneId]);
  }
}

function tmux(args) {
  const result = spawnSync("tmux", ["-S", socketPath, ...args], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function quote(value) { return `'${value.replace(/'/g, "'\\''")}'`; }

async function waitForPrompt(paneId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (tmux(["capture-pane", "-p", "-J", "-S", "0", "-t", paneId]).trimEnd().endsWith("CURRENT_BOARD>")) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Fixture did not reach the board prompt");
}
