const test = require("node:test");
const assert = require("node:assert/strict");

const { ReceiptFormatter } = require("../src/main/services/receiptFormatter");

test("ReceiptFormatter wraps and limits lines to target width", () => {
  const formatter = new ReceiptFormatter();
  const result = formatter.format(
    {
      language: "en",
      sessionId: "12345678-1234-1234-1234-1234567890ab",
      createdAt: "2026-02-26T10:00:00.000Z",
      login: "USER_LONG_NAME",
      verdict: "DENIED",
      contentSource: "template_fallback",
      receiptTitle: "SYSTEM RECOVERY RECEIPT",
      metrics: [
        { label: "Self-discipline", value: 12, suffix: "%" },
        { label: "Control appetite", value: 71, suffix: "%" },
        { label: "Delay reflex", value: 43, suffix: "%" },
      ],
      screenSummary: [
        "This is a compact summary line.",
        "Second line remains printable.",
        "Third line closes the verdict.",
      ],
      receiptBodyLines: [
        "This is a longer paragraph line that should wrap across multiple receipt rows without exceeding width.",
      ],
      tags: ["SELF-SABOTAGE", "CONTROL", "CURIOSITY"],
    },
    42,
  );

  assert.equal(result.width, 42);
  assert.ok(Array.isArray(result.lines));
  assert.ok(result.lines.length > 10);
  for (const line of result.lines) {
    assert.ok(line.length <= 42, `line exceeds width: ${line}`);
  }
});
