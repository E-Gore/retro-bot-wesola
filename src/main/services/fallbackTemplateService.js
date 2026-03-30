const { VERDICTS } = require("../../shared/constants");

function hashSeed(input) {
  const str = String(input ?? "");
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}

function pick(list, seed, offset = 0) {
  if (!list.length) return "";
  return list[(seed + offset) % list.length];
}

class FallbackTemplateService {
  constructor() {
    this.catalog = {
      pl: {
        summaries: [
          ["Próba logowania zakończona zgodnie z oczekiwaniami.", "System odnotował upór.", "Cel pozostaje poza zasięgiem."],
          ["Brak dostępu potwierdzony.", "Ambicja wykryta, skuteczność nie.", "Raport gotowy do odbioru."],
          ["Wniosek: chcesz wejść.", "Kontrwniosek: system nie chce.", "Równowaga została zachowana."],
          ["Użytkownik obecny.", "Hasło nieobecne.", "Konsekwencje estetyczne: satysfakcjonujące."],
        ],
        bodies: [
          [
            "Wykazałeś się konsekwencją, nawet jeśli przypadkową.",
            "System docenia powtarzalność bardziej niż trafność.",
            "Twoje odpowiedzi sugerują potrzebę kontroli",
            "ukrytą pod warstwą uprzejmego chaosu.",
            "To nie jest wada. To po prostu wzorzec.",
            "Wzorzec został zapisany z odpowiednim chłodem.",
            "Dostęp odrzucono, ale materiał poznawczy przyjęto.",
            "To i tak więcej niż zwykle dostaje się od ludzi.",
          ],
          [
            "Próbujesz negocjować z interfejsem.",
            "To odważne, jeśli pominąć skuteczność.",
            "W systemie widoczny jest ślad ambicji",
            "oraz kilka dobrze utrzymanych wymówek.",
            "Nie usuwamy ich. Klasyfikujemy je.",
            "Twój profil zachowania jest spójny.",
            "Niepokój i ciekawość nadal współpracują.",
            "Raport zamknięto bez oznak pojednania.",
          ],
          [
            "Należysz do użytkowników, którzy chcą znaku.",
            "Najlepiej pieczątki. Najlepiej ostatecznej.",
            "System spełnia tę potrzebę bez czułości.",
            "Wynik nie jest osobisty. To tylko precyzja.",
            "Jednocześnie wynik jest zaskakująco trafny.",
            "To bywa mylone z okrucieństwem.",
            "Prosimy nie mylić procedury z troską.",
            "Procedura działa bez zarzutu.",
          ],
        ],
        tags: [
          "AUTO-SABOTAZ",
          "POTRZEBA-KONTROLI",
          "CIEKAWOSC",
          "UPOR",
          "ESTETYKA-PORAZKI",
          "TRYB-OBRONNY",
          "MIKRO-AMBICJA",
          "RUTYNA",
        ],
        quotes: [
          "System nie odrzucił cię jako osoby. Odrzucił cię jako metodę.",
          "Ambicja wykryta. Skuteczność nadal w drodze.",
          "Konsekwencja została odnotowana, trafność nie.",
          "To nie był sukces, ale był charakter.",
        ],
        metricLabels: ["Samodyscyplina", "Apetyt kontroli", "Refleks zwłoki"],
      },
      en: {
        summaries: [
          ["Login attempt failed as designed.", "Persistence detected.", "Access remains unavailable."],
          ["Denial confirmed.", "Ambition detected, accuracy not.", "Report compiled."],
          ["You wanted entry.", "The system preferred distance.", "Balance preserved."],
          ["User present.", "Password absent.", "Aesthetic outcome acceptable."],
        ],
        bodies: [
          [
            "You demonstrated consistency, even if accidental.",
            "The system values repetition more than precision.",
            "Your answers suggest a need for control",
            "hidden under a layer of polite noise.",
            "This is not a flaw. It is a pattern.",
            "The pattern has been stored without sympathy.",
            "Access denied; behavioral material accepted.",
            "That is more than most systems offer.",
          ],
          [
            "You tried negotiating with an interface.",
            "Bold move, if we ignore the result.",
            "The system detected ambition",
            "and a well-maintained set of excuses.",
            "They are not removed. They are categorized.",
            "Your behavior profile is internally consistent.",
            "Anxiety and curiosity remain in partnership.",
            "Report closed without reconciliation.",
          ],
          [
            "You belong to users who want a sign.",
            "Preferably a stamp. Preferably final.",
            "The system provides one without tenderness.",
            "The verdict is not personal. Only precise.",
            "Precision is often mistaken for cruelty.",
            "Please do not confuse procedure with care.",
            "Procedure completed successfully.",
            "Access remains unavailable by design.",
          ],
        ],
        tags: [
          "SELF-SABOTAGE",
          "CONTROL-APPETITE",
          "CURIOSITY",
          "PERSISTENCE",
          "FAILURE-AESTHETIC",
          "DEFENSE-MODE",
          "MICRO-AMBITION",
          "ROUTINE",
        ],
        quotes: [
          "The system did not reject you as a person. It rejected your method.",
          "Ambition detected. Accuracy still pending.",
          "Consistency logged. Correctness absent.",
          "Not a success, but undeniably a pattern.",
        ],
        metricLabels: ["Self-discipline", "Control appetite", "Delay reflex"],
      },
    };
  }

  generate(input) {
    const language = input.language === "pl" ? "pl" : "en";
    const catalog = this.catalog[language];
    const seed = hashSeed(
      [
        input.sessionId,
        input.login,
        input.answers?.purpose || "",
        input.answers?.self_word || "",
        input.answers?.judged_or_ignored || "",
      ].join("|"),
    );

    const summary = pick(catalog.summaries, seed, 1);
    const body = pick(catalog.bodies, seed, 3);
    const tagStart = seed % catalog.tags.length;
    const tags = Array.from({ length: 3 }).map((_, idx) =>
      catalog.tags[(tagStart + idx * 2) % catalog.tags.length],
    );

    const verdict = seed % 100 < 15 ? VERDICTS.PROVISIONAL : VERDICTS.DENIED;
    const metrics = catalog.metricLabels.map((label, idx) => ({
      label,
      value: (seed >> (idx * 5)) % 100,
      suffix: "%",
    }));

    return {
      language,
      screen_summary: summary,
      receipt_title: "SYSTEM RECOVERY RECEIPT",
      receipt_body_lines: body,
      tags,
      archive_quote: pick(catalog.quotes, seed, 5),
      metrics,
      verdict,
    };
  }
}

module.exports = { FallbackTemplateService };
