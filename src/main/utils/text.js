function stripControlChars(value) {
  return String(value ?? "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function clamp(str, max) {
  const value = String(str ?? "");
  return value.length <= max ? value : value.slice(0, max);
}

function wrapLine(text, width) {
  const words = String(text ?? "")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return [""];

  const lines = [];
  let current = "";
  for (const word of words) {
    if (word.length > width) {
      if (current) {
        lines.push(current);
        current = "";
      }
      let chunk = word;
      while (chunk.length > width) {
        lines.push(chunk.slice(0, width));
        chunk = chunk.slice(width);
      }
      current = chunk;
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function padRight(text, width) {
  const str = String(text ?? "");
  if (str.length >= width) return str.slice(0, width);
  return str + " ".repeat(width - str.length);
}

function centerText(text, width) {
  const str = String(text ?? "");
  if (str.length >= width) return str.slice(0, width);
  const left = Math.floor((width - str.length) / 2);
  const right = width - str.length - left;
  return `${" ".repeat(left)}${str}${" ".repeat(right)}`;
}

module.exports = {
  stripControlChars,
  clamp,
  wrapLine,
  padRight,
  centerText,
};
