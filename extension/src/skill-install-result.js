const loading = document.getElementById("loading");
const result = document.getElementById("result");
const summary = document.getElementById("summary");
const metadata = document.getElementById("metadata");
const stderrSection = document.getElementById("stderr-section");
const stdoutSection = document.getElementById("stdout-section");
const stderrOutput = document.getElementById("stderr");
const stdoutOutput = document.getElementById("stdout");
const emptyOutput = document.getElementById("empty-output");
const copyButton = document.getElementById("copy");
const closeButton = document.getElementById("close");
let copyText = "";

closeButton.addEventListener("click", () => window.close());
copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(copyText);
    copyButton.textContent = "Copied";
  } catch {
    copyButton.textContent = "Copy unavailable";
  }
});

loadResult().catch(() => showUnavailable("The local installer failure detail could not be loaded."));

async function loadResult() {
  const token = decodeURIComponent(String(location.hash || "").replace(/^#/, ""));
  if (!/^[a-f0-9]{32}$/.test(token)) {
    showUnavailable("The local installer failure token is missing or invalid.");
    return;
  }
  history.replaceState(null, "", location.pathname);
  const response = await chrome.runtime.sendMessage({
    type: "skill-install-failure-consume",
    token
  });
  if (response?.ok !== true || !response.detail) {
    showUnavailable(response?.error || "The local installer failure detail is no longer available.");
    return;
  }
  renderResult(response.detail);
}

function renderResult(detail) {
  loading.classList.add("hidden");
  result.classList.remove("hidden");
  const operation = detail.operation === "uninstall" ? "uninstallation" : "installation";
  document.title = `Skill ${operation} result`;
  document.getElementById("title").textContent = `Skill ${operation} failed`;
  document.getElementById("failure-badge").textContent = operation === "uninstallation" ? "Still installed" : "Not installed";
  const skillName = String(detail.skillName || detail.skillId || "Skill");
  const skillId = String(detail.skillId || "");
  summary.textContent = `${skillName}${skillId && skillId !== skillName ? ` (${skillId})` : ""}: ${String(detail.error || "The installer did not complete successfully.")}`;

  const metadataParts = [];
  if (Number.isInteger(detail.exitCode)) metadataParts.push(`Exit code: ${detail.exitCode}`);
  if (detail.signal) metadataParts.push(`Signal: ${String(detail.signal)}`);
  if (Number.isFinite(detail.durationMs)) metadataParts.push(`Duration: ${detail.durationMs} ms`);
  if (Number.isFinite(detail.idleTimeoutSeconds)) metadataParts.push(`Output-idle limit: ${detail.idleTimeoutSeconds} s`);
  if (metadataParts.length > 0) {
    metadata.textContent = metadataParts.join(" · ");
    metadata.classList.remove("hidden");
  }

  const output = detail.installerOutput || {};
  const stderr = String(output.stderr || "");
  const stdout = String(output.stdout || "");
  if (stderr || output.stderrTruncated === true) {
    stderrSection.classList.remove("hidden");
    document.getElementById("stderr-title").textContent = `stderr${output.stderrTruncated === true ? " (showing captured tail)" : ""}`;
    stderrOutput.textContent = stderr || "(output exceeded the capture limit)";
  }
  if (stdout || output.stdoutTruncated === true) {
    stdoutSection.classList.remove("hidden");
    document.getElementById("stdout-title").textContent = `stdout${output.stdoutTruncated === true ? " (showing captured tail)" : ""}`;
    stdoutOutput.textContent = stdout || "(output exceeded the capture limit)";
  }
  if (!stderr && !stdout && output.stderrTruncated !== true && output.stdoutTruncated !== true) {
    emptyOutput.classList.remove("hidden");
  }

  copyText = [summary.textContent, metadata.textContent, stderr ? `stderr:\n${stderr}` : "", stdout ? `stdout:\n${stdout}` : ""]
    .filter(Boolean)
    .join("\n\n");
  copyButton.classList.remove("hidden");
  closeButton.focus();
}

function showUnavailable(message) {
  loading.textContent = String(message || "The local installer failure detail is unavailable.");
  loading.setAttribute("role", "alert");
  closeButton.focus();
}
