function registerIpcHandlers({
  ipcMain,
  config,
  repository,
  statsService,
  analyticsService,
  connectivityService,
  contentGenerationService,
  sessionAnalysisService,
  safetyService,
  audioCueService,
  questionGenerationService,
  reportTxtExportService,
}) {
  const requireOperator = () => Boolean(config.app.operatorMode);
  const accessDenied = () => ({
    ok: false,
    error: "access_denied",
    message: "Operator mode required",
  });
  const toIpcError = (error, fallbackCode) => {
    const payload = {
      code: String(error?.code || fallbackCode || "unknown_error"),
      reasonCode: String(error?.reasonCode || "unknown"),
      message: String(error?.message || error || "unknown_error"),
    };
    return new Error(JSON.stringify(payload));
  };

  ipcMain.handle("retrobot:get-bootstrap", async () => {
    return {
      app: {
        name: config.app.name,
        version: config.app.version,
        idleTimeoutMs: config.app.idleTimeoutMs,
        postResultTimeoutMs: config.app.postResultTimeoutMs,
        handoffDurationMs: config.app.handoffDurationMs,
        analysisMinMs: config.app.analysisMinMs,
        analysisMaxMs: config.app.analysisMaxMs,
        receiptWidth: config.app.receiptWidth,
        operatorMode: config.app.operatorMode,
      },
      tonePreset: config.tone.current,
      storageMode: repository.mode,
      llmConfigured: Boolean(config.llm.apiKey),
    };
  });

  ipcMain.handle("retrobot:get-attractor-stats", async () => {
    const connectivityStatus = await connectivityService.getStatus();
    return statsService.getAttractorStats({ connectivityStatus });
  });

  ipcMain.handle("retrobot:screen-user-text", async (_event, payload) => {
    const key = String(payload?.key || "text");
    const value = String(payload?.value || "");
    return safetyService.screenUserInput({ [key]: value });
  });

  ipcMain.handle("retrobot:generate-result", async (_event, payload) => {
    try {
      return await sessionAnalysisService.analyzeSession(payload);
    } catch (error) {
      throw toIpcError(error, "report_generation_failed");
    }
  });

  ipcMain.handle("retrobot:get-adaptive-question", async (_event, payload) => {
    try {
      return await questionGenerationService.getAdaptiveQuestion(payload || {});
    } catch (error) {
      throw toIpcError(error, "question_generation_failed");
    }
  });

  ipcMain.handle("retrobot:check-llm-availability", async () => {
    const checkedAt = new Date().toISOString();
    if (!contentGenerationService.isConfigured()) {
      return {
        ok: true,
        available: false,
        reasonCode: "missing_api_key",
        operatorMessage: "GEMINI_API_KEY is missing",
        checkedAt,
      };
    }

    const connectivityStatus = await connectivityService.getStatus();
    if (connectivityStatus !== "online") {
      return {
        ok: true,
        available: false,
        reasonCode: "offline",
        operatorMessage: "Connectivity probe failed",
        checkedAt,
      };
    }

    return contentGenerationService.checkAvailability();
  });

  ipcMain.handle("retrobot:log-event", async (_event, eventType, payload) => {
    repository.logEvent(String(eventType || "ui_event"), payload || {});
    return { ok: true };
  });

  ipcMain.handle("retrobot:log-session-event", async (_event, payload) => {
    repository.logSessionEvent(
      String(payload?.sessionId || ""),
      String(payload?.eventType || "session_event"),
      String(payload?.screenId || ""),
      payload?.meta || {},
    );
    return { ok: true };
  });

  ipcMain.handle("retrobot:log-quality-event", async (_event, payload) => {
    repository.logQualityEvent(
      String(payload?.sessionId || ""),
      String(payload?.stage || "question"),
      String(payload?.metricName || "metric"),
      Number(payload?.metricValue || 0),
      payload?.meta || {},
    );
    return { ok: true };
  });

  ipcMain.handle("retrobot:get-analytics-summary", async (_event, payload) => {
    if (!requireOperator()) return accessDenied();
    return {
      ok: true,
      summary: analyticsService.getAnalyticsSummary(payload || {}),
    };
  });

  ipcMain.handle("retrobot:get-quality-report", async (_event, payload) => {
    if (!requireOperator()) return accessDenied();
    return {
      ok: true,
      report: analyticsService.getQualityReport(payload || {}),
    };
  });

  ipcMain.handle("retrobot:export-analytics", async (_event, payload) => {
    if (!requireOperator()) return accessDenied();
    return analyticsService.exportAnalytics(payload || {});
  });

  ipcMain.handle("retrobot:export-report-txt", async (_event, payload) => {
    try {
      return reportTxtExportService.exportResult(payload?.result || {}, {
        directory: payload?.directory,
        fileName: payload?.fileName,
      });
    } catch (error) {
      throw toIpcError(error, "report_txt_export_failed");
    }
  });

  ipcMain.handle("retrobot:audio-cue", async (_event, cueName) => {
    return { ok: audioCueService.play(cueName) };
  });

  ipcMain.handle("retrobot:purge-logins", async () => {
    if (!requireOperator()) return accessDenied();
    repository.purgeRawLogins();
    repository.logEvent("purge_raw_logins", {});
    return { ok: true };
  });
}

module.exports = { registerIpcHandlers };
