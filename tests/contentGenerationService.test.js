const test = require("node:test");
const assert = require("node:assert/strict");

const { ContentGenerationService } = require("../src/main/services/contentGenerationService");

function createConfig(overrides = {}) {
  return {
    llm: {
      apiKey: "",
      model: "gemini-3-flash-preview",
      baseUrl: "https://example.invalid",
      timeoutMs: 1500,
      temperature: 1,
      thinkingLevels: {
        question: "low",
        report: "low",
        repair: "minimal",
      },
      ...(overrides.llm || {}),
    },
    tone: {
      presets: {
        cruel_balanced: "balanced",
      },
      current: "cruel_balanced",
    },
    ...overrides,
  };
}

test("ContentGenerationService.checkAvailability returns missing_api_key when key is absent", async () => {
  const service = new ContentGenerationService(createConfig());
  const result = await service.checkAvailability();

  assert.equal(result.ok, true);
  assert.equal(result.available, false);
  assert.equal(result.reasonCode, "missing_api_key");
});

test("ContentGenerationService.checkAvailability returns timeout reason from classified error", async () => {
  const service = new ContentGenerationService(
    createConfig({
      llm: {
        apiKey: "test-key",
      },
    }),
  );
  service.callGemini = async () => {
    const error = new Error("Gemini request timeout after 1000ms");
    error.reasonCode = "timeout";
    throw error;
  };

  const result = await service.checkAvailability();

  assert.equal(result.ok, true);
  assert.equal(result.available, false);
  assert.equal(result.reasonCode, "timeout");
});
