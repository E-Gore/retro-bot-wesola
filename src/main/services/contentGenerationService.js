const {
  parseGeneratedJson,
  validateGeneratedCopyShape,
  validateAdaptiveQuestionShape,
} = require("./jsonSchema");
const { LLM_REASON_CODES } = require("../../shared/constants");

class ContentGenerationService {
  constructor(config) {
    this.config = config;
  }

  isConfigured() {
    return Boolean(this.config.llm?.apiKey);
  }

  async checkAvailability() {
    const checkedAt = new Date().toISOString();
    if (!this.isConfigured()) {
      return {
        ok: true,
        available: false,
        reasonCode: LLM_REASON_CODES.MISSING_API_KEY,
        operatorMessage: "GEMINI_API_KEY is missing",
        checkedAt,
      };
    }

    try {
      await this.callGemini("Return exactly: OK", {
        thinkingLevel: this.config.llm?.thinkingLevels?.repair || "minimal",
        timeoutMs: Math.min(5000, Number(this.config.llm?.timeoutMs || 15000)),
      });
      return {
        ok: true,
        available: true,
        reasonCode: LLM_REASON_CODES.OK,
        operatorMessage: "LLM available",
        checkedAt,
      };
    } catch (error) {
      const classified = this.classifyAvailabilityError(error);
      return {
        ok: true,
        available: false,
        reasonCode: classified.reasonCode,
        operatorMessage: classified.operatorMessage,
        checkedAt,
      };
    }
  }

  classifyAvailabilityError(error) {
    const explicit = String(error?.reasonCode || "").trim();
    if (explicit) {
      return {
        reasonCode: explicit,
        operatorMessage: String(error?.message || error || "LLM unavailable"),
      };
    }

    const message = String(error?.message || error || "LLM unavailable");
    const lower = message.toLowerCase();

    if (lower.includes("timeout")) {
      return { reasonCode: LLM_REASON_CODES.TIMEOUT, operatorMessage: message };
    }
    if (lower.includes("model_not_found") || lower.includes("model not found") || lower.includes("no longer available")) {
      return { reasonCode: LLM_REASON_CODES.MODEL_NOT_FOUND, operatorMessage: message };
    }
    if (lower.includes("fetch failed") || lower.includes("network") || lower.includes("offline")) {
      return { reasonCode: LLM_REASON_CODES.OFFLINE, operatorMessage: message };
    }
    if (lower.includes("gemini http")) {
      return { reasonCode: LLM_REASON_CODES.HTTP_ERROR, operatorMessage: message };
    }
    return { reasonCode: LLM_REASON_CODES.UNKNOWN, operatorMessage: message };
  }

  async generate(input) {
    if (!this.isConfigured()) {
      throw new Error("Gemini API key missing");
    }
    const prompt = this.buildPrompt(input);
    const responseJsonSchema = this.buildReportResponseJsonSchema();
    const response = await this.callGemini(prompt, {
      thinkingLevel: this.config.llm?.thinkingLevels?.report || "low",
      responseJsonSchema,
    });
    const rawText = response.text;
    const parsed = parseGeneratedJson(rawText);

    if (!parsed.ok) {
      const repairedResponse = await this.repairJson(rawText, input, { responseJsonSchema });
      const repairedText = repairedResponse.text;
      const repairedParsed = parseGeneratedJson(repairedText);
      if (!repairedParsed.ok) {
        throw new Error(`Gemini JSON parse failed: ${repairedParsed.error?.message || "unknown"}`);
      }
      const validated = validateGeneratedCopyShape(repairedParsed.value);
      if (!validated.ok) {
        throw new Error(`Gemini JSON schema invalid after repair: ${validated.errors.join(", ")}`);
      }
      return {
        ...validated.value,
        _usage: repairedResponse.usage || response.usage || null,
      };
    }

    const validated = validateGeneratedCopyShape(parsed.value);
    if (!validated.ok) {
      throw new Error(`Gemini JSON schema invalid: ${validated.errors.join(", ")}`);
    }
    return {
      ...validated.value,
      _usage: response.usage || null,
    };
  }

