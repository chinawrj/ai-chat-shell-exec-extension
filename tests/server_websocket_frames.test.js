#!/usr/bin/env node

const assert = require("node:assert/strict");
const { decodeTextFrames, encodeTextFrame } = require("../server/shell_server.js");

function maskedClientFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  let header;

  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(payload.length, 6);
  }

  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) {
    masked[i] ^= mask[i % 4];
  }

  return Buffer.concat([header, mask, masked]);
}

function decodeIncrementally(frame, chunkSizes) {
  let pending = Buffer.alloc(0);
  const messages = [];
  let offset = 0;

  for (const size of chunkSizes) {
    const next = frame.subarray(offset, offset + size);
    offset += next.length;
    const decoded = decodeTextFrames(Buffer.concat([pending, next]));
    pending = decoded.remaining;
    messages.push(...decoded.messages);
  }

  if (offset < frame.length) {
    const decoded = decodeTextFrames(Buffer.concat([pending, frame.subarray(offset)]));
    pending = decoded.remaining;
    messages.push(...decoded.messages);
  }

  return { messages, pending };
}

{
  const frame = maskedClientFrame("hello");
  const { messages, pending } = decodeIncrementally(frame, [1, 1, 2, 1, 1]);
  assert.deepEqual(messages, ["hello"]);
  assert.equal(pending.length, 0);
}

{
  const first = maskedClientFrame("one");
  const second = maskedClientFrame("two");
  const decoded = decodeTextFrames(Buffer.concat([first, second]));
  assert.deepEqual(decoded.messages, ["one", "two"]);
  assert.equal(decoded.remaining.length, 0);
}

{
  const text = "x".repeat(400);
  const frame = maskedClientFrame(text);
  const { messages, pending } = decodeIncrementally(frame, [2, 1, 3, 17, 128]);
  assert.deepEqual(messages, [text]);
  assert.equal(pending.length, 0);
}

{
  const frame = maskedClientFrame("partial");
  const decoded = decodeTextFrames(frame.subarray(0, frame.length - 2));
  assert.deepEqual(decoded.messages, []);
  assert.equal(decoded.remaining.length, frame.length - 2);
}

{
  const frame = encodeTextFrame("server response");
  const decoded = decodeTextFrames(frame);
  assert.deepEqual(decoded.messages, ["server response"]);
  assert.equal(decoded.remaining.length, 0);
}

console.log("server websocket frame tests passed");
