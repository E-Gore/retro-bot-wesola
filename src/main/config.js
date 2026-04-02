const path = require("node:path");

function parseIntEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseThinkingLevelEnv(name, fallback) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["minimal", "low", "medium", "high"].includes(raw)) return raw;
  return fallback;
}

function parseBoolEnv(name, fallback = false) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function getConfig({ userDataPath }) {
  const tonePreset = process.env.RETROBOT_TONE_PRESET || "cruel_balanced";
  const fullScreenEnv = process.env.RETROBOT_FULLSCREEN;
  const kioskEnv = process.env.RETROBOT_KIOSK;

  return {
    app: {
      name: "RETRO BOT / Terminal Odzyskiwania Dostępu",
      version: "0.1.0",
      fullscreen: fullScreenEnv === "0" ? false : true,
      kiosk: kioskEnv === "1",
      operatorMode: parseBoolEnv("RETROBOT_OPERATOR_MODE", false),
      idleTimeoutMs: parseIntEnv("RETROBOT_IDLE_TIMEOUT_MS", 35000),
      postResultTimeoutMs: parseIntEnv("RETROBOT_POST_RESULT_TIMEOUT_MS", 180000),
      handoffDurationMs: 1600,
      analysisMinMs: 3000,
      analysisMaxMs: 10000,
      analysisRequestTimeoutMs: 7000,
      receiptWidth: 42,
    },
    tone: {
      current: tonePreset,
      presets: {
        cruel_light:
          "cool, ironic, gently patronizing, restrained, elegant, no insults, no cruelty escalation",
        cruel_balanced:
          "corporate cynicism, surgical observations, passive-aggressive, elegant, witty, sharp but clean",
        cruel_sharp:
          "cold, precise, biting, superior tone, still safe and non-abusive, elegant and controlled",
      },
    },
    llm: {
      provider: "gemini",
      apiKey: process.env.GEMINI_API_KEY || "",
      model: process.env.GEMINI_MODEL || "gemini-3-flash-preview",
      baseUrl:
        process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta",
      temperature: Number(process.env.GEMINI_TEMPERATURE || "1.0"),
      timeoutMs: parseIntEnv("GEMINI_TIMEOUT_MS", 15000),
      thinkingLevels: {
        question: parseThinkingLevelEnv("GEMINI_THINKING_LEVEL_QUESTION", "low"),
        report: parseThinkingLevelEnv("GEMINI_THINKING_LEVEL_REPORT", "low"),
        repair: parseThinkingLevelEnv("GEMINI_THINKING_LEVEL_REPAIR", "minimal"),
      },
    },
    storage: {
      dataDir: path.join(userDataPath, "retrobot-data"),
      sqlitePath: path.join(userDataPath, "retrobot-data", "retrobot.db"),
      jsonFallbackPath: path.join(userDataPath, "retrobot-data", "retrobot-sessions.json"),
      exportsDir: path.join(userDataPath, "retrobot-data", "exports"),
    },
    safety: {
      bannedWords: [
        "kurwa",
        "chuj",
        "fuck",
        "shit",
        "bitch",
        "idiot",
        "retard",
      ],
      riskyPhrases: [
        "kill yourself",
        "samob",
        "suicide",
        "violent",
        "nazi",
      ],
      maxArchiveQuoteChars: 120,
      maxReceiptBodyLines: 12,
      maxScreenSummaryLines: 3,
    },
  };
}

module.exports = { getConfig };
