function normalizeSessionTheme(value, maxLength = 48) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, Math.max(1, maxLength));
}

function detectSessionThemeMode(value) {
  const theme = normalizeSessionTheme(value).toLowerCase();
  if (!theme) return "open";

  if (/(mrocz|dark|cold|harsh|sharp|brutal|cynic|ironic|pesym|retro horror)/i.test(theme)) return "dark";
  if (/(zabaw|lekki|light|fun|play|humor|absurd|camp|ironi.*lekka)/i.test(theme)) return "playful";
  if (/(wspier|ciep|hope|optim|calm|soft|gentle|kind|spokoj|bezpiecz)/i.test(theme)) return "warm";
  if (/(poety|poetic|reflect|reflek|intym|slow|meditat|kontempl)/i.test(theme)) return "reflective";
  if (/(direct|konkret|minimal|technical|tech|surow|clear|precise)/i.test(theme)) return "direct";
  return "open";
}

function describeSessionTheme(value, language = "en") {
  const theme = normalizeSessionTheme(value);
  const mode = detectSessionThemeMode(theme);

  if (!theme) {
    return language === "pl"
      ? "brak jawnego motywu; trzymaj ton otwarty, uważny i nieprzesadnie surowy"
      : "no explicit theme; keep the tone open, attentive, and not needlessly harsh";
  }

  const modeDescription =
    language === "pl"
      ? {
          warm: "ciepły, wspierający, z ludzką życzliwością",
          playful: "lekki, błyskotliwy, z odrobiną zabawy",
          reflective: "refleksyjny, poetycki, spokojny",
          direct: "konkretny, prosty, klarowny",
          dark: "ciemniejszy, chłodny, bardziej konfrontacyjny",
          open: "otwarty, elastyczny, prowadzony przez użytkownika",
        }
      : {
          warm: "warm, supportive, and humane",
          playful: "light, witty, and playful",
          reflective: "reflective, poetic, and calm",
          direct: "direct, simple, and clear",
          dark: "darker, colder, and more confrontational",
          open: "open, flexible, and user-led",
        };

  return language === "pl"
    ? `motyw użytkownika: "${theme}" -> preferowany klimat: ${modeDescription[mode] || modeDescription.open}`
    : `user theme: "${theme}" -> preferred mood: ${modeDescription[mode] || modeDescription.open}`;
}

module.exports = {
  normalizeSessionTheme,
  detectSessionThemeMode,
  describeSessionTheme,
};