  async generateAdaptiveQuestion(input) {
    if (!this.isConfigured()) {
      throw new Error("Gemini API key missing");
    }
    const prompt = this.buildAdaptiveQuestionPrompt(input);
    const responseJsonSchema = this.buildAdaptiveQuestionResponseJsonSchema(input.slot, input.language);
    const response = await this.callGemini(prompt, {
      thinkingLevel: this.config.llm?.thinkingLevels?.question || "minimal",
      responseJsonSchema,
    });
    const rawText = response.text;
    const parsed = parseGeneratedJson(rawText);

    if (!parsed.ok) {
      const repairedResponse = await this.repairJson(rawText, input, { responseJsonSchema });
      const repairedText = repairedResponse.text;
      const repairedParsed = parseGeneratedJson(repairedText);
      if (!repairedParsed.ok) {
        throw new Error(`Gemini question JSON parse failed: ${repairedParsed.error?.message || "unknown"}`);
      }
      const validated = validateAdaptiveQuestionShape(repairedParsed.value, input.slot);
      if (!validated.ok) {
        throw new Error(`Gemini question schema invalid after repair: ${validated.errors.join(", ")}`);
      }
      return {
        ...validated.value,
        _usage: repairedResponse.usage || response.usage || null,
      };
    }

    const validated = validateAdaptiveQuestionShape(parsed.value, input.slot);
    if (!validated.ok) {
      throw new Error(`Gemini question schema invalid: ${validated.errors.join(", ")}`);
    }
    return {
      ...validated.value,
      _usage: response.usage || null,
    };
  }

  buildPrompt(input) {
    const toneDescription =
      this.config.tone?.presets?.[input.tonePreset] || this.config.tone?.presets?.cruel_balanced || "";
    const languageLabel = input.language === "pl" ? "Polish (PL)" : "English (EN)";

    const answerLines = Object.entries(input.answers || {})
      .map(([key, value]) => `- ${key}: ${String(value ?? "")}`)
      .join("\n");
    const questionHistoryLines = Array.isArray(input.questionHistory)
      ? input.questionHistory
          .map((item, idx) => {
            const q = String(item?.prompt || item?.questionPrompt || "").trim();
            const a = String(item?.answerLabel || item?.answerValue || item?.answer || "").trim();
            if (!q && !a) return null;
            return `- Q${idx + 1}: ${q || item?.id || "question"} | A: ${a || "-"}`;
          })
          .filter(Boolean)
          .join("\n")
      : "";
    const passwordContextLines = this.formatPasswordContextForPrompt(input.passwordContext);
    const arcSummary = typeof input.arcSummary === "string" ? input.arcSummary : "";
    const contradictionLines = Array.isArray(input.keyContradictions)
      ? input.keyContradictions
          .map((line, idx) => `- C${idx + 1}: ${String(line || "").trim()}`)
          .filter(Boolean)
          .join("\n")
      : "";
    const allowedVerbatimQuotesMax = Number.isFinite(Number(input.allowedVerbatimQuotesMax))
      ? Math.max(0, Math.min(2, Math.round(Number(input.allowedVerbatimQuotesMax))))
      : 2;

    return [
      "You are writing copy for an art installation terminal.",
      `Language: ${languageLabel}. Output language must match exactly.`,
      `Tone preset: ${input.tonePreset} (${toneDescription}).`,
      "",
      "Hard rules (must follow):",
      "- No profanity.",
      "- No hate, slurs, or references to protected traits.",
      "- No medical/psychiatric diagnosis.",
      "- No self-harm or violence suggestions.",
      "- Do not mention real personal data.",
      "- Be cynical, sharp, and elegant. Judge behavior patterns, not identity.",
      "- Make the result feel specific to THIS exact session.",
      "- Use connections between earlier and later answers; avoid generic fortune-cookie text.",
      "- You may reference password attempts directly as part of the session artifact context.",
      "- The long receipt text must read as one flowing section (not disconnected aphorisms).",
      "- Be more creative in imagery and rhythm, but remain clear and printable.",
      "- Build one narrative arc: observation -> confrontation -> verdict.",
      `- Use at most ${allowedVerbatimQuotesMax} short verbatim quotes from the user's own words.`,
      "",
      "Context:",
      `- login/pseudonym: ${input.login}`,
      `- session_id: ${input.sessionId}`,
      `- user_input_flags: ${JSON.stringify(input.userInputFlags || {})}`,
      "- answers:",
      answerLines || "- none",
      "- question_history:",
      questionHistoryLines || "- none",
      "- password_context:",
      passwordContextLines || "- none",
      "- arc_summary:",
      arcSummary || "- none",
      contradictionLines ? "- key_contradictions:" : "- key_contradictions: none",
      contradictionLines || "",
      "- instruction:",
      "  Use question history and password attempts as evidence. Make the receipt_body_lines a single coherent mini-monologue split across lines for printing.",
      "",
      "Return ONLY valid JSON with this exact schema and keys:",
      "{",
      '  "language": "pl|en",',
      '  "screen_summary": ["line1","line2","line3"],',
      '  "receipt_title": "SYSTEM RECOVERY RECEIPT",',
      '  "receipt_body_lines": ["line1","line2","line3","line4","line5","line6","line7","line8"],',
      '  "tags": ["TAG1","TAG2","TAG3"],',
      '  "archive_quote": "max 120 chars",',
      '  "metrics": [{"label":"...", "value": 0-100, "suffix":"%"} , 3 items total],',
      '  "verdict": "DENIED" or "PROVISIONAL"',
      "}",
      "",
      "Formatting constraints:",
      "- screen_summary exactly 3 items.",
      "- receipt_body_lines 8-12 items, concise and printable.",
      "- receipt_body_lines should feel like one paragraph split by hard wraps; avoid standalone slogans.",
      "- tags exactly 3, uppercase-friendly, short.",
      "- archive_quote max 120 chars.",
      "- metrics exactly 3 items.",
      "- No markdown, no code fences, no commentary.",
    ].join("\n");
  }

