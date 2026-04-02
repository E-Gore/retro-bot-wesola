const crypto = require("node:crypto");
const { QUESTIONS } = require("../../shared/questions");
const { CONTENT_SOURCES, VERDICTS } = require("../../shared/constants");
const { validateLogin, validateTextAnswer, normalizeTextInput } = require("../../shared/validation");
const { sha256 } = require("../utils/hash");
const { buildPasswordContext } = require("../utils/passwordContext");

class SessionAnalysisService {
  constructor({ config, repository, contentGenerationService, safetyService, receiptFormatter, connectivityService }) {
    this.config = config;
    this.repository = repository;
    this.contentGenerationService = contentGenerationService;
    this.safetyService = safetyService;
    this.receiptFormatter = receiptFormatter;
    this.connectivityService = connectivityService;
    this.loginSalt = crypto.randomBytes(12).toString("hex");
  }

  async analyzeSession(rawDraft) {
    const pipelineStartedAt = Date.now();
    const trace = [];
    const pushTrace = (step, status, meta = {}) => {
      trace.push({
        t_ms: Date.now() - pipelineStartedAt,
        step,
        status,
        meta,
      });
    };

    const normalized = this.normalizeDraft(rawDraft);
    const narrativeArc = this.buildNarrativeArcSummary(normalized.questionHistory, normalized.passwordContext);
    pushTrace("normalize_draft", "ok", {
      language: normalized.language,
      session_id: normalized.sessionId,
      answers_count: Object.keys(normalized.answers || {}).length,
      question_history_count: normalized.questionHistory?.length || 0,
      password_attempts_count: normalized.passwordContext?.summary?.count || 0,
      arc_contradictions: narrativeArc.keyContradictions.length,
    });
    const userScreen = this.safetyService.screenUserInput({
      login: normalized.login,
      ...normalized.answers,
    });
    pushTrace("screen_user_input", userScreen.safe ? "ok" : "warn", {
      safe: userScreen.safe,
      flags: userScreen.flags,
    });

    const connectivityStatus = await this.connectivityService.getStatus();
    pushTrace("connectivity_probe", "ok", {
      connectivity: connectivityStatus,
      llm_configured: this.contentGenerationService.isConfigured(),
    });
    const failWith = (code, reasonCode, message, meta = {}) => {
      pushTrace("analysis_pipeline_hard_fail", "error", {
        code,
        reasonCode,
        message,
        ...meta,
      });
      if (normalized.sessionId) {
        this.repository.logSessionEvent(normalized.sessionId, "analysis_pipeline_hard_fail", "analysis", {
          code,
          reason_code: reasonCode,
          message: String(message || ""),
        });
        this.repository.logQualityEvent(normalized.sessionId, "report", "llm_hard_block", 1, {
          reason_code: reasonCode,
        });
        this.repository.logQualityEvent(normalized.sessionId, "report", "llm_reason_code", 1, {
          reason_code: reasonCode,
        });
      }
      throw this.createHardFailError({
        code,
        reasonCode,
        message,
        trace,
      });
    };
    if (!this.contentGenerationService.isConfigured()) {
      failWith(
        "report_generation_failed",
        "missing_api_key",
        "Report pipeline requires GEMINI_API_KEY",
      );
    }
    if (connectivityStatus !== "online") {
      failWith(
        "report_generation_failed",
        "offline",
        "Report pipeline requires online connectivity",
      );
    }

    let generated = null;
    const contentSource = CONTENT_SOURCES.GEMINI;
    let generationError = null;
    const llmAttempted = true;
    let llmSucceeded = false;
    let llmLatencyMs = null;
    const rewriteAttempted = false;
    const rewriteSucceeded = false;

    const llmStartedAt = Date.now();
    const reportThinkingLevel = this.config.llm?.thinkingLevels?.report || "low";
    pushTrace("gemini_generate", "start", {
      model: this.config.llm.model,
      thinking_level: reportThinkingLevel,
    });
    try {
      generated = await this.contentGenerationService.generate({
        sessionId: normalized.sessionId,
        language: normalized.language,
        login: userScreen.sanitized.login || normalized.login,
        answers: userScreen.sanitized,
        questionHistory: normalized.questionHistory,
        passwordContext: normalized.passwordContext,
        arcSummary: narrativeArc.arcSummary,
        keyContradictions: narrativeArc.keyContradictions,
        allowedVerbatimQuotesMax: Math.max(0, 2 - (normalized.arcState?.verbatimQuoteCount || 0)),
        tonePreset: this.config.tone.current,
        userInputFlags: userScreen.flags,
      });
      llmLatencyMs = Date.now() - llmStartedAt;
      llmSucceeded = true;
      this.connectivityService.noteSuccess();
      pushTrace("gemini_generate", "ok", {
        latency_ms: llmLatencyMs,
        verdict: generated.verdict,
        thinking_level: reportThinkingLevel,
      });
    } catch (error) {
      llmLatencyMs = Date.now() - llmStartedAt;
      generationError = error;
      this.connectivityService.noteFailure();
      const classified = this.contentGenerationService.classifyAvailabilityError(error);
      failWith("report_generation_failed", classified.reasonCode, String(error?.message || error), {
        latency_ms: llmLatencyMs,
      });
    }

    generated = this.enforceVerbatimQuoteLimit(
      generated,
      Math.max(0, 2 - (normalized.arcState?.verbatimQuoteCount || 0)),
    );

    let outputSafety = this.safetyService.screenGeneratedCopy(generated);
    pushTrace("screen_generated_copy", outputSafety.safe ? "ok" : "warn", {
      flags: outputSafety.flags,
      source_before: contentSource,
    });
    if (!outputSafety.safe) {
      failWith("report_generation_failed", "unknown", "Generated report did not pass safety screening", {
        flags: outputSafety.flags,
      });
    }

    const receipt = this.receiptFormatter.format(
      {
        language: normalized.language,
        sessionId: normalized.sessionId,
        createdAt: normalized.startedAt,
        login: normalized.login,
        verdict: generated.verdict || VERDICTS.DENIED,
        contentSource,
        receiptTitle: generated.receipt_title,
        metrics: generated.metrics,
        screenSummary: generated.screen_summary,
        receiptBodyLines: generated.receipt_body_lines,
        tags: generated.tags,
      },
      this.config.app.receiptWidth,
    );
    pushTrace("format_receipt_preview", "ok", {
      width: this.config.app.receiptWidth,
      lines: receipt.lines?.length || 0,
    });

    const endedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.now() - new Date(normalized.startedAt).getTime());
    const pipelineTotalMs = Date.now() - pipelineStartedAt;
    const reportSignals = this.estimateReportSignals({
      generated,
      narrativeArc,
      login: normalized.login,
      answers: userScreen.sanitized,
    });
    const qualitySignals = {
      questionNoveltyAvg: this.estimateQuestionNovelty(normalized.questionHistory),
      reportCoherenceScore: this.estimateReportCoherence(generated.receipt_body_lines || []),
      reportSpecificityScore: this.estimateReportSpecificity({
        login: normalized.login,
        answers: userScreen.sanitized,
        textBlocks: [
          ...(generated.screen_summary || []),
          ...(generated.receipt_body_lines || []),
          generated.archive_quote || "",
        ],
      }),
      reportAnchorCoverage: reportSignals.coverage,
      reportContradictionCount: reportSignals.contradictionCount,
    };
    const sessionRecord = this.buildSessionRecord({
      normalized,
      userScreen,
      generated,
      contentSource,
      outputSafety,
      receipt,
      endedAt,
      durationMs,
      qualitySignals,
      llmUsed: llmSucceeded,
      llmLatencyMs,
      rewriteUsed: rewriteAttempted,
      fallbackUsed: false,
      analysisPipelineMs: pipelineTotalMs,
    });

