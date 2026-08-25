#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const previewSource = fs.readFileSync(path.join(ROOT, "extension", "src", "drawio-preview.js"), "utf8");
const viewerSource = fs.readFileSync(path.join(ROOT, "extension", "drawio", "viewer.js"), "utf8");

class MockDOMParser {
  parseFromString(text) {
    const source = String(text || "");
    const rootMatch = source.match(/^\s*(?:<\?xml[^>]*>\s*)?<([A-Za-z0-9:_-]+)/);
    const diagramMatches = Array.from(source.matchAll(/<diagram\b([^>]*)>/g));
    const malformed = !rootMatch || !source.includes(`</${rootMatch[1]}>`);
    return {
      documentElement: { localName: rootMatch?.[1]?.split(":").at(-1) || "" },
      querySelector(selector) {
        return selector === "parsererror" && malformed ? { textContent: "mock XML parse error" } : null;
      },
      getElementsByTagName(name) {
        if (name !== "diagram") return [];
        return diagramMatches.map((match) => ({
          getAttribute(attribute) {
            if (attribute !== "name") return null;
            return /\bname="([^"]*)"/.exec(match[1])?.[1] || null;
          }
        }));
      }
    };
  }
}

const context = {
  Blob,
  DOMParser: MockDOMParser,
  TextEncoder,
  URL,
  clearTimeout,
  console,
  setTimeout
};
vm.createContext(context);
vm.runInContext(previewSource, context, { filename: "drawio-preview.js" });
const preview = context.AiChatDrawioPreview;

const valid = '<mxfile><diagram name="System"><mxGraphModel/></diagram></mxfile>';
assert.deepEqual(
  JSON.parse(JSON.stringify(preview.validateDrawioXml(valid))),
  { ok: true, byteLength: valid.length, pageCount: 1, title: "System" }
);
assert.equal(preview.validateDrawioXml("<svg></svg>").ok, false);
assert.match(preview.validateDrawioXml("<svg></svg>").error, /root must be <mxfile>/);
assert.equal(preview.validateDrawioXml("<mxfile></mxfile>").ok, false);
assert.match(preview.validateDrawioXml("<mxfile>").error, /malformed/);
assert.equal(preview.validateDrawioXml(`<!--${"x".repeat(preview.DRAWIO_XML_MAX_BYTES)}-->`).ok, false);
assert.match(preview.validateDrawioXml(`<!--${"x".repeat(preview.DRAWIO_XML_MAX_BYTES)}-->`).error, /limit/);
assert.equal(preview.isLikelyCompleteDrawioXml(valid), true);
assert.equal(preview.isLikelyCompleteDrawioXml("<mxfile><diagram>"), false);
assert.equal(preview.hashDrawioXml(valid), preview.hashDrawioXml(valid));
assert.notEqual(preview.hashDrawioXml(valid), preview.hashDrawioXml(valid.replace("System", "Other")));

assert.match(previewSource, /drawio-frame-staging/);
assert.match(previewSource, /oldLayer\?\.remove\(\)/, "The old SVG frame is removed only after a fresh renderer succeeds.");
assert.match(previewSource, /previous SVG was kept/i);
assert.match(previewSource, /stale renderer completion/);
assert.match(previewSource, /superseded by a newer valid helper/);
assert.match(previewSource, /console\.error\(`\[AI Chat Draw\.io\]/, "Preview failures must reach browser diagnostics.");
assert.match(previewSource, /sandbox", "allow-scripts"/, "The renderer must run in an isolated sandbox without same-origin access.");
assert.doesNotMatch(previewSource, /innerHTML\s*=\s*(?:candidate|xml|artifact)/i, "Untrusted draw.io XML must not be injected into the host page.");
assert.match(previewSource, /function close\(\)/);
assert.match(previewSource, /function reopen\(\)/);
assert.match(previewSource, /function downloadCurrent\(\)/);

assert.match(viewerSource, /GraphViewer\?\.processElements/);
assert.match(viewerSource, /ai-chat-drawio-render-error/);
assert.match(viewerSource, /did not produce an SVG before the render timeout/);
assert.doesNotMatch(viewerSource, /https?:\/\//, "The runtime viewer must not fetch a remote renderer.");

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "extension", "manifest.json"), "utf8"));
assert.deepEqual(manifest.content_scripts[0].js.slice(0, 2), ["src/drawio-preview.js", "src/content.js"]);
assert.ok(manifest.sandbox.pages.includes("drawio/viewer.html"));
assert.ok(manifest.web_accessible_resources.some((entry) => entry.resources.includes("vendor/drawio/viewer-static.min.js")));
assert.ok(fs.statSync(path.join(ROOT, "extension", "vendor", "drawio", "viewer-static.min.js")).size > 1_000_000);
assert.ok(fs.existsSync(path.join(ROOT, "extension", "vendor", "drawio", "LICENSE")));
const attribution = fs.readFileSync(path.join(ROOT, "extension", "vendor", "drawio", "ATTRIBUTION.md"), "utf8");
assert.match(attribution, /Apache License 2\.0/);
assert.match(attribution, /v31\.1\.5/);
assert.match(attribution, /a318b4c1f82daab96d1b067169704d11ca118275/);
assert.match(attribution, /13f6a01d141f8edd23213242f2472c7a3eb7637c76144bf7917c76858477c251/);
assert.match(attribution, /not affiliated with,\s+endorsed by, or sponsored by/i);
assert.match(attribution, /Atlassian/i);
const thirdPartyNotices = fs.readFileSync(path.join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8");
assert.match(thirdPartyNotices, /draw\.io viewer/i);
assert.match(thirdPartyNotices, /Apache License 2\.0/);
assert.match(thirdPartyNotices, /does not relicense/i);

console.log("drawio preview tests passed");
