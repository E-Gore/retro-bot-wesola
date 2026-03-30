const { QUESTIONS, RHETORICAL_FORMS } = require("../../shared/questions");
const { LLM_REASON_CODES } = require("../../shared/constants");
const { buildPasswordContext } = require("../utils/passwordContext");

class QuestionGenerationService {
  constructor({ config, contentGenerationService, safetyService, connectivityService, repository = null }) {
    this.config = config;
    this.contentGenerationService = contentGenerationService;
    this.safetyService = safetyService;
    this.connectivityService = connectivityService;
    this.repository = repository;
  }

  getSlotByIndex(index) {
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= QUESTIONS.length) {
      throw new Error(`Invalid question index: ${index}`);
    }
    return QUESTIONS[idx];
  }

  async getAdaptiveQuestion(payload) {
    const startedAt = Date.now();
    const trace = [];
    const pushTrace = (step, status, meta = {}) => {
      trace.push({ t_ms: Date.now() - startedAt, step, status, meta });
    };

    const language = payload.language === "en" ? "en" : "pl";
    const sessionId = String(payload.sessionId || "");
    const login = this.safetyService.sanitizeText(payload.login || "USER", 24) || "USER";
    const previousHistory = this.normalizePreviousHistory(payload.previousHistory);
    const passwordContext = buildPasswordContext(payload.passwordAttempts, this.safetyService);
    const contextFocus = this.buildContextFocus({ previousHistory, passwordContext });
    const slot = this.getSlotByIndex(payload.questionIndex);
    const arcState = this.normalizeArcState(payload.arcState);
    const arcConstraints = this.buildArcConstraints(slot, payload.questionIndex, arcState);
    const interactionDigest = this.buildInteractionDigest({
      language,
      previousHistory,
      passwordContext,
      contextFocus,
      login,
      questionIndex: Number(payload.questionIndex),
      sessionId,
      arcState,
    });

    pushTrace("normalize_payload", "ok", {
      questionIndex: payload.questionIndex,
      slotId: slot.id,
      intent: slot.intentTag,
      stageLabel: slot.stageLabel?.[language] || slot.stageLabel?.pl || "",
      previousCount: previousHistory.length,
      passwordAttemptsCount: passwordContext.summary.count,
      contextFocus,
    });

    const connectivityStatus = await this.connectivityService.getStatus();
    pushTrace("connectivity_probe", "ok", {
      connectivity: connectivityStatus,
      llm_configured: this.contentGenerationService.isConfigured(),
    });

    const failWith = (code, reasonCode, message, meta = {}) => {
      pushTrace("question_pipeline_hard_fail", "error", {
        code,
        reasonCode,
        message,
        ...meta,
      });
      if (this.repository && sessionId) {
        this.repository.logSessionEvent(sessionId, "question_pipeline_hard_fail", "question", {
          question_index: Number(payload.questionIndex),
          slot_id: slot.id,
          code,
          reason_code: reasonCode,
          message: String(message || ""),
        });
        this.repository.logQualityEvent(
          sessionId,
          "question",
          "llm_hard_block",
          1,
          { question_index: Number(payload.questionIndex), slot_id: slot.id, reason_code: reasonCode },
        );
        this.repository.logQualityEvent(
          sessionId,
          "question",
          "llm_reason_code",
          1,
          { question_index: Number(payload.questionIndex), slot_id: slot.id, reason_code: reasonCode },
        );
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
        "question_llm_unavailable",
        LLM_REASON_CODES.MISSING_API_KEY,
        "Question pipeline requires GEMINI_API_KEY",
      );
    }
    if (connectivityStatus !== "online") {
      failWith(
        "question_llm_unavailable",
        LLM_REASON_CODES.OFFLINE,
        "Question pipeline requires online connectivity",
      );
    }

    let candidate = null;
    const source = "gemini";
    let generationError = null;
    let generationReasonCode = LLM_REASON_CODES.UNKNOWN;
    const llmAttempted = true;
    let llmSucceeded = false;
    let llmLatencyMs = null;
    let regenCount = 0;
    let lastEvaluation = null;

    const questionThinkingLevel = this.config.llm?.thinkingLevels?.question || "minimal";
    pushTrace("gemini_question_generate", "start", {
      model: this.config.llm.model,
      slotId: slot.id,
      thinking_level: questionThinkingLevel,
      contextFocus,
    });
    try {
      const llmStartedAt = Date.now();
      const firstAttempt = await this.contentGenerationService.generateAdaptiveQuestion({
        language,
        slot,
        questionIndex: Number(payload.questionIndex),
        sessionId,
        login,
        previousHistory,
        passwordContext,
        contextFocus,
        interactionDigest,
        tonePreset: this.config.tone.current,
        arcConstraints,
      });
      llmLatencyMs = Date.now() - llmStartedAt;
      const firstEvaluated = this.evaluateQuestionCandidate({
        question: firstAttempt,
        slot,
        previousHistory,
        arcState,
        arcConstraints,
        interactionDigest,
        source: "gemini",
      });
      lastEvaluation = firstEvaluated;

      if (!firstEvaluated.pass) {
        regenCount = 1;
        pushTrace("question_quality_gate", "warn", {
          reason: firstEvaluated.quality.failureReasons.join("|"),
          noveltyScore: firstEvaluated.quality.noveltyScore,
        });
        const retryAttempt = await this.contentGenerationService.generateAdaptiveQuestion({
          language,
          slot,
          questionIndex: Number(payload.questionIndex),
          sessionId,
          login,
          previousHistory,
          passwordContext,
          contextFocus,
          interactionDigest,
          tonePreset: this.config.tone.current,
          arcConstraints,
          qualityFeedback: firstEvaluated.quality.failureReasons.join("; "),
        });
        const retryEvaluated = this.evaluateQuestionCandidate({
          question: retryAttempt,
          slot,
          previousHistory,
          arcState,
          arcConstraints,
          interactionDigest,
          source: "gemini",
          regenCount,
        });
        lastEvaluation = retryEvaluated;
        if (retryEvaluated.pass) {
          candidate = retryEvaluated.question;
        } else {
          generationError = new Error(`question_quality_gate_failed: ${retryEvaluated.quality.failureReasons.join(",")}`);
          generationReasonCode = LLM_REASON_CODES.UNKNOWN;
        }
      } else {
        candidate = firstEvaluated.question;
      }

      llmSucceeded = Boolean(candidate);
      if (llmSucceeded) {
        this.connectivityService.noteSuccess();
        pushTrace("gemini_question_generate", "ok", {
          latency_ms: llmLatencyMs,
          slotId: slot.id,
          thinking_level: questionThinkingLevel,
          regenCount,
        });
      } else {
        this.connectivityService.noteFailure();
        pushTrace("gemini_question_generate", "warn", {
          latency_ms: llmLatencyMs,
          reason: generationError ? String(generationError.message || generationError) : "quality_gate_failed",
          regenCount,
        });
      }
    } catch (error) {
      llmLatencyMs = Date.now() - startedAt;
      generationError = error;
      this.connectivityService.noteFailure();
      const classified = this.contentGenerationService.classifyAvailabilityError(error);
      generationReasonCode = classified.reasonCode || LLM_REASON_CODES.UNKNOWN;
      pushTrace("gemini_question_generate", "error", {
        error: String(error?.message || error),
        reason_code: generationReasonCode,
      });
    }

    if (!candidate) {
      failWith(
        "question_generation_failed",
        generationReasonCode,
        generationError ? String(generationError.message || generationError) : "No question generated",
        { regenCount },
      );
    }

    const screened = this.screenQuestion(candidate, { slot, language });
    if (!screened.safe) {
      failWith("question_safety_failed", LLM_REASON_CODES.UNKNOWN, "Generated question did not pass safety screening", {
        flags: screened.flags,
        source_before: source,
      });
    }
    candidate = screened.question;
    pushTrace("screen_question", "ok", { source_before: source });

    const finalEval = lastEvaluation
      || this.evaluateQuestionCandidate({
        question: candidate,
        slot,
        previousHistory,
        arcState,
        arcConstraints,
        interactionDigest,
        source,
        regenCount,
      });

    const qualitySignals = {
      noveltyScore: finalEval.quality.noveltyScore,
      maxSimilarity: finalEval.quality.maxSimilarity,
      anchorCount: finalEval.quality.anchorCount,
      anchorTokens: finalEval.quality.anchorTokens,
      contextAnchorsUsed: finalEval.quality.anchorCount > 0,
      duplicationRisk: finalEval.quality.maxSimilarity >= 0.72 ? "high" : finalEval.quality.maxSimilarity >= 0.55 ? "medium" : "low",
      semanticRedundancyFlag: finalEval.quality.semanticRedundancyFlag,
      intentOverlap: finalEval.quality.intentOverlap,
      noveltyGateFail: finalEval.quality.noveltyGateFail,
      source,
      regenCount,
    };
    pushTrace("question_quality", finalEval.pass ? "ok" : "warn", qualitySignals);

    if (this.repository && sessionId) {
      const index = Number(payload.questionIndex);
      this.repository.logQualityEvent(sessionId, "question", "novelty_score", qualitySignals.noveltyScore, {
        question_index: index,
        slot_id: slot.id,
        source,
      });
      this.repository.logQualityEvent(sessionId, "question", "question_intent_overlap", qualitySignals.intentOverlap ? 1 : 0, {
        question_index: index,
        slot_id: slot.id,
      });
      this.repository.logQualityEvent(sessionId, "question", "question_novelty_gate_fail", qualitySignals.noveltyGateFail ? 1 : 0, {
        question_index: index,
        slot_id: slot.id,
      });
      this.repository.logQualityEvent(sessionId, "question", "question_regen_count", regenCount > 0 ? 1 : 0, {
        question_index: index,
        slot_id: slot.id,
      });
      this.repository.logQualityEvent(sessionId, "question", "semantic_redundancy_flag", qualitySignals.semanticRedundancyFlag ? 1 : 0, {
        question_index: index,
        slot_id: slot.id,
      });
      this.repository.logSessionEvent(sessionId, "question_generated", "question", {
        question_index: index,
        slot_id: slot.id,
        source,
        intent_tag: candidate.intentTag,
        rhetorical_form: candidate.rhetoricalForm,
        novelty_score: qualitySignals.noveltyScore,
        regen_count: regenCount,
      });
    }

    return {
      question: candidate,
      transitionLine: candidate.transitionLine,
      meta: {
        source,
        intentTag: candidate.intentTag,
        rhetoricalForm: candidate.rhetoricalForm,
        noveltyScore: qualitySignals.noveltyScore,
        anchorTokens: qualitySignals.anchorTokens.slice(0, 8),
        regenCount,
      },
      debug: {
        source,
        llmAttempted,
        llmSucceeded,
        llmLatencyMs,
        llmThinkingLevel: this.config.llm?.thinkingLevels?.question || "minimal",
        passwordContextSummary: passwordContext.summary,
        generationError: generationError ? String(generationError.message || generationError) : null,
        connectivityStatus,
        arcConstraints,
        qualitySignals,
        trace,
        fallbackUsed: false,
      },
    };
  }

  createHardFailError({ code, reasonCode, message, trace }) {
    const error = new Error(String(message || code || "question_pipeline_failed"));
    error.code = String(code || "question_pipeline_failed");
    error.reasonCode = String(reasonCode || LLM_REASON_CODES.UNKNOWN);
    error.trace = Array.isArray(trace) ? trace : [];
    return error;
  }

  normalizeArcState(arcState) {
    return {
      usedIntents: Array.isArray(arcState?.usedIntents) ? [...new Set(arcState.usedIntents.map((x) => String(x || "")))] : [],
      usedRhetoricalForms: Array.isArray(arcState?.usedRhetoricalForms)
        ? [...new Set(arcState.usedRhetoricalForms.map((x) => String(x || "")))]
        : [],
      usedAnchors: Array.isArray(arcState?.usedAnchors) ? [...new Set(arcState.usedAnchors.map((x) => String(x || "").toLowerCase()))] : [],
      verbatimQuoteCount: Number.isFinite(Number(arcState?.verbatimQuoteCount))
        ? Math.max(0, Math.round(Number(arcState.verbatimQuoteCount)))
        : 0,
    };
  }

  buildArcConstraints(slot, questionIndex, arcState) {
    const idx = Number(questionIndex);
    const preferredByIndex = ["probe", "contrast", "counterfactual", "commitment", "cost_frame"];
    const preferred = preferredByIndex[idx] || (slot.preferredRhetoricalForms || [])[0] || "probe";
    const forbidden = [...new Set([...(slot.forbiddenIntentOverlap || []), ...arcState.usedIntents])];
    const requiredRhetoricalForm = arcState.usedRhetoricalForms.includes(preferred)
      ? RHETORICAL_FORMS.find((form) => !arcState.usedRhetoricalForms.includes(form)) || preferred
      : preferred;

    return {
      requiredIntent: slot.intentTag,
      forbiddenIntentOverlap: forbidden,
      requiredRhetoricalForm,
      minNoveltyScore: 0.55,
      requireAnchor: idx >= 1,
      remainingVerbatimQuotes: Math.max(0, 2 - arcState.verbatimQuoteCount),
    };
  }

  evaluateQuestionCandidate({
    question,
    slot,
    previousHistory,
    arcState,
    arcConstraints,
    interactionDigest,
    source,
    regenCount = 0,
  }) {
    const normalized = this.normalizeQuestionShape(question, slot);
    const normalizedPrompt = this.normalizePrompt(normalized.prompt);
    const previousPrompts = (previousHistory || [])
      .map((item) => this.normalizePrompt(item?.prompt || ""))
      .filter(Boolean);
    const similarities = previousPrompts.map((prev) => this.jaccardSimilarity(prev, normalizedPrompt));
    const maxSimilarity = similarities.length ? Math.max(...similarities) : 0;
    const noveltyScore = Math.max(0, Math.min(1, 1 - maxSimilarity));
    const noveltyGateFail = noveltyScore < Number(arcConstraints?.minNoveltyScore || 0.55);

    const anchorTokens = this.extractAnchorTokens({
      previousHistory,
      interactionDigest,
    });
    const promptLower = normalizedPrompt.toLowerCase();
    const anchorCount = anchorTokens.filter((token) => promptLower.includes(token)).length;
    const missingAnchor = arcConstraints?.requireAnchor && anchorCount === 0;

    const intentOverlap = Array.isArray(arcState?.usedIntents) && arcState.usedIntents.includes(normalized.intentTag);
    const forbiddenIntent = Array.isArray(arcConstraints?.forbiddenIntentOverlap)
      && arcConstraints.forbiddenIntentOverlap.includes(normalized.intentTag);
    const invalidIntent = normalized.intentTag !== slot.intentTag;

    const semanticRedundancyFlag = maxSimilarity >= 0.58;
    const quoteCount = this.countVerbatimQuotes(`${normalized.prompt} ${normalized.transitionLine}`);
    const overQuoteBudget = quoteCount > Math.max(0, Number(arcConstraints?.remainingVerbatimQuotes || 0));
    const rhetoricalFormMismatch =
      arcConstraints?.requiredRhetoricalForm
      && normalized.rhetoricalForm !== arcConstraints.requiredRhetoricalForm;

    const failureReasons = [];
    if (noveltyGateFail) failureReasons.push("novelty_low");
    if (semanticRedundancyFlag) failureReasons.push("semantic_redundancy_flag");
    if (invalidIntent) failureReasons.push("intent_mismatch");
    if (intentOverlap) failureReasons.push("intent_overlap");
    if (forbiddenIntent) failureReasons.push("forbidden_intent_overlap");
    if (missingAnchor) failureReasons.push("missing_anchor");
    if (overQuoteBudget) failureReasons.push("verbatim_quote_budget_exceeded");
    if (rhetoricalFormMismatch) failureReasons.push("rhetorical_form_mismatch");

    return {
      pass: failureReasons.length === 0,
      question: {
        ...normalized,
        stageLabel: slot.stageLabel,
      },
      quality: {
        source,
        regenCount,
        noveltyScore,
        maxSimilarity,
        anchorCount,
        anchorTokens,
        semanticRedundancyFlag,
        intentOverlap,
        noveltyGateFail,
        failureReasons,
      },
    };
  }

  normalizeQuestionShape(question, slot) {
    const normalized = question && typeof question === "object" ? question : {};
    return {
      ...normalized,
      id: slot.id,
      type: slot.type,
      prompt: String(normalized.prompt || ""),
      transitionLine: String(normalized.transitionLine || ""),
      intentTag: String(normalized.intentTag || slot.intentTag || "motive_declaration"),
      rhetoricalForm: String(normalized.rhetoricalForm || "probe"),
    };
  }

  extractAnchorTokens({ previousHistory, interactionDigest }) {
    const tokens = [];
    for (const item of previousHistory || []) {
      tokens.push(...this.normalizePrompt(item?.answerLabel || item?.answerValue || "").split(" "));
    }
    for (const line of interactionDigest || []) {
      tokens.push(...this.normalizePrompt(line).split(" "));
    }
    return [...new Set(tokens.filter((token) => token.length >= 4))].slice(0, 24);
  }

  buildInteractionDigest({ language, previousHistory, passwordContext, contextFocus, login, questionIndex, sessionId, arcState }) {
    const history = Array.isArray(previousHistory) ? previousHistory : [];
    const summary = passwordContext?.summary || {};
    const purpose = history.find((h) => h.id === "purpose")?.answerLabel || history.find((h) => h.id === "purpose")?.answerValue || "";
    const selfWord = history.find((h) => h.id === "self_word")?.answerLabel || history.find((h) => h.id === "self_word")?.answerValue || "";
    const lastQ = history[history.length - 1]?.prompt || "";
    const lastA = history[history.length - 1]?.answerLabel || history[history.length - 1]?.answerValue || "";
    const attempts = Array.isArray(passwordContext?.attempts) ? passwordContext.attempts : [];
    const samplePasswords = attempts.map((a) => a.sanitized).slice(0, 3);

    const lines =
      language === "pl"
        ? [
            `- kontekst_fokus: ${contextFocus}`,
            `- login: ${login}`,
            `- cel_zadeklarowany: ${purpose || "brak"}`,
            `- autodefinicja: ${selfWord || "brak"}`,
            `- ostatnia_para_q_a: Q="${lastQ || "-"}" / A="${lastA || "-"}"`,
            `- hasla_probki: ${samplePasswords.join(" | ") || "-"}`,
            `- wzorzec: count=${summary.count || 0}, repeated=${summary.anyRepeated ? "yes" : "no"}, year_like=${summary.anyYearLike ? "yes" : "no"}`,
            `- arc_used_intents: ${(arcState?.usedIntents || []).join("|") || "-"}`,
            `- seed: ${sessionId}|${questionIndex}`,
          ]
        : [
            `- context_focus: ${contextFocus}`,
            `- login: ${login}`,
            `- declared_purpose: ${purpose || "none"}`,
            `- self_word: ${selfWord || "none"}`,
            `- last_q_a_pair: Q="${lastQ || "-"}" / A="${lastA || "-"}"`,
            `- password_samples: ${samplePasswords.join(" | ") || "-"}`,
            `- pattern: count=${summary.count || 0}, repeated=${summary.anyRepeated ? "yes" : "no"}, year_like=${summary.anyYearLike ? "yes" : "no"}`,
            `- arc_used_intents: ${(arcState?.usedIntents || []).join("|") || "-"}`,
            `- seed: ${sessionId}|${questionIndex}`,
          ];
    return lines;
  }

  buildContextFocus({ previousHistory, passwordContext }) {
    const history = Array.isArray(previousHistory) ? previousHistory : [];
    const purpose = history.find((h) => h.id === "purpose")?.answerValue || "";
    const selfWord = history.find((h) => h.id === "self_word")?.answerValue || "";
    const summary = passwordContext?.summary || {};
    const tags = Array.isArray(summary.uniqueTagList) ? summary.uniqueTagList : [];

    if (purpose === "proof") return "artifact_hunter";
    if (purpose === "beat_machine") return "control_competition";
    if (summary.anyRepeated || tags.includes("repeated_chars")) return "repetition_loop";
    if (selfWord && /zm[eę]cz|tired|stress|spięt|anx|nerw|chaos/i.test(selfWord)) return "fatigue_signal";
    if (tags.includes("common_pattern")) return "default_pattern";
    return "neutral_probe";
  }

  normalizePreviousHistory(previousHistory) {
    if (!Array.isArray(previousHistory)) return [];
    return previousHistory
      .map((item) => ({
        id: String(item?.id || "").trim(),
        type: String(item?.type || "").trim(),
        prompt: this.safetyService.sanitizeText(item?.prompt || "", 140),
        answerValue: this.safetyService.sanitizeText(item?.answerValue || "", 64),
        answerLabel: this.safetyService.sanitizeText(item?.answerLabel || "", 96),
        intentTag: String(item?.intentTag || ""),
      }))
      .filter((item) => item.id);
  }

  screenQuestion(question, { slot, language }) {
    const flags = {
      containsBannedWord: false,
      containsRiskyPhrase: false,
      containsPII: false,
    };
    const inspect = (text) => {
      const value = String(text || "");
      if (this.safetyService.containsBannedWord(value)) flags.containsBannedWord = true;
      if (this.safetyService.containsRiskyPhrase(value)) flags.containsRiskyPhrase = true;
      if (this.safetyService.containsPII(value)) flags.containsPII = true;
    };

    inspect(question?.prompt);
    inspect(question?.transitionLine);
    inspect(question?.placeholder);
    (question?.options || []).forEach((opt) => inspect(opt?.label));

    const safe = !flags.containsBannedWord && !flags.containsRiskyPhrase && !flags.containsPII;

    if (slot.type === "choice") {
      return {
        safe,
        flags,
        question: {
          id: slot.id,
          type: "choice",
          language,
          prompt: this.safetyService.sanitizeText(question.prompt, 140),
          transitionLine: this.safetyService.sanitizeText(question.transitionLine, 160),
          intentTag: slot.intentTag,
          rhetoricalForm: RHETORICAL_FORMS.includes(question.rhetoricalForm) ? question.rhetoricalForm : "probe",
          stageLabel: slot.stageLabel,
          options: (slot.options || []).map((slotOpt) => {
            const generated = (question.options || []).find((opt) => opt.value === slotOpt.value);
            return {
              value: slotOpt.value,
              label: this.safetyService.sanitizeText(
                generated?.label || slotOpt.label?.[language] || slotOpt.value,
                48,
              ),
            };
          }),
          maxLength: slot.maxLength || 32,
        },
      };
    }

    return {
      safe,
      flags,
      question: {
        id: slot.id,
        type: "text",
        language,
        prompt: this.safetyService.sanitizeText(question.prompt, 140),
        transitionLine: this.safetyService.sanitizeText(question.transitionLine, 160),
        intentTag: slot.intentTag,
        rhetoricalForm: RHETORICAL_FORMS.includes(question.rhetoricalForm) ? question.rhetoricalForm : "probe",
        stageLabel: slot.stageLabel,
        placeholder: this.safetyService.sanitizeText(
          question.placeholder || slot.placeholder?.[language] || "",
          32,
        ),
        minLength: slot.minLength || 1,
        maxLength: slot.maxLength || 24,
      },
    };
  }

  countVerbatimQuotes(text) {
    const matches = String(text || "").match(/"[^"\n]{1,60}"/g);
    return Array.isArray(matches) ? matches.length : 0;
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

module.exports = { QuestionGenerationService };
