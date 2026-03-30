const DEFAULT_ALLOWED_RE = /^[\p{L}\p{N}\s.,!?'"()\-_/:%+&]*$/u;

function normalizeTextInput(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function validateTextAnswer(value, { minLength = 1, maxLength = 24 } = {}) {
  const normalized = normalizeTextInput(value);
  if (normalized.length < minLength) {
    return { ok: false, reason: "too_short", normalized };
  }
  if (normalized.length > maxLength) {
    return { ok: false, reason: "too_long", normalized };
  }
  if (!DEFAULT_ALLOWED_RE.test(normalized)) {
    return { ok: false, reason: "invalid_chars", normalized };
  }
  return { ok: true, normalized };
}

function validateLogin(value) {
  return validateTextAnswer(value, { minLength: 1, maxLength: 24 });
}

function normalizeAnswerValue(question, rawValue) {
  if (question.type === "choice") {
    return String(rawValue ?? "").trim();
  }
  return normalizeTextInput(rawValue);
}

module.exports = {
  DEFAULT_ALLOWED_RE,
  normalizeTextInput,
  validateTextAnswer,
  validateLogin,
  normalizeAnswerValue,
};
