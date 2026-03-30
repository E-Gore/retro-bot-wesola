const test = require("node:test");
const assert = require("node:assert/strict");

const { SafetyService } = require("../src/main/services/safetyService");

const config = {
  safety: {
    bannedWords: ["fuck", "kurwa"],
    riskyPhrases: ["kill yourself", "suicide"],
    maxArchiveQuoteChars: 120,
    maxReceiptBodyLines: 12,
  },
};

test("SafetyService flags PII and banned words in user input", () => {
  const safety = new SafetyService(config);
  const result = safety.screenUserInput({
    login: "someone@example.com",
    self_word: "fuck",
  });

  assert.equal(result.safe, false);
  assert.equal(result.flags.containsPII, true);
  assert.equal(result.flags.containsBannedWord, true);
  assert.ok(result.flags.rejectedKeys.includes("self_word"));
});

test("SafetyService rewrites unsafe generated copy into safe printable text", async () => {
  const safety = new SafetyService(config);
  const rewritten = await safety.rewriteUnsafe(
    {
      screen_summary: ["This includes fuck", "Normal line", "Reach @user later"],
      receipt_body_lines: ["Contact me at test@example.com"],
      tags: ["badtag", "fuck", "safe"],
      archive_quote: "Kill yourself (bad phrase)",
      metrics: [{ label: "fuck-meter", value: 120, suffix: "%" }],
    },
    { language: "en" },
  );

  const screened = safety.screenGeneratedCopy(rewritten);
  assert.equal(screened.safe, true);
  assert.equal(rewritten.metrics[0].value, 100);
  assert.ok(rewritten.archive_quote.length <= 120);
});
