#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const serverPath = path.join(__dirname, "..", "server", "shell_server.js");
const source = fs.readFileSync(serverPath, "utf8");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "board-prompt-snapshot-"));
const pane = { id: "%7", currentCommand: "board-app" };
const timing = { probeIdleMs: 100 };

main().then(() => {
  console.log("tmux board prompt snapshot tests passed");
}).catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function main() {
  // Old output can exceed either the public output budget or the subprocess
  // budget. Only the current screen is readiness evidence in either case.
  for (const historyLength of [80001, 1000001]) {
    const fixture = loadFixture({ history: "x".repeat(historyLength), screens: ["recent output\nBOARD> \n\n"] });
    assert.equal(await fixture.context.readStableBoardPrompt(pane, timing), "BOARD>");
    assert.equal(fixture.captures.length, 2, "Readiness needs two independent snapshots.");
    assert.equal(fixture.revalidations(), 1, "The pane must be revalidated between snapshots.");
    assert.equal(fixture.sleeps(), 1, "The snapshots must be separated by the idle interval.");
    assert.ok(fixture.captures.every(({ start }) => start >= -1), "Prompt inspection may read only one historical boundary row.");
  }

  const wrapped = loadFixture({ history: "x".repeat(1000), screens: ["x".repeat(80) + ">"], wrapsFromHistory: true });
  assert.equal(await wrapped.context.readStableBoardPrompt(pane, timing), "", "The short visible suffix of an overlong wrapped line is not a complete prompt.");
  const wrappedThenPrompt = loadFixture({ history: "x".repeat(1000), screens: ["continued old output\nBOARD>"], wrapsFromHistory: true });
  assert.equal(await wrappedThenPrompt.context.readStableBoardPrompt(pane, timing), "BOARD>", "A fresh complete prompt after a clipped first logical line remains usable.");
  const topRow = loadFixture({ screens: ["BOARD>\n\n"] });
  assert.equal(await topRow.context.readStableBoardPrompt(pane, timing), "BOARD>", "A new pane's first screen row is complete when there is no history.");
  const clearedScreen = loadFixture({ history: "old complete line\n", screens: ["BOARD>\n\n"] });
  assert.equal(await clearedScreen.context.readStableBoardPrompt(pane, timing), "BOARD>", "A top-row prompt after a clear screen must survive an independent historical row.");
  const boundaryPromptOnly = loadFixture({ history: "OLD>\n", screens: ["\n\n"] });
  assert.equal(await boundaryPromptOnly.context.readStableBoardPrompt(pane, timing), "", "A prompt in the boundary history row cannot make an empty screen ready.");
  const changedHistory = loadFixture({ history: ["old boundary one\n", "new boundary two\n"], screens: ["BOARD>"] });
  assert.equal(await changedHistory.context.readStableBoardPrompt(pane, timing), "BOARD>", "Discarded boundary history is not part of current-screen stability.");
  for (const rawCaptureOutput of ["BOARD>", "\nBOARD>", "-1\nBOARD>", "not-a-number\nBOARD>", "9007199254740992\nBOARD>"]) {
    const fixture = loadFixture({ screens: ["BOARD>"], rawCaptureOutput });
    assert.equal(await fixture.context.readStableBoardPrompt(pane, timing), "", "Missing, negative, nonnumeric, and unsafe history metadata must fail closed.");
  }

  const oldPrompt = loadFixture({ history: `${"x".repeat(79993)}\nOLD>\n`, screens: ["still producing output"] });
  assert.equal(await oldPrompt.context.readStableBoardPrompt(pane, timing), "", "A historical prompt at an output-budget boundary must never grant readiness.");

  for (const screen of ["", "\n\n", "not a prompt", `${"p".repeat(200)}>`, `${"x".repeat(80000)}\nBOARD>`]) {
    const fixture = loadFixture({ screens: [screen] });
    assert.equal(await fixture.context.readStableBoardPrompt(pane, timing), "", "Blank, invalid, oversized, or incomplete screen data must fail closed.");
  }
  const longestPrompt = `${"p".repeat(199)}>`;
  const boundary = loadFixture({ screens: [longestPrompt] });
  assert.equal(await boundary.context.readStableBoardPrompt(pane, timing), longestPrompt, "A complete 200-character prompt remains valid.");

  for (const truncatedIndex of [0, 1]) {
    const fixture = loadFixture({ screens: ["OLD>", "OLD>"], truncatedIndex });
    assert.equal(await fixture.context.readStableBoardPrompt(pane, timing), "", "An explicitly truncated capture must not turn its prefix into a prompt.");
  }

  const changingOutput = loadFixture({ screens: ["progress 1\nBOARD>", "progress 2\nBOARD>"] });
  assert.equal(await changingOutput.context.readStableBoardPrompt(pane, timing), "", "Matching last-line prompts do not make a changing screen stable.");
  const changingPrompt = loadFixture({ screens: ["BOARD>", "OTHER>"] });
  assert.equal(await changingPrompt.context.readStableBoardPrompt(pane, timing), "");

  for (const readiness of [[false], [true, false]]) {
    const fixture = loadFixture({ screens: ["BOARD>"], readiness, currentPane: { ...pane, currentCommand: "sh" } });
    assert.equal(await fixture.context.readStableBoardPrompt({ ...pane, currentCommand: "sh" }, timing), "", "A shell's foreground-process readiness still overrides prompt text.");
    assert.equal(fixture.captures.length, readiness.length - 1, "Busy shells must stop before the next snapshot.");
  }
  const becameShell = loadFixture({ screens: ["BOARD>"], currentPane: { ...pane, currentCommand: "sh" }, readiness: [false] });
  assert.equal(await becameShell.context.readStableBoardPrompt(pane, timing), "", "A pane that becomes a shell must acquire fresh shell readiness proof.");

  const replacedPane = loadFixture({ screens: ["BOARD>"], verificationError: new Error("pane instance changed") });
  await assert.rejects(replacedPane.context.readStableBoardPrompt(pane, timing), /pane instance changed/);
  assert.equal(replacedPane.captures.length, 1, "An invalidated pane cannot supply the second observation.");

  for (const captureError of [new Error("capture failed"), { ok: false, exitCode: 1, stderr: "capture failed", stdout: "OLD>" }]) {
    const fixture = loadFixture({ screens: ["BOARD>"], captureError });
    await assert.rejects(fixture.context.readStableBoardPrompt(pane, timing), /capture failed/);
  }
}

