const test = require("node:test");
const assert = require("node:assert/strict");

const { QUESTIONS } = require("../src/shared/questions");
const { AdaptiveQuestionFallbackService } = require("../src/main/services/adaptiveQuestionFallbackService");
const { validateAdaptiveQuestionShape } = require("../src/main/services/jsonSchema");

test("AdaptiveQuestionFallbackService returns a valid runtime text question for slot 0", () => {
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
  assert.equal(validated.value.type, "text");
  assert.equal(typeof validated.value.placeholder, "string");
  assert.equal(typeof validated.value.intentTag, "string");
  assert.equal(typeof validated.value.rhetoricalForm, "string");
  assert.equal(typeof validated.value.transitionLine, "string");
});

test("validateAdaptiveQuestionShape rejects missing text prompt", () => {
  const slot = QUESTIONS[0];
  const result = validateAdaptiveQuestionShape(
    {
      language: "en",
      id: "purpose",
      type: "text",
      placeholder: "e.g. I want clarity",
    },
    slot,
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("prompt"));
});
