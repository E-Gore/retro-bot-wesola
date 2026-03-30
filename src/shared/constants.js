const LANGUAGES = {
  PL: "pl",
  EN: "en",
};

const SCREEN_IDS = {
  ATTRACTOR: "attractor",
  ADMIN_LOCK: "admin_lock",
  LANGUAGE: "language",
  LOGIN: "login",
  PASSWORD1: "password1",
  PASSWORD2: "password2",
  PASSWORD3: "password3",
  HANDOFF: "handoff",
  QUESTION: "question",
  QUESTION_TRANSITION: "question_transition",
  ANALYSIS: "analysis",
  RESULT: "result",
  RECEIPT_PREVIEW: "receipt_preview",
};

const CONTENT_SOURCES = {
  GEMINI: "gemini",
  TEMPLATE_FALLBACK: "template_fallback",
  REWRITTEN: "rewritten",
};

const LLM_REASON_CODES = {
  OK: "ok",
  MISSING_API_KEY: "missing_api_key",
  OFFLINE: "offline",
  HTTP_ERROR: "http_error",
  TIMEOUT: "timeout",
  MODEL_NOT_FOUND: "model_not_found",
  UNKNOWN: "unknown",
};

const VERDICTS = {
  DENIED: "DENIED",
  PROVISIONAL: "PROVISIONAL",
};

const RECEIPT_WIDTHS = {
  W80: 42,
  W58: 32,
};

module.exports = {
  LANGUAGES,
  SCREEN_IDS,
  CONTENT_SOURCES,
  VERDICTS,
  RECEIPT_WIDTHS,
  LLM_REASON_CODES,
};
