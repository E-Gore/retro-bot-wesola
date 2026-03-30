const test = require("node:test");
const assert = require("node:assert/strict");

const { AnalyticsService } = require("../src/main/services/analyticsService");

test("AnalyticsService exports JSON payload with summary and dataset", () => {
  const service = new AnalyticsService({
    getAnalyticsSummary: () => ({ sessions_total: 3, session_completion_rate: 66.6 }),
    getQualityReport: () => ({ count: 2, metrics: [{ stage: "question", metric_name: "novelty_score" }] }),
    getAnalyticsDataset: () => ({
      sessions: [{ session_id: "s1" }],
      dailyRollups: [{ day: "2026-02-27" }],
      qualityEvents: [{ metric_name: "novelty_score", metric_value: 0.8 }],
    }),
  });

  const exported = service.exportAnalytics({ format: "json", days: 7 });
  assert.equal(exported.ok, true);
  assert.equal(exported.format, "json");
  assert.equal(exported.summary.sessions_total, 3);
  assert.equal(exported.dataset.sessions.length, 1);
});

test("AnalyticsService exports CSV payload with files bundle", () => {
  const service = new AnalyticsService({
    getAnalyticsSummary: () => ({ sessions_total: 2 }),
    getQualityReport: () => ({ count: 1, metrics: [] }),
    getAnalyticsDataset: () => ({
      sessions: [
        {
          session_id: "s1",
          created_at: "2026-02-27T00:00:00.000Z",
          ended_at: "2026-02-27T00:01:00.000Z",
          language: "pl",
          verdict: "DENIED",
          completed: 1,
          duration_ms: 60000,
          llm_used: 1,
          llm_latency_ms: 1200,
          rewrite_used: 0,
          fallback_used: 0,
          question_novelty_avg: 0.75,
          report_coherence_score: 0.83,
          analysis_pipeline_ms: 1800,
        },
      ],
      qualityEvents: [
        {
          created_at: "2026-02-27T00:00:30.000Z",
          session_id: "s1",
          stage: "question",
          metric_name: "novelty_score",
          metric_value: 0.75,
        },
      ],
    }),
  });

  const exported = service.exportAnalytics({ format: "csv", days: 7 });
  assert.equal(exported.ok, true);
  assert.equal(exported.format, "csv");
  assert.ok(Array.isArray(exported.files));
  assert.ok(exported.files.length >= 3);
  assert.ok(exported.files.some((file) => file.fileName.includes("sessions")));
  assert.ok(exported.files.every((file) => typeof file.data === "string" && file.data.length > 0));
});