  buildAdaptiveQuestionPrompt(input) {
    const toneDescription =
      this.config.tone?.presets?.[input.tonePreset] || this.config.tone?.presets?.cruel_balanced || "";
    const language = input.language === "pl" ? "pl" : "en";
    const languageLabel = language === "pl" ? "Polish (PL)" : "English (EN)";
    const slot = input.slot || {};
    const contextFocus = String(input.contextFocus || "neutral_probe");
    const arc = input.arcConstraints || {};
    const requiredIntent = String(arc.requiredIntent || slot.intentTag || "motive_declaration");
    const forbiddenIntentOverlap = Array.isArray(arc.forbiddenIntentOverlap)
      ? arc.forbiddenIntentOverlap.join("|") || "none"
      : "none";
    const requiredRhetoricalForm = String(arc.requiredRhetoricalForm || "probe");
    const minNoveltyScore = Number.isFinite(Number(arc.minNoveltyScore))
      ? Number(arc.minNoveltyScore).toFixed(2)
      : "0.55";
    const requireAnchor = arc.requireAnchor ? "yes" : "no";
    const remainingVerbatimQuotes = Number.isFinite(Number(arc.remainingVerbatimQuotes))
      ? Math.max(0, Math.round(Number(arc.remainingVerbatimQuotes)))
      : 2;
    const qualityFeedback = typeof input.qualityFeedback === "string" && input.qualityFeedback.trim()
      ? input.qualityFeedback.trim()
      : "";
    const passwordContextLines = this.formatPasswordContextForPrompt(input.passwordContext);
    const interactionDigestLines = Array.isArray(input.interactionDigest) ? input.interactionDigest : [];
    const previousHistoryLines = Array.isArray(input.previousHistory)
      ? input.previousHistory
          .map((item, idx) => {
            const prompt = String(item?.prompt || "").trim();
            const answer = String(item?.answerLabel || item?.answerValue || "").trim();
            return `- Q${idx + 1}: ${prompt} | A: ${answer}`;
          })
          .join("\n")
      : "";

    const slotOptionsText =
      slot.type === "choice"
        ? (slot.options || [])
            .map(
              (opt) =>
                `  - value="${opt.value}" label_default="${opt.label?.[language] || opt.value}"`,
            )
            .join("\n")
        : "";

    return [
      "You are generating ONE interview question for an art installation terminal.",
      `Language: ${languageLabel}. Return output in ${language}.`,
      `Tone preset: ${input.tonePreset} (${toneDescription}).`,
      "",
      "Goal:",
      "- Make the question feel specific to the current user/session.",
      "- Use previous answers to steer the next question.",
      "- If question_index > 0, explicitly anchor the wording in at least one previous answer or password pattern.",
      "- Use slot prompt as a structural hint only; write fresh wording every time.",
      "- You have creative freedom in phrasing, rhetorical shape, and contrast.",
      "- Keep it short, sharp, and safe for a public gallery.",
      "- It may be cynical/procedural, but not abusive.",
      "- Avoid repeating the exact phrasing pattern of previous prompts.",
      "- Prefer questions that expose contradiction or tension in the user's interaction trail.",
      `- Intent must be exactly: ${requiredIntent}.`,
      `- Rhetorical form must be exactly: ${requiredRhetoricalForm}.`,
      "- Return one transitionLine used between questions (procedural, concise, cinematic).",
      "",
      "Hard rules:",
      "- No profanity.",
      "- No hate/slurs/protected trait references.",
      "- No medical/psychiatric diagnosis.",
      "- No self-harm/violence suggestions.",
      "- Do not ask for personal data (name, address, phone, email, etc.).",
      "- Keep prompt under 140 chars.",
      "- Keep transitionLine under 160 chars.",
      "- Do not make Q3 and Q5 semantic clones.",
      `- Forbidden overlap intents: ${forbiddenIntentOverlap}.`,
      `- Min novelty score target: ${minNoveltyScore}.`,
      `- Require anchor to prior context: ${requireAnchor}.`,
      `- Remaining verbatim quote budget: ${remainingVerbatimQuotes}.`,
      "- You may refer to password attempts directly as session material.",
      "",
      "Session context:",
      `- login/pseudonym: ${input.login}`,
      `- session_id: ${input.sessionId}`,
      `- question_index: ${input.questionIndex}`,
      `- slot_id: ${slot.id}`,
      `- slot_type: ${slot.type}`,
      `- context_focus: ${contextFocus}`,
      previousHistoryLines ? "- previous Q/A:" : "- previous Q/A: none",
      previousHistoryLines || "",
      interactionDigestLines.length ? "- interaction_digest:" : "",
      interactionDigestLines.length ? interactionDigestLines.join("\n") : "",
      "- password_context:",
      passwordContextLines || "- none",
      qualityFeedback ? "- quality_feedback_from_previous_attempt:" : "",
      qualityFeedback || "",
      "",
      "Slot constraints (must follow exactly):",
      `- id must be "${slot.id}"`,
      `- type must be "${slot.type}"`,
      `- intentTag must be "${requiredIntent}"`,
      `- rhetoricalForm must be "${requiredRhetoricalForm}"`,
      slot.type === "text"
        ? `- minLength ${slot.minLength || 1}, maxLength ${slot.maxLength || 24}`
        : "- options values must match provided set exactly",
      slot.type === "choice" ? "- Provide all options, preserving values; you may rewrite labels only." : "",
      slot.type === "choice" ? slotOptionsText : "",
      "- You may rewrite option labels aggressively, but values must stay identical.",
      "",
      "Return ONLY valid JSON with keys:",
      slot.type === "choice"
        ? `{"language":"${language}","id":"${slot.id}","type":"choice","intentTag":"${requiredIntent}","rhetoricalForm":"${requiredRhetoricalForm}","transitionLine":"...","prompt":"...","options":[{"value":"...","label":"..."}]}`
        : `{"language":"${language}","id":"${slot.id}","type":"text","intentTag":"${requiredIntent}","rhetoricalForm":"${requiredRhetoricalForm}","transitionLine":"...","prompt":"...","placeholder":"...","minLength":${slot.minLength || 1},"maxLength":${slot.maxLength || 24}}`,
      "",
      "No markdown. No comments. JSON only.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  formatPasswordContextForPrompt(passwordContext) {
    if (!passwordContext || typeof passwordContext !== "object") return "";
    const attempts = Array.isArray(passwordContext.attempts) ? passwordContext.attempts : [];
    const summary = passwordContext.summary || {};
    const lines = [];
    if (attempts.length) {
      for (const attempt of attempts) {
        lines.push(
          `- attempt_${attempt.index}: sanitized="${attempt.sanitized}", length=${attempt.length}, tags=${(attempt.tags || []).join("|") || "none"}, classes=${JSON.stringify(
            attempt.charClasses || {},
          )}`,
        );
      }
    }
    lines.push(
      `- summary: count=${summary.count || 0}, duplicates=${summary.duplicateSanitizedCount || 0}, anyRepeated=${
        summary.anyRepeated ? "true" : "false"
      }, anyYearLike=${summary.anyYearLike ? "true" : "false"}, minLength=${summary.minLength || 0}, maxLength=${
        summary.maxLength || 0
      }, tags=${Array.isArray(summary.uniqueTagList) ? summary.uniqueTagList.join("|") : ""}`,
    );
    return lines.join("\n");
  }

  buildReportResponseJsonSchema() {
    return {
      type: "object",
      additionalProperties: false,
      properties: {
        language: { type: "string", enum: ["pl", "en"] },
        screen_summary: {
          type: "array",
          description: "Exactly 3 short summary lines for the result screen.",
          minItems: 3,
          maxItems: 3,
          items: { type: "string" },
        },
        receipt_title: { type: "string", description: "Printable receipt section title." },
        receipt_body_lines: {
          type: "array",
          description:
            "8-12 lines that together form one continuous, coherent paragraph/monologue split for receipt printing.",
          minItems: 8,
          maxItems: 12,
          items: { type: "string" },
        },
        tags: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: { type: "string" },
        },
        archive_quote: { type: "string" },
        metrics: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              label: { type: "string" },
              value: { type: "number" },
              suffix: { type: "string" },
            },
            required: ["label", "value", "suffix"],
          },
        },
        verdict: { type: "string", enum: ["DENIED", "PROVISIONAL"] },
      },
      required: [
        "language",
        "screen_summary",
        "receipt_title",
        "receipt_body_lines",
        "tags",
        "archive_quote",
        "metrics",
        "verdict",
      ],
    };
  }

  buildAdaptiveQuestionResponseJsonSchema(slot, language) {
    const lang = language === "pl" ? "pl" : "en";
    if (!slot || typeof slot !== "object") {
      return {
        type: "object",
        properties: {
          language: { type: "string", enum: [lang] },
        },
        required: ["language"],
      };
    }

    if (slot.type === "choice") {
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          language: { type: "string", enum: [lang] },
          id: { type: "string", enum: [slot.id] },
          type: { type: "string", enum: ["choice"] },
          intentTag: { type: "string", enum: [slot.intentTag || "motive_declaration"] },
          rhetoricalForm: { type: "string" },
          transitionLine: { type: "string" },
          prompt: { type: "string" },
          options: {
            type: "array",
            minItems: Array.isArray(slot.options) ? slot.options.length : 0,
            maxItems: Array.isArray(slot.options) ? slot.options.length : 8,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                value: {
                  type: "string",
                  enum: Array.isArray(slot.options) ? slot.options.map((opt) => opt.value) : [],
                },
                label: { type: "string" },
              },
              required: ["value", "label"],
            },
          },
        },
        required: ["language", "id", "type", "intentTag", "rhetoricalForm", "transitionLine", "prompt", "options"],
      };
    }

    return {
      type: "object",
      additionalProperties: false,
      properties: {
        language: { type: "string", enum: [lang] },
        id: { type: "string", enum: [slot.id] },
        type: { type: "string", enum: ["text"] },
        intentTag: { type: "string", enum: [slot.intentTag || "motive_declaration"] },
        rhetoricalForm: { type: "string" },
        transitionLine: { type: "string" },
        prompt: { type: "string" },
        placeholder: { type: "string" },
        minLength: { type: "number" },
        maxLength: { type: "number" },
      },
      required: [
        "language",
        "id",
        "type",
        "intentTag",
        "rhetoricalForm",
        "transitionLine",
        "prompt",
        "placeholder",
        "minLength",
        "maxLength",
      ],
    };
  }

  async repairJson(rawText, input, options = {}) {
    const prompt = [
      "Fix the following invalid output into valid JSON only.",
      "Do not rewrite the meaning more than necessary.",
      `Language must remain ${input.language}.`,
      "Return only JSON.",
      "",
      rawText,
    ].join("\n");
    return this.callGemini(prompt, {
      thinkingLevel: this.config.llm?.thinkingLevels?.repair || "minimal",
      responseJsonSchema: options.responseJsonSchema || null,
    });
  }

  async callGemini(prompt, options = {}) {
    const model = this.config.llm.model;
    const url = `${this.config.llm.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;

    const controller = new AbortController();
    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
      ? Math.max(500, Math.round(Number(options.timeoutMs)))
      : this.config.llm.timeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.config.llm.apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: Number.isFinite(this.config.llm.temperature) ? this.config.llm.temperature : 1.0,
            responseMimeType: "application/json",
            ...(options.responseJsonSchema ? { responseJsonSchema: options.responseJsonSchema } : {}),
            ...(options.thinkingLevel
              ? {
                  thinkingConfig: {
                    thinkingLevel: options.thinkingLevel,
                  },
                }
              : {}),
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const message = `Gemini HTTP ${response.status}: ${body.slice(0, 400)}`;
        const error = new Error(message);
        if (response.status === 404 && /model|not[_\s-]*found|no longer available/i.test(body)) {
          error.reasonCode = LLM_REASON_CODES.MODEL_NOT_FOUND;
        } else {
          error.reasonCode = LLM_REASON_CODES.HTTP_ERROR;
        }
        throw error;
      }

      const payload = await response.json();
      const text = this.extractText(payload);
      if (!text) {
        throw new Error("Gemini returned no text content");
      }
      return {
        text,
        usage: this.extractUsage(payload),
      };
    } catch (error) {
      if (error && (error.name === "AbortError" || String(error.message || "").includes("aborted"))) {
        const timeoutError = new Error(`Gemini request timeout after ${timeoutMs}ms`);
        timeoutError.reasonCode = LLM_REASON_CODES.TIMEOUT;
        throw timeoutError;
      }
      if (error && !error.reasonCode) {
        const lower = String(error.message || error).toLowerCase();
        if (lower.includes("fetch failed") || lower.includes("network")) {
          error.reasonCode = LLM_REASON_CODES.OFFLINE;
        } else {
          error.reasonCode = LLM_REASON_CODES.UNKNOWN;
        }
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  extractText(payload) {
    const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
    for (const candidate of candidates) {
      const parts = candidate?.content?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (typeof part?.text === "string" && part.text.trim()) {
          return part.text;
        }
      }
    }
    return "";
  }

  extractUsage(payload) {
    const usage = payload?.usageMetadata;
    if (!usage || typeof usage !== "object") return null;
    const promptTokens = Number(usage.promptTokenCount);
    const completionTokens = Number(usage.candidatesTokenCount);
    const totalTokens = Number(usage.totalTokenCount);
    const thoughtsTokens = Number(usage.thoughtsTokenCount);

    return {
      promptTokens: Number.isFinite(promptTokens) ? promptTokens : null,
      completionTokens: Number.isFinite(completionTokens) ? completionTokens : null,
      totalTokens: Number.isFinite(totalTokens) ? totalTokens : null,
      thoughtsTokens: Number.isFinite(thoughtsTokens) ? thoughtsTokens : null,
    };
  }
}

module.exports = { ContentGenerationService };
