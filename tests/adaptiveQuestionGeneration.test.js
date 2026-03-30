const test = require("node:test");
const assert = require("node:assert/strict");

const { QUESTIONS } = require("../src/shared/questions");
const { AdaptiveQuestionFallbackService } = require("../src/main/services/adaptiveQuestionFallbackService");
const { validateAdaptiveQuestionShape } = require("../src/main/services/jsonSchema");

test("AdaptiveQuestionFallbackService returns a valid runtime choice question for slot 0", () => {
  const service = new AdaptiveQuestionFallbackService();
  const slot = QUESTIONS[0];
  const question = service.generate({
    language: "pl",
    slot,
    login: "Hubert",
    sessionId: "abc",
    questionIndex: 0,
    previousHistory: [],
  });

  const validated = validateAdaptiveQuestionShape(question, slot);
  assert.equal(validated.ok, true);
  assert.equal(validated.value.id, "purpose");
  assert.equal(validated.value.type, "choice");
  assert.equal(validated.value.options.length, slot.options.length);
  assert.equal(typeof validated.value.intentTag, "string");
  assert.equal(typeof validated.value.rhetoricalForm, "string");
  assert.equal(typeof validated.value.transitionLine, "string");
});

test("validateAdaptiveQuestionShape rejects missing choice options", () => {
  const slot = QUESTIONS[0];
  const result = validateAdaptiveQuestionShape(
    {
      language: "en",
      id: "purpose",
      type: "choice",
      prompt: "Choose.",
      options: [{ value: "curiosity", label: "Curiosity" }],
    },
    slot,
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("options"));
});
