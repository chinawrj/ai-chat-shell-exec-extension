"use strict";

class CdpPipeClient {
  constructor(writer, reader, processHandle, options = {}) {
    if (!writer || typeof writer.write !== "function" || !reader || typeof reader.on !== "function") {
      throw new Error("CDP pipe requires writable fd 3 and readable fd 4 streams.");
    }
    this.writer = writer;
    this.reader = reader;
    this.processHandle = processHandle || null;
    this.timeoutMs = Math.max(1, Number(options.timeoutMs || 45_000));
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.closed = false;

    this.onData = (chunk) => this.acceptChunk(chunk);
    this.onReaderError = (error) => this.failAll(error || new Error("CDP pipe read failed"));
    this.onReaderClose = () => this.failAll(new Error("CDP pipe closed"));
    this.onProcessExit = (code, signal) => this.failAll(new Error(
      `Chrome exited while CDP pipe requests were pending (code=${code ?? "none"}, signal=${signal || "none"})`
    ));
    reader.on("data", this.onData);
    reader.on("error", this.onReaderError);
    reader.on("close", this.onReaderClose);
    processHandle?.on?.("exit", this.onProcessExit);
  }

  static fromProcess(processHandle, options = {}) {
    return new CdpPipeClient(
      processHandle?.stdio?.[3],
      processHandle?.stdio?.[4],
      processHandle,
      options
    );
  }

  send(method, params = {}) {
    if (this.closed) {
      return Promise.reject(new Error("CDP pipe is closed"));
    }
    const id = this.nextId;
    this.nextId += 1;
    const payload = Buffer.from(`${JSON.stringify({ id, method, params })}\0`, "utf8");
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, this.timeoutMs);
      timeout.unref?.();
      this.pending.set(id, { resolve, reject, timeout });
      this.writer.write(payload, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(error);
      });
    });
  }

  acceptChunk(chunk) {
    if (this.closed) {
      return;
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, bytes]) : bytes;
    let delimiter = this.buffer.indexOf(0);
    while (delimiter >= 0) {
      const frame = this.buffer.subarray(0, delimiter);
      this.buffer = this.buffer.subarray(delimiter + 1);
      if (frame.length > 0) {
        let message;
        try {
          message = JSON.parse(frame.toString("utf8"));
        } catch (error) {
          this.failAll(new Error(`Invalid CDP pipe frame: ${error.message}`));
          return;
        }
        this.acceptMessage(message);
      }
      delimiter = this.buffer.indexOf(0);
    }
  }

  acceptMessage(message) {
    if (!message?.id) {
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
  }

  failAll(error) {
    if (this.closed && this.pending.size === 0) {
      return;
    }
    this.closed = true;
    const failure = error instanceof Error ? error : new Error(String(error || "CDP pipe closed"));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(failure);
    }
    this.pending.clear();
  }
}

module.exports = { CdpPipeClient };
