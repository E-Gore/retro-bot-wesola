const test = require("node:test");
const assert = require("node:assert/strict");

const { QUESTIONS } = require("../src/shared/questions");
const { SafetyService } = require("../src/main/services/safetyService");
const { QuestionGenerationService } = require("../src/main/services/questionGenerationService");

function createSafetyService() {
  return new SafetyService({
    safety: {
      bannedWords: ["kurwa", "fuck"],
      riskyPhrases: ["kill yourself", "suicide"],
    },
  });
}

test("QUESTION_ARC keeps unique intents and explicit Q3/Q5 separation", () => {
  assert.equal(QUESTIONS.length, 5);
  const intents = QUESTIONS.map((q) => q.intentTag);
  assert.equal(new Set(intents).size, 5);
  assert.ok(Array.isArray(QUESTIONS[2].forbiddenIntentOverlap));
  assert.ok(QUESTIONS[2].forbiddenIntentOverlap.includes(QUESTIONS[4].intentTag));
  assert.ok(QUESTIONS[4].forbiddenIntentOverlap.includes(QUESTIONS[2].intentTag));
});

test("QuestionGenerationService retries low-novelty LLM output once then hard-fails", async () => {
  let llmCalls = 0;
  const sessionEvents = [];
  const qualityEvents = [];
  const service = new QuestionGenerationService({
    config: {
      tone: { current: "cruel_balanced" },
      llm: {
        model: "gemini-3-flash-preview",
        thinkingLevels: { question: "low" },
      },
    },
    contentGenerationService: {
      isConfigured: () => true,
      generateAdaptiveQuestion: async () => {
        llmCalls += 1;
        return {
          language: "pl",
          id: "self_word",
          type: "text",
          intentTag: "self_state_label",
          rhetoricalForm: "contrast",
          transitionLine: "Przechodzę dalej.",
          prompt: "Powiedz jedno słowo o sobie.",
          placeholder: "np. zmęczony",
          minLength: 1,
          maxLength: 24,
        };
      },
    },
    safetyService: createSafetyService(),
    connectivityService: {
      getStatus: async () => "online",
      noteSuccess: () => {},
      noteFailure: () => {},
    },
    repository: {
      logQualityEvent: (...args) => qualityEvents.push(args),
      logSessionEvent: (...args) => sessionEvents.push(args),
    },
  });

  await assert.rejects(
    () =>
      service.getAdaptiveQuestion({
        sessionId: "test-session",
        language: "pl",
        login: "Tester",
        questionIndex: 1,
        previousHistory: [
          {
            id: "purpose",
            prompt: "Po co tu jesteś?",
            answerValue: "proof",
            answerLabel: "Chcę dowodu",
          },
          {
            id: "self_word",
            prompt: "Powiedz jedno słowo o sobie.",
            answerValue: "zmęczony",
            answerLabel: "zmęczony",
          },
        ],
        passwordAttempts: ["abc123", "abc123", "abc123"],
        arcState: {
          usedIntents: ["motive_declaration"],
          usedRhetoricalForms: ["probe"],
          usedAnchors: ["dowodu"],
          verbatimQuoteCount: 0,
        },
      }),
    (error) => error && error.code === "question_generation_failed",
  );

  assert.equal(llmCalls, 2);
  assert.ok(sessionEvents.some((eventArgs) => String(eventArgs?.[1] || "").includes("hard_fail")));
  assert.ok(qualityEvents.some((eventArgs) => String(eventArgs?.[2] || "") === "llm_hard_block"));
});
