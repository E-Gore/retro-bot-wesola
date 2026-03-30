function normalizePasswordRaw(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .slice(0, 64);
}

function classifyChars(text) {
  let lower = 0;
  let upper = 0;
  let digits = 0;
  let spaces = 0;
  let symbols = 0;
  for (const ch of String(text || "")) {
    if (/[a-z]/.test(ch)) lower += 1;
    else if (/[A-Z]/.test(ch)) upper += 1;
    else if (/[0-9]/.test(ch)) digits += 1;
    else if (/\s/.test(ch)) spaces += 1;
    else symbols += 1;
  }
  return { lower, upper, digits, spaces, symbols };
}

function detectPasswordTags(text) {
  const value = String(text || "");
  const lower = value.toLowerCase();
  const tags = [];
  if (!value) return tags;
  if (/^\d+$/.test(value)) tags.push("digits_only");
  if (/^[a-z]+$/i.test(value)) tags.push("letters_only");
  if (/^(.)\1{2,}$/.test(value)) tags.push("single_char_repeat");
  if (/(.)\1{2,}/.test(value)) tags.push("repeated_chars");
  if (/\d{4}/.test(value)) tags.push("year_like");
  if (/[!@#$%^&*()_\-+=\[\]{};:'",.<>/?\\|`~]/.test(value)) tags.push("has_symbols");
  if (/\s/.test(value)) tags.push("has_spaces");
  if (/(qwerty|asdf|1234|password|admin|letmein)/i.test(lower)) tags.push("common_pattern");
  if (value.length <= 4) tags.push("very_short");
  if (value.length >= 12) tags.push("long");
  return tags;
}

function buildAttemptDescriptor(raw, index, safetyService) {
  const normalized = normalizePasswordRaw(raw);
  if (!normalized) return null;
  const exposed = normalized.slice(0, 64);
  const charClasses = classifyChars(normalized);
  const tags = detectPasswordTags(normalized);
  return {
    index,
    sanitized: exposed,
    length: normalized.length,
    charClasses,
    tags,
  };
}

function buildPasswordContext(rawPasswordAttempts, safetyService) {
  const attempts = Array.isArray(rawPasswordAttempts)
    ? rawPasswordAttempts
        .slice(0, 3)
        .map((raw, idx) => buildAttemptDescriptor(raw, idx + 1, safetyService))
        .filter(Boolean)
    : [];

  const summary = {
    count: attempts.length,
    duplicateSanitizedCount: 0,
    anyRepeated: false,
    anyYearLike: false,
    maxLength: 0,
    minLength: 0,
    uniqueTagList: [],
  };

  if (attempts.length > 0) {
    const seen = new Map();
    for (const attempt of attempts) {
      seen.set(attempt.sanitized, (seen.get(attempt.sanitized) || 0) + 1);
    }
    summary.duplicateSanitizedCount = Array.from(seen.values()).filter((count) => count > 1).length;
    summary.anyRepeated = attempts.some((a) => a.tags.includes("repeated_chars") || a.tags.includes("single_char_repeat"));
    summary.anyYearLike = attempts.some((a) => a.tags.includes("year_like"));
    summary.maxLength = Math.max(...attempts.map((a) => a.length));
    summary.minLength = Math.min(...attempts.map((a) => a.length));
    summary.uniqueTagList = [...new Set(attempts.flatMap((a) => a.tags))].slice(0, 8);
  }

  return { attempts, summary };
}

module.exports = {
  buildPasswordContext,
};
