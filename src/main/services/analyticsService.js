function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(headers.map((key) => csvEscape(row?.[key])).join(","));
  }
  return lines.join("\n");
}

class AnalyticsService {
  constructor(repository) {
    this.repository = repository;
  }

  getAnalyticsSummary(options = {}) {
    return this.repository.getAnalyticsSummary(options);
  }

  getQualityReport(options = {}) {
    return this.repository.getQualityReport(options);
  }

  exportAnalytics(options = {}) {
    const format = String(options?.format || "json").toLowerCase();
    const daysRaw = Number(options?.days);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(Math.round(daysRaw), 90) : 7;
    const summary = this.repository.getAnalyticsSummary({ days });
    const quality = this.repository.getQualityReport({ days, limit: 5000 });
    const dataset = this.repository.getAnalyticsDataset({ days, limit: 5000 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    if (format === "csv") {
      const summaryRows = Object.entries(summary || {}).map(([k, v]) => ({ metric: k, value: typeof v === "object" ? JSON.stringify(v) : v }));
      const sessionsRows = (dataset.sessions || []).map((s) => ({
        session_id: s.session_id,
        created_at: s.created_at,
        ended_at: s.ended_at,
        language: s.language,
        verdict: s.verdict,
        completed: s.completed,
        duration_ms: s.duration_ms,
        llm_used: s.llm_used,
        llm_latency_ms: s.llm_latency_ms,
        rewrite_used: s.rewrite_used,
        fallback_used: s.fallback_used,
        question_novelty_avg: s.question_novelty_avg,
        report_coherence_score: s.report_coherence_score,
        analysis_pipeline_ms: s.analysis_pipeline_ms,
      }));
      const qualityRows = (dataset.qualityEvents || []).map((q) => ({
        created_at: q.created_at,
        session_id: q.session_id,
        stage: q.stage,
        metric_name: q.metric_name,
        metric_value: q.metric_value,
      }));

      return {
        ok: true,
        format: "csv",
        exportedAt: new Date().toISOString(),
        days,
        files: [
          {
            fileName: `retrobot-summary-${stamp}.csv`,
            data: toCsv(["metric", "value"], summaryRows),
          },
          {
            fileName: `retrobot-sessions-${stamp}.csv`,
            data: toCsv(
              [
                "session_id",
                "created_at",
                "ended_at",
                "language",
                "verdict",
                "completed",
                "duration_ms",
                "llm_used",
                "llm_latency_ms",
                "rewrite_used",
                "fallback_used",
                "question_novelty_avg",
                "report_coherence_score",
                "analysis_pipeline_ms",
              ],
              sessionsRows,
            ),
          },
          {
            fileName: `retrobot-quality-events-${stamp}.csv`,
            data: toCsv(["created_at", "session_id", "stage", "metric_name", "metric_value"], qualityRows),
          },
        ],
      };
    }

    return {
      ok: true,
      format: "json",
      exportedAt: new Date().toISOString(),
      days,
      summary,
      quality,
      dataset: {
        sessions: dataset.sessions || [],
        dailyRollups: dataset.dailyRollups || [],
        qualityEvents: dataset.qualityEvents || [],
      },
    };
  }
}

module.exports = { AnalyticsService };
