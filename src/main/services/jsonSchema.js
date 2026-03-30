const { clamp } = require("../utils/text");
const { RHETORICAL_FORMS, INTENT_TAGS } = require("../../shared/questions");
const { VERDICTS } = require("../../shared/constants");

const ALLOWED_INTENTS = Object.values(INTENT_TAGS);

function extractFirstJsonObject(text) {
  const source = String(text ?? "").trim();
  const start = source.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function parseGeneratedJson(text) {
  const direct = String(text ?? "").trim();
  const candidates = [direct, extractFirstJsonObject(direct)].filter(Boolean);
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch (error) {
      lastError = error;
    }
  }
  return { ok: false, error: lastError || new Error("Invalid JSON") };
}

function asLineArray(value, maxItems, maxLen) {
  if (!Array.isArray(value)) return null;
  const lines = value
    .filter((item) => typeof item === "string")
    .map((item) => clamp(item.trim(), maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
  return lines.length > 0 ? lines : null;
}

function normalizeMetric(metric) {
  if (!metric || typeof metric !== "object") return null;
  const label = typeof metric.label === "string" ? clamp(metric.label.trim(), 28) : "";
  const rawValue = Number(metric.value);
  const value = Number.isFinite(rawValue) ? Math.max(0, Math.min(100, Math.round(rawValue))) : null;
  const suffix = typeof metric.suffix === "string" ? clamp(metric.suffix.trim(), 4) : "%";
  if (!label || value === null) return null;
  return { label, value, suffix: suffix || "%" };
}

function validateGeneratedCopyShape(obj) {
  if (!obj || typeof obj !== "object") {
    return { ok: false, errors: ["payload_not_object"] };
  }

  const language = obj.language === "pl" || obj.language === "en" ? obj.language : null;
  const screenSummary = asLineArray(obj.screen_summary, 3, 96);
  const receiptTitle =
    typeof obj.receipt_title === "string" && obj.receipt_title.trim()
      ? clamp(obj.receipt_title.trim(), 48)
      : null;
  const receiptBodyLines = asLineArray(obj.receipt_body_lines, 12, 96);
  const tags = asLineArray(obj.tags, 3, 20);
  const archiveQuote =
    typeof obj.archive_quote === "string" && obj.archive_quote.trim()
      ? clamp(obj.archive_quote.trim(), 120)
      : null;
  const metrics = Array.isArray(obj.metrics)
    ? obj.metrics.map(normalizeMetric).filter(Boolean).slice(0, 5)
    : null;
  const verdict =
    obj.verdict === VERDICTS.DENIED || obj.verdict === VERDICTS.PROVISIONAL ? obj.verdict : null;

  const errors = [];
  if (!language) errors.push("language");
  if (!screenSummary) errors.push("screen_summary");
  if (!receiptTitle) errors.push("receipt_title");
  if (!receiptBodyLines) errors.push("receipt_body_lines");
  if (!tags || tags.length < 3) errors.push("tags");
  if (!archiveQuote) errors.push("archive_quote");
  if (!metrics || metrics.length < 3) errors.push("metrics");
  if (!verdict) errors.push("verdict");

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      language,
      screen_summary: screenSummary,
      receipt_title: receiptTitle,
      receipt_body_lines: receiptBodyLines,
      tags: tags.slice(0, 3),
      archive_quote: archiveQuote,
      metrics: metrics.slice(0, 3),
      verdict,
    },
  };
}

