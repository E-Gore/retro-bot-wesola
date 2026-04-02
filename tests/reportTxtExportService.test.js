const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { ReportTxtExportService } = require("../src/main/services/reportTxtExportService");

test("ReportTxtExportService builds readable txt report from analysis payload", () => {
  const service = new ReportTxtExportService({ storage: { exportsDir: "/tmp/unused" } });
  const output = service.buildReportText({
    createdAt: "2026-04-02T12:30:00.000Z",
    sessionId: "abcd1234-9876-ffff-eeee-111122223333",
    login: "igor",
    language: "pl",
    verdict: "DENIED",
    contentSource: "gemini",
    screenSummary: ["Linia 1", "Linia 2"],
    receiptBodyLines: ["Akapit 1", "Akapit 2"],
    metrics: [{ label: "Control appetite", value: 71, suffix: "%" }],
    tags: ["CONTROL", "LOOP"],
    archiveQuote: "Pamieta cie jako wzorzec.",
  });

  assert.match(output, /RETRO BOT \/ REPORT EXPORT/);
  assert.match(output, /Session ID: abcd1234-9876-ffff-eeee-111122223333/);
  assert.match(output, /Screen Summary/);
  assert.match(output, /Report Body/);
  assert.match(output, /- Control appetite: 71%/);
  assert.match(output, /CONTROL \| LOOP/);
});

test("ReportTxtExportService writes txt file to exports directory", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "retrobot-export-"));
  const service = new ReportTxtExportService({ storage: { exportsDir: tmpDir } });

  const exported = service.exportResult({
    createdAt: "2026-04-02T12:30:00.000Z",
    sessionId: "abcd1234-9876-ffff-eeee-111122223333",
    login: "igor",
    language: "pl",
    verdict: "DENIED",
    contentSource: "gemini",
    receiptBodyLines: ["Akapit 1"],
  });

  assert.equal(exported.ok, true);
  assert.ok(exported.fileName.endsWith(".txt"));
  assert.ok(fs.existsSync(exported.filePath));
  assert.match(fs.readFileSync(exported.filePath, "utf8"), /Akapit 1/);
});
