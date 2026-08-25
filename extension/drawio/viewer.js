(() => {
  "use strict";

  const RENDER_TIMEOUT_MS = 5500;
  const channel = new URLSearchParams(location.hash.replace(/^#/, "")).get("channel") || "";
  const viewer = document.getElementById("viewer");
  let renderStarted = false;
  let renderSettled = false;

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
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (renderSettled) {
        clearInterval(timer);
        return;
      }
      const svg = container.querySelector("svg");
      if (svg) {
        clearInterval(timer);
        renderSettled = true;
        svg.setAttribute("role", "img");
        svg.setAttribute("aria-label", metadata.title);
        post("ai-chat-drawio-rendered", {
          artifactId,
          title: metadata.title,
          pageCount: metadata.pageCount
        });
        return;
      }
      if (Date.now() - startedAt >= RENDER_TIMEOUT_MS) {
        clearInterval(timer);
        fail("The draw.io viewer did not produce an SVG before the render timeout.", artifactId);
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
    if (!message || message.channel !== channel || message.type !== "ai-chat-drawio-render") {
      return;
    }
    render(message);
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
