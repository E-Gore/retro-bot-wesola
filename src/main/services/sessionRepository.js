const fs = require("node:fs");

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safePct(numerator, denominator) {
  const n = safeNumber(numerator, 0);
  const d = safeNumber(denominator, 0);
  if (d <= 0) return 0;
  return Math.max(0, Math.min(100, (n / d) * 100));
}

function mean(values) {
  const nums = (values || []).filter((v) => Number.isFinite(v));
  if (!nums.length) return 0;
  return nums.reduce((acc, v) => acc + v, 0) / nums.length;
}

function median(values) {
  const nums = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const mid = Math.floor(nums.length / 2);
  if (nums.length % 2 === 0) return (nums[mid - 1] + nums[mid]) / 2;
  return nums[mid];
}

function percentile(values, p) {
  const nums = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return 0;
  const clampedP = Math.max(0, Math.min(100, safeNumber(p, 50)));
  const idx = (clampedP / 100) * (nums.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return nums[lo];
  const weight = idx - lo;
  return nums[lo] * (1 - weight) + nums[hi] * weight;
}

function isoNow() {
  return new Date().toISOString();
}

function dateKey(isoString) {
  return String(isoString || "").slice(0, 10);
}

function toMillis(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function sortByCreatedAtDesc(rows) {
  return [...(rows || [])].sort((a, b) => toMillis(b.created_at) - toMillis(a.created_at));
}

function limitRows(rows, limit) {
  const max = Math.max(1, Math.min(50000, safeNumber(limit, 5000)));
  return (rows || []).slice(0, max);
}

class SessionRepository {
  constructor(config) {
    this.config = config;
    this.mode = "json";
    this.db = null;
    this.jsonState = {
      sessions: [],
      app_events: [],
      session_events: [],
      quality_events: [],
      daily_rollups: [],
    };
    this.screenOrder = [
      "attractor",
      "language",
      "login",
      "password1",
      "password2",
      "password3",
      "handoff",
      "question",
      "question_transition",
      "analysis",
      "result",
      "receipt_preview",
    ];
    this.init();
  }

  init() {
    fs.mkdirSync(this.config.storage.dataDir, { recursive: true });
    if (this.tryInitSqlite()) return;
    this.initJsonFallback();
  }

  tryInitSqlite() {
    try {
      const BetterSqlite3 = require("better-sqlite3");
      this.db = new BetterSqlite3(this.config.storage.sqlitePath);
      this.db.pragma("journal_mode = WAL");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          ended_at TEXT NOT NULL,
          language TEXT NOT NULL,
          login_raw TEXT,
          login_hash TEXT NOT NULL,
          content_source TEXT NOT NULL,
          verdict TEXT NOT NULL,
          screen_summary_json TEXT NOT NULL,
          receipt_body_lines_json TEXT NOT NULL,
          tags_json TEXT NOT NULL,
          archive_quote TEXT NOT NULL,
          safety_flags_json TEXT NOT NULL,
          duration_ms INTEGER NOT NULL,
          completed INTEGER NOT NULL,
          llm_used INTEGER NOT NULL DEFAULT 0,
          llm_latency_ms INTEGER,
          rewrite_used INTEGER NOT NULL DEFAULT 0,
          fallback_used INTEGER NOT NULL DEFAULT 0,
          question_novelty_avg REAL,
          report_coherence_score REAL,
          analysis_pipeline_ms INTEGER
        );
        CREATE TABLE IF NOT EXISTS session_answers (
          session_id TEXT NOT NULL,
          question_id TEXT NOT NULL,
          answer_text TEXT NOT NULL,
          answer_normalized TEXT NOT NULL,
          PRIMARY KEY (session_id, question_id)
        );
        CREATE TABLE IF NOT EXISTS session_metrics (
          session_id TEXT NOT NULL,
          metric_index INTEGER NOT NULL,
          label TEXT NOT NULL,
          value INTEGER NOT NULL,
          suffix TEXT NOT NULL,
          PRIMARY KEY (session_id, metric_index)
        );
        CREATE TABLE IF NOT EXISTS app_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT,
          event_type TEXT NOT NULL,
          screen_id TEXT,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS quality_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT,
          stage TEXT NOT NULL,
          metric_name TEXT NOT NULL,
          metric_value REAL NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS daily_rollups (
          day TEXT PRIMARY KEY,
          sessions_count INTEGER NOT NULL,
          completed_count INTEGER NOT NULL,
          completion_rate REAL NOT NULL,
          median_duration_ms INTEGER NOT NULL,
          llm_success_rate REAL NOT NULL,
          fallback_rate REAL NOT NULL,
          rewrite_rate REAL NOT NULL,
          avg_question_novelty REAL NOT NULL,
          avg_report_coherence REAL NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);
        CREATE INDEX IF NOT EXISTS idx_session_events_created_at ON session_events(created_at);
        CREATE INDEX IF NOT EXISTS idx_quality_events_created_at ON quality_events(created_at);
        CREATE INDEX IF NOT EXISTS idx_quality_events_metric ON quality_events(stage, metric_name, created_at);
      `);

      this.ensureTableColumn("sessions", "llm_used", "INTEGER NOT NULL DEFAULT 0");
      this.ensureTableColumn("sessions", "llm_latency_ms", "INTEGER");
      this.ensureTableColumn("sessions", "rewrite_used", "INTEGER NOT NULL DEFAULT 0");
      this.ensureTableColumn("sessions", "fallback_used", "INTEGER NOT NULL DEFAULT 0");
      this.ensureTableColumn("sessions", "question_novelty_avg", "REAL");
      this.ensureTableColumn("sessions", "report_coherence_score", "REAL");
      this.ensureTableColumn("sessions", "analysis_pipeline_ms", "INTEGER");

      this.insertSessionStmt = this.db.prepare(`
        INSERT OR REPLACE INTO sessions (
          session_id, created_at, ended_at, language, login_raw, login_hash,
          content_source, verdict, screen_summary_json, receipt_body_lines_json,
          tags_json, archive_quote, safety_flags_json, duration_ms, completed,
          llm_used, llm_latency_ms, rewrite_used, fallback_used,
          question_novelty_avg, report_coherence_score, analysis_pipeline_ms
        ) VALUES (
          @session_id, @created_at, @ended_at, @language, @login_raw, @login_hash,
          @content_source, @verdict, @screen_summary_json, @receipt_body_lines_json,
          @tags_json, @archive_quote, @safety_flags_json, @duration_ms, @completed,
          @llm_used, @llm_latency_ms, @rewrite_used, @fallback_used,
          @question_novelty_avg, @report_coherence_score, @analysis_pipeline_ms
        )
      `);
      this.insertAnswerStmt = this.db.prepare(`
        INSERT OR REPLACE INTO session_answers (session_id, question_id, answer_text, answer_normalized)
        VALUES (@session_id, @question_id, @answer_text, @answer_normalized)
      `);
      this.insertMetricStmt = this.db.prepare(`
        INSERT OR REPLACE INTO session_metrics (session_id, metric_index, label, value, suffix)
        VALUES (@session_id, @metric_index, @label, @value, @suffix)
      `);
      this.deleteAnswersStmt = this.db.prepare(`DELETE FROM session_answers WHERE session_id = ?`);
      this.deleteMetricsStmt = this.db.prepare(`DELETE FROM session_metrics WHERE session_id = ?`);

      this.insertAppEventStmt = this.db.prepare(`
        INSERT INTO app_events (created_at, event_type, payload_json)
        VALUES (?, ?, ?)
      `);
      this.insertSessionEventStmt = this.db.prepare(`
        INSERT INTO session_events (session_id, event_type, screen_id, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      this.insertQualityEventStmt = this.db.prepare(`
        INSERT INTO quality_events (session_id, stage, metric_name, metric_value, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      this.getAttractorStatsStmt = this.db.prepare(`
        SELECT
          SUM(CASE WHEN date(created_at) = date('now', 'localtime') THEN 1 ELSE 0 END) AS sessions_today,
          SUM(CASE WHEN date(created_at) = date('now', 'localtime') AND completed = 1 THEN 1 ELSE 0 END) AS completed_today
        FROM sessions
      `);
      this.getLastVerdictStmt = this.db.prepare(`
        SELECT verdict
        FROM sessions
        WHERE completed = 1
        ORDER BY created_at DESC
        LIMIT 1
      `);
      this.purgeRawLoginsStmt = this.db.prepare(`UPDATE sessions SET login_raw = NULL`);

      this.getSessionsByDateStmt = this.db.prepare(`
        SELECT * FROM sessions
        WHERE substr(created_at, 1, 10) = ?
      `);
      this.upsertDailyRollupStmt = this.db.prepare(`
        INSERT INTO daily_rollups (
          day, sessions_count, completed_count, completion_rate, median_duration_ms,
          llm_success_rate, fallback_rate, rewrite_rate,
          avg_question_novelty, avg_report_coherence,
          created_at, updated_at
        ) VALUES (
          @day, @sessions_count, @completed_count, @completion_rate, @median_duration_ms,
          @llm_success_rate, @fallback_rate, @rewrite_rate,
          @avg_question_novelty, @avg_report_coherence,
          @created_at, @updated_at
        )
        ON CONFLICT(day) DO UPDATE SET
          sessions_count=excluded.sessions_count,
          completed_count=excluded.completed_count,
          completion_rate=excluded.completion_rate,
          median_duration_ms=excluded.median_duration_ms,
          llm_success_rate=excluded.llm_success_rate,
          fallback_rate=excluded.fallback_rate,
          rewrite_rate=excluded.rewrite_rate,
          avg_question_novelty=excluded.avg_question_novelty,
          avg_report_coherence=excluded.avg_report_coherence,
          updated_at=excluded.updated_at
      `);

      this.selectAnalyticsSessionsStmt = this.db.prepare(`
        SELECT * FROM sessions
        WHERE created_at >= ?
        ORDER BY created_at DESC
        LIMIT ?
      `);
      this.selectAnalyticsSessionEventsStmt = this.db.prepare(`
        SELECT * FROM session_events
        WHERE created_at >= ?
        ORDER BY created_at DESC
        LIMIT ?
      `);
      this.selectAnalyticsQualityEventsStmt = this.db.prepare(`
        SELECT * FROM quality_events
        WHERE created_at >= ?
        ORDER BY created_at DESC
        LIMIT ?
      `);
      this.selectAnalyticsAppEventsStmt = this.db.prepare(`
        SELECT * FROM app_events
        WHERE created_at >= ?
        ORDER BY created_at DESC
        LIMIT ?
      `);
      this.selectAnalyticsDailyRollupsStmt = this.db.prepare(`
        SELECT * FROM daily_rollups
        WHERE day >= ?
        ORDER BY day DESC
        LIMIT ?
      `);

      this.saveSessionTx = this.db.transaction((record) => {
        this.insertSessionStmt.run(record.session);
        this.deleteAnswersStmt.run(record.session.session_id);
        this.deleteMetricsStmt.run(record.session.session_id);
        for (const answer of record.answers) this.insertAnswerStmt.run(answer);
        for (const metric of record.metrics) this.insertMetricStmt.run(metric);
      });

      this.mode = "sqlite";
      return true;
    } catch {
      this.db = null;
      return false;
    }
  }

  ensureTableColumn(tableName, columnName, definition) {
    try {
      const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all();
      const hasColumn = rows.some((row) => String(row.name) === String(columnName));
      if (!hasColumn) {
        this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
      }
    } catch {
      // If migration fails, app will continue and rely on fallback paths.
    }
  }

  initJsonFallback() {
    const file = this.config.storage.jsonFallbackPath;
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (parsed && typeof parsed === "object") {
          this.jsonState = {
            sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
            app_events: Array.isArray(parsed.app_events) ? parsed.app_events : [],
            session_events: Array.isArray(parsed.session_events) ? parsed.session_events : [],
            quality_events: Array.isArray(parsed.quality_events) ? parsed.quality_events : [],
            daily_rollups: Array.isArray(parsed.daily_rollups) ? parsed.daily_rollups : [],
          };
        }
      } catch {
        this.jsonState = {
          sessions: [],
          app_events: [],
          session_events: [],
          quality_events: [],
          daily_rollups: [],
        };
      }
    } else {
      this.flushJson();
    }
  }

  flushJson() {
    fs.writeFileSync(this.config.storage.jsonFallbackPath, JSON.stringify(this.jsonState, null, 2), "utf8");
  }

  saveSession(record) {
    if (this.mode === "sqlite") {
      this.saveSessionTx(record);
      this.rebuildDailyRollup(dateKey(record?.session?.created_at));
      return;
    }

    const idx = this.jsonState.sessions.findIndex((s) => s.session.session_id === record.session.session_id);
    if (idx >= 0) this.jsonState.sessions[idx] = record;
    else this.jsonState.sessions.push(record);
    this.rebuildDailyRollup(dateKey(record?.session?.created_at));
    this.flushJson();
  }

  logEvent(eventType, payload = {}) {
    const row = {
      created_at: isoNow(),
      event_type: String(eventType),
      payload_json: JSON.stringify(payload),
    };
    if (this.mode === "sqlite") {
      this.insertAppEventStmt.run(row.created_at, row.event_type, row.payload_json);
      return;
    }
    this.jsonState.app_events.push(row);
    if (this.jsonState.app_events.length > 5000) {
      this.jsonState.app_events.splice(0, this.jsonState.app_events.length - 5000);
    }
    this.flushJson();
  }

  logSessionEvent(sessionId, eventType, screenId, payload = {}) {
    const row = {
      session_id: sessionId ? String(sessionId) : null,
      event_type: String(eventType || "session_event"),
      screen_id: screenId ? String(screenId) : null,
      payload_json: JSON.stringify(payload || {}),
      created_at: isoNow(),
    };

    if (this.mode === "sqlite") {
      this.insertSessionEventStmt.run(row.session_id, row.event_type, row.screen_id, row.payload_json, row.created_at);
      return;
    }

    this.jsonState.session_events.push(row);
    if (this.jsonState.session_events.length > 30000) {
      this.jsonState.session_events.splice(0, this.jsonState.session_events.length - 30000);
    }
    this.flushJson();
  }

  logQualityEvent(sessionId, stage, metricName, metricValue, payload = {}) {
    if (!Number.isFinite(Number(metricValue))) return;
    const row = {
      session_id: sessionId ? String(sessionId) : null,
      stage: String(stage || "unknown"),
      metric_name: String(metricName || "metric"),
      metric_value: Number(metricValue),
      payload_json: JSON.stringify(payload || {}),
      created_at: isoNow(),
    };

    if (this.mode === "sqlite") {
      this.insertQualityEventStmt.run(
        row.session_id,
        row.stage,
        row.metric_name,
        row.metric_value,
        row.payload_json,
        row.created_at,
      );
      return;
    }

    this.jsonState.quality_events.push(row);
    if (this.jsonState.quality_events.length > 30000) {
      this.jsonState.quality_events.splice(0, this.jsonState.quality_events.length - 30000);
    }
    this.flushJson();
  }

  rebuildDailyRollup(day) {
    if (!day) return;

    if (this.mode === "sqlite") {
      const rows = this.getSessionsByDateStmt.all(day);
      const rollup = this.buildDailyRollupFromSessions(day, rows);
      this.upsertDailyRollupStmt.run(rollup);
      return;
    }

    const rows = this.jsonState.sessions
      .map((record) => record?.session)
      .filter((session) => session && dateKey(session.created_at) === day);
    const rollup = this.buildDailyRollupFromSessions(day, rows);
    const idx = this.jsonState.daily_rollups.findIndex((r) => r.day === day);
    if (idx >= 0) this.jsonState.daily_rollups[idx] = rollup;
    else this.jsonState.daily_rollups.push(rollup);
  }

  buildDailyRollupFromSessions(day, sessionRows) {
    const rows = Array.isArray(sessionRows) ? sessionRows : [];
    const completedRows = rows.filter((s) => Number(s.completed) === 1);
    const durations = completedRows.map((s) => safeNumber(s.duration_ms, 0));
    const llmCount = completedRows.filter((s) => Number(s.llm_used) === 1).length;
    const fallbackCount = completedRows.filter((s) => Number(s.fallback_used) === 1).length;
    const rewriteCount = completedRows.filter((s) => Number(s.rewrite_used) === 1).length;
    const noveltyValues = completedRows.map((s) => Number(s.question_novelty_avg)).filter((v) => Number.isFinite(v));
    const coherenceValues = completedRows.map((s) => Number(s.report_coherence_score)).filter((v) => Number.isFinite(v));
    const now = isoNow();

    return {
      day,
      sessions_count: rows.length,
      completed_count: completedRows.length,
      completion_rate: safePct(completedRows.length, rows.length),
      median_duration_ms: Math.round(median(durations)),
      llm_success_rate: safePct(llmCount, completedRows.length),
      fallback_rate: safePct(fallbackCount, completedRows.length),
      rewrite_rate: safePct(rewriteCount, completedRows.length),
      avg_question_novelty: mean(noveltyValues),
      avg_report_coherence: mean(coherenceValues),
      created_at: now,
      updated_at: now,
    };
  }

  getAttractorStats() {
    if (this.mode === "sqlite") {
      const row = this.getAttractorStatsStmt.get() || {};
      const last = this.getLastVerdictStmt.get() || {};
      return {
        sessionsToday: Number(row.sessions_today || 0),
        completedToday: Number(row.completed_today || 0),
        lastVerdict: last.verdict || "N/A",
        storageMode: "sqlite",
      };
    }

    const today = dateKey(isoNow());
    const todays = this.jsonState.sessions.filter((r) => dateKey(r?.session?.created_at) === today);
    const completed = todays.filter((r) => Number(r?.session?.completed) === 1).length;
    const lastCompleted = [...this.jsonState.sessions].reverse().find((r) => Number(r?.session?.completed) === 1);
    return {
      sessionsToday: todays.length,
      completedToday: completed,
      lastVerdict: lastCompleted?.session?.verdict || "N/A",
      storageMode: "json",
    };
  }

  getAnalyticsDataset(options = {}) {
    const daysRaw = Number(options?.days);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(Math.round(daysRaw), 90) : 7;
    const limitRaw = Number(options?.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.round(limitRaw), 50000) : 5000;
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString();
    const cutoffDay = dateKey(cutoffIso);

    if (this.mode === "sqlite") {
      return {
        days,
        sessions: this.selectAnalyticsSessionsStmt.all(cutoffIso, limit),
        sessionEvents: this.selectAnalyticsSessionEventsStmt.all(cutoffIso, limit * 5),
        qualityEvents: this.selectAnalyticsQualityEventsStmt.all(cutoffIso, limit * 10),
        appEvents: this.selectAnalyticsAppEventsStmt.all(cutoffIso, limit * 5),
        dailyRollups: this.selectAnalyticsDailyRollupsStmt.all(cutoffDay, Math.max(days * 3, 30)),
      };
    }

    const sessions = sortByCreatedAtDesc(
      this.jsonState.sessions
        .map((record) => record?.session)
        .filter((session) => session && toMillis(session.created_at) >= cutoffMs),
    );
    const sessionEvents = sortByCreatedAtDesc(
      this.jsonState.session_events.filter((row) => toMillis(row.created_at) >= cutoffMs),
    );
    const qualityEvents = sortByCreatedAtDesc(
      this.jsonState.quality_events.filter((row) => toMillis(row.created_at) >= cutoffMs),
    );
    const appEvents = sortByCreatedAtDesc(
      this.jsonState.app_events.filter((row) => toMillis(row.created_at) >= cutoffMs),
    );
    const dailyRollups = [...(this.jsonState.daily_rollups || [])]
      .filter((row) => String(row.day || "") >= cutoffDay)
      .sort((a, b) => String(b.day).localeCompare(String(a.day)));

    return {
      days,
      sessions: limitRows(sessions, limit),
      sessionEvents: limitRows(sessionEvents, limit * 5),
      qualityEvents: limitRows(qualityEvents, limit * 10),
      appEvents: limitRows(appEvents, limit * 5),
      dailyRollups: dailyRollups.slice(0, Math.max(days * 3, 30)),
    };
  }

  getAnalyticsSummary(options = {}) {
    const dataset = this.getAnalyticsDataset(options);
    const sessions = dataset.sessions || [];
    const completed = sessions.filter((s) => Number(s.completed) === 1);
    const durations = completed.map((s) => safeNumber(s.duration_ms, 0));

    const llmUsedCount = completed.filter((s) => Number(s.llm_used) === 1).length;
    const fallbackCount = completed.filter((s) => Number(s.fallback_used) === 1).length;
    const rewriteCount = completed.filter((s) => Number(s.rewrite_used) === 1).length;

    const noveltyValues = completed.map((s) => Number(s.question_novelty_avg)).filter((v) => Number.isFinite(v));
    const coherenceValues = completed.map((s) => Number(s.report_coherence_score)).filter((v) => Number.isFinite(v));

    const dropoff = this.buildDropoffByScreen(dataset.sessionEvents || [], sessions, completed.length);
    const inputStats = this.buildInputRejectionStats(dataset.sessionEvents || [], dataset.appEvents || []);

    return {
      days: dataset.days,
      generatedAt: isoNow(),
      storageMode: this.mode,
      sessions_total: sessions.length,
      sessions_completed: completed.length,
      session_completion_rate: safePct(completed.length, sessions.length),
      median_session_duration_ms: Math.round(median(durations)),
      llm_success_rate: safePct(llmUsedCount, completed.length),
      fallback_rate_online: safePct(fallbackCount, completed.length),
      rewrite_rate: safePct(rewriteCount, completed.length),
      question_novelty_score: {
        avg: mean(noveltyValues),
        p50: percentile(noveltyValues, 50),
        p90: percentile(noveltyValues, 90),
      },
      report_coherence_score: {
        avg: mean(coherenceValues),
        p50: percentile(coherenceValues, 50),
        p90: percentile(coherenceValues, 90),
      },
      dropoff_by_screen: dropoff,
      input_rejection_rate: inputStats.rate,
      input_submitted: inputStats.submitted,
      input_rejected: inputStats.rejected,
    };
  }

  buildDropoffByScreen(sessionEvents, sessions, completedCount) {
    const events = (sessionEvents || []).filter((e) => e.event_type === "screen_entered" && e.session_id);
    const bySession = new Map();
    for (const event of events) {
      if (!bySession.has(event.session_id)) bySession.set(event.session_id, new Set());
      bySession.get(event.session_id).add(String(event.screen_id || ""));
    }

    const reachedCount = Object.fromEntries(this.screenOrder.map((screen) => [screen, 0]));
    for (const set of bySession.values()) {
      for (const screen of this.screenOrder) {
        if (set.has(screen)) reachedCount[screen] += 1;
      }
    }

    if (!events.length && sessions.length) {
      // Fallback when screen events are not yet available in historical data.
      reachedCount.attractor = sessions.length;
      reachedCount.result = completedCount;
      reachedCount.receipt_preview = completedCount;
    }

    const rows = [];
    for (let i = 0; i < this.screenOrder.length; i += 1) {
      const screen = this.screenOrder[i];
      const nextScreen = this.screenOrder[i + 1];
      const reached = safeNumber(reachedCount[screen], 0);
      const nextReached = nextScreen ? safeNumber(reachedCount[nextScreen], 0) : safeNumber(completedCount, 0);
      const dropoffCount = Math.max(0, reached - nextReached);
      rows.push({
        screen,
        reached,
        dropoff_count: dropoffCount,
        dropoff_rate_pct: safePct(dropoffCount, reached),
      });
    }
    return rows;
  }

  buildInputRejectionStats(sessionEvents, appEvents) {
    const sessionSubmitted = (sessionEvents || []).filter((e) => e.event_type === "input_submitted").length;
    const sessionRejected = (sessionEvents || []).filter((e) => e.event_type === "input_rejected").length;

    if (sessionSubmitted > 0 || sessionRejected > 0) {
      return {
        submitted: sessionSubmitted,
        rejected: sessionRejected,
        rate: safePct(sessionRejected, sessionSubmitted),
      };
    }

    const events = appEvents || [];
    const fallbackSubmitted = events.filter((e) => /screening_started|analysis_started|session_started/.test(String(e.event_type || ""))).length;
    const fallbackRejected = events.filter((e) => /validation_failed|screening_rejected/.test(String(e.event_type || ""))).length;
    return {
      submitted: fallbackSubmitted,
      rejected: fallbackRejected,
      rate: safePct(fallbackRejected, fallbackSubmitted),
    };
  }

  getQualityReport(options = {}) {
    const limitRaw = Number(options?.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.round(limitRaw), 10000) : 500;
    const dataset = this.getAnalyticsDataset(options);
    const events = (dataset.qualityEvents || []).slice(0, limit);
    const grouped = new Map();

    for (const event of events) {
      const stage = String(event.stage || "unknown");
      const metric = String(event.metric_name || "metric");
      const key = `${stage}::${metric}`;
      const value = Number(event.metric_value);
      if (!Number.isFinite(value)) continue;
      if (!grouped.has(key)) {
        grouped.set(key, {
          stage,
          metric_name: metric,
          values: [],
        });
      }
      grouped.get(key).values.push(value);
    }

    const metrics = Array.from(grouped.values()).map((group) => {
      const values = group.values;
      return {
        stage: group.stage,
        metric_name: group.metric_name,
        count: values.length,
        avg: mean(values),
        p50: percentile(values, 50),
        p90: percentile(values, 90),
        min: values.length ? Math.min(...values) : 0,
        max: values.length ? Math.max(...values) : 0,
      };
    });

    metrics.sort((a, b) => {
      if (a.stage === b.stage) return a.metric_name.localeCompare(b.metric_name);
      return a.stage.localeCompare(b.stage);
    });

    return {
      days: dataset.days,
      generatedAt: isoNow(),
      count: events.length,
      metrics,
      recent: events.slice(0, 80),
    };
  }

  purgeRawLogins() {
    if (this.mode === "sqlite") {
      this.purgeRawLoginsStmt.run();
      return;
    }
    for (const record of this.jsonState.sessions) {
      if (record?.session) record.session.login_raw = null;
    }
    this.flushJson();
  }
}

module.exports = { SessionRepository };
