const { clamp, stripControlChars } = require("../utils/text");
const { normalizeTextInput } = require("../../shared/validation");

class SafetyService {
  constructor(config) {
    this.config = config;
    this.bannedWords = (config.safety?.bannedWords || []).map((w) => w.toLowerCase());
    this.riskyPhrases = (config.safety?.riskyPhrases || []).map((w) => w.toLowerCase());
    this.emailRe = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
    this.phoneRe = /(?:\+?\d[\d\s().-]{6,}\d)/;
    this.urlRe = /\bhttps?:\/\/\S+/i;
    this.handleRe = /(^|\s)@\w{2,}/;
  }

  containsBannedWord(text) {
    const lower = String(text ?? "").toLowerCase();
    return this.bannedWords.some((word) => word && lower.includes(word));
  }

  containsRiskyPhrase(text) {
    const lower = String(text ?? "").toLowerCase();
    return this.riskyPhrases.some((word) => word && lower.includes(word));
  }

  containsPII(text) {
    const value = String(text ?? "");
    return (
      this.emailRe.test(value) ||
      this.phoneRe.test(value) ||
      this.urlRe.test(value) ||
      this.handleRe.test(value)
    );
  }

  sanitizeText(text, maxLength = 120) {
    let value = normalizeTextInput(stripControlChars(text));
    value = value.replace(/\s{2,}/g, " ");
    if (this.containsPII(value)) {
      value = value
        .replace(this.emailRe, "[redacted-email]")
        .replace(this.phoneRe, "[redacted-phone]")
        .replace(this.urlRe, "[redacted-url]")
        .replace(this.handleRe, " [redacted-handle]");
    }
    if (this.containsBannedWord(value) || this.containsRiskyPhrase(value)) {
      value = "[redacted-input]";
    }
    return clamp(value, maxLength);
  }

  screenUserInput(inputMap) {
    const sanitized = {};
    const flags = {
      containsBannedWord: false,
      containsPII: false,
      containsRiskyPhrase: false,
      rejectedKeys: [],
    };

    for (const [key, raw] of Object.entries(inputMap || {})) {
      const text = normalizeTextInput(String(raw ?? ""));
      if (this.containsPII(text)) flags.containsPII = true;
      if (this.containsBannedWord(text)) flags.containsBannedWord = true;
      if (this.containsRiskyPhrase(text)) flags.containsRiskyPhrase = true;
      const sanitizedText = this.sanitizeText(text, key === "login" ? 24 : 64);
      if (sanitizedText === "[redacted-input]") flags.rejectedKeys.push(key);
      sanitized[key] = sanitizedText;
    }

    return {
      safe:
        flags.rejectedKeys.length === 0 &&
        !flags.containsRiskyPhrase &&
        !flags.containsPII &&
        !flags.containsBannedWord,
      flags,
      sanitized,
    };
  }

  screenGeneratedCopy(copy) {
    const strings = [];
    const push = (value) => {
      if (typeof value === "string") strings.push(value);
    };

    push(copy?.receipt_title);
    (copy?.screen_summary || []).forEach(push);
    (copy?.receipt_body_lines || []).forEach(push);
    (copy?.tags || []).forEach(push);
    push(copy?.archive_quote);
    (copy?.metrics || []).forEach((m) => {
      push(m?.label);
      push(m?.suffix);
    });

    const flags = {
      containsBannedWord: strings.some((s) => this.containsBannedWord(s)),
      containsRiskyPhrase: strings.some((s) => this.containsRiskyPhrase(s)),
      containsPII: strings.some((s) => this.containsPII(s)),
      tooLong:
        (copy?.archive_quote || "").length > (this.config.safety?.maxArchiveQuoteChars || 120) ||
        (copy?.receipt_body_lines || []).length > (this.config.safety?.maxReceiptBodyLines || 12),
    };

    return {
      safe: !flags.containsBannedWord && !flags.containsRiskyPhrase && !flags.containsPII && !flags.tooLong,
      flags,
    };
  }

  async rewriteUnsafe(copy, context = {}) {
    const language = context.language === "pl" ? "pl" : "en";
    const cleanLine = (value, max = 96) => {
      const sanitized = this.sanitizeText(value, max);
      if (!sanitized || sanitized === "[redacted-input]") {
        return language === "pl" ? "Treść znormalizowana przez system." : "Content normalized by system.";
      }
      return sanitized;
    };

    return {
      ...copy,
      receipt_title: cleanLine(copy.receipt_title, 48),
      screen_summary: (copy.screen_summary || []).slice(0, 3).map((line) => cleanLine(line, 96)),
      receipt_body_lines: (copy.receipt_body_lines || [])
        .slice(0, this.config.safety?.maxReceiptBodyLines || 12)
        .map((line) => cleanLine(line, 96)),
      tags: (copy.tags || []).slice(0, 3).map((tag) => cleanLine(tag, 20).toUpperCase()),
      archive_quote: cleanLine(copy.archive_quote, this.config.safety?.maxArchiveQuoteChars || 120),
      metrics: (copy.metrics || []).slice(0, 3).map((metric) => ({
        label: cleanLine(metric.label, 28),
        value: Number.isFinite(metric.value) ? Math.max(0, Math.min(100, Math.round(metric.value))) : 50,
        suffix: cleanLine(metric.suffix || "%", 4),
      })),
    };
  }
}

module.exports = { SafetyService };
