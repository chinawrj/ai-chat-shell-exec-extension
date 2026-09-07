(() => {
  "use strict";

  const RENDER_OUTPUT_TIMEOUT_MS = 15000;
  const embeddedChannel = typeof document.querySelector === "function"
    ? document.querySelector('meta[name="ai-chat-drawio-channel"]')?.getAttribute("content") || ""
    : "";
  const channel = embeddedChannel || new URLSearchParams(location.hash.replace(/^#/, "")).get("channel") || "";
  const viewer = document.getElementById("viewer");
  let renderStarted = false;
  let renderSettled = false;
  let renderedArtifactId = "";
  let graphViewer = null;
  let pageRevision = 0;
  let exporting = false;
  let cspLabelStylesInstalled = false;

  function installCspLabelStyles() {
    if (!embeddedChannel || cspLabelStylesInstalled) return;
    const canvasPrototype = globalThis.mxSvgCanvas2D?.prototype;
    const textPrototype = globalThis.mxText?.prototype;
    if (typeof canvasPrototype?.setCssText !== "function" || typeof textPrototype?.updateBoundingBox !== "function") return;
    cspLabelStylesInstalled = true;
    const setCssText = canvasPrototype.setCssText;
    canvasPrototype.setCssText = function(node, text) {
      // The nonce-authorized viewer may use CSSOM under a strict host CSP.
      // setAttribute('style') instead blocks Draw.io's own label layout and
      // makes its measured content bounds expand to the iframe width.
      if (node?.ownerDocument === document && node.style) node.style.cssText = String(text || "");
      else return setCssText.apply(this, arguments);
    };
    const updateBoundingBox = textPrototype.updateBoundingBox;
    textPrototype.updateBoundingBox = function() {
      // Include sanitized rich-label markup before the synchronous measurement;
      // an observer would run too late and leave the initial bounds incorrect.
      const node = this.node;
      if (node?.ownerDocument === document) {
        for (const element of [node, ...Array.from(node.querySelectorAll?.("[style]") || [])]) {
          const text = element.getAttribute?.("style");
          if (text && element.style) element.style.cssText = text;
        }
      }
      return updateBoundingBox.apply(this, arguments);
    };
  }

  function validatePngDimensions(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 ||
        width > 8192 || height > 8192 || width * height > 16 * 1024 * 1024) {
      throw new Error("PNG content bounds must be non-empty, at most 8192 pixels per side and 16 megapixels. Export a smaller diagram.");
    }
  }

  function currentPageInfo() {
    const pageIndex = Number(graphViewer?.currentPage || 0);
    return { pageIndex, pageRevision, title: String(graphViewer?.diagrams?.[pageIndex]?.getAttribute("name") || `Page ${pageIndex + 1}`) };
  }

  function installPageSelector(instance) {
    graphViewer = instance;
    if (instance.diagrams?.length < 2) return;
    const bar = document.createElement("div");
    bar.className = "page-selector";
    bar.textContent = "Page ";
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Draw.io page");
    Array.from(instance.diagrams).forEach((diagram, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `${index + 1}. ${diagram.getAttribute("name") || `Page ${index + 1}`}`;
      select.appendChild(option);
    });
    select.value = String(instance.currentPage);
    function choosePage(index, event) {
      if (!event.isTrusted || !Number.isInteger(index) || index < 0 || index >= instance.diagrams.length) return;
      try { instance.selectPage(index); }
      catch (error) { post("ai-chat-drawio-page-error", { artifactId: renderedArtifactId, error: compactError(error) }); }
    }
    select.addEventListener("change", (event) => choosePage(Number(select.value), event));
    const previous = document.createElement("button");
    const next = document.createElement("button");
    previous.textContent = "‹";
    next.textContent = "›";
    previous.setAttribute("aria-label", "Previous page");
    next.setAttribute("aria-label", "Next page");
    previous.title = "Previous page";
    next.title = "Next page";
    previous.addEventListener("click", (event) => choosePage(instance.currentPage - 1, event));
    next.addEventListener("click", (event) => choosePage(instance.currentPage + 1, event));
    function updatePageButtons() {
      previous.disabled = instance.currentPage <= 0;
      next.disabled = instance.currentPage >= instance.diagrams.length - 1;
    }
    updatePageButtons();
    instance.addListener("graphChanged", () => {
      pageRevision += 1;
      select.value = String(instance.currentPage);
      updatePageButtons();
      post("ai-chat-drawio-page-changed", { artifactId: renderedArtifactId, ...currentPageInfo() });
    });
    bar.appendChild(select);
    bar.appendChild(previous);
    bar.appendChild(next);
    viewer.before(bar);
  }

  async function exportPng(message) {
    if (!renderedArtifactId || message.artifactId !== renderedArtifactId ||
        typeof message.requestId !== "string" || message.requestId.length > 256 || !message.requestId || exporting) return;
    const identity = { artifactId: renderedArtifactId, requestId: message.requestId, ...currentPageInfo() };
    exporting = true;
    let image = null;
    let timer = 0;
    let canvas = null;
    const deadline = Date.now() + 12000;
    try {
      const graph = graphViewer?.graph;
      if (!graph?.getSvg) throw new Error("The diagram is not ready for PNG export.");
      const bounds = graph.getGraphBounds();
      validatePngDimensions(Math.ceil(bounds.width / graph.view.scale), Math.ceil(bounds.height / graph.view.scale));
      // Draw.io crops all diagram content at its natural scale, independently of
      // preview zoom, page paper size, toolbar, and the origin of its shapes.
      const svg = graph.getSvg("#ffffff", 1, 0);
      const width = Number(String(svg.getAttribute("width")).replace(/px$/, ""));
      const height = Number(String(svg.getAttribute("height")).replace(/px$/, ""));
      validatePngDimensions(width, height);
      const serialized = new XMLSerializer().serializeToString(svg);
      if (new TextEncoder().encode(serialized).byteLength > 8 * 1024 * 1024) throw new Error("The SVG exceeds the 8 MiB PNG export limit.");
      image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("The browser could not rasterize this diagram. Check its embedded images and fonts."));
        timer = setTimeout(() => reject(new Error("PNG rasterization timed out. Try a smaller diagram.")), 12000);
        // A data URL keeps foreignObject labels rasterizable without an external
        // resource request or a same-origin privilege in the sandbox.
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;
      });
      if (identity.pageRevision !== pageRevision) throw new Error("The selected page changed. Export the current page again.");
      canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("The browser could not allocate a PNG canvas.");
      context.drawImage(image, 0, 0);
      clearTimeout(timer);
      const blob = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("PNG encoding timed out. Try a smaller diagram.")), Math.max(1, deadline - Date.now()));
        canvas.toBlob(resolve, "image/png");
      });
      if (!blob || blob.type !== "image/png" || !blob.size || blob.size > 32 * 1024 * 1024) throw new Error("PNG encoding failed or exceeded the 32 MiB limit.");
      if (identity.pageRevision !== pageRevision) throw new Error("The selected page changed. Export the current page again.");
      post("ai-chat-drawio-exported-png", { ...identity, blob, width, height });
    } catch (error) {
      post("ai-chat-drawio-export-error", { ...identity, error: compactError(error) });
    } finally {
      clearTimeout(timer);
      if (image) { image.onload = null; image.onerror = null; image.src = ""; }
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      exporting = false;
    }
  }

  function post(type, fields = {}) {
    parent.postMessage({ type, channel, ...fields }, "*");
  }

  function compactError(error) {
    const text = String(error?.message || error || "unknown draw.io renderer error")
      .replace(/\s+/g, " ")
      .trim();
    return text.length <= 600 ? text : `${text.slice(0, 599)}…`;
  }

  function fail(error, artifactId = "") {
    if (renderSettled) {
      return;
    }
    renderSettled = true;
    const message = compactError(error);
    const errorNode = document.createElement("div");
    errorNode.className = "render-error";
    errorNode.textContent = `Draw.io render failed\n${message}`;
    viewer.replaceChildren(errorNode);
    console.error("[AI Chat Draw.io Viewer] render failed", { artifactId, error: message });
    post("ai-chat-drawio-render-error", { artifactId, error: message });
  }

  function validateMessageXml(xml) {
    const text = String(xml || "");
    const parsed = new DOMParser().parseFromString(text, "application/xml");
    if (parsed.querySelector("parsererror")) {
      throw new Error("The isolated viewer received malformed XML.");
    }
    if (parsed.documentElement?.localName !== "mxfile") {
      throw new Error("The isolated viewer requires an <mxfile> root.");
    }
    const diagrams = Array.from(parsed.getElementsByTagName("diagram"));
    if (diagrams.length === 0) {
      throw new Error("The isolated viewer requires at least one <diagram> page.");
    }
    return {
      title: String(diagrams[0].getAttribute("name") || "Draw.io preview"),
      pageCount: diagrams.length
    };
  }

  function waitForRenderedSvg(container, artifactId, metadata) {
    let visibleElapsedMs = 0;
    let visibleStartedAt = document.hidden ? 0 : Date.now();
    let timer = 0;
    let observer = null;
    function activeVisibleElapsedMs() {
      return visibleElapsedMs + (visibleStartedAt > 0 ? Date.now() - visibleStartedAt : 0);
    }
    function onVisibilityChange() {
      if (document.hidden) {
        if (visibleStartedAt > 0) {
          visibleElapsedMs += Date.now() - visibleStartedAt;
          visibleStartedAt = 0;
        }
      } else if (visibleStartedAt === 0) {
        visibleStartedAt = Date.now();
      }
    }
    function cleanupTimer() {
      clearInterval(timer);
      observer?.disconnect();
      observer = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    function settleRenderedSvg() {
      if (renderSettled) {
        cleanupTimer();
        return true;
      }
      const svg = container.querySelector("svg");
      if (!svg) {
        return false;
      }
      cleanupTimer();
      renderSettled = true;
      renderedArtifactId = artifactId;
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", metadata.title);
      post("ai-chat-drawio-rendered", {
        artifactId,
        title: metadata.title,
        pageCount: metadata.pageCount
      });
      return true;
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    if (settleRenderedSvg()) {
      return;
    }
    observer = new MutationObserver(() => {
      settleRenderedSvg();
    });
    observer.observe(container, { childList: true, subtree: true });
    timer = setInterval(() => {
      if (settleRenderedSvg()) {
        return;
      }
      if (activeVisibleElapsedMs() >= RENDER_OUTPUT_TIMEOUT_MS) {
        cleanupTimer();
        const rendererDetail = String(container.textContent || "").replace(/\s+/g, " ").trim();
        fail(
          rendererDetail
            ? `The draw.io viewer did not produce an SVG before the render timeout. Renderer detail: ${rendererDetail}`
            : "The draw.io viewer did not produce an SVG before the render timeout.",
          artifactId
        );
      }
    }, 50);
  }

  function render(message) {
    if (renderStarted) {
      return;
    }
    renderStarted = true;
    const artifactId = String(message?.artifactId || "");
    try {
      const xml = String(message?.xml || "");
      const metadata = validateMessageXml(xml);
      if (!globalThis.GraphViewer?.processElements) {
        throw new Error("The packaged draw.io GraphViewer did not load.");
      }
      const container = document.createElement("div");
      container.className = "mxgraph";
      container.setAttribute("data-mxgraph", JSON.stringify({
        highlight: "#4057d6",
        nav: false,
        resize: true,
        toolbar: "zoom layers",
        toolbarPosition: "bottom",
        lightbox: false,
        editable: false,
        tooltips: false,
        target: "blank",
        xml
      }));
      viewer.replaceChildren(container);
      // Acknowledge the exact validated render request before entering the
      // packaged renderer's synchronous layout work. On complex host pages
      // that work can run longer than the parent's acceptance handshake even
      // though the isolated viewer is healthy; delaying this acknowledgement
      // causes the parent to replace the iframe mid-render and can strand the
      // final retry in staging forever.
      post("ai-chat-drawio-render-started", { artifactId });
      installCspLabelStyles();
      const originalInitialized = globalThis.GraphViewer.viewerInitialized;
      globalThis.GraphViewer.viewerInitialized = function(instance) {
        originalInitialized?.apply(this, arguments);
        installPageSelector(instance);
      };
      globalThis.GraphViewer.processElements();
      waitForRenderedSvg(container, artifactId, metadata);
    } catch (error) {
      fail(error, artifactId);
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== parent) {
      return;
    }
    const message = event.data;
    if (!message || message.channel !== channel) {
      return;
    }
    if (message.type === "ai-chat-drawio-render") render(message);
    else if (message.type === "ai-chat-drawio-export-png") void exportPng(message);
  });

  window.addEventListener("error", (event) => {
    if (renderStarted && !renderSettled) {
      fail(event.error || event.message || "Unhandled draw.io viewer error.");
    }
  });

  window.addEventListener("unhandledrejection", (event) => {
    if (renderStarted && !renderSettled) {
      fail(event.reason || "Unhandled draw.io viewer promise rejection.");
    }
  });

  document.addEventListener("click", (event) => {
    if (event.target?.closest?.("a")) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);

  post("ai-chat-drawio-viewer-ready");
})();
