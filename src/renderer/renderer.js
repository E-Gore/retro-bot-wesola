(function () {
  const api = window.retroBot;
  const staticData = api.getStaticData();
  const { questions, copy, constants } = staticData;
  const { SCREEN_IDS, CONTENT_SOURCES, VERDICTS, LLM_REASON_CODES } = constants;

  const appEl = document.getElementById("app");

  const state = {
    bootstrap: null,
    screen: SCREEN_IDS.ATTRACTOR,
    language: null,
    session: null,
    login: "",
    passwordAttempts: [],
    answers: {},
    questionHistory: [],
    arcState: {
      usedIntents: [],
      usedRhetoricalForms: [],
      usedAnchors: [],
      verbatimQuoteCount: 0,
    },
    dynamicQuestions: [],
    dynamicQuestionSignatures: [],
    dynamicQuestionPayloads: [],
    questionIndex: 0,
    questionLoadingIndex: -1,
    questionTransition: {
      token: 0,
      nextIndex: -1,
      line: "",
      ready: false,
      skipRequested: false,
      shownAt: 0,
      interpretationLine: "",
      loading: false,
    },
    choiceIndex: 0,
    message: "",
    attractorStats: {
      sessionsToday: 0,
      completedToday: 0,
      lastVerdictLabel: "N/A",
      systemPatiencePct: 100,
      completionRatePct: 0,
      connectivityStatus: "offline",
      storageMode: "json",
    },
    attractorLineIndex: 0,
    showDataInfo: false,
    handoffEndsAt: 0,
    analysisStartedAt: 0,
    analysisTickAt: 0,
    analysisLogIndex: 0,
    analysisProgressPct: 0,
    result: null,
    receiptPreviewViewed: false,
    lastInteractionAt: Date.now(),
    renderNonce: 0,
    pending: false,
    fatalError: null,
    lastScreenEventSent: null,
    adminLock: {
      reasonCode: LLM_REASON_CODES.UNKNOWN,
      operatorMessage: "",
      checkedAt: "",
      context: "",
    },
    debug: {
      enabled: true,
      lines: [],
    },
  };

  const tempInputs = {
    login: "",
    password1: "",
    password2: "",
    password3: "",
    questionText: "",
  };

  const attractorStaticLogs = [
    { level: "ok", text: "[BOOT] Recovery Node online" },
    { level: "warn", text: "[AUTH] Secure channel degraded" },
    { level: "ok", text: "[ARCHIVE] Quote memory mounted" },
    { level: "warn", text: "[HUMAN] Voluntary self-assessment detected" },
    { level: "ok", text: "[UI] Keyboard-first mode active" },
  ];

  let tickInterval = null;
  let attractorRefreshInterval = null;
  let questionPrefetchDebounceTimer = null;
  const questionRequestCache = new Map();
  const questionRequestInflight = new Map();

  function currentCopy() {
    return copy[state.language || "pl"];
  }

  function debugMetaString(meta) {
    if (!meta || typeof meta !== "object") return "";
    const compact = {};
    for (const [key, value] of Object.entries(meta)) {
      if (value === undefined) continue;
      if (value && typeof value === "object") {
        compact[key] = Array.isArray(value) ? `[${value.length}]` : "{...}";
      } else {
        compact[key] = value;
      }
    }
    const json = JSON.stringify(compact);
    return json && json !== "{}" ? json : "";
  }

  function pushDebug(level, message, meta = null) {
    const ts = new Date();
    const stamp = ts.toLocaleTimeString("pl-PL", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const line = {
      ts: stamp,
      level: level || "info",
      message: String(message || ""),
      meta: debugMetaString(meta),
    };
    state.debug.lines.push(line);
    if (state.debug.lines.length > 120) {
      state.debug.lines.splice(0, state.debug.lines.length - 120);
    }
  }

  function resetDebugForSession() {
    state.debug.lines = [];
    pushDebug("info", "Session debug log initialized");
  }

  function resetQuestionPrefetchState() {
    if (questionPrefetchDebounceTimer) {
      clearTimeout(questionPrefetchDebounceTimer);
      questionPrefetchDebounceTimer = null;
    }
    questionRequestCache.clear();
    questionRequestInflight.clear();
  }

  function ingestBackendTrace(result) {
    if (!result?.debug) return;
    const debug = result.debug;
    pushDebug("info", "analysis_result", {
      contentSource: result.contentSource,
      llmAttempted: debug.llmAttempted,
      llmSucceeded: debug.llmSucceeded,
      llmLatencyMs: debug.llmLatencyMs,
      llmThinkingLevel: debug.llmThinkingLevel,
      rewriteAttempted: debug.rewriteAttempted,
      rewriteSucceeded: debug.rewriteSucceeded,
      pipelineTotalMs: debug.pipelineTotalMs,
      connectivityStatus: result.connectivityStatus,
    });
    if (debug.qualitySignals) {
      pushDebug("info", "analysis_quality", debug.qualitySignals);
    }
    if (debug.passwordContextSummary) {
      pushDebug("info", "password_context_summary", {
        context: "analysis",
        count: debug.passwordContextSummary.count,
        duplicates: debug.passwordContextSummary.duplicateSanitizedCount,
        anyRepeated: debug.passwordContextSummary.anyRepeated,
        anyYearLike: debug.passwordContextSummary.anyYearLike,
        minLength: debug.passwordContextSummary.minLength,
        maxLength: debug.passwordContextSummary.maxLength,
        tags: (debug.passwordContextSummary.uniqueTagList || []).join("|"),
      });
    }
    if (debug.generationError) {
      pushDebug("error", "gemini_error", { error: debug.generationError });
    }
    if (Array.isArray(debug.trace)) {
      for (const item of debug.trace) {
        pushDebug(
          item.status === "error" ? "error" : item.status === "warn" ? "warn" : "ok",
          `[backend] ${item.step} (${item.status}) @${item.t_ms}ms`,
          item.meta || null,
        );
      }
    }
  }

  function ingestQuestionBackendTrace(index, payload) {
    if (!payload) return;
    const debug = payload.debug || {};
    pushDebug("info", "question_generated", {
      index,
      slotId: payload.question?.id,
      source: debug.source,
      llmAttempted: debug.llmAttempted,
      llmSucceeded: debug.llmSucceeded,
      llmLatencyMs: debug.llmLatencyMs,
      llmThinkingLevel: debug.llmThinkingLevel,
    });
    if (debug.qualitySignals) {
      pushDebug("info", "question_quality", {
        index,
        ...debug.qualitySignals,
      });
    }
    if (debug.passwordContextSummary) {
      pushDebug("info", "password_context_summary", {
        context: `question_${index}`,
        count: debug.passwordContextSummary.count,
        duplicates: debug.passwordContextSummary.duplicateSanitizedCount,
        anyRepeated: debug.passwordContextSummary.anyRepeated,
        anyYearLike: debug.passwordContextSummary.anyYearLike,
        minLength: debug.passwordContextSummary.minLength,
        maxLength: debug.passwordContextSummary.maxLength,
        tags: (debug.passwordContextSummary.uniqueTagList || []).join("|"),
      });
    }
    if (debug.generationError) {
      pushDebug("error", "question_gemini_error", { index, error: debug.generationError });
    }
    if (Array.isArray(debug.trace)) {
      for (const item of debug.trace) {
        pushDebug(
          item.status === "error" ? "error" : item.status === "warn" ? "warn" : "ok",
          `[q-backend:${index}] ${item.step} (${item.status}) @${item.t_ms}ms`,
          item.meta || null,
        );
      }
    }
  }

  function renderDebugTerminalHtml({ maxLines = 16 } = {}) {
    if (!state.debug.enabled) return "";
    const lines = state.debug.lines.slice(-maxLines);
    return `
      <div style="height: 12px"></div>
      <h2>DEBUG TERMINAL</h2>
      <div class="debug-terminal">
        ${
          lines.length
            ? lines
                .map(
                  (line) => `
              <div class="debug-line ${line.level}">
                <span class="ts">${escapeHtml(line.ts)}</span>
                <span class="lvl">[${escapeHtml(line.level.toUpperCase())}]</span>
                <span class="msg">${escapeHtml(line.message)}</span>
                ${line.meta ? `<div class="meta">${escapeHtml(line.meta)}</div>` : ""}
              </div>
            `,
                )
                .join("")
            : `<div class="debug-line info"><span class="msg">No debug events yet.</span></div>`
        }
      </div>
    `;
  }

  function parseIpcErrorPayload(error) {
    const raw = String(error?.message || error || "");
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // ignore parse error and fallback to heuristic classification
    }
    return {
      code: "unknown_error",
      reasonCode: classifyReasonCodeFromMessage(raw),
      message: raw || "unknown_error",
    };
  }

  function classifyReasonCodeFromMessage(message) {
    const lower = String(message || "").toLowerCase();
    if (lower.includes("missing_api_key")) return LLM_REASON_CODES.MISSING_API_KEY;
    if (lower.includes("model_not_found") || lower.includes("no longer available")) return LLM_REASON_CODES.MODEL_NOT_FOUND;
    if (lower.includes("timeout")) return LLM_REASON_CODES.TIMEOUT;
    if (lower.includes("offline") || lower.includes("fetch failed") || lower.includes("network")) return LLM_REASON_CODES.OFFLINE;
    if (lower.includes("http")) return LLM_REASON_CODES.HTTP_ERROR;
    return LLM_REASON_CODES.UNKNOWN;
  }

  function touch() {
    state.lastInteractionAt = Date.now();
  }

  function createSession() {
    return {
      sessionId: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      meta: {
        uiVersion: state.bootstrap?.app?.version || "0.1.0",
      },
    };
  }

  function resetToAttractor(reason = "manual_reset") {
    pushDebug("info", "reset_to_attractor", { reason });
    resetQuestionPrefetchState();
    state.screen = SCREEN_IDS.ATTRACTOR;
    state.language = null;
    state.session = null;
    state.login = "";
    state.passwordAttempts = [];
    state.answers = {};
    state.questionHistory = [];
    state.arcState = {
      usedIntents: [],
      usedRhetoricalForms: [],
      usedAnchors: [],
      verbatimQuoteCount: 0,
    };
    state.dynamicQuestions = [];
    state.dynamicQuestionSignatures = [];
    state.dynamicQuestionPayloads = [];
    state.questionIndex = 0;
    state.questionLoadingIndex = -1;
    state.questionTransition = {
      token: state.questionTransition.token + 1,
      nextIndex: -1,
      line: "",
      ready: false,
      skipRequested: false,
      shownAt: 0,
      interpretationLine: "",
      loading: false,
    };
    state.choiceIndex = 0;
    state.message = "";
    state.handoffEndsAt = 0;
    state.analysisStartedAt = 0;
    state.analysisTickAt = 0;
    state.analysisLogIndex = 0;
    state.analysisProgressPct = 0;
    state.result = null;
    state.receiptPreviewViewed = false;
    state.pending = false;
    state.lastScreenEventSent = null;
    state.adminLock = {
      reasonCode: LLM_REASON_CODES.UNKNOWN,
      operatorMessage: "",
      checkedAt: "",
      context: "",
    };
    tempInputs.login = "";
    tempInputs.password1 = "";
    tempInputs.password2 = "";
    tempInputs.password3 = "";
    tempInputs.questionText = "";
    touch();
    render();
    api.logEvent("session_reset", { reason }).catch(() => {});
  }

  function beginSessionFlow() {
    resetQuestionPrefetchState();
    state.session = createSession();
    pushDebug("info", "session_started", { sessionId: state.session.sessionId });
    state.screen = SCREEN_IDS.LANGUAGE;
    state.language = null;
    state.choiceIndex = 0;
    state.message = "";
    state.passwordAttempts = [];
    state.answers = {};
    state.questionHistory = [];
    state.arcState = {
      usedIntents: [],
      usedRhetoricalForms: [],
      usedAnchors: [],
      verbatimQuoteCount: 0,
    };
    state.dynamicQuestions = [];
    state.dynamicQuestionSignatures = [];
    state.dynamicQuestionPayloads = [];
    state.questionTransition = {
      token: state.questionTransition.token + 1,
      nextIndex: -1,
      line: "",
      ready: false,
      skipRequested: false,
      shownAt: 0,
      interpretationLine: "",
      loading: false,
    };
    state.questionLoadingIndex = -1;
    state.result = null;
    state.lastScreenEventSent = null;
    touch();
    render();
    api.logEvent("session_started", { session_id: state.session.sessionId }).catch(() => {});
  }

  function enterAdminLock({
    reasonCode = LLM_REASON_CODES.UNKNOWN,
    operatorMessage = "",
    checkedAt = "",
    context = "unknown",
    source = "runtime",
  }) {
    const preservedLanguage = state.language || null;
    resetToAttractor("llm_required_lock");
    state.screen = SCREEN_IDS.ADMIN_LOCK;
    state.language = preservedLanguage;
    state.adminLock = {
      reasonCode: String(reasonCode || LLM_REASON_CODES.UNKNOWN),
      operatorMessage: String(operatorMessage || ""),
      checkedAt: String(checkedAt || new Date().toISOString()),
      context: String(context || "unknown"),
    };
    state.pending = false;
    state.message = "";
    pushDebug("warn", "admin_lock_entered", {
      source,
      reasonCode: state.adminLock.reasonCode,
      context: state.adminLock.context,
    });
    api.logEvent("llm_admin_lock", {
      source,
      reason_code: state.adminLock.reasonCode,
      context: state.adminLock.context,
    }).catch(() => {});
    touch();
    render();
  }

  async function runLlmPreflight(context = "session_start") {
    pushDebug("info", "llm_preflight_started", { context });
    api.logEvent("llm_preflight_started", { context }).catch(() => {});

    try {
      const response = await api.checkLlmAvailability();
      if (response?.available) {
        pushDebug("ok", "llm_preflight_succeeded", {
          context,
          checkedAt: response.checkedAt,
        });
        api.logEvent("llm_preflight_succeeded", { context }).catch(() => {});
        return {
          available: true,
          reasonCode: LLM_REASON_CODES.OK,
          operatorMessage: "LLM available",
          checkedAt: response.checkedAt || new Date().toISOString(),
        };
      }

      const reasonCode = String(response?.reasonCode || LLM_REASON_CODES.UNKNOWN);
      const operatorMessage = String(response?.operatorMessage || "LLM unavailable");
      pushDebug("warn", "llm_preflight_failed", {
        context,
        reasonCode,
        operatorMessage,
      });
      api.logEvent("llm_preflight_failed", { context, reason_code: reasonCode }).catch(() => {});
      return {
        available: false,
        reasonCode,
        operatorMessage,
        checkedAt: response?.checkedAt || new Date().toISOString(),
      };
    } catch (error) {
      const parsed = parseIpcErrorPayload(error);
      const reasonCode = String(parsed.reasonCode || LLM_REASON_CODES.UNKNOWN);
      const operatorMessage = String(parsed.message || "LLM availability check failed");
      pushDebug("error", "llm_preflight_error", {
        context,
        reasonCode,
        operatorMessage,
      });
      api.logEvent("llm_preflight_failed", { context, reason_code: reasonCode }).catch(() => {});
      return {
        available: false,
        reasonCode,
        operatorMessage,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  async function startFlow() {
    if (state.pending) return;
    resetDebugForSession();
    resetQuestionPrefetchState();
    state.pending = true;
    touch();
    render();
    const preflight = await runLlmPreflight("session_start");
    state.pending = false;
    if (!preflight.available) {
      enterAdminLock({
        reasonCode: preflight.reasonCode,
        operatorMessage: preflight.operatorMessage,
        checkedAt: preflight.checkedAt,
        context: "session_start",
        source: "preflight",
      });
      return;
    }
    beginSessionFlow();
  }

  async function retryFromAdminLock() {
    if (state.pending) return;
    state.pending = true;
    render();
    const preflight = await runLlmPreflight("admin_retry");
    state.pending = false;
    if (!preflight.available) {
      enterAdminLock({
        reasonCode: preflight.reasonCode,
        operatorMessage: preflight.operatorMessage,
        checkedAt: preflight.checkedAt,
        context: "admin_retry",
        source: "preflight",
      });
      return;
    }
    pushDebug("ok", "admin_lock_cleared", { checkedAt: preflight.checkedAt });
    resetToAttractor("llm_recovered");
  }

  function logSessionEvent(eventType, screenId = state.screen, meta = {}) {
    if (!state.session?.sessionId) return;
    api
      .logSessionEvent({
        sessionId: state.session.sessionId,
        eventType: String(eventType || "session_event"),
        screenId: String(screenId || state.screen || ""),
        meta: meta || {},
      })
      .catch(() => {});
  }

  function abortSessionToAdminLock(error, context = "runtime_failure") {
    const parsed = parseIpcErrorPayload(error);
    const reasonCode = String(parsed.reasonCode || LLM_REASON_CODES.UNKNOWN);
    const operatorMessage = String(parsed.message || "LLM pipeline failed");
    const sessionId = state.session?.sessionId || null;

    pushDebug("error", "session_aborted_llm_unavailable", {
      context,
      reasonCode,
      message: operatorMessage,
    });

    if (sessionId) {
      logSessionEvent("session_aborted_llm_unavailable", state.screen, {
        context,
        reason_code: reasonCode,
        message: operatorMessage,
      });
      api.logQualityEvent({
        sessionId,
        stage: context.includes("question") ? "question" : "report",
        metricName: "llm_hard_block",
        metricValue: 1,
        meta: { context, reason_code: reasonCode },
      }).catch(() => {});
      api.logQualityEvent({
        sessionId,
        stage: context.includes("question") ? "question" : "report",
        metricName: "llm_reason_code",
        metricValue: 1,
        meta: { context, reason_code: reasonCode },
      }).catch(() => {});
    }

    api.logEvent("session_aborted_llm_unavailable", {
      session_id: sessionId,
      context,
      reason_code: reasonCode,
    }).catch(() => {});

    enterAdminLock({
      reasonCode,
      operatorMessage,
      checkedAt: new Date().toISOString(),
      context,
      source: "runtime",
    });
  }

  function emitScreenEnteredIfNeeded() {
    if (!state.session?.sessionId) return;
    if (state.lastScreenEventSent === state.screen) return;
    state.lastScreenEventSent = state.screen;
    logSessionEvent("screen_entered", state.screen, {
      language: state.language || null,
    });
  }

  function setLanguage(lang) {
    state.language = lang === "en" ? "en" : "pl";
    pushDebug("info", "language_selected", { language: state.language });
    state.screen = SCREEN_IDS.LOGIN;
    state.choiceIndex = 0;
    state.message = "";
    touch();
    render();
  }

  function submitLogin() {
    const c = currentCopy();
    const raw = tempInputs.login;
    const checked = api.validateLogin(raw);
    if (!checked.ok) {
      logSessionEvent("input_rejected", state.screen, {
        input: "login",
        reason: checked.reason,
      });
      pushDebug("warn", "login_validation_failed", { reason: checked.reason });
      state.message =
        checked.reason === "too_long"
          ? c.validationTooLong
          : checked.reason === "too_short"
            ? c.validationTooShort
            : c.validationRejected;
      render();
      focusPrimaryInput();
      return;
    }

    state.pending = true;
    logSessionEvent("input_submitted", state.screen, {
      input: "login",
      value: checked.normalized,
    });
    pushDebug("info", "login_screening_started", { login: checked.normalized });
    render();

    api
      .screenUserText("login", checked.normalized)
      .then((screened) => {
        if (!screened.safe) {
          logSessionEvent("input_rejected", state.screen, {
            input: "login",
            reason: "screening_rejected",
            flags: screened.flags,
          });
          pushDebug("warn", "login_screening_rejected", screened.flags);
          state.message = c.validationRejected;
          state.pending = false;
          render();
          focusPrimaryInput();
          return;
        }
        state.login = checked.normalized;
        pushDebug("ok", "login_accepted", { login: state.login });
        state.message = "";
        state.pending = false;
        state.screen = SCREEN_IDS.PASSWORD1;
        touch();
        render();
      })
      .catch(() => {
        state.login = checked.normalized;
        pushDebug("warn", "login_screening_error_bypass", { login: state.login });
        logSessionEvent("input_submitted", state.screen, {
          input: "login",
          reason: "screening_error_bypass",
        });
        state.message = "";
        state.pending = false;
        state.screen = SCREEN_IDS.PASSWORD1;
        render();
      });
  }

  function submitPassword(rawPassword = "") {
    const c = currentCopy();
    const attempt =
      state.screen === SCREEN_IDS.PASSWORD1 ? 1 : state.screen === SCREEN_IDS.PASSWORD2 ? 2 : state.screen === SCREEN_IDS.PASSWORD3 ? 3 : 0;
    if (attempt > 0) {
      state.passwordAttempts[attempt - 1] = String(rawPassword || "").slice(0, 64);
      logSessionEvent("input_submitted", state.screen, {
        input: `password_${attempt}`,
        length: state.passwordAttempts[attempt - 1].length,
      });
      pushDebug("info", "password_attempt_captured", {
        attempt,
        length: state.passwordAttempts[attempt - 1].length,
      });
      logPasswordSummaryPreview(`password_attempt_${attempt}`);
    }
    if (state.screen === SCREEN_IDS.PASSWORD1) {
      pushDebug("warn", "password_attempt_failed", { attempt: 1 });
      logSessionEvent("password_attempt_failed", state.screen, { attempt: 1 });
      state.message = c.invalidPassword1;
      state.screen = SCREEN_IDS.PASSWORD2;
    } else if (state.screen === SCREEN_IDS.PASSWORD2) {
      pushDebug("warn", "password_attempt_failed", { attempt: 2 });
      logSessionEvent("password_attempt_failed", state.screen, { attempt: 2 });
      state.message = c.invalidPassword2;
      state.screen = SCREEN_IDS.PASSWORD3;
    } else if (state.screen === SCREEN_IDS.PASSWORD3) {
      pushDebug("warn", "password_attempt_failed", { attempt: 3, lockout: true });
      logSessionEvent("password_attempt_failed", state.screen, { attempt: 3, lockout: true });
      state.message = c.invalidPassword3;
      state.screen = SCREEN_IDS.HANDOFF;
      state.handoffEndsAt = 0;
      api.playCue("lock").catch(() => {});
    }
    touch();
    render();
  }

  function getQuestion() {
    return state.dynamicQuestions[state.questionIndex] || questions[state.questionIndex] || null;
  }

  function getQuestionSlot(index = state.questionIndex) {
    return questions[index] || null;
  }

  function getQuestionCount() {
    return questions.length;
  }

  function passwordSummaryPreviewFromAttempts(attempts) {
    const list = Array.isArray(attempts) ? attempts.filter(Boolean).map(String) : [];
    const lengths = list.map((v) => v.length);
    const duplicates = new Set(list).size < list.length;
    const anyRepeated = list.some((v) => /(.)\1{2,}/.test(v));
    const anyYearLike = list.some((v) => /\d{4}/.test(v));
    return {
      count: list.length,
      lengths: lengths.join(",") || "-",
      duplicates,
      anyRepeated,
      anyYearLike,
    };
  }

  function logPasswordSummaryPreview(context = "runtime") {
    const summary = passwordSummaryPreviewFromAttempts(state.passwordAttempts);
    pushDebug("info", "password_context_summary", { context, ...summary });
  }

  function questionPromptText(question) {
    if (!question) return "";
    if (typeof question.prompt === "string") return question.prompt;
    return question.prompt?.[state.language] || question.prompt?.pl || "";
  }

  function questionPlaceholderText(question) {
    if (!question) return "";
    if (typeof question.placeholder === "string") return question.placeholder;
    return question.placeholder?.[state.language] || question.placeholder?.pl || "";
  }

  function questionOptionLabel(opt) {
    if (!opt) return "";
    if (typeof opt.label === "string") return opt.label;
    return opt.label?.[state.language] || opt.label?.pl || opt.value || "";
  }

  function countVerbatimQuotes(text) {
    const matches = String(text || "").match(/"[^"\n]{1,60}"/g);
    return Array.isArray(matches) ? matches.length : 0;
  }

  function normalizeRuntimeQuestion(question, slot) {
    if (!question || !slot) return null;
    if (slot.type === "choice") {
      const provided = Array.isArray(question.options) ? question.options : [];
      const map = new Map(
        provided.map((opt) => {
          const label =
            typeof opt.label === "string"
              ? opt.label
              : opt.label?.[state.language] || opt.label?.pl || opt.value;
          return [String(opt.value), { value: String(opt.value), label: String(label || opt.value) }];
        }),
      );
      return {
        id: slot.id,
        type: "choice",
        stageLabel:
          (typeof slot.stageLabel?.[state.language] === "string" && slot.stageLabel[state.language])
          || slot.stageLabel?.pl
          || "",
        intentTag: String(question.intentTag || slot.intentTag || ""),
        rhetoricalForm: String(question.rhetoricalForm || "probe"),
        transitionLine: typeof question.transitionLine === "string" ? question.transitionLine : "",
        meta: question.meta || null,
        prompt: typeof question.prompt === "string" && question.prompt.trim()
          ? question.prompt.trim()
          : slot.prompt?.[state.language] || slot.prompt?.pl || slot.id,
        maxLength: slot.maxLength || 32,
        options: (slot.options || []).map((opt) => ({
          value: opt.value,
          label:
            map.get(opt.value)?.label ||
            (typeof opt.label === "string" ? opt.label : opt.label?.[state.language] || opt.label?.pl || opt.value),
        })),
      };
    }

    return {
      id: slot.id,
      type: "text",
      stageLabel:
        (typeof slot.stageLabel?.[state.language] === "string" && slot.stageLabel[state.language])
        || slot.stageLabel?.pl
        || "",
      intentTag: String(question.intentTag || slot.intentTag || ""),
      rhetoricalForm: String(question.rhetoricalForm || "probe"),
      transitionLine: typeof question.transitionLine === "string" ? question.transitionLine : "",
      meta: question.meta || null,
      prompt: typeof question.prompt === "string" && question.prompt.trim()
        ? question.prompt.trim()
        : slot.prompt?.[state.language] || slot.prompt?.pl || slot.id,
      placeholder: typeof question.placeholder === "string" ? question.placeholder : questionPlaceholderText(slot),
      minLength: slot.minLength || 1,
      maxLength: slot.maxLength || 24,
    };
  }

  function buildQuestionHistoryWithDraftCurrentAnswer(index, draftAnswerValue, draftAnswerLabel) {
    const currentQuestion = state.dynamicQuestions[index] || getQuestion();
    const base = state.questionHistory
      .filter((item) => Number(item.index) < index)
      .map((item) => ({ ...item }));

    if (currentQuestion && index === state.questionIndex && draftAnswerValue !== undefined && draftAnswerValue !== null) {
      base.push({
        index,
        id: currentQuestion.id,
        type: currentQuestion.type,
        intentTag: currentQuestion.intentTag || "",
        rhetoricalForm: currentQuestion.rhetoricalForm || "",
        prompt: questionPromptText(currentQuestion),
        answerValue: String(draftAnswerValue),
        answerLabel: String(draftAnswerLabel ?? draftAnswerValue),
      });
    }
    return base;
  }

  function buildQuestionRequestPayload(index, historyOverride) {
    return {
      sessionId: state.session?.sessionId || "",
      language: state.language,
      login: state.login,
      passwordAttempts: [...(state.passwordAttempts || [])],
      questionIndex: index,
      previousHistory: Array.isArray(historyOverride) ? historyOverride : state.questionHistory,
      arcState: {
        usedIntents: [...state.arcState.usedIntents],
        usedRhetoricalForms: [...state.arcState.usedRhetoricalForms],
        usedAnchors: [...state.arcState.usedAnchors],
        verbatimQuoteCount: state.arcState.verbatimQuoteCount,
      },
      experienceProfile: "controlled_arc_balanced",
    };
  }

  function questionRequestSignature(payload) {
    const compactHistory = (payload.previousHistory || []).map((item) => ({
      id: item.id,
      prompt: item.prompt,
      answerValue: item.answerValue,
      answerLabel: item.answerLabel,
    }));
    return JSON.stringify({
      sessionId: payload.sessionId,
      language: payload.language,
      login: payload.login,
      questionIndex: payload.questionIndex,
      passwordAttempts: payload.passwordAttempts || [],
      previousHistory: compactHistory,
      arcState: payload.arcState || {},
      experienceProfile: payload.experienceProfile || "controlled_arc_balanced",
    });
  }

  function cacheQuestionResult(signature, payload, runtimeQuestion, rawPayload) {
    questionRequestCache.set(signature, {
      signature,
      payload,
      runtimeQuestion,
      rawPayload,
      cachedAt: Date.now(),
    });
    if (questionRequestCache.size > 40) {
      const firstKey = questionRequestCache.keys().next().value;
      if (firstKey) questionRequestCache.delete(firstKey);
    }
  }

  function getCachedQuestionResult(signature) {
    return questionRequestCache.get(signature) || null;
  }

  function recordQuestionAnswer(question, answerValue, answerLabel) {
    if (!question) return;
    const entry = {
      index: state.questionIndex,
      id: question.id,
      type: question.type,
      intentTag: question.intentTag || "",
      rhetoricalForm: question.rhetoricalForm || "",
      stageLabel: question.stageLabel || "",
      prompt: questionPromptText(question),
      transitionLine: question.transitionLine || "",
      answerValue: String(answerValue ?? ""),
      answerLabel: String(answerLabel ?? answerValue ?? ""),
      anchorTokens: Array.isArray(question.meta?.anchorTokens) ? question.meta.anchorTokens : [],
    };
    const existingIndex = state.questionHistory.findIndex((item) => item.id === entry.id);
    if (existingIndex >= 0) state.questionHistory[existingIndex] = entry;
    else state.questionHistory.push(entry);

    if (entry.intentTag && !state.arcState.usedIntents.includes(entry.intentTag)) {
      state.arcState.usedIntents.push(entry.intentTag);
    }
    if (entry.rhetoricalForm && !state.arcState.usedRhetoricalForms.includes(entry.rhetoricalForm)) {
      state.arcState.usedRhetoricalForms.push(entry.rhetoricalForm);
    }
    for (const token of entry.anchorTokens || []) {
      const normalized = String(token || "").toLowerCase();
      if (!normalized) continue;
      if (!state.arcState.usedAnchors.includes(normalized)) {
        state.arcState.usedAnchors.push(normalized);
      }
    }
    state.arcState.verbatimQuoteCount = Math.min(
      2,
      state.arcState.verbatimQuoteCount + countVerbatimQuotes(entry.prompt),
    );
  }

  function buildInterpretationLineFromHistory(history = state.questionHistory) {
    const last = Array.isArray(history) ? history[history.length - 1] : null;
    const answer = String(last?.answerLabel || last?.answerValue || "").trim();
    if (!answer) {
      return state.language === "en"
        ? "Interpreting response pattern before next test..."
        : "Interpretuję wzorzec odpowiedzi przed kolejnym testem...";
    }
    if (state.language === "en") {
      return `Pattern registered: "${answer}". Reframing next test...`;
    }
    return `Zarejestrowano wzorzec: "${answer}". Przechodzę do kolejnego testu...`;
  }

  async function ensureAdaptiveQuestionLoaded(index = state.questionIndex, options = {}) {
    const slot = getQuestionSlot(index);
    if (!slot || !state.session) return;
    const commit = options.commit !== false;
    const silent = Boolean(options.silent);
    const historyOverride = Array.isArray(options.historyOverride) ? options.historyOverride : undefined;
    const payloadRequest = buildQuestionRequestPayload(index, historyOverride);
    const signature = questionRequestSignature(payloadRequest);

    if (commit && state.dynamicQuestions[index] && state.dynamicQuestionSignatures[index] === signature) {
      return state.dynamicQuestions[index];
    }

    const cached = getCachedQuestionResult(signature);
    if (cached) {
      if (commit) {
        state.dynamicQuestions[index] = cached.runtimeQuestion;
        state.dynamicQuestionSignatures[index] = signature;
        state.dynamicQuestionPayloads[index] = cached.rawPayload || null;
        if (!silent) {
          pushDebug("ok", "question_generation_cache_hit", {
            index,
            slotId: cached.runtimeQuestion?.id,
          });
          state.questionLoadingIndex = -1;
          state.pending = false;
          state.message = "";
          render();
          maybePrefetchNextQuestion("cache_hit");
        }
      } else if (!silent) {
        pushDebug("ok", "question_prefetch_cache_hit", { index, slotId: cached.runtimeQuestion?.id });
      }
      return cached.runtimeQuestion;
    }

    if (!silent) {
      state.questionLoadingIndex = index;
      state.pending = true;
      state.message = state.language === "en" ? "Generating next question..." : "Generowanie kolejnego pytania...";
      pushDebug("info", "question_generation_started", {
        index,
        slotId: slot.id,
        previousCount: (payloadRequest.previousHistory || []).length,
        prefetch: options.prefetch ? true : false,
      });
      render();
    } else if (options.prefetch) {
      pushDebug("info", "question_prefetch_started", {
        index,
        slotId: slot.id,
        previousCount: (payloadRequest.previousHistory || []).length,
        reason: options.prefetchReason || "speculative",
      });
    }

    const requestPromise =
      questionRequestInflight.get(signature) ||
      (async () => {
        const payload = await api.getAdaptiveQuestion(payloadRequest);
        const runtimeQuestion = normalizeRuntimeQuestion(
          {
            ...(payload?.question || {}),
            transitionLine: payload?.transitionLine || payload?.question?.transitionLine || "",
            intentTag: payload?.meta?.intentTag || payload?.question?.intentTag || slot.intentTag || "",
            rhetoricalForm: payload?.meta?.rhetoricalForm || payload?.question?.rhetoricalForm || "probe",
            meta: payload?.meta || null,
          },
          slot,
        );
        if (!runtimeQuestion) throw new Error("No runtime question");
        cacheQuestionResult(signature, payloadRequest, runtimeQuestion, payload);
        return { payload, runtimeQuestion };
      })();

    if (!questionRequestInflight.has(signature)) {
      questionRequestInflight.set(signature, requestPromise);
      requestPromise.finally(() => {
        questionRequestInflight.delete(signature);
      });
    }

    try {
      const { payload, runtimeQuestion } = await requestPromise;

      if (commit) {
        state.dynamicQuestions[index] = runtimeQuestion;
        state.dynamicQuestionSignatures[index] = signature;
        state.dynamicQuestionPayloads[index] = payload || null;
        ingestQuestionBackendTrace(index, payload);
        pushDebug("ok", "question_generation_ready", {
          index,
          slotId: runtimeQuestion.id,
          source: payload?.debug?.source || "unknown",
        });
      } else if (options.prefetch) {
        pushDebug("ok", "question_prefetch_ready", {
          index,
          slotId: runtimeQuestion.id,
          source: payload?.debug?.source || "unknown",
          reason: options.prefetchReason || "speculative",
        });
      }

      return runtimeQuestion;
    } catch (error) {
      if (commit) {
        pushDebug("error", "question_generation_hard_fail", {
          index,
          error: String(error?.message || error),
        });
        throw error;
      }
      pushDebug("warn", "question_prefetch_failed", {
        index,
        error: String(error?.message || error),
      });
      return null;
    } finally {
      if (!silent && commit) {
        state.questionLoadingIndex = -1;
        state.pending = false;
        state.message = "";
        render();
        maybePrefetchNextQuestion("after_commit");
      }
    }
  }

  function maybePrefetchNextQuestion(reason = "unknown") {
    if (state.screen !== SCREEN_IDS.QUESTION) return;
    if (state.questionLoadingIndex === state.questionIndex) return;
    const currentIndex = state.questionIndex;
    const nextIndex = currentIndex + 1;
    if (nextIndex >= getQuestionCount()) return;
    const currentQuestion = getQuestion();
    if (!currentQuestion) return;

    let draftValue = null;
    let draftLabel = null;

    if (currentQuestion.type === "choice") {
      const selected = currentQuestion.options?.[state.choiceIndex];
      if (!selected) return;
      draftValue = selected.value;
      draftLabel = questionOptionLabel(selected);
      void ensureAdaptiveQuestionLoaded(nextIndex, {
        historyOverride: buildQuestionHistoryWithDraftCurrentAnswer(currentIndex, draftValue, draftLabel),
        silent: true,
        commit: false,
        prefetch: true,
        prefetchReason: `${reason}:choice_preview`,
      });
      return;
    }

    const normalizedDraft = api.normalizeTextInput(tempInputs.questionText || "");
    if (!normalizedDraft) return;
    if (questionPrefetchDebounceTimer) clearTimeout(questionPrefetchDebounceTimer);
    questionPrefetchDebounceTimer = setTimeout(() => {
      questionPrefetchDebounceTimer = null;
      if (state.screen !== SCREEN_IDS.QUESTION || state.questionIndex !== currentIndex) return;
      void ensureAdaptiveQuestionLoaded(nextIndex, {
        historyOverride: buildQuestionHistoryWithDraftCurrentAnswer(currentIndex, normalizedDraft, normalizedDraft),
        silent: true,
        commit: false,
        prefetch: true,
        prefetchReason: `${reason}:text_draft`,
      });
    }, 350);
  }

  function enterQuestionFlow() {
    pushDebug("info", "question_flow_entered", { count: getQuestionCount() });
    logPasswordSummaryPreview("enter_question_flow");
    state.screen = SCREEN_IDS.QUESTION;
    state.questionIndex = 0;
    state.dynamicQuestions = [];
    state.dynamicQuestionSignatures = [];
    state.dynamicQuestionPayloads = [];
    state.questionHistory = [];
    state.arcState = {
      usedIntents: [],
      usedRhetoricalForms: [],
      usedAnchors: [],
      verbatimQuoteCount: 0,
    };
    state.questionTransition = {
      token: state.questionTransition.token + 1,
      nextIndex: -1,
      line: "",
      ready: false,
      skipRequested: false,
      shownAt: 0,
      interpretationLine: "",
      loading: false,
    };
    state.choiceIndex = 0;
    state.questionLoadingIndex = 0;
    state.pending = true;
    state.message = state.language === "en" ? "Generating first question..." : "Generowanie pierwszego pytania...";
    tempInputs.questionText = "";
    touch();
    render();
    ensureAdaptiveQuestionLoaded(0);
  }

  function moveChoice(delta) {
    const screen = state.screen;
    if (screen === SCREEN_IDS.LANGUAGE) {
      state.choiceIndex = (state.choiceIndex + delta + 2) % 2;
      render();
      return;
    }
    if (screen === SCREEN_IDS.QUESTION) {
      const q = getQuestion();
      if (!q || q.type !== "choice") return;
      const len = q.options.length;
      state.choiceIndex = (state.choiceIndex + delta + len) % len;
      render();
      maybePrefetchNextQuestion("move_choice");
    }
  }

  function submitQuestionChoice(value) {
    const q = getQuestion();
    if (!q || q.type !== "choice") return;
    logSessionEvent("input_submitted", state.screen, {
      input: q.id,
      type: "choice",
      value: String(value),
    });
    state.answers[q.id] = String(value);
    const selected = (q.options || []).find((opt) => String(opt.value) === String(value));
    recordQuestionAnswer(q, value, questionOptionLabel(selected) || value);
    pushDebug("ok", "question_answer_choice", { questionId: q.id, value: state.answers[q.id] });
    state.message = "";
    advanceQuestionOrAnalyze();
  }

  function submitQuestionText() {
    const q = getQuestion();
    if (!q || q.type !== "text") return;
    const c = currentCopy();
    const raw = tempInputs.questionText;
    const checked = api.validateTextAnswer(raw, {
      minLength: q.minLength || 1,
      maxLength: q.maxLength || 24,
    });
    if (!checked.ok) {
      logSessionEvent("input_rejected", state.screen, {
        input: q.id,
        type: "text",
        reason: checked.reason,
      });
      pushDebug("warn", "question_validation_failed", { questionId: q.id, reason: checked.reason });
      state.message =
        checked.reason === "too_long"
          ? c.validationTooLong
          : checked.reason === "too_short"
            ? c.validationTooShort
            : c.validationRejected;
      render();
      focusPrimaryInput();
      return;
    }

    state.pending = true;
    logSessionEvent("input_submitted", state.screen, {
      input: q.id,
      type: "text",
      value: checked.normalized,
    });
    pushDebug("info", "question_screening_started", { questionId: q.id });
    render();

    api
      .screenUserText(q.id, checked.normalized)
      .then((screened) => {
        state.pending = false;
        if (!screened.safe) {
          logSessionEvent("input_rejected", state.screen, {
            input: q.id,
            type: "text",
            reason: "screening_rejected",
            flags: screened.flags,
          });
          pushDebug("warn", "question_screening_rejected", { questionId: q.id, flags: screened.flags });
          state.message = c.validationRejected;
          render();
          focusPrimaryInput();
          return;
        }
        state.answers[q.id] = checked.normalized;
        recordQuestionAnswer(q, checked.normalized, checked.normalized);
        pushDebug("ok", "question_answer_text", { questionId: q.id, value: checked.normalized });
        state.message = "";
        advanceQuestionOrAnalyze();
      })
      .catch(() => {
        state.pending = false;
        state.answers[q.id] = checked.normalized;
        recordQuestionAnswer(q, checked.normalized, checked.normalized);
        pushDebug("warn", "question_screening_error_bypass", { questionId: q.id });
        logSessionEvent("input_submitted", state.screen, {
          input: q.id,
          type: "text",
          reason: "screening_error_bypass",
        });
        state.message = "";
        advanceQuestionOrAnalyze();
      });
  }

  function finalizeQuestionTransition(nextIndex, token, reason = "auto") {
    if (token !== state.questionTransition.token) return;
    const shownMs = Math.max(0, Date.now() - state.questionTransition.shownAt);
    logSessionEvent("question_transition_shown", SCREEN_IDS.QUESTION_TRANSITION, {
      next_index: nextIndex,
      transition_shown_ms: shownMs,
      reason,
    });
    if (state.session?.sessionId) {
      api.logQualityEvent({
        sessionId: state.session.sessionId,
        stage: "question",
        metricName: "transition_shown_ms",
        metricValue: shownMs,
        meta: {
          next_index: nextIndex,
          reason,
        },
      }).catch(() => {});
    }
    state.questionIndex = nextIndex;
    state.choiceIndex = 0;
    state.screen = SCREEN_IDS.QUESTION;
    state.questionTransition.ready = false;
    state.questionTransition.loading = false;
    state.questionTransition.line = "";
    state.questionTransition.skipRequested = false;
    state.questionTransition.interpretationLine = "";
    state.questionLoadingIndex = -1;
    state.pending = false;
    state.message = "";
    tempInputs.questionText = "";
    render();
    maybePrefetchNextQuestion("post_submit");
  }

  async function beginQuestionTransition(nextIndex) {
    const token = state.questionTransition.token + 1;
    const minDuration = 600 + Math.floor(Math.random() * 601);
    state.questionTransition = {
      token,
      nextIndex,
      line: "",
      ready: false,
      skipRequested: false,
      shownAt: Date.now(),
      interpretationLine: buildInterpretationLineFromHistory(),
      loading: true,
    };
    state.screen = SCREEN_IDS.QUESTION_TRANSITION;
    state.pending = true;
    state.message = "";
    render();

    const historySnapshot = state.questionHistory.map((item) => ({ ...item }));
    const loadStartedAt = Date.now();
    let runtimeQuestion = null;

    try {
      const minDelay = delay(minDuration);
      const load = ensureAdaptiveQuestionLoaded(nextIndex, {
        historyOverride: historySnapshot,
        commit: true,
        silent: true,
      });
      [runtimeQuestion] = await Promise.all([load, minDelay]);
    } catch (error) {
      pushDebug("error", "question_transition_load_failed", {
        index: nextIndex,
        error: String(error?.message || error),
      });
      abortSessionToAdminLock(error, "question_transition_generation");
      return;
    }

    if (token !== state.questionTransition.token) return;

    const loadMs = Math.max(0, Date.now() - loadStartedAt);
    const transitionLine = runtimeQuestion?.transitionLine || buildInterpretationLineFromHistory(historySnapshot);
    state.questionTransition.line = transitionLine;
    state.questionTransition.ready = true;
    state.questionTransition.loading = false;
    if (loadMs > 1800) {
      state.questionTransition.interpretationLine = buildInterpretationLineFromHistory(historySnapshot);
    }
    render();

    if (state.questionTransition.skipRequested) {
      finalizeQuestionTransition(nextIndex, token, "user_skip");
      return;
    }

    setTimeout(() => {
      finalizeQuestionTransition(nextIndex, token, "auto");
    }, 360);
  }

  function advanceQuestionOrAnalyze() {
    touch();
    if (state.questionIndex < getQuestionCount() - 1) {
      const nextIndex = state.questionIndex + 1;
      state.questionLoadingIndex = nextIndex;
      void beginQuestionTransition(nextIndex);
      return;
    }
    beginAnalysis();
  }

  async function beginAnalysis() {
    state.screen = SCREEN_IDS.ANALYSIS;
    state.analysisStartedAt = Date.now();
    state.analysisTickAt = Date.now();
    state.analysisLogIndex = 0;
    state.analysisProgressPct = 3;
    state.pending = true;
    state.message = "";
    pushDebug("info", "analysis_started", {
      sessionId: state.session?.sessionId,
      language: state.language,
      login: state.login,
      answers: state.answers,
      questionHistoryCount: state.questionHistory.length,
      passwordAttemptsCount: state.passwordAttempts.filter(Boolean).length,
    });
    logSessionEvent("analysis_started", SCREEN_IDS.ANALYSIS, {
      language: state.language,
      question_history_count: state.questionHistory.length,
    });
    touch();
    render();
    api.logEvent("analysis_started", { session_id: state.session?.sessionId }).catch(() => {});

    const minDelay = delay(state.bootstrap?.app?.analysisMinMs || 3000);
    let result = null;

    try {
      result = await api.generateResult({
        sessionId: state.session.sessionId,
        startedAt: state.session.startedAt,
        language: state.language,
        login: state.login,
        passwordAttempts: state.passwordAttempts,
        answers: state.answers,
        questionHistory: state.questionHistory,
        arcState: state.arcState,
        meta: state.session.meta,
      });
      pushDebug("ok", "analysis_ipc_returned", { hasResult: Boolean(result) });
    } catch (error) {
      pushDebug("error", "analysis_ipc_failed", { error: String(error?.message || error) });
      await minDelay;
      state.pending = false;
      abortSessionToAdminLock(error, "analysis_generate_result");
      return;
    }

    await minDelay;
    state.pending = false;

    if (!result) {
      abortSessionToAdminLock(new Error('{"code":"report_generation_failed","reasonCode":"unknown","message":"empty_result"}'), "analysis_empty_result");
      return;
    }

    state.result = result;
    state.message = "";
    ingestBackendTrace(result);

    state.screen = SCREEN_IDS.RESULT;
    state.analysisProgressPct = 100;
    pushDebug("info", "analysis_finished", {
      verdict: state.result?.verdict,
      contentSource: state.result?.contentSource,
      llm: state.result?.debug?.llmSucceeded ? "yes" : "no",
    });
    logSessionEvent("analysis_finished", SCREEN_IDS.RESULT, {
      verdict: state.result?.verdict,
      content_source: state.result?.contentSource,
      llm_used: Boolean(state.result?.debug?.llmSucceeded),
    });
    touch();
    render();
    api.playCue("deny").catch(() => {});
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function onKeyDown(event) {
    touch();
    if (event.key === "F2") {
      event.preventDefault();
      state.debug.enabled = !state.debug.enabled;
      pushDebug("info", "debug_panel_toggled", { enabled: state.debug.enabled });
      render();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      return;
    }

    if (state.screen === SCREEN_IDS.ATTRACTOR) {
      if (event.key === "Enter") {
        event.preventDefault();
        void startFlow();
        return;
      }
      if (event.key.toLowerCase() === "i") {
        event.preventDefault();
        state.showDataInfo = !state.showDataInfo;
        render();
      }
      return;
    }

    if (state.screen === SCREEN_IDS.LANGUAGE) {
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        moveChoice(-1);
        return;
      }
      if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "Tab") {
        event.preventDefault();
        moveChoice(1);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        setLanguage(state.choiceIndex === 1 ? "en" : "pl");
      }
      return;
    }

    if (state.screen === SCREEN_IDS.QUESTION) {
      const q = getQuestion();
      if (state.questionLoadingIndex === state.questionIndex) {
        return;
      }
      if (q?.type === "choice") {
        if (event.key === "ArrowUp") {
          event.preventDefault();
          moveChoice(-1);
          return;
        }
        if (event.key === "ArrowDown" || event.key === "Tab") {
          event.preventDefault();
          moveChoice(1);
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          submitQuestionChoice(q.options[state.choiceIndex].value);
        }
      }
      return;
    }

    if (state.screen === SCREEN_IDS.QUESTION_TRANSITION && event.key === "Enter") {
      event.preventDefault();
      state.questionTransition.skipRequested = true;
      if (state.questionTransition.ready) {
        finalizeQuestionTransition(
          state.questionTransition.nextIndex,
          state.questionTransition.token,
          "user_skip",
        );
      } else {
        render();
      }
      return;
    }

    if (state.screen === SCREEN_IDS.HANDOFF && event.key === "Enter") {
      event.preventDefault();
      enterQuestionFlow();
      return;
    }

    if (state.screen === SCREEN_IDS.RESULT && event.key === "Enter") {
      event.preventDefault();
      state.screen = SCREEN_IDS.RECEIPT_PREVIEW;
      state.receiptPreviewViewed = true;
      touch();
      render();
      return;
    }

    if (state.screen === SCREEN_IDS.RECEIPT_PREVIEW && event.key === "Enter") {
      event.preventDefault();
      resetToAttractor("completed");
      return;
    }

    if (state.screen === SCREEN_IDS.ADMIN_LOCK && event.key === "Enter") {
      event.preventDefault();
      void retryFromAdminLock();
    }
  }

  function onClick(event) {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    touch();
    const action = target.dataset.action;

    if (action === "start") {
      void startFlow();
      return;
    }
    if (action === "toggle-data") {
      state.showDataInfo = !state.showDataInfo;
      render();
      return;
    }
    if (action === "select-language") {
      setLanguage(target.dataset.value === "en" ? "en" : "pl");
      return;
    }
    if (action === "select-question-option") {
      if (state.questionLoadingIndex === state.questionIndex) return;
      submitQuestionChoice(target.dataset.value || "");
      return;
    }
    if (action === "handoff-continue") {
      enterQuestionFlow();
      return;
    }
    if (action === "question-transition-continue") {
      state.questionTransition.skipRequested = true;
      if (state.questionTransition.ready) {
        finalizeQuestionTransition(
          state.questionTransition.nextIndex,
          state.questionTransition.token,
          "user_skip",
        );
      } else {
        render();
      }
      return;
    }
    if (action === "result-continue") {
      state.screen = SCREEN_IDS.RECEIPT_PREVIEW;
      render();
      return;
    }
    if (action === "receipt-done") {
      resetToAttractor("completed");
      return;
    }
    if (action === "admin-lock-retry") {
      void retryFromAdminLock();
    }
  }

  function onSubmit(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    touch();

    const action = form.dataset.action;
    if (action === "submit-login") {
      tempInputs.login = new FormData(form).get("login")?.toString() || "";
      submitLogin();
      return;
    }
    if (action === "submit-password") {
      const rawPassword = new FormData(form).get("password")?.toString() || "";
      submitPassword(rawPassword);
      return;
    }
    if (action === "submit-question-text") {
      if (state.questionLoadingIndex === state.questionIndex) return;
      tempInputs.questionText = new FormData(form).get("answer")?.toString() || "";
      submitQuestionText();
    }
  }

  function onInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.name === "login") tempInputs.login = target.value;
    if (target.name === "password") {
      const attempt =
        state.screen === SCREEN_IDS.PASSWORD1
          ? "password1"
          : state.screen === SCREEN_IDS.PASSWORD2
            ? "password2"
            : state.screen === SCREEN_IDS.PASSWORD3
              ? "password3"
              : null;
      if (attempt) tempInputs[attempt] = target.value;
    }
    if (target.name === "answer") {
      tempInputs.questionText = target.value;
      maybePrefetchNextQuestion("text_input");
    }
  }

  function tick() {
    const now = Date.now();
    const appCfg = state.bootstrap?.app;
    if (!appCfg) return;

    if (state.screen !== SCREEN_IDS.ATTRACTOR && state.screen !== SCREEN_IDS.ADMIN_LOCK) {
      const idleMs = now - state.lastInteractionAt;
      const timeout =
        state.screen === SCREEN_IDS.RESULT || state.screen === SCREEN_IDS.RECEIPT_PREVIEW
          ? appCfg.postResultTimeoutMs
          : appCfg.idleTimeoutMs;
      if (idleMs >= timeout) {
        resetToAttractor("idle_timeout");
        return;
      }
    }

    if (state.screen === SCREEN_IDS.ANALYSIS) {
      const elapsed = now - state.analysisStartedAt;
      const maxMs = appCfg.analysisMaxMs || 10000;
      const pct = Math.min(96, Math.max(4, Math.round((elapsed / maxMs) * 100)));
      if (pct !== state.analysisProgressPct) {
        state.analysisProgressPct = pct;
        render();
      }
      if (now - state.analysisTickAt >= 850) {
        state.analysisTickAt = now;
        state.analysisLogIndex += 1;
        render();
      }
    }

    if (state.screen === SCREEN_IDS.QUESTION_TRANSITION) {
      const elapsed = now - state.questionTransition.shownAt;
      if (elapsed > 1800 && state.questionTransition.loading && now % 420 < 120) {
        render();
      }
    }

    if (state.screen === SCREEN_IDS.ATTRACTOR && now % 4000 < 120) {
      const nextIndex = Math.floor(now / 4000);
      if (nextIndex !== state.attractorLineIndex) {
        state.attractorLineIndex = nextIndex;
        render();
      }
    }
  }

  async function refreshAttractorStats() {
    try {
      const stats = await api.getAttractorStats();
      state.attractorStats = {
        ...state.attractorStats,
        ...stats,
      };
      if (state.screen === SCREEN_IDS.ATTRACTOR) render();
    } catch {
      state.attractorStats = {
        ...state.attractorStats,
        connectivityStatus: "offline",
      };
      if (state.screen === SCREEN_IDS.ATTRACTOR) render();
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function focusPrimaryInput() {
    requestAnimationFrame(() => {
      const el = document.querySelector("[data-autofocus='true']");
      if (el && typeof el.focus === "function") el.focus();
      if (el && el.select) el.select();
    });
  }

  function sourceLabel(contentSource, langCopy) {
    switch (contentSource) {
      case CONTENT_SOURCES.GEMINI:
        return langCopy.labels.sourceGemini;
      case CONTENT_SOURCES.REWRITTEN:
        return langCopy.labels.sourceRewritten;
      default:
        return langCopy.labels.sourceFallback;
    }
  }

  function interviewTraceText() {
    if (!state.questionHistory.length) return "-";
    return state.questionHistory
      .map(
        (item, idx) =>
          `Q${idx + 1}: ${item.prompt || item.id || "question"}\nA: ${item.answerLabel || item.answerValue || "-"}`,
      )
      .join("\n\n");
  }

  function renderShell({ leftHtml, rightHtml, footerLeft, footerRight }) {
    const c = currentCopy();
    const connectivityLine =
      state.attractorStats.connectivityStatus === "online" ? c.connectivityOnline : c.connectivityOffline;
    const langLabel = state.language ? state.language.toUpperCase() : "--";

    appEl.innerHTML = `
      <div class="shell">
        <header class="topbar">
          <div class="brand">RETRO BOT / RECOVERY NODE</div>
          <div class="status">
            <span class="status-pill ${state.attractorStats.connectivityStatus !== "online" ? "offline" : ""}">
              ${escapeHtml(connectivityLine)}
            </span>
            <span>${escapeHtml(c.labels.language)}: ${escapeHtml(langLabel)}</span>
            <span>${escapeHtml(c.labels.sessionId)}: ${escapeHtml(state.session?.sessionId?.slice(0, 8) || "--------")}</span>
          </div>
        </header>
        <section class="content">
          <section class="panel">${leftHtml}</section>
          <aside class="panel">${rightHtml || ""}${renderDebugTerminalHtml({
            maxLines:
              state.screen === SCREEN_IDS.ANALYSIS ||
              state.screen === SCREEN_IDS.RESULT ||
              state.screen === SCREEN_IDS.RECEIPT_PREVIEW
                ? 18
                : 10,
          })}</aside>
        </section>
        <footer class="footer">
          <div>${footerLeft || ""}</div>
          <div>${footerRight || `${escapeHtml(c.keyboardHelp)}  |  F2: debug`}</div>
        </footer>
      </div>
    `;
    focusPrimaryInput();
  }

  function renderAttractor() {
    const c = copy.pl;
    const dynamicLines = [
      `Zidentyfikowano ${state.attractorStats.sessionsToday} prób dziś.`,
      `Ostatni wynik: ${state.attractorStats.lastVerdictLabel}.`,
      `System: cierpliwość ${state.attractorStats.systemPatiencePct}%.`,
      `Skuteczność finalizacji: ${state.attractorStats.completionRatePct}%.`,
    ];
    const dynamicText = dynamicLines[state.attractorLineIndex % dynamicLines.length];
    const syslog = [
      ...attractorStaticLogs,
      {
        level: state.attractorStats.connectivityStatus === "online" ? "ok" : "err",
        text: `[NET] ${state.attractorStats.connectivityStatus.toUpperCase()} / ${state.attractorStats.storageMode.toUpperCase()}`,
      },
    ];

    renderShell({
      leftHtml: `
        <div class="center-stack">
          <div class="inner">
            <h1 class="cursor">${escapeHtml(c.appTitle)}</h1>
            <div class="subtle">${escapeHtml(c.appSubtitle)}</div>
            <div class="dynamic-bait">${escapeHtml(dynamicText)}</div>
            <div class="muted-box">
              <strong>${escapeHtml(c.attractorIntroTitle)}</strong>
              ${escapeHtml("\n" + (c.attractorIntroLead || ""))}
              ${escapeHtml("\n" + (c.attractorIntroSteps || []).join("\n"))}
            </div>
            <div>
              <button class="choice-button" data-action="start" ${state.pending ? "disabled" : ""}>${escapeHtml(c.attractorCta)}</button>
            </div>
            ${state.pending ? `<div class="subtle">${escapeHtml(c.llmPreflightChecking || "Sprawdzam dostępność generatora...")}</div>` : ""}
            <div class="subtle">[I] ${escapeHtml(c.dataInfoLabel)} / Data</div>
            <div class="muted-box ${state.showDataInfo ? "" : "hidden"}">${escapeHtml(c.dataInfoText)}</div>
          </div>
        </div>
      `,
      rightHtml: `
        <h2>System Log</h2>
        <div class="syslog">
          ${syslog
            .map((row) => `<div class="${row.level}">${escapeHtml(row.text)}</div>`)
            .join("")}
        </div>
        <div style="height: 16px"></div>
        <h2>Live Stats</h2>
        <div class="kv">
          <div class="kv-row"><div class="k">Attempts today</div><div>${state.attractorStats.sessionsToday}</div></div>
          <div class="kv-row"><div class="k">Completed today</div><div>${state.attractorStats.completedToday}</div></div>
          <div class="kv-row"><div class="k">Last verdict</div><div>${escapeHtml(state.attractorStats.lastVerdictLabel)}</div></div>
          <div class="kv-row"><div class="k">Patience</div><div>${state.attractorStats.systemPatiencePct}%</div></div>
        </div>
      `,
      footerLeft: "ENTER / click to start",
      footerRight: "I: data info  ESC: ignored (kiosk mode)",
    });
  }

  function renderAdminLock() {
    const c = currentCopy();
    const operatorMode = Boolean(state.bootstrap?.app?.operatorMode);
    const checkedAtText = state.adminLock.checkedAt
      ? new Date(state.adminLock.checkedAt).toLocaleString("pl-PL", { hour12: false })
      : "-";

    renderShell({
      leftHtml: `
        <div class="center-stack">
          <div class="inner">
            <h1>${escapeHtml(c.adminLockTitle || "SYSTEM UNAVAILABLE")}</h1>
            <div class="alert error">${escapeHtml(c.adminLockLead || "Language generation unavailable.")}</div>
            <div class="muted-box">${escapeHtml(c.adminLockPublic || "This station cannot run sessions right now.")}</div>
            <div style="height: 12px"></div>
            <button class="choice-button" data-action="admin-lock-retry" ${state.pending ? "disabled" : ""}>
              ${escapeHtml(state.pending ? "CHECKING..." : c.adminLockRetry || "[ENTER] Retry")}
            </button>
          </div>
        </div>
      `,
      rightHtml: operatorMode
        ? `
          <h2>${escapeHtml(c.adminLockOperatorLabel || "Operator details")}</h2>
          <div class="kv">
            <div class="kv-row"><div class="k">${escapeHtml(c.adminLockReasonLabel || "Reason code")}</div><div>${escapeHtml(state.adminLock.reasonCode || "-")}</div></div>
            <div class="kv-row"><div class="k">${escapeHtml(c.adminLockMessageLabel || "Message")}</div><div>${escapeHtml(state.adminLock.operatorMessage || "-")}</div></div>
            <div class="kv-row"><div class="k">Context</div><div>${escapeHtml(state.adminLock.context || "-")}</div></div>
            <div class="kv-row"><div class="k">${escapeHtml(c.adminLockCheckedAtLabel || "Last check")}</div><div>${escapeHtml(checkedAtText)}</div></div>
          </div>
        `
        : `
          <h2>Status</h2>
          <div class="muted-box">Skontaktuj się z obsługą stanowiska.</div>
        `,
      footerLeft: "LLM-required mode active",
    });
  }

  function renderLanguageSelect() {
    const c = currentCopy();
    const options = [
      { value: "pl", label: "PL / Polski" },
      { value: "en", label: "EN / English" },
    ];
    renderShell({
      leftHtml: `
        <h1>${escapeHtml(c.chooseLanguageTitle)}</h1>
        <div class="subtle">${escapeHtml(c.chooseLanguageSubtitle)}</div>
        <div style="height: 18px"></div>
        <div class="button-grid">
          ${options
            .map(
              (opt, idx) => `
              <button class="choice-button" data-action="select-language" data-value="${opt.value}" data-active="${
                idx === state.choiceIndex
              }">
                ${escapeHtml(opt.label)}
              </button>`,
            )
            .join("")}
        </div>
      `,
      rightHtml: `
        <h2>Protocol</h2>
        <ol class="list-mono">
          <li>Language lock</li>
          <li>Username capture</li>
          <li>Password failure x3</li>
          <li>Assisted recovery interview</li>
          <li>Report compilation</li>
        </ol>
      `,
      footerLeft: "ARROWS/TAB to switch, ENTER to confirm",
    });
  }

  function renderLogin() {
    const c = currentCopy();
    renderShell({
      leftHtml: `
        <h1>${escapeHtml(c.loginTitle)}</h1>
        <div class="subtle">${escapeHtml(c.loginHint)}</div>
        <div style="height: 12px"></div>
        ${state.message ? `<div class="alert warn">${escapeHtml(state.message)}</div>` : ""}
        <form class="terminal-form" data-action="submit-login">
          <input
            class="terminal-input"
            data-autofocus="true"
            type="text"
            name="login"
            maxlength="24"
            autocomplete="off"
            spellcheck="false"
            value="${escapeHtml(tempInputs.login)}"
            placeholder="USER_01"
          />
          <button class="choice-button" type="submit" ${state.pending ? "disabled" : ""}>
            ${state.pending ? "VALIDATING..." : "ENTER"}
          </button>
        </form>
      `,
      rightHtml: `
        <h2>Input Rules</h2>
        <div class="list-mono">
          <div>Use a pseudonym.</div>
          <div>No contact data.</div>
          <div>Max 24 chars.</div>
          <div>Output may appear in private receipt preview.</div>
        </div>
      `,
      footerLeft: "LOGIN stage",
    });
  }

  function renderPassword() {
    const c = currentCopy();
    const attempt = state.screen === SCREEN_IDS.PASSWORD1 ? 1 : state.screen === SCREEN_IDS.PASSWORD2 ? 2 : 3;
    const pwdValue = tempInputs[`password${attempt}`] || "";
    renderShell({
      leftHtml: `
        <h1>${escapeHtml(c.passwordTitle)} #${attempt}</h1>
        <div class="subtle">${escapeHtml(c.passwordHint)}</div>
        <div style="height: 12px"></div>
        ${state.message ? `<div class="alert ${attempt === 3 ? "error" : "warn"}">${escapeHtml(state.message)}</div>` : ""}
        <form class="terminal-form" data-action="submit-password">
          <input
            class="terminal-input"
            data-autofocus="true"
            type="password"
            name="password"
            autocomplete="off"
            spellcheck="false"
            value="${escapeHtml(pwdValue)}"
            placeholder="••••••••"
          />
          <button class="choice-button" type="submit">SUBMIT</button>
        </form>
      `,
      rightHtml: `
        <h2>Auth Monitor</h2>
        <div class="syslog">
          <div class="ok">[AUTH] Username accepted: ${escapeHtml(state.login || "USER")}</div>
          <div class="${attempt >= 2 ? "warn" : "ok"}">[AUTH] Password attempt #1: FAILED</div>
          <div class="${attempt >= 3 ? "warn" : ""}">[AUTH] Password attempt #2: ${
            attempt >= 3 ? "FAILED" : "PENDING"
          }</div>
          <div class="${attempt === 3 ? "err" : ""}">[AUTH] Password attempt #3: ${attempt === 3 ? "ACTIVE" : "LOCKED"}</div>
        </div>
      `,
      footerLeft: "Password is performative. Failure is guaranteed.",
    });
  }

  function renderHandoff() {
    const c = currentCopy();
    const lines = [state.message, ...c.handoffLines].filter(Boolean);
    renderShell({
      leftHtml: `
        <div class="center-stack">
          <div class="inner">
            <h1>${escapeHtml(c.handoffCriticalTitle || "ACCESS REJECTED")}</h1>
            <div class="alert error">${escapeHtml(c.handoffCriticalLead || "")}</div>
            <div class="alert warn">${escapeHtml(c.handoffProtocolLabel || "Emergency protocol engaged.")}</div>
            <div class="alert warn">${escapeHtml(c.handoffQuestionLead || "Entering diagnostic questions.")}</div>
            <div class="subtle">${escapeHtml(c.handoffQuestionCount || `Question count: ${getQuestionCount()}`)}</div>
            <div style="height: 12px"></div>
            <button class="choice-button" data-action="handoff-continue">${escapeHtml(c.handoffContinue || "[ENTER] Continue")}</button>
            <div class="syslog">
              ${lines.map((line) => `<div class="warn">${escapeHtml(line)}</div>`).join("")}
            </div>
            <div class="subtle">System voice lock-in... / Step: protocol handoff</div>
          </div>
        </div>
      `,
      rightHtml: `
        <h2>Telemetry</h2>
        <div class="kv">
          <div class="kv-row"><div class="k">Auth status</div><div>3/3 rejected</div></div>
          <div class="kv-row"><div class="k">Frustration</div><div>detected</div></div>
          <div class="kv-row"><div class="k">Urgency</div><div>detected</div></div>
          <div class="kv-row"><div class="k">Ambition</div><div>detected</div></div>
          <div class="kv-row"><div class="k">Empathy Layer</div><div>disabled</div></div>
        </div>
      `,
      footerLeft: "Read message, then continue to questions",
    });
  }

  function renderQuestion() {
    const c = currentCopy();
    const q = getQuestion();
    if (!q) {
      beginAnalysis();
      return;
    }

    const progress = `${state.questionIndex + 1}/${getQuestionCount()}`;
    const prompt = questionPromptText(q);
    const isLoadingQuestion = state.questionLoadingIndex === state.questionIndex;
    const stageLabel =
      q.stageLabel
      || (typeof questions[state.questionIndex]?.stageLabel?.[state.language] === "string"
        ? questions[state.questionIndex].stageLabel[state.language]
        : questions[state.questionIndex]?.stageLabel?.pl)
      || `Q${state.questionIndex + 1}`;
    const progressPct = Math.round(((state.questionIndex + 1) / Math.max(1, getQuestionCount())) * 100);

    let leftHtml = `
      <h1>${escapeHtml(stageLabel)}</h1>
      <div class="subtle">Q${state.questionIndex + 1} / ${getQuestionCount()}</div>
      <div class="progress" style="margin-top:10px;"><span style="width:${progressPct}%"></span></div>
      <div class="subtle">${escapeHtml(prompt)}</div>
      <div style="height: 12px"></div>
      ${state.message ? `<div class="alert warn">${escapeHtml(state.message)}</div>` : ""}
    `;

    if (isLoadingQuestion) {
      leftHtml += `
        <div class="analysis-shell">
          <div class="progress"><span style="width: ${Math.max(10, state.analysisProgressPct || 20)}%"></span></div>
          <div class="syslog">
            <div class="warn">${escapeHtml(state.language === "en" ? "Generating adaptive question..." : "Generowanie pytania adaptacyjnego...")}</div>
            <div>${escapeHtml(buildInterpretationLineFromHistory())}</div>
            <div>[Q-PIPELINE] Gemini-only + safety</div>
          </div>
        </div>
      `;
    } else if (q.type === "choice") {
      leftHtml += `
        <div class="button-grid">
          ${q.options
            .map(
              (opt, idx) => `
                <button
                  class="choice-button"
                  data-action="select-question-option"
                  data-value="${escapeHtml(opt.value)}"
                  data-active="${idx === state.choiceIndex}"
                  ${state.pending || isLoadingQuestion ? "disabled" : ""}
                >
                  ${escapeHtml(questionOptionLabel(opt))}
                </button>
              `,
            )
            .join("")}
        </div>
      `;
    } else {
      leftHtml += `
        <form class="terminal-form" data-action="submit-question-text">
          <input
            class="terminal-input"
            data-autofocus="true"
            type="text"
            name="answer"
            maxlength="${q.maxLength || 24}"
            autocomplete="off"
            spellcheck="false"
            value="${escapeHtml(tempInputs.questionText)}"
            placeholder="${escapeHtml(questionPlaceholderText(q) || "")}"
            ${isLoadingQuestion ? "disabled" : ""}
          />
          <button class="choice-button" type="submit" ${state.pending || isLoadingQuestion ? "disabled" : ""}>
            ${state.pending ? "VALIDATING..." : "ENTER"}
          </button>
        </form>
      `;
    }

    renderShell({
      leftHtml,
      rightHtml: `
        <h2>Session Snapshot</h2>
        <div class="kv">
          <div class="kv-row"><div class="k">${escapeHtml(c.labels.login)}</div><div>${escapeHtml(state.login)}</div></div>
          <div class="kv-row"><div class="k">Stage</div><div>${escapeHtml(stageLabel)}</div></div>
          <div class="kv-row"><div class="k">Progress</div><div>${escapeHtml(progress)}</div></div>
          <div class="kv-row"><div class="k">Question source</div><div>${state.dynamicQuestions[state.questionIndex] ? "adaptive" : "default"}</div></div>
          <div class="kv-row"><div class="k">Intent</div><div>${escapeHtml(q.intentTag || "-")}</div></div>
          <div class="kv-row"><div class="k">Form</div><div>${escapeHtml(q.rhetoricalForm || "-")}</div></div>
          <div class="kv-row"><div class="k">Purpose</div><div>${escapeHtml(state.answers.purpose || "-")}</div></div>
          <div class="kv-row"><div class="k">Word</div><div>${escapeHtml(state.answers.self_word || "-")}</div></div>
          <div class="kv-row"><div class="k">Preference</div><div>${escapeHtml(state.answers.judged_or_ignored || "-")}</div></div>
        </div>
      `,
      footerLeft: isLoadingQuestion ? "Please wait..." : q.type === "choice" ? "ARROWS/TAB + ENTER" : "TYPE + ENTER",
    });
  }

  function renderQuestionTransition() {
    const c = currentCopy();
    const nextIndex = state.questionTransition.nextIndex;
    const stage = questions[nextIndex];
    const stageLabel = stage?.stageLabel?.[state.language] || stage?.stageLabel?.pl || `Q${nextIndex + 1}`;
    const elapsed = Math.max(0, Date.now() - state.questionTransition.shownAt);
    const waitingLong = elapsed > 1800;
    const line = state.questionTransition.line
      || (waitingLong ? state.questionTransition.interpretationLine : buildInterpretationLineFromHistory());

    renderShell({
      leftHtml: `
        <h1>${escapeHtml(stageLabel)}</h1>
        <div class="subtle">${escapeHtml(state.language === "en" ? "Preparing next diagnostic step..." : "Przygotowuję kolejny krok diagnostyczny...")}</div>
        <div style="height: 12px"></div>
        <div class="analysis-shell">
          <div class="progress"><span style="width:${Math.min(98, 20 + Math.floor(elapsed / 20))}%"></span></div>
          <div class="syslog">
            <div class="warn">${escapeHtml(line || "-")}</div>
            ${
              waitingLong
                ? `<div>${escapeHtml(state.language === "en" ? "LLM delay detected: showing interpreted context..." : "Wykryto opóźnienie LLM: pokazuję interpretację kontekstu...")}</div>`
                : ""
            }
            <div>[Q-TRANSITION] ${escapeHtml(state.questionTransition.loading ? "loading next prompt..." : "ready")}</div>
          </div>
        </div>
        <div style="height: 12px"></div>
        <button class="choice-button" data-action="question-transition-continue">
          ${escapeHtml(state.language === "en" ? "[ENTER] Continue" : "[ENTER] Kontynuuj")}
        </button>
      `,
      rightHtml: `
        <h2>Arc State</h2>
        <div class="kv">
          <div class="kv-row"><div class="k">Used intents</div><div>${escapeHtml(String(state.arcState.usedIntents.length))}</div></div>
          <div class="kv-row"><div class="k">Used forms</div><div>${escapeHtml(String(state.arcState.usedRhetoricalForms.length))}</div></div>
          <div class="kv-row"><div class="k">Used anchors</div><div>${escapeHtml(String(state.arcState.usedAnchors.length))}</div></div>
          <div class="kv-row"><div class="k">Quote budget</div><div>${escapeHtml(String(Math.max(0, 2 - state.arcState.verbatimQuoteCount)))}</div></div>
        </div>
      `,
      footerLeft: "Micro-transition: Enter skips extra wait",
      footerRight: `${escapeHtml(c.keyboardHelp)}  |  F2: debug`,
    });
  }

  function renderAnalysis() {
    const c = currentCopy();
    const logs = c.analysisLogs;
    const activeLog = logs[state.analysisLogIndex % logs.length];
    renderShell({
      leftHtml: `
        <h1>${escapeHtml(c.analysisTitle)}</h1>
        <div class="analysis-shell">
          <div class="progress"><span style="width:${state.analysisProgressPct}%"></span></div>
          <div class="syslog">
            <div class="warn">${escapeHtml(activeLog)}</div>
            <div>[PIPELINE] JSON schema enforcement: ACTIVE</div>
            <div>[SAFETY] Curatorial rails: ACTIVE</div>
            <div>[OUTPUT] Receipt preview adapter: ACTIVE</div>
          </div>
        </div>
      `,
      rightHtml: `
        <h2>Runtime</h2>
        <div class="kv">
          <div class="kv-row"><div class="k">Tone preset</div><div>${escapeHtml(state.bootstrap?.tonePreset || "cruel_balanced")}</div></div>
          <div class="kv-row"><div class="k">LLM configured</div><div>${state.bootstrap?.llmConfigured ? "yes" : "no"}</div></div>
          <div class="kv-row"><div class="k">Storage</div><div>${escapeHtml(state.bootstrap?.storageMode || "json")}</div></div>
          <div class="kv-row"><div class="k">Language</div><div>${escapeHtml((state.language || "").toUpperCase())}</div></div>
        </div>
      `,
      footerLeft: "Please wait. The system is pretending this takes effort.",
    });
  }

  function renderResult() {
    const c = currentCopy();
    const result = state.result;
    if (!result) {
      renderFatal("Missing result payload in RESULT screen");
      return;
    }
    const denied = result.verdict === VERDICTS.DENIED;
    const stampText = denied ? c.resultDenied : c.resultProvisional;
    const sourceText = sourceLabel(result.contentSource, c);
    const llmSucceeded = Boolean(result.debug?.llmSucceeded);
    const llmAttempted = Boolean(result.debug?.llmAttempted);

    renderShell({
      leftHtml: `
        <h1>${escapeHtml(c.sessionReportLabel)}</h1>
        <div class="stamp ${denied ? "denied" : "provisional"}">${escapeHtml(stampText)}</div>
        <h2>${escapeHtml(c.resultDefinitiveTitle || "")}</h2>
        <div class="alert error">${escapeHtml(c.resultDefinitiveLine || "")}</div>
        <div style="height:10px"></div>
        <div class="summary-lines">
          ${(result.screenSummary || []).map((line) => `<div>${escapeHtml(line)}</div>`).join("")}
        </div>
        ${state.message ? `<div style="height:10px"></div><div class="alert warn">${escapeHtml(state.message)}</div>` : ""}
        <div style="height:14px"></div>
        <button class="choice-button" data-action="result-continue">${escapeHtml(c.resultContinue)}</button>
      `,
      rightHtml: `
        <h2>${escapeHtml(c.labels.summary)}</h2>
        <div class="mini-grid">
          <div class="panel" style="padding:10px;">
            <div class="subtle">${escapeHtml(c.labels.source)}</div>
            <div>${escapeHtml(sourceText)}</div>
          </div>
          <div class="panel" style="padding:10px;">
            <div class="subtle">${escapeHtml(c.labels.login)}</div>
            <div>${escapeHtml(state.login)}</div>
          </div>
        </div>
        <div style="height:12px"></div>
        <h2>Pipeline Origin</h2>
        <div class="kv">
          <div class="kv-row"><div class="k">LLM used</div><div>${llmSucceeded ? "YES" : "NO"}</div></div>
          <div class="kv-row"><div class="k">LLM attempted</div><div>${llmAttempted ? "YES" : "NO"}</div></div>
          <div class="kv-row"><div class="k">Thinking</div><div>${escapeHtml(result.debug?.llmThinkingLevel || "-")}</div></div>
          <div class="kv-row"><div class="k">Rewrite</div><div>${result.debug?.rewriteSucceeded ? "YES" : result.debug?.rewriteAttempted ? "FAILED" : "NO"}</div></div>
          <div class="kv-row"><div class="k">Latency</div><div>${result.debug?.llmLatencyMs ?? "-"} ms</div></div>
        </div>
        <div style="height:12px"></div>
        <h2>${escapeHtml(c.labels.metric)}</h2>
        <div class="kv">
          ${(result.metrics || [])
            .map(
              (m) => `
              <div class="kv-row">
                <div class="k">${escapeHtml(m.label)}</div>
                <div>${escapeHtml(String(m.value))}${escapeHtml(m.suffix || "")}</div>
              </div>
            `,
            )
            .join("")}
        </div>
        <div style="height:12px"></div>
        <h2>${escapeHtml(c.labels.tags)}</h2>
        <div>${(result.tags || []).map((t) => `<span class="badge">${escapeHtml(t)}</span>`).join("")}</div>
        <div style="height:12px"></div>
        <h2>Interview Trace</h2>
        <div class="muted-box">${escapeHtml(interviewTraceText())}</div>
      `,
      footerLeft: "ENTER to receipt preview",
    });
  }

  function renderReceiptPreview() {
    const c = currentCopy();
    const result = state.result;
    if (!result) {
      renderFatal("Missing result payload in RECEIPT_PREVIEW screen");
      return;
    }
    const receiptLines = result.receiptPreview?.lines || [];
    renderShell({
      leftHtml: `
        <div class="receipt-wrap">
          <div>
            <h1>${escapeHtml(c.receiptTitleFallback)}</h1>
            <div class="subtle">Screen preview adapter (ESC/POS-ready line model)</div>
          </div>
          <pre class="receipt-pre">${escapeHtml(receiptLines.join("\n"))}</pre>
          <button class="choice-button" data-action="receipt-done">${escapeHtml(c.receiptContinue)}</button>
        </div>
      `,
      rightHtml: `
        <h2>${escapeHtml(c.labels.quote)}</h2>
        <div class="muted-box">${escapeHtml(result.archiveQuote || "-")}</div>
        <div style="height:12px"></div>
        <h2>Debug</h2>
        <div class="kv">
          <div class="kv-row"><div class="k">${escapeHtml(c.labels.source)}</div><div>${escapeHtml(result.contentSource || "-")}</div></div>
          <div class="kv-row"><div class="k">LLM used</div><div>${result.debug?.llmSucceeded ? "YES" : "NO"}</div></div>
          <div class="kv-row"><div class="k">LLM attempted</div><div>${result.debug?.llmAttempted ? "YES" : "NO"}</div></div>
          <div class="kv-row"><div class="k">Thinking</div><div>${escapeHtml(result.debug?.llmThinkingLevel || "-")}</div></div>
          <div class="kv-row"><div class="k">Session</div><div>${escapeHtml(result.sessionId || "-")}</div></div>
          <div class="kv-row"><div class="k">Lang</div><div>${escapeHtml((result.language || state.language || "").toUpperCase())}</div></div>
        </div>
      `,
      footerLeft: "ENTER to reset session",
    });
  }

  function renderFatal(error) {
    appEl.innerHTML = `
      <div class="shell">
        <header class="topbar"><div class="brand">RETRO BOT</div><div>FATAL</div></header>
        <section class="content">
          <section class="panel">
            <h1>RUNTIME FAILURE</h1>
            <div class="alert error">${escapeHtml(String(error || "Unknown error"))}</div>
          </section>
          <aside class="panel">
            <h2>Recovery</h2>
            <div class="subtle">Restart application. If issue persists, check Electron console and local storage permissions.</div>
          </aside>
        </section>
        <footer class="footer"><div>Esc is ignored in kiosk mode.</div><div></div></footer>
      </div>
    `;
  }

  function render() {
    state.renderNonce += 1;
    if (state.fatalError) {
      renderFatal(state.fatalError);
      return;
    }
    try {
      switch (state.screen) {
        case SCREEN_IDS.ATTRACTOR:
          renderAttractor();
          break;
        case SCREEN_IDS.ADMIN_LOCK:
          renderAdminLock();
          break;
        case SCREEN_IDS.LANGUAGE:
          renderLanguageSelect();
          break;
        case SCREEN_IDS.LOGIN:
          renderLogin();
          break;
        case SCREEN_IDS.PASSWORD1:
        case SCREEN_IDS.PASSWORD2:
        case SCREEN_IDS.PASSWORD3:
          renderPassword();
          break;
        case SCREEN_IDS.HANDOFF:
          renderHandoff();
          break;
        case SCREEN_IDS.QUESTION:
          renderQuestion();
          break;
        case SCREEN_IDS.QUESTION_TRANSITION:
          renderQuestionTransition();
          break;
        case SCREEN_IDS.ANALYSIS:
          renderAnalysis();
          break;
        case SCREEN_IDS.RESULT:
          renderResult();
          break;
        case SCREEN_IDS.RECEIPT_PREVIEW:
          renderReceiptPreview();
          break;
        default:
          resetToAttractor("unknown_screen");
      }
      emitScreenEnteredIfNeeded();
    } catch (error) {
      state.fatalError = error?.stack || error?.message || String(error);
      renderFatal(state.fatalError);
      api.logEvent("renderer_fatal", { error: state.fatalError }).catch(() => {});
    }
  }

  async function init() {
    try {
      state.bootstrap = await api.getBootstrap();
      touch();
      render();
      refreshAttractorStats();
      tickInterval = setInterval(tick, 120);
      attractorRefreshInterval = setInterval(refreshAttractorStats, 8000);
    } catch (error) {
      state.fatalError = error?.stack || error?.message || String(error);
      renderFatal(state.fatalError);
    }
  }

  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("click", onClick);
  document.addEventListener("submit", onSubmit);
  document.addEventListener("input", onInput);
  document.addEventListener("pointerdown", touch, { passive: true });
  document.addEventListener("mousemove", touch, { passive: true });

  window.addEventListener("beforeunload", () => {
    if (tickInterval) clearInterval(tickInterval);
    if (attractorRefreshInterval) clearInterval(attractorRefreshInterval);
  });

  init();
})();
