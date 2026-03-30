const { centerText, wrapLine } = require("../utils/text");

function fmtTimestamp(dateInput) {
  const d = new Date(dateInput);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

class ReceiptFormatter {
  format(input, width = 42) {
    const language = input.language === "pl" ? "pl" : "en";
    const labels = language === "pl"
      ? {
          header: "SYSTEM RECOVERY RECEIPT",
          session: "SESJA",
          login: "LOGIN",
          verdict: "WERDYKT",
          metrics: "METRYKI",
          tags: "ARCHIVE TAGS",
          source: "ZRODLO",
          footer: "Ten system nie pamieta cie jako osoby.",
          footer2: "Pamieta cie jako wzorzec.",
        }
      : {
          header: "SYSTEM RECOVERY RECEIPT",
          session: "SESSION",
          login: "LOGIN",
          verdict: "VERDICT",
          metrics: "METRICS",
          tags: "ARCHIVE TAGS",
          source: "SOURCE",
          footer: "This system does not remember you as a person.",
          footer2: "It remembers you as a pattern.",
        };

    const lines = [];
    const pushWrapped = (value) => {
      for (const line of wrapLine(value, width)) lines.push(line);
    };
    const hr = "-".repeat(width);

    lines.push(centerText("RETRO BOT / RECOVERY NODE", width));
    lines.push(centerText(fmtTimestamp(input.createdAt || Date.now()), width));
    lines.push(hr);
    lines.push(centerText(input.receiptTitle || labels.header, width));
    lines.push(hr);
    pushWrapped(`${labels.session}: ${(input.sessionId || "").slice(0, 8).toUpperCase()}`);
    pushWrapped(`${labels.login}: ${input.login || "USER"}`);
    pushWrapped(`${labels.verdict}: ${input.verdict}`);
    pushWrapped(`${labels.source}: ${input.contentSource}`);
    lines.push(hr);
    lines.push(labels.metrics);
    for (const metric of input.metrics || []) {
      pushWrapped(`- ${metric.label}: ${metric.value}${metric.suffix || ""}`);
    }
    lines.push(hr);
    for (const summary of input.screenSummary || []) pushWrapped(summary);
    if ((input.screenSummary || []).length) lines.push(hr);
    for (const line of input.receiptBodyLines || []) pushWrapped(line);
    lines.push(hr);
    lines.push(labels.tags);
    pushWrapped((input.tags || []).join(" | "));
    lines.push(hr);
    pushWrapped(labels.footer);
    pushWrapped(labels.footer2);

    return { width, lines };
  }
}

module.exports = { ReceiptFormatter };