    this.repository.saveSession(sessionRecord);
    this.repository.logQualityEvent(
      normalized.sessionId,
      "question",
      "novelty_score",
      qualitySignals.questionNoveltyAvg,
      { source: "analysis" },
    );
    this.repository.logQualityEvent(
      normalized.sessionId,
      "report",
      "coherence_score",
      qualitySignals.reportCoherenceScore,
      { content_source: contentSource },
    );
    this.repository.logQualityEvent(
      normalized.sessionId,
      "report",
      "specificity_score",
      qualitySignals.reportSpecificityScore,
      { content_source: contentSource },
    );
    this.repository.logQualityEvent(
      normalized.sessionId,
      "report",
      "report_anchor_coverage",
      qualitySignals.reportAnchorCoverage,
      { content_source: contentSource },
    );
    this.repository.logQualityEvent(
      normalized.sessionId,
      "report",
      "report_contradiction_count",
      qualitySignals.reportContradictionCount,
      { content_source: contentSource },
    );
    this.repository.logSessionEvent(normalized.sessionId, "analysis_finished", "analysis", {
      content_source: contentSource,
      llm_used: llmSucceeded,
      rewrite_used: rewriteAttempted,
      fallback_used: 0,
      pipeline_total_ms: pipelineTotalMs,
    });
    pushTrace("save_session", "ok", {
      storage_mode: this.repository.mode,
      duration_ms: durationMs,
    });
    this.repository.logEvent("session_completed", {
      session_id: normalized.sessionId,
      content_source: contentSource,
      verdict: generated.verdict,
      generation_error: generationError ? String(generationError.message || generationError) : null,
    });

