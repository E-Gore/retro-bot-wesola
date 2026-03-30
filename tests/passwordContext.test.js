const test = require("node:test");
const assert = require("node:assert/strict");

const { SafetyService } = require("../src/main/services/safetyService");
const { buildPasswordContext } = require("../src/main/utils/passwordContext");

test("buildPasswordContext summarizes password attempts without exposing raw control chars", () => {
  const safety = new SafetyService({
    safety: {
      bannedWords: ["fuck"],
      riskyPhrases: ["kill yourself"],
      maxArchiveQuoteChars: 120,
      maxReceiptBodyLines: 12,
    },
  });

  const ctx = buildPasswordContext(["abc123", "aaaa", " 2024 "], safety);
  assert.equal(ctx.summary.count, 3);
  assert.equal(ctx.attempts[0].length, 6);
  assert.ok(Array.isArray(ctx.attempts[1].tags));
  assert.ok(ctx.attempts[1].tags.includes("single_char_repeat") || ctx.attempts[1].tags.includes("repeated_chars"));
  assert.equal(ctx.summary.anyYearLike, true);
  assert.equal(typeof ctx.attempts[0].sanitized, "string");
});
