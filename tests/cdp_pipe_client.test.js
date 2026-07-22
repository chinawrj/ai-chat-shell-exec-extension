#!/usr/bin/env node

"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { CdpPipeClient } = require("./helpers/cdp_pipe_client");

function createHarness() {
  const writer = new PassThrough();
  const reader = new PassThrough();
  const processHandle = new EventEmitter();
  processHandle.stdio = [null, null, null, writer, reader];
  let outbound = Buffer.alloc(0);
  writer.on("data", (chunk) => {
    outbound = Buffer.concat([outbound, chunk]);
  });
  const client = CdpPipeClient.fromProcess(processHandle, { timeoutMs: 1000 });
  return {
    client,
    processHandle,
    reader,
    takeRequests() {
      const frames = outbound.toString("utf8").split("\0").filter(Boolean).map(JSON.parse);
      outbound = Buffer.alloc(0);
      return frames;
    }
  };
}

async function nextTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function verifySplitAndMultipleFrames() {
  const harness = createHarness();
  const first = harness.client.send("Extensions.loadUnpacked", { path: "/tmp/extension" });
  const second = harness.client.send("Browser.getVersion");
  await nextTurn();
  const requests = harness.takeRequests();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => request.method), [
    "Extensions.loadUnpacked",
    "Browser.getVersion"
  ]);

  const responses = [
    JSON.stringify({ id: requests[0].id, result: { id: "extension-id" } }),
    JSON.stringify({ method: "Target.targetCreated", params: {} }),
    JSON.stringify({ id: requests[1].id, result: { product: "Chrome/150" } })
  ].join("\0") + "\0";
  harness.reader.write(responses.slice(0, 17));
  harness.reader.write(responses.slice(17));
  assert.deepEqual(await first, { id: "extension-id" });
  assert.deepEqual(await second, { product: "Chrome/150" });
}

async function verifyCdpErrorRejectsOnlyItsRequest() {
  const harness = createHarness();
  const pending = harness.client.send("Extensions.loadUnpacked", { path: "/bad" });
  await nextTurn();
  const [request] = harness.takeRequests();
  harness.reader.write(`${JSON.stringify({
    id: request.id,
    error: { code: -32000, message: "Unsafe operations are not allowed" }
  })}\0`);
  await assert.rejects(pending, /Unsafe operations are not allowed \(-32000\)/);
}

async function verifyChromeExitRejectsPendingRequest() {
  const harness = createHarness();
  const pending = harness.client.send("Extensions.loadUnpacked", { path: "/tmp/extension" });
  await nextTurn();
  harness.processHandle.emit("exit", 1, null);
  await assert.rejects(pending, /Chrome exited while CDP pipe requests were pending/);
}

Promise.resolve()
  .then(verifySplitAndMultipleFrames)
  .then(verifyCdpErrorRejectsOnlyItsRequest)
  .then(verifyChromeExitRejectsPendingRequest)
  .then(() => console.log("CDP pipe client tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
