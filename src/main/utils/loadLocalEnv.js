const fs = require("node:fs");
const path = require("node:path");

function parseEnvFile(content) {
  const lines = String(content || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;

    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (!key) continue;

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function loadLocalEnvFiles(baseDir) {
  const candidates = [".env", ".env.local"];
  for (const fileName of candidates) {
    const filePath = path.join(baseDir, fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      const content = fs.readFileSync(filePath, "utf8");
      parseEnvFile(content);
    } catch {
      // Ignore malformed local env file; app will fall back to runtime env/defaults.
    }
  }
}

module.exports = { loadLocalEnvFiles };