function loadFixture({ history = "", screens, wrapsFromHistory = false, truncatedIndex = -1, readiness = [true], currentPane = pane, verificationError, captureError, rawCaptureOutput }) {
  const context = {
    Buffer, clearTimeout, console, module: { exports: {} }, exports: {}, require, setTimeout,
    process: { ...process, env: { ...process.env, AI_CHAT_SHELL_STATE_DIR: stateDir } },
    __dirname: path.dirname(serverPath), __filename: serverPath
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: serverPath });
  const captures = [];
  let revalidationCount = 0;
  let sleepCount = 0;
  let readinessCount = 0;
  context.runTmuxCommandRaw = async (args, options) => {
    const captureIndex = args.indexOf("capture-pane");
    assert.ok(captureIndex >= 0, "A read-only prompt probe must capture the pane.");
    const captureArgs = args.slice(captureIndex);
    assert.equal(captureArgs[captureArgs.indexOf("-t") + 1], pane.id);
    const start = captureArgs.includes("-S") ? Number(captureArgs[captureArgs.indexOf("-S") + 1]) : 0;
    const index = captures.length;
    captures.push({ start });
    if (captureError instanceof Error) throw captureError;
    if (captureError) return captureError;
    const screen = screens[Math.min(index, screens.length - 1)];
    const currentHistory = Array.isArray(history) ? history[Math.min(index, history.length - 1)] : history;
    const boundary = currentHistory ? `${currentHistory.trimEnd().slice(-40)}${wrapsFromHistory ? "" : "\n"}` : "";
    const prefix = start < -1 ? currentHistory : start === -1 ? boundary : "";
    const metadata = args.includes("#{history_size}") ? `${currentHistory ? 100 : 0}\n` : "";
    const output = rawCaptureOutput === undefined ? `${metadata}${prefix}${screen}` : rawCaptureOutput;
    const limit = options?.maxOutputChars || 1000000;
    return { ok: true, exitCode: 0, stdout: output.slice(0, limit), stderr: "", stdoutTruncated: index === truncatedIndex || output.length > limit };
  };
  context.runTmuxCommand = async (...args) => {
    const result = await context.runTmuxCommandRaw(...args);
    if (!result.ok) throw new Error(result.stderr || "capture failed");
    return result;
  };
  context.sleep = async (ms) => {
    assert.equal(ms, timing.probeIdleMs);
    sleepCount += 1;
  };
  context.getTmuxSocketPath = () => "/test/private-tmux.sock";
  context.isTmuxPaneReadyForHelper = async () => readiness[Math.min(readinessCount++, readiness.length - 1)];
  context.verifyTmuxShellPaneBeforeDispatch = async (observed) => {
    assert.equal(observed.id, pane.id);
    revalidationCount += 1;
    if (verificationError) throw verificationError;
    return currentPane;
  };
  return { context, captures, revalidations: () => revalidationCount, sleeps: () => sleepCount };
}
