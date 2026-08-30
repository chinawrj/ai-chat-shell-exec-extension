(() => {
  "use strict";

  const DRAWIO_PREVIEW_HOST_ID = "ai-chat-shell-exec-drawio-preview";
  const DRAWIO_XML_MAX_BYTES = 1024 * 1024;
  const DRAWIO_VIEWER_STARTUP_TIMEOUT_MS = 7000;
  const DRAWIO_RENDER_ACCEPT_TIMEOUT_MS = 7000;
  const DRAWIO_VIEWER_STARTUP_ATTEMPTS = 2;
  const DRAWIO_INVALID_LOG_KEYS_LIMIT = 64;

  let previewHost = null;
  let previewShadow = null;
  let previewElements = null;
  let currentArtifact = null;
  let pendingArtifactId = "";
  let renderGeneration = 0;
  let renderCount = 0;
  let renderErrorCount = 0;
  let activeStage = null;
  let errorLog = [];
  let invalidLogKeys = new Set();
  let failedRenderResults = new Map();
  let maximized = false;
  let restoreWindowStyle = null;

  function validateDrawioXml(xml) {
    const text = String(xml || "");
    const byteLength = utf8ByteLength(text);
    if (!text) {
      return { ok: false, error: "Draw.io XML payload is empty.", byteLength };
    }
    if (byteLength > DRAWIO_XML_MAX_BYTES) {
      return {
        ok: false,
        error: `Draw.io XML payload is ${byteLength} bytes; the limit is ${DRAWIO_XML_MAX_BYTES} bytes.`,
        byteLength
      };
    }
    if (typeof DOMParser !== "function") {
      return { ok: false, error: "DOMParser is unavailable for draw.io XML validation.", byteLength };
    }

    let documentNode;
    try {
      documentNode = new DOMParser().parseFromString(text, "application/xml");
    } catch (error) {
      return {
        ok: false,
        error: `Draw.io XML parser failed: ${safeErrorMessage(error)}`,
        byteLength
      };
    }
    const parserError = documentNode.querySelector?.("parsererror");
    if (parserError) {
      return {
        ok: false,
        error: `Draw.io XML is malformed: ${compactText(parserError.textContent || "parse error", 240)}`,
        byteLength
      };
    }
    if (documentNode.documentElement?.localName !== "mxfile") {
      return {
        ok: false,
        error: "Draw.io XML root must be <mxfile>.",
        byteLength
      };
    }
    const diagrams = Array.from(documentNode.getElementsByTagName?.("diagram") || []);
    if (diagrams.length === 0) {
      return {
        ok: false,
        error: "Draw.io XML must contain at least one <diagram> page.",
        byteLength
      };
    }
    return {
      ok: true,
      byteLength,
      pageCount: diagrams.length,
      title: String(diagrams[0]?.getAttribute?.("name") || "Draw.io preview")
    };
  }

  function isLikelyCompleteDrawioXml(xml) {
    const text = String(xml || "").trim();
    if (!/^<\?xml\b[^>]*>\s*/i.test(text) && !/^<mxfile(?:\s|>)/i.test(text)) {
      return false;
    }
    const withoutDeclaration = text.replace(/^<\?xml\b[^>]*>\s*/i, "");
    return /^<mxfile(?:\s|>)/i.test(withoutDeclaration) && (
      /<\/mxfile>\s*$/i.test(withoutDeclaration) ||
      /^<mxfile\b[^>]*\/\s*>$/is.test(withoutDeclaration)
    );
  }

  function hashDrawioXml(xml) {
    const text = String(xml || "");
    let hashA = 2166136261;
    let hashB = 2246822519;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      hashA ^= code;
      hashA = Math.imul(hashA, 16777619);
      hashB ^= code + index;
      hashB = Math.imul(hashB, 3266489917);
    }
    return `${(hashA >>> 0).toString(16).padStart(8, "0")}${(hashB >>> 0).toString(16).padStart(8, "0")}`;
  }

  function consider(candidate) {
    const xml = String(candidate?.xml || "");
    const validation = candidate?.validation?.ok === true
      ? candidate.validation
      : validateDrawioXml(xml);
    const artifactId = String(candidate?.artifactId || hashDrawioXml(xml));
    const candidateKey = String(candidate?.candidateKey || artifactId);
    if (!validation.ok) {
      const result = reportInvalid({
        key: candidate?.candidateKey || `${artifactId}:${validation.error}`,
        artifactId,
        error: validation.error
      });
      return Promise.resolve(result);
    }
    if (pendingArtifactId === artifactId) {
      updateHostDiagnostics();
      return Promise.resolve({ ok: true, unchanged: true, artifactId });
    }
    if (currentArtifact?.artifactId === artifactId) {
      if (cancelSupersededStage(artifactId, "superseded by the latest already-rendered helper")) {
        renderGeneration += 1;
        pendingArtifactId = "";
        ensurePreview();
        previewHost.hidden = false;
        clearErrorLog();
        setPreviewState("ready");
        setPreviewStatus("SVG ready. Only the latest complete helper is displayed.");
      }
      updateHostDiagnostics();
      return Promise.resolve({ ok: true, unchanged: true, artifactId });
    }
    if (failedRenderResults.has(candidateKey)) {
      const cached = failedRenderResults.get(candidateKey);
      const outcomeAlreadyVisible = !activeStage && !currentArtifact && pendingArtifactId === "" &&
        previewHost?.dataset?.state === "error" && errorLog.at(-1)?.artifactId === artifactId;
      if (!outcomeAlreadyVisible) {
        cancelSupersededStage(artifactId, "superseded by the latest cached renderer failure");
        renderGeneration += 1;
        pendingArtifactId = "";
        ensurePreview();
        previewHost.hidden = false;
        clearCurrentArtifact("No render is available for the latest helper.");
        replaceErrorLog(cached.error, artifactId, { count: false, console: false });
        setPreviewState("error");
        setPreviewStatus("The latest helper failed to render. Open the error log for details.");
      }
      updateHostDiagnostics();
      return Promise.resolve({
        ...cached,
        unchanged: true,
        newError: false
      });
    }

    renderGeneration += 1;
    const generation = renderGeneration;
    pendingArtifactId = artifactId;
    ensurePreview();
    previewHost.hidden = false;
    clearErrorLog();
    setPreviewState("staging");
    setPreviewStatus(currentArtifact
      ? "Rendering the latest valid helper in staging; the current SVG remains visible."
      : "Rendering the latest valid draw.io helper…");

    cancelSupersededStage(artifactId, "superseded by a newer valid helper");
    activeStage = createRenderStage({
      generation,
      artifactId,
      xml,
      title: validation.title,
      byteLength: validation.byteLength,
      pageCount: validation.pageCount,
      candidateKey
    });
    return activeStage.promise;
  }

  function cancelSupersededStage(nextArtifactId, reason) {
    if (!activeStage || activeStage.artifactId === String(nextArtifactId || "")) {
      return false;
    }
    activeStage.cancel(reason, { log: false });
    activeStage = null;
    return true;
  }

  function createRenderStage(artifact) {
    let settled = false;
    let resolvePromise;
    let layer = null;
    let iframe = null;
    let channel = "";
    let renderRequested = false;
    let renderAccepted = false;
    const promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    function cleanup() {
      attemptPolicy.cancel();
      window.removeEventListener("message", onMessage, true);
      iframe?.removeEventListener("error", onFrameError);
      iframe?.removeEventListener("load", onFrameLoad);
    }

    function cancel(reason, options = {}) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      layer?.remove();
      if (pendingArtifactId === artifact.artifactId) {
        pendingArtifactId = "";
      }
      if (options.log === true) {
        replaceErrorLog(`Draw.io staging cancelled: ${reason}`, artifact.artifactId);
      }
      resolvePromise({ ok: false, cancelled: true, error: reason, artifactId: artifact.artifactId });
    }

    function fail(message) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      layer?.remove();
      if (pendingArtifactId === artifact.artifactId) {
        pendingArtifactId = "";
      }
      if (activeStage?.artifactId === artifact.artifactId) {
        activeStage = null;
      }
      const result = {
        ok: false,
        renderError: true,
        newError: true,
        error: `Draw.io render failed: ${compactText(message, 500)}`,
        artifactId: artifact.artifactId
      };
      rememberFailedRenderResult(artifact.candidateKey, result);
      clearCurrentArtifact("No render is available for the latest helper.");
      replaceErrorLog(result.error, artifact.artifactId);
      setPreviewState("error");
      setPreviewStatus("The latest helper failed to render. Open the error log for details.");
      resolvePromise(result);
    }

    function mountViewerAttempt() {
      if (settled) {
        return;
      }
      iframe?.removeEventListener("error", onFrameError);
      iframe?.removeEventListener("load", onFrameLoad);
      layer?.remove();

      const startupAttempt = attemptPolicy.beginAttempt();
      renderRequested = false;
      renderAccepted = false;
      channel = buildChannelToken(artifact.artifactId, `${artifact.generation}-${startupAttempt}`);
      layer = document.createElement("div");
      layer.className = "drawio-frame-layer drawio-frame-staging";
      layer.dataset.artifactId = artifact.artifactId;
      layer.dataset.startupAttempt = String(startupAttempt);
      iframe = document.createElement("iframe");
      iframe.title = `Rendering ${artifact.title || "draw.io preview"}`;
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.setAttribute("aria-hidden", "true");
      iframe.addEventListener("error", onFrameError);
      iframe.addEventListener("load", onFrameLoad);
      iframe.src = `${chrome.runtime.getURL("drawio/viewer.html")}#channel=${encodeURIComponent(channel)}`;
      layer.appendChild(iframe);
      previewElements.viewport.appendChild(layer);
      updateHostDiagnostics();
    }

    function requestRender() {
      if (settled || renderRequested || !iframe?.contentWindow) {
        return;
      }
      renderRequested = true;
      iframe.contentWindow.postMessage({
        type: "ai-chat-drawio-render",
        channel,
        artifactId: artifact.artifactId,
        xml: artifact.xml
      }, "*");
      attemptPolicy.awaitAcceptance();
    }

    function succeed(message) {
      if (settled) {
        return;
      }
      if (artifact.generation !== renderGeneration || pendingArtifactId !== artifact.artifactId) {
        cancel("stale renderer completion", { log: false });
        return;
      }
      settled = true;
      cleanup();
      const oldLayer = previewElements.viewport.querySelector(".drawio-frame-current");
      layer.classList.remove("drawio-frame-staging");
      layer.classList.add("drawio-frame-current");
      iframe.removeAttribute("aria-hidden");
      oldLayer?.remove();
      previewElements.empty.hidden = true;
      currentArtifact = {
        artifactId: artifact.artifactId,
        xml: artifact.xml,
        title: String(message?.title || artifact.title || "Draw.io preview"),
        byteLength: artifact.byteLength,
        pageCount: Number(message?.pageCount || artifact.pageCount || 1),
        candidateKey: artifact.candidateKey
      };
      pendingArtifactId = "";
      renderCount += 1;
      activeStage = null;
      previewElements.title.textContent = currentArtifact.title;
      previewElements.meta.textContent = `${currentArtifact.pageCount} page${currentArtifact.pageCount === 1 ? "" : "s"} · ${currentArtifact.byteLength.toLocaleString()} bytes · ${currentArtifact.artifactId.slice(0, 12)}`;
      previewElements.download.disabled = false;
      clearErrorLog();
      setPreviewState("ready");
      setPreviewStatus("SVG ready. Only the latest complete helper is displayed.");
      updateHostDiagnostics();
      resolvePromise({ ok: true, rendered: true, artifactId: artifact.artifactId });
    }

    function onFrameError() {
      attemptPolicy.failOrRetry("startup", "The isolated draw.io viewer iframe could not be loaded.");
    }

    function onFrameLoad() {
      // A load event is a safe fallback if the one-shot viewer-ready message was
      // lost during a fast cached iframe startup. viewer.js installs its message
      // listener before the document load event and ignores duplicate renders.
      requestRender();
    }

    function onMessage(event) {
      const message = event.data;
      const action = classifyDrawioViewerMessage({
        source: event.source,
        expectedSource: iframe.contentWindow,
        message,
        channel,
        artifactId: artifact.artifactId,
        renderRequested,
        renderAccepted
      });
      if (action === "ready") {
        requestRender();
        return;
      }
      if (action === "started") {
        renderAccepted = true;
        attemptPolicy.accept();
        setPreviewStatus("The isolated draw.io viewer accepted the helper and is rendering it locally…");
        return;
      }
      if (action === "rendered") {
        succeed(message);
        return;
      }
      if (action === "error") {
        fail(message.error || "The draw.io viewer returned an unknown render error.");
      }
    }

    const attemptPolicy = createRenderAttemptWatchdog({
      maxAttempts: DRAWIO_VIEWER_STARTUP_ATTEMPTS,
      startupTimeoutMs: DRAWIO_VIEWER_STARTUP_TIMEOUT_MS,
      acceptTimeoutMs: DRAWIO_RENDER_ACCEPT_TIMEOUT_MS,
      createWatchdog: createVisibleTimeWatchdog,
      onRetry({ phase, nextAttempt }) {
        setPreviewStatus(phase === "startup"
          ? `The draw.io viewer did not start in time; retrying locally (${nextAttempt}/${DRAWIO_VIEWER_STARTUP_ATTEMPTS})…`
          : `The draw.io viewer did not accept the render request; retrying locally (${nextAttempt}/${DRAWIO_VIEWER_STARTUP_ATTEMPTS})…`);
        mountViewerAttempt();
      },
      onFailure: fail
    });

    // Register the parent listener before the iframe is navigated or inserted.
    window.addEventListener("message", onMessage, true);
    mountViewerAttempt();
    return {
      artifactId: artifact.artifactId,
      generation: artifact.generation,
      get layer() { return layer; },
      promise,
      cancel
    };
  }

  function classifyDrawioViewerMessage(options) {
    const message = options.message;
    if (options.source !== options.expectedSource || !message || message.channel !== options.channel) {
      return "";
    }
    if (message.type === "ai-chat-drawio-viewer-ready") {
      return "ready";
    }
    if (options.renderRequested !== true || String(message.artifactId || "") !== String(options.artifactId || "")) {
      return "";
    }
    if (message.type === "ai-chat-drawio-render-started") {
      return "started";
    }
    if (message.type === "ai-chat-drawio-render-error") {
      return "error";
    }
    if (options.renderAccepted === true && message.type === "ai-chat-drawio-rendered") {
      return "rendered";
    }
    return "";
  }

  function createRenderAttemptWatchdog(options) {
    const maxAttempts = Math.max(1, Number(options.maxAttempts || 1));
    let attempt = 0;
    let phase = "idle";
    let watchdog = null;
    let stopped = false;

    function cancelWatchdog() {
      watchdog?.cancel?.();
      watchdog = null;
    }

    function timeoutMessage(timeoutPhase) {
      return timeoutPhase === "startup"
        ? `Draw.io viewer startup timed out after ${options.startupTimeoutMs}ms on ${maxAttempts} attempts.`
        : `Draw.io viewer did not accept the render request after ${options.acceptTimeoutMs}ms on ${maxAttempts} attempts.`;
    }

    function failOrRetry(timeoutPhase, message = timeoutMessage(timeoutPhase)) {
      if (stopped) {
        return false;
      }
      cancelWatchdog();
      if (attempt < maxAttempts) {
        phase = "retrying";
        options.onRetry?.({ phase: timeoutPhase, attempt, nextAttempt: attempt + 1 });
        return true;
      }
      if (timeoutPhase === "accept") {
        phase = "awaiting-accept";
        return false;
      }
      stopped = true;
      phase = "failed";
      options.onFailure?.(message);
      return false;
    }

    function startPhase(timeoutPhase, timeoutMs) {
      if (stopped) {
        return;
      }
      cancelWatchdog();
      phase = timeoutPhase;
      watchdog = options.createWatchdog(timeoutMs, () => failOrRetry(timeoutPhase));
    }

    return {
      beginAttempt() {
        if (stopped) {
          return attempt;
        }
        attempt += 1;
        startPhase("startup", options.startupTimeoutMs);
        return attempt;
      },
      awaitAcceptance() {
        startPhase("accept", options.acceptTimeoutMs);
      },
      accept() {
        if (stopped || (phase !== "accept" && phase !== "awaiting-accept")) {
          return false;
        }
        cancelWatchdog();
        phase = "rendering";
        return true;
      },
      failOrRetry,
      cancel() {
        stopped = true;
        phase = "cancelled";
        cancelWatchdog();
      },
      getState: () => ({ attempt, phase, stopped })
    };
  }

  function createVisibleTimeWatchdog(timeoutMs, onTimeout) {
    const fullBudget = Math.max(1, Number(timeoutMs || 0));
    let remainingMs = fullBudget;
    let visibleStartedAt = 0;
    let timer = 0;
    let stopped = false;

    function pageIsHidden() {
      return document.visibilityState === "hidden" || document.hidden === true;
    }

    function stopTimer() {
      if (!timer) {
        return;
      }
      clearTimeout(timer);
      timer = 0;
      if (visibleStartedAt > 0) {
        remainingMs = Math.max(0, remainingMs - (Date.now() - visibleStartedAt));
        visibleStartedAt = 0;
      }
    }

    function schedule() {
      if (stopped || timer || pageIsHidden()) {
        return;
      }
      if (remainingMs <= 0) {
        stopped = true;
        document.removeEventListener?.("visibilitychange", onVisibilityChange);
        onTimeout();
        return;
      }
      visibleStartedAt = Date.now();
      timer = setTimeout(() => {
        timer = 0;
        remainingMs = Math.max(0, remainingMs - (Date.now() - visibleStartedAt));
        visibleStartedAt = 0;
        schedule();
      }, remainingMs);
    }

    function onVisibilityChange() {
      if (pageIsHidden()) {
        stopTimer();
      } else {
        schedule();
      }
    }

    document.addEventListener?.("visibilitychange", onVisibilityChange);
    schedule();
    return {
      cancel() {
        if (stopped) {
          return;
        }
        stopped = true;
        stopTimer();
        document.removeEventListener?.("visibilitychange", onVisibilityChange);
      }
    };
  }

  function reportInvalid({ key, artifactId, error }) {
    const logKey = String(key || `${artifactId || "invalid"}:${error || "unknown"}`);
    const alreadyReported = invalidLogKeys.has(logKey);
    if (!alreadyReported) {
      invalidLogKeys.add(logKey);
      if (invalidLogKeys.size > DRAWIO_INVALID_LOG_KEYS_LIMIT) {
        invalidLogKeys.delete(invalidLogKeys.values().next().value);
      }
    }
    ensurePreview();
    previewHost.hidden = false;
    renderGeneration += 1;
    pendingArtifactId = "";
    cancelSupersededStage("", "superseded by the latest invalid helper");
    const message = `Draw.io helper rejected: ${compactText(error || "invalid XML", 500)}`;
    clearCurrentArtifact("No render is available for the latest helper.");
    replaceErrorLog(message, artifactId || "invalid", {
      count: !alreadyReported,
      console: !alreadyReported
    });
    setPreviewState("error");
    setPreviewStatus("The latest complete draw.io helper is invalid.");
    return {
      ok: false,
      validationError: true,
      unchanged: alreadyReported,
      newError: !alreadyReported,
      artifactId: String(artifactId || ""),
      error: message
    };
  }

  function rememberFailedRenderResult(key, result) {
    const value = String(key || "");
    if (!value) {
      return;
    }
    failedRenderResults.set(value, { ...result });
    if (failedRenderResults.size > DRAWIO_INVALID_LOG_KEYS_LIMIT) {
      failedRenderResults.delete(failedRenderResults.keys().next().value);
    }
  }

  function clearCurrentArtifact(emptyText) {
    previewElements?.viewport?.querySelector?.(".drawio-frame-current")?.remove();
    currentArtifact = null;
    if (!previewElements) {
      return;
    }
    previewElements.title.textContent = "Draw.io preview";
    previewElements.meta.textContent = "Latest helper has no render";
    previewElements.download.disabled = true;
    previewElements.empty.textContent = String(emptyText || "Waiting for the latest complete draw.io helper.");
    previewElements.empty.hidden = false;
  }

  function clearErrorLog() {
    errorLog = [];
    if (!previewElements) {
      updateHostDiagnostics();
      return;
    }
    previewElements.log.textContent = "";
    previewElements.logDetails.open = false;
    previewElements.logDetails.hidden = true;
    updateHostDiagnostics();
  }

  function replaceErrorLog(message, artifactId, options = {}) {
    if (options.count !== false) {
      renderErrorCount += 1;
    }
    const entry = {
      at: new Date().toISOString(),
      artifactId: String(artifactId || ""),
      message: compactText(message, 800)
    };
    errorLog = [entry];
    ensurePreview();
    previewElements.logDetails.hidden = false;
    previewElements.logDetails.open = true;
    previewElements.log.textContent = `[${entry.at}] ${entry.artifactId ? `${entry.artifactId.slice(0, 12)} ` : ""}${entry.message}`;
    if (options.console !== false) {
      console.error(`[AI Chat Draw.io] ${entry.message}`, {
        artifactId: entry.artifactId,
        renderGeneration
      });
    }
    updateHostDiagnostics(entry.message);
  }

  function ensurePreview() {
    if (previewHost?.isConnected && previewShadow && previewElements) {
      return previewHost;
    }
    previewHost = document.createElement("div");
    previewHost.id = DRAWIO_PREVIEW_HOST_ID;
    previewHost.hidden = true;
    previewHost.dataset.state = "idle";
    previewHost.dataset.renderCount = String(renderCount);
    previewHost.dataset.errorCount = String(renderErrorCount);
    previewShadow = previewHost.attachShadow({ mode: "open" });
    previewShadow.innerHTML = `
      <style>
        :host { all: initial; }
        .window { position: fixed; right: 24px; top: 36px; z-index: 2147483646; display: grid; grid-template-rows: auto minmax(0, 1fr) auto auto; width: min(760px, calc(100vw - 48px)); height: min(590px, calc(100vh - 72px)); min-width: 420px; min-height: 320px; resize: both; overflow: hidden; border: 1px solid rgba(100,116,139,.42); border-radius: 14px; background: #fff; box-shadow: 0 26px 80px rgba(15,23,42,.28), 0 5px 20px rgba(15,23,42,.13); color: #172033; font: 12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
        .window.maximized { left: 8px; right: 8px; top: 8px; bottom: 8px; width: auto; height: auto; min-width: 0; min-height: 0; resize: none; border-radius: 10px; }
        header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 11px 10px 14px; border-bottom: 1px solid #e3e7ee; background: #f8fafc; cursor: move; user-select: none; }
        .heading { min-width: 0; }
        .title { display: block; overflow: hidden; color: #172033; font-size: 13px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
        .meta { display: block; margin-top: 2px; overflow: hidden; color: #6b778d; font: 10px ui-monospace,SFMono-Regular,Menlo,monospace; text-overflow: ellipsis; white-space: nowrap; }
        .actions { display: flex; gap: 4px; flex-shrink: 0; }
        button { border: 1px solid transparent; border-radius: 7px; padding: 5px 7px; background: transparent; color: #334155; cursor: pointer; font: 11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
        button:hover { border-color: #cbd5e1; background: #fff; }
        button:disabled { cursor: default; opacity: .45; }
        .viewport { position: relative; min-height: 0; overflow: hidden; background-color: #fbfcfe; background-image: radial-gradient(#dce2ec .75px, transparent .75px); background-size: 18px 18px; }
        .empty { position: absolute; inset: 0; display: grid; place-items: center; padding: 30px; color: #64748b; text-align: center; }
        .drawio-frame-layer { position: absolute; inset: 0; background: #fff; }
        .drawio-frame-layer iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
        .drawio-frame-staging { inset: 0 auto 0 -200vw; width: 100%; visibility: visible; opacity: 0; pointer-events: none; }
        .drawio-frame-current { visibility: visible; opacity: 1; pointer-events: auto; }
        .status { padding: 8px 12px; border-top: 1px solid #e5e7eb; background: #fff; color: #526078; font-size: 11px; line-height: 1.35; }
        details { border-top: 1px solid #fecaca; background: #fff7f7; color: #7f1d1d; }
        details[hidden] { display: none; }
        summary { padding: 7px 12px; cursor: pointer; font-size: 11px; font-weight: 700; }
        pre { max-height: 112px; margin: 0; overflow: auto; padding: 0 12px 10px; white-space: pre-wrap; word-break: break-word; font: 10px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; }
        :host-context([hidden]) { display: none; }
        @media (max-width: 700px) { .window { left: 8px; right: 8px; top: 8px; width: auto; height: calc(100vh - 16px); min-width: 0; } }
      </style>
      <section class="window" role="dialog" aria-label="Draw.io preview">
        <header data-drawio-drag-handle>
          <div class="heading"><span class="title">Draw.io preview</span><span class="meta">Waiting for a valid helper</span></div>
          <div class="actions"><button type="button" data-action="download" disabled>Download .drawio</button><button type="button" data-action="maximize" title="Maximize preview to the browser viewport" aria-pressed="false">Maximize</button><button type="button" data-action="close">Close</button></div>
        </header>
        <div class="viewport"><div class="empty">Waiting for the last complete and valid draw.io helper.</div></div>
        <div class="status" aria-live="polite">Draw.io preview is idle.</div>
        <details hidden><summary>Draw.io render error log</summary><pre></pre></details>
      </section>
    `;
    previewElements = {
      window: previewShadow.querySelector(".window"),
      title: previewShadow.querySelector(".title"),
      meta: previewShadow.querySelector(".meta"),
      viewport: previewShadow.querySelector(".viewport"),
      empty: previewShadow.querySelector(".empty"),
      status: previewShadow.querySelector(".status"),
      logDetails: previewShadow.querySelector("details"),
      log: previewShadow.querySelector("pre"),
      download: previewShadow.querySelector('[data-action="download"]'),
      maximize: previewShadow.querySelector('[data-action="maximize"]'),
      close: previewShadow.querySelector('[data-action="close"]'),
      dragHandle: previewShadow.querySelector("[data-drawio-drag-handle]")
    };
    previewElements.close.addEventListener("click", close);
    previewElements.download.addEventListener("click", downloadCurrent);
    previewElements.maximize.addEventListener("click", toggleMaximize);
    installDrag(previewElements.window, previewElements.dragHandle);
    document.documentElement.appendChild(previewHost);
    updateHostDiagnostics();
    return previewHost;
  }

  function installDrag(windowNode, handle) {
    let drag = null;
    handle.addEventListener("pointerdown", (event) => {
      if (maximized || event.target?.closest?.("button")) {
        return;
      }
      const rect = windowNode.getBoundingClientRect();
      drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      handle.setPointerCapture?.(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag) {
        return;
      }
      const left = Math.max(8, Math.min(event.clientX - drag.x, innerWidth - windowNode.offsetWidth - 8));
      const top = Math.max(8, Math.min(event.clientY - drag.y, innerHeight - windowNode.offsetHeight - 8));
      windowNode.style.left = `${left}px`;
      windowNode.style.top = `${top}px`;
      windowNode.style.right = "auto";
    });
    const finish = () => {
      drag = null;
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  }

  function setPreviewState(state) {
    ensurePreview();
    previewHost.dataset.state = String(state || "idle");
    updateHostDiagnostics();
  }

  function setPreviewStatus(text) {
    ensurePreview();
    previewElements.status.textContent = String(text || "");
  }

  function updateHostDiagnostics(lastError = "") {
    if (!previewHost) {
      return;
    }
    previewHost.dataset.renderCount = String(renderCount);
    previewHost.dataset.errorCount = String(renderErrorCount);
    previewHost.dataset.currentArtifactId = currentArtifact?.artifactId || "";
    previewHost.dataset.pendingArtifactId = pendingArtifactId;
    previewHost.dataset.currentTitle = currentArtifact?.title || "";
    previewHost.dataset.lastError = String(lastError || errorLog.at(-1)?.message || "");
  }

  function close() {
    if (previewHost) {
      previewHost.hidden = true;
    }
  }

  function toggleMaximize() {
    ensurePreview();
    if (!maximized) {
      restoreWindowStyle = previewElements.window.getAttribute("style");
      previewElements.window.removeAttribute("style");
      previewElements.window.classList.add("maximized");
      maximized = true;
    } else {
      previewElements.window.classList.remove("maximized");
      if (restoreWindowStyle === null) {
        previewElements.window.removeAttribute("style");
      } else {
        previewElements.window.setAttribute("style", restoreWindowStyle);
      }
      restoreWindowStyle = null;
      maximized = false;
    }
    previewElements.maximize.textContent = maximized ? "Restore" : "Maximize";
    previewElements.maximize.title = maximized
      ? "Restore preview window"
      : "Maximize preview to the browser viewport";
    previewElements.maximize.setAttribute("aria-pressed", maximized ? "true" : "false");
    previewHost.dataset.maximized = maximized ? "true" : "false";
  }

  function reopen() {
    if (!currentArtifact && errorLog.length === 0) {
      return false;
    }
    ensurePreview();
    previewHost.hidden = false;
    return true;
  }

  function downloadCurrent() {
    if (!currentArtifact?.xml) {
      return false;
    }
    const url = URL.createObjectURL(new Blob([currentArtifact.xml], { type: "application/xml" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = safeDownloadName(currentArtifact.title);
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  function resetForPage() {
    renderGeneration += 1;
    pendingArtifactId = "";
    activeStage?.cancel("page lifecycle changed", { log: false });
    activeStage = null;
    currentArtifact = null;
    errorLog = [];
    invalidLogKeys = new Set();
    failedRenderResults = new Map();
    maximized = false;
    restoreWindowStyle = null;
    renderCount = 0;
    renderErrorCount = 0;
    previewHost?.remove();
    previewHost = null;
    previewShadow = null;
    previewElements = null;
  }

  function getDiagnostics() {
    return {
      state: previewHost?.dataset?.state || "idle",
      hidden: previewHost?.hidden !== false,
      currentArtifactId: currentArtifact?.artifactId || "",
      currentTitle: currentArtifact?.title || "",
      pendingArtifactId,
      renderGeneration,
      renderCount,
      renderErrorCount,
      maximized,
      errors: errorLog.map((entry) => ({ ...entry }))
    };
  }

  function buildChannelToken(artifactId, generation) {
    const entropy = globalThis.crypto?.getRandomValues
      ? Array.from(globalThis.crypto.getRandomValues(new Uint32Array(2))).join("-")
      : `${Date.now()}-${Math.random()}`;
    return `${artifactId}:${generation}:${entropy}`;
  }

  function utf8ByteLength(text) {
    if (typeof TextEncoder === "function") {
      return new TextEncoder().encode(String(text || "")).byteLength;
    }
    return unescape(encodeURIComponent(String(text || ""))).length;
  }

  function safeDownloadName(title) {
    const base = String(title || "diagram")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "diagram";
    return base.toLowerCase().endsWith(".drawio") ? base : `${base}.drawio`;
  }

  function compactText(text, maxLength) {
    const compact = String(text || "").replace(/\s+/g, " ").trim();
    return compact.length <= maxLength ? compact : `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
  }

  function safeErrorMessage(error) {
    return compactText(error?.message || String(error || "unknown error"), 400);
  }

  globalThis.AiChatDrawioPreview = Object.freeze({
    DRAWIO_PREVIEW_HOST_ID,
    DRAWIO_XML_MAX_BYTES,
    DRAWIO_VIEWER_STARTUP_TIMEOUT_MS,
    DRAWIO_RENDER_ACCEPT_TIMEOUT_MS,
    DRAWIO_VIEWER_STARTUP_ATTEMPTS,
    consider,
    reportInvalid,
    close,
    reopen,
    resetForPage,
    getDiagnostics,
    validateDrawioXml,
    isLikelyCompleteDrawioXml,
    hashDrawioXml,
    createVisibleTimeWatchdog,
    createRenderAttemptWatchdog,
    classifyDrawioViewerMessage
  });
})();