function validateAdaptiveQuestionShape(obj, slot) {
  if (!obj || typeof obj !== "object") {
    return { ok: false, errors: ["payload_not_object"] };
  }
  if (!slot || typeof slot !== "object") {
    return { ok: false, errors: ["missing_slot"] };
  }

  const errors = [];
  const language = obj.language === "pl" || obj.language === "en" ? obj.language : null;
  if (!language) errors.push("language");

  const id = obj.id === slot.id ? obj.id : null;
  if (!id) errors.push("id");

  const type = obj.type === slot.type ? obj.type : null;
  if (!type) errors.push("type");

  const prompt =
    typeof obj.prompt === "string" && obj.prompt.trim() ? clamp(obj.prompt.trim(), 140) : null;
  if (!prompt) errors.push("prompt");

  const expectedIntent = typeof slot.intentTag === "string" ? slot.intentTag : null;
  const intentTag =
    typeof obj.intentTag === "string" && ALLOWED_INTENTS.includes(obj.intentTag)
      ? obj.intentTag
      : expectedIntent;
  if (!intentTag) errors.push("intentTag");
  if (expectedIntent && intentTag !== expectedIntent) errors.push("intentTag_mismatch");

  const rhetoricalForm =
    typeof obj.rhetoricalForm === "string" && RHETORICAL_FORMS.includes(obj.rhetoricalForm)
      ? obj.rhetoricalForm
      : null;
  if (!rhetoricalForm) errors.push("rhetoricalForm");

  const transitionLine =
    typeof obj.transitionLine === "string" && obj.transitionLine.trim()
      ? clamp(obj.transitionLine.trim(), 160)
      : null;
  if (!transitionLine) errors.push("transitionLine");

  if (slot.type === "choice") {
    const inputOptions = Array.isArray(obj.options) ? obj.options : [];
    const normalizedOptions = [];
    const slotValues = new Set((slot.options || []).map((opt) => opt.value));
    for (const opt of inputOptions) {
      if (!opt || typeof opt !== "object") continue;
      const value = typeof opt.value === "string" ? opt.value.trim() : "";
      const label = typeof opt.label === "string" ? clamp(opt.label.trim(), 48) : "";
      if (!value || !label) continue;
      if (!slotValues.has(value)) continue;
      normalizedOptions.push({ value, label });
    }
    const uniqueValues = new Set(normalizedOptions.map((opt) => opt.value));
    if ((slot.options || []).length === 0) {
      errors.push("slot_options_missing");
    } else if (uniqueValues.size !== slot.options.length) {
      errors.push("options");
    }

    const options = (slot.options || []).map((slotOpt) => {
      const generated = normalizedOptions.find((opt) => opt.value === slotOpt.value);
      return {
        value: slotOpt.value,
        label: generated?.label || slotOpt.label?.[language] || slotOpt.value,
      };
    });

    if (errors.length > 0) return { ok: false, errors };
    return {
      ok: true,
      value: {
        id: slot.id,
        type: slot.type,
        language,
        prompt,
        transitionLine,
        intentTag,
        rhetoricalForm,
        options,
        maxLength: slot.maxLength || 32,
      },
    };
  }

  if (slot.type === "text") {
    const placeholder =
      typeof obj.placeholder === "string" && obj.placeholder.trim()
        ? clamp(obj.placeholder.trim(), 32)
        : clamp(slot.placeholder?.[language] || "", 32);

    const minLengthRaw = Number(obj.minLength);
    const maxLengthRaw = Number(obj.maxLength);
    const minLength = Number.isFinite(minLengthRaw) ? Math.max(1, Math.min(8, Math.round(minLengthRaw))) : slot.minLength || 1;
    const maxLength = Number.isFinite(maxLengthRaw)
      ? Math.max(minLength, Math.min(32, Math.round(maxLengthRaw)))
      : slot.maxLength || 24;

    if (errors.length > 0) return { ok: false, errors };
    return {
      ok: true,
      value: {
        id: slot.id,
        type: slot.type,
        language,
        prompt,
        transitionLine,
        intentTag,
        rhetoricalForm,
        placeholder,
        minLength,
        maxLength,
      },
    };
  }

  return { ok: false, errors: ["unsupported_slot_type"] };
}

module.exports = {
  extractFirstJsonObject,
  parseGeneratedJson,
  validateGeneratedCopyShape,
  validateAdaptiveQuestionShape,
};