    return {
      sessionId: normalized.sessionId,
      createdAt: normalized.startedAt,
      language: normalized.language,
      login: normalized.login,
      verdict: generated.verdict || VERDICTS.DENIED,
      screenSummary: generated.screen_summary || [],
      receiptTitle: generated.receipt_title,
      receiptBodyLines: generated.receipt_body_lines || [],
      tags: generated.tags || [],
      archiveQuote: generated.archive_quote || "",
      metrics: generated.metrics || [],
      receiptPreview: receipt,
      contentSource,
      safetyFlags: {
        userInput: userScreen.flags,
        output: outputSafety.flags,
      },
      connectivityStatus,
      debug: {
        generationError: generationError ? String(generationError.message || generationError) : null,
        llmAttempted,
        llmSucceeded,
        llmLatencyMs,
        llmThinkingLevel: this.config.llm?.thinkingLevels?.report || "low",
        rewriteAttempted,
        rewriteSucceeded,
        passwordContextSummary: normalized.passwordContext?.summary || null,
        finalContentSource: contentSource,
        pipelineTotalMs,
        qualitySignals,
        reportSignals,
        narrativeArc,
        trace,
      },
    };
  }

  createHardFailError({ code, reasonCode, message, trace }) {
    const error = new Error(String(message || code || "report_generation_failed"));
    error.code = String(code || "report_generation_failed");
    error.reasonCode = String(reasonCode || "unknown");
    error.trace = Array.isArray(trace) ? trace : [];
    return error;
  }

  normalizeDraft(rawDraft) {
    const language = rawDraft?.language === "pl" ? "pl" : "en";
    const sessionId = typeof rawDraft?.sessionId === "string" && rawDraft.sessionId
      ? rawDraft.sessionId
      : crypto.randomUUID();
    const loginValidation = validateLogin(rawDraft?.login || "");
    const login = loginValidation.ok ? loginValidation.normalized : "USER";

    const answers = {};
    for (const question of QUESTIONS) {
      const rawValue = rawDraft?.answers?.[question.id];
      if (question.type === "choice") {
        const allowed = new Set(question.options.map((opt) => opt.value));
        answers[question.id] = allowed.has(String(rawValue)) ? String(rawValue) : question.options[0].value;
      } else {
        const checked = validateTextAnswer(rawValue || "", {
          minLength: question.minLength || 1,
          maxLength: question.maxLength || 24,
        });
        answers[question.id] = checked.ok ? checked.normalized : "n/a";
      }
    }

    const startedAt = rawDraft?.startedAt ? new Date(rawDraft.startedAt).toISOString() : new Date().toISOString();
    const questionHistory = this.normalizeQuestionHistory(rawDraft?.questionHistory, language, answers);
    const passwordContext = buildPasswordContext(rawDraft?.passwordAttempts, this.safetyService);
    const arcState = this.normalizeArcState(rawDraft?.arcState);
    return {
      sessionId,
      language,
      startedAt,
      login,
      answers,
      questionHistory,
      passwordContext,
      arcState,
      rawDraftMeta: rawDraft?.meta || {},
    };
  }

  normalizeArcState(rawArcState) {
    return {
      usedIntents: Array.isArray(rawArcState?.usedIntents)
        ? [...new Set(rawArcState.usedIntents.map((item) => String(item || "")))]
        : [],
      usedRhetoricalForms: Array.isArray(rawArcState?.usedRhetoricalForms)
        ? [...new Set(rawArcState.usedRhetoricalForms.map((item) => String(item || "")))]
        : [],
      usedAnchors: Array.isArray(rawArcState?.usedAnchors)
        ? [...new Set(rawArcState.usedAnchors.map((item) => String(item || "").toLowerCase()))]
        : [],
      verbatimQuoteCount: Number.isFinite(Number(rawArcState?.verbatimQuoteCount))
        ? Math.max(0, Math.round(Number(rawArcState.verbatimQuoteCount)))
        : 0,
    };
  }

  normalizeQuestionHistory(rawQuestionHistory, language, fallbackAnswers) {
    if (!Array.isArray(rawQuestionHistory) || rawQuestionHistory.length === 0) {
      return QUESTIONS.map((q) => ({
        id: q.id,
        type: q.type,
        intentTag: q.intentTag || "",
        prompt: q.prompt?.[language] || q.prompt?.pl || q.id,
        answerValue: String(fallbackAnswers?.[q.id] || ""),
        answerLabel: String(fallbackAnswers?.[q.id] || ""),
      }));
    }

    const normalized = rawQuestionHistory
      .map((item) => ({
        id: String(item?.id || "").trim(),
        type: String(item?.type || "").trim(),
        intentTag: String(item?.intentTag || "").trim(),
        rhetoricalForm: String(item?.rhetoricalForm || "").trim(),
        prompt: this.safetyService.sanitizeText(normalizeTextInput(String(item?.prompt || "")), 140),
        answerValue: this.safetyService.sanitizeText(
          normalizeTextInput(String(item?.answerValue || "")),
          64,
        ),
        answerLabel: this.safetyService.sanitizeText(
          normalizeTextInput(String(item?.answerLabel || item?.answerValue || "")),
          96,
        ),
      }))
      .filter((item) => item.id && item.prompt);

    return normalized.length > 0
      ? normalized
      : QUESTIONS.map((q) => ({
          id: q.id,
          type: q.type,
          intentTag: q.intentTag || "",
          prompt: q.prompt?.[language] || q.prompt?.pl || q.id,
          answerValue: String(fallbackAnswers?.[q.id] || ""),
          answerLabel: String(fallbackAnswers?.[q.id] || ""),
        }));
  }

  buildSessionRecord({
    normalized,
    userScreen,
    generated,
    contentSource,
    outputSafety,
    endedAt,
    durationMs,
    qualitySignals,
    llmUsed,
    llmLatencyMs,
    rewriteUsed,
    fallbackUsed,
    analysisPipelineMs,
  }) {
    const session = {
      session_id: normalized.sessionId,
      created_at: normalized.startedAt,
      ended_at: endedAt,
      language: normalized.language,
      login_raw: normalized.login,
      login_hash: sha256(normalized.login, this.loginSalt),
      content_source: contentSource,
      verdict: generated.verdict || VERDICTS.DENIED,
      screen_summary_json: JSON.stringify(generated.screen_summary || []),
      receipt_body_lines_json: JSON.stringify(generated.receipt_body_lines || []),
      tags_json: JSON.stringify(generated.tags || []),
      archive_quote: normalizeTextInput(generated.archive_quote || ""),
      safety_flags_json: JSON.stringify({
        user_input: userScreen.flags,
        output: outputSafety.flags,
      }),
      duration_ms: durationMs,
      completed: 1,
      llm_used: llmUsed ? 1 : 0,
      llm_latency_ms: Number.isFinite(llmLatencyMs) ? Math.round(llmLatencyMs) : null,
      rewrite_used: rewriteUsed ? 1 : 0,
      fallback_used: fallbackUsed ? 1 : 0,
      question_novelty_avg: Number(qualitySignals?.questionNoveltyAvg || 0),
      report_coherence_score: Number(qualitySignals?.reportCoherenceScore || 0),
      analysis_pipeline_ms: Number.isFinite(analysisPipelineMs) ? Math.round(analysisPipelineMs) : null,
    };

    const answers = Object.entries(normalized.answers).map(([questionId, value]) => ({
      session_id: normalized.sessionId,
      question_id: questionId,
      answer_text: String(value),
      answer_normalized: String(value),
    }));

    const metrics = (generated.metrics || []).map((metric, index) => ({
      session_id: normalized.sessionId,
      metric_index: index,
      label: String(metric.label),
      value: Number(metric.value) || 0,
      suffix: String(metric.suffix || "%"),
    }));

    return { session, answers, metrics };
  }

  estimateQuestionNovelty(questionHistory) {
    const prompts = Array.isArray(questionHistory)
      ? questionHistory
          .map((item) => this.normalizePrompt(item?.prompt))
          .filter(Boolean)
      : [];
    if (prompts.length <= 1) return 1;

    let maxSimilarity = 0;
    for (let i = 0; i < prompts.length; i += 1) {
      for (let j = i + 1; j < prompts.length; j += 1) {
        const sim = this.jaccardSimilarity(prompts[i], prompts[j]);
        if (sim > maxSimilarity) maxSimilarity = sim;
      }
    }
    return Math.max(0, Math.min(1, 1 - maxSimilarity));
  }

  buildNarrativeArcSummary(questionHistory, passwordContext) {
    const history = Array.isArray(questionHistory) ? questionHistory : [];
    const byId = (id) => history.find((item) => item.id === id);
    const purpose = String(byId("purpose")?.answerLabel || byId("purpose")?.answerValue || "").trim();
    const selfWord = String(byId("self_word")?.answerLabel || byId("self_word")?.answerValue || "").trim();
    const friction = String(byId("judged_or_ignored")?.answerLabel || byId("judged_or_ignored")?.answerValue || "").trim();
    const habit = String(byId("defended_habit")?.answerLabel || byId("defended_habit")?.answerValue || "").trim();
    const tradeoff = String(byId("right_or_peace")?.answerLabel || byId("right_or_peace")?.answerValue || "").trim();
    const tags = Array.isArray(passwordContext?.summary?.uniqueTagList) ? passwordContext.summary.uniqueTagList : [];
    const firstPassword = passwordContext?.attempts?.[0]?.sanitized || "";

    const contradictions = [];
    if (/beat_machine|proof/i.test(purpose) && /(wycof|cisz|milcz|retreat|withdraw|silence)/i.test(tradeoff)) {
      contradictions.push("Deklarujesz nacisk, a domykasz sesję wycofaniem.");
    }
    if (/(zm[eę]cz|tired|stress|anx|chaos)/i.test(selfWord) && /(control|wygra|nacisk|push|force)/i.test(friction)) {
      contradictions.push("Zmęczenie współistnieje z impulsem kontroli.");
    }
    if (tags.includes("repeated_chars") && /(powtarz|repeat|again|loop)/i.test(habit) === false) {
      contradictions.push("Powtarzalność w hasłach nie jest nazwana w deklarowanym nawyku.");
    }
    if (/(ignored|ignorowan|pomij)/i.test(friction) && /(approval|potwierd|ocen|judge)/i.test(tradeoff)) {
      contradictions.push("Unikasz oceny, ale końcówkę opierasz na potrzebie potwierdzenia.");
    }

    const arcSummaryParts = [
      purpose ? `Motyw wejścia: ${purpose}.` : "",
      selfWord ? `Stan własny: ${selfWord}.` : "",
      friction ? `Reakcja na tarcie: ${friction}.` : "",
      habit ? `Mechanizm autosabotażu: ${habit}.` : "",
      tradeoff ? `Koszt i wybór: ${tradeoff}.` : "",
      firstPassword ? `Kontekst haseł: ${firstPassword}.` : "",
    ].filter(Boolean);

    const anchorTokens = [...new Set(
      [purpose, selfWord, friction, habit, tradeoff, firstPassword]
        .flatMap((value) => String(value || "").toLowerCase().split(/[^a-z0-9ąćęłńóśźż]+/i))
        .filter((token) => token.length >= 4),
    )].slice(0, 18);

    return {
      arcSummary: arcSummaryParts.join(" "),
      keyContradictions: contradictions.slice(0, 3),
      anchorTokens,
    };
  }

  estimateReportCoherence(lines) {
    const normalizedLines = (Array.isArray(lines) ? lines : [])
      .map((line) => String(line || "").trim())
      .filter(Boolean);
    if (!normalizedLines.length) return 0;

    const lengthScore = Math.min(1, normalizedLines.length / 10);
    const adjacency = [];
    for (let i = 0; i < normalizedLines.length - 1; i += 1) {
      adjacency.push(this.jaccardSimilarity(normalizedLines[i], normalizedLines[i + 1]));
    }
    const adjacencyScore = adjacency.length ? Math.max(0, Math.min(1, mean(adjacency) * 2.5)) : 0.25;

    const avgLen = mean(normalizedLines.map((line) => line.length));
    const compactnessScore = avgLen > 10 && avgLen < 90 ? 1 : avgLen <= 10 ? 0.35 : 0.6;

    return Math.max(
      0,
      Math.min(1, lengthScore * 0.35 + adjacencyScore * 0.45 + compactnessScore * 0.2),
    );
  }

  estimateReportSpecificity({ login, answers, textBlocks }) {
    const sourceTokens = [];
    sourceTokens.push(...String(login || "").toLowerCase().split(/[^a-z0-9ąćęłńóśźż]+/i));
    for (const value of Object.values(answers || {})) {
      sourceTokens.push(...String(value || "").toLowerCase().split(/[^a-z0-9ąćęłńóśźż]+/i));
    }
    const anchors = [...new Set(sourceTokens.filter((token) => token.length >= 4))].slice(0, 20);
    if (!anchors.length) return 0.5;

    const reportText = (Array.isArray(textBlocks) ? textBlocks : [textBlocks]).join(" ").toLowerCase();
    const matched = anchors.filter((token) => reportText.includes(token)).length;
    return Math.max(0, Math.min(1, matched / anchors.length));
  }

  estimateReportSignals({ generated, narrativeArc, login, answers }) {
    const text = [
      ...(generated.screen_summary || []),
      ...(generated.receipt_body_lines || []),
      generated.archive_quote || "",
    ]
      .join(" ")
      .toLowerCase();
    const tokens = Array.isArray(narrativeArc?.anchorTokens) ? narrativeArc.anchorTokens : [];
    const matched = tokens.filter((token) => text.includes(token)).length;
    const coverage = tokens.length ? matched / tokens.length : this.estimateReportSpecificity({
      login,
      answers,
      textBlocks: [text],
    });
    return {
      coverage: Math.max(0, Math.min(1, coverage)),
      contradictionCount: Array.isArray(narrativeArc?.keyContradictions) ? narrativeArc.keyContradictions.length : 0,
      anchorUsage: matched,
    };
  }

  enforceVerbatimQuoteLimit(generated, allowedMax) {
    const maxQuotes = Math.max(0, Math.min(2, Number.isFinite(Number(allowedMax)) ? Number(allowedMax) : 2));
    let remaining = maxQuotes;
    const trimQuotes = (value) => {
      let text = String(value || "");
      return text.replace(/"[^"\n]{1,60}"/g, (segment) => {
        if (remaining > 0) {
          remaining -= 1;
          return segment;
        }
        return segment.replace(/"/g, "");
      });
    };
    return {
      ...generated,
      screen_summary: (generated.screen_summary || []).map(trimQuotes),
      receipt_body_lines: (generated.receipt_body_lines || []).map(trimQuotes),
      archive_quote: trimQuotes(generated.archive_quote || ""),
    };
  }

  normalizePrompt(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  jaccardSimilarity(a, b) {
    const aTokens = new Set(this.normalizePrompt(a).split(" ").filter((token) => token.length >= 3));
    const bTokens = new Set(this.normalizePrompt(b).split(" ").filter((token) => token.length >= 3));
    if (!aTokens.size && !bTokens.size) return 1;
    if (!aTokens.size || !bTokens.size) return 0;

    let intersection = 0;
    for (const token of aTokens) {
      if (bTokens.has(token)) intersection += 1;
    }
    const union = new Set([...aTokens, ...bTokens]).size;
    return union > 0 ? intersection / union : 0;
  }
}

function mean(values) {
  const nums = (values || []).filter((v) => Number.isFinite(v));
  if (!nums.length) return 0;
  return nums.reduce((acc, v) => acc + v, 0) / nums.length;
}

module.exports = { SessionAnalysisService };
