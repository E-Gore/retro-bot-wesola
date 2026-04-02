const fs = require("node:fs");
const path = require("node:path");

function fmtTimestamp(dateInput) {
  const d = new Date(dateInput || Date.now());
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

function sanitizeSegment(value, fallback = "report") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

class ReportTxtExportService {
  constructor(config) {
    this.config = config;
  }

  buildReportText(result = {}) {
    const lines = [];
    const add = (value = "") => lines.push(String(value));
    const addSection = (title, values = []) => {
      const printable = (values || []).map((value) => String(value || "").trim()).filter(Boolean);
      if (!printable.length) return;
      if (lines.length) add("");
      add(title);
      add("=".repeat(title.length));
      for (const value of printable) add(value);
    };

    const metrics = Array.isArray(result.metrics) ? result.metrics : [];
    const metricLines = metrics.map((metric) => {
      const label = String(metric?.label || "Metric");
      const value = metric?.value ?? "";
      const suffix = String(metric?.suffix || "");
      return `- ${label}: ${value}${suffix}`;
    });
    const tagLine = Array.isArray(result.tags) && result.tags.length ? result.tags.join(" | ") : "";

    add("RETRO BOT / REPORT EXPORT");
    add("=========================");
    add(`Created at: ${fmtTimestamp(new Date())}`);
    add(`Session created at: ${fmtTimestamp(result.createdAt || new Date())}`);
    add(`Session ID: ${String(result.sessionId || "-")}`);
    add(`Login: ${String(result.login || "USER")}`);
    add(`Language: ${String(result.language || "-").toUpperCase()}`);
    add(`Verdict: ${String(result.verdict || "-")}`);
    add(`Source: ${String(result.contentSource || "-")}`);

    addSection("Screen Summary", result.screenSummary || []);
    addSection("Report Body", result.receiptBodyLines || []);
    addSection("Metrics", metricLines);
    addSection("Tags", tagLine ? [tagLine] : []);
    addSection("Archive Quote", result.archiveQuote ? [result.archiveQuote] : []);

    return `${lines.join("\n")}\n`;
  }

  exportResult(result = {}, options = {}) {
    const exportDir = String(options.directory || this.config?.storage?.exportsDir || "").trim();
    if (!exportDir) {
      throw new Error("TXT export directory is not configured");
    }

    fs.mkdirSync(exportDir, { recursive: true });

    const createdAt = result.createdAt || new Date().toISOString();
    const stamp = String(createdAt).replace(/[:.]/g, "-");
    const sessionPart = sanitizeSegment(String(result.sessionId || "").slice(0, 8), "session");
    const loginPart = sanitizeSegment(result.login || "user", "user");
    const fileName = options.fileName
      ? `${sanitizeSegment(options.fileName, "report")}.txt`
      : `retrobot-report-${stamp}-${sessionPart}-${loginPart}.txt`;
    const filePath = path.join(exportDir, fileName);
    const data = this.buildReportText(result);

    fs.writeFileSync(filePath, data, "utf8");

    return {
      ok: true,
      fileName,
      filePath,
      bytes: Buffer.byteLength(data, "utf8"),
      exportedAt: new Date().toISOString(),
      data,
    };
  }
}

module.exports = { ReportTxtExportService };
