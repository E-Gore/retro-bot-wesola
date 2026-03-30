const { RHETORICAL_FORMS } = require("../../shared/questions");

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
  if (!Array.isArray(list) || list.length === 0) return "";
  return list[(seed + offset) % list.length];
}

class AdaptiveQuestionFallbackService {
  generate({
    language,
    slot,
    login,
    sessionId,
    questionIndex,
    previousHistory,
    passwordContext,
    arcConstraints = {},
  }) {
    const lang = language === "pl" ? "pl" : "en";
    const seed = hashSeed(
      [
        sessionId,
        login,
        slot?.id,
        questionIndex,
        arcConstraints.requiredIntent || slot?.intentTag || "unknown",
        ...(previousHistory || []).map((h) => `${h.id}:${h.answerValue || h.answerLabel || ""}`),
      ].join("|"),
    );
    if (!slot) throw new Error("Missing slot");

    const intentTag = arcConstraints.requiredIntent || slot.intentTag || "motive_declaration";
    const rhetoricalForm = this.resolveRhetoricalForm(arcConstraints, slot, seed);
    const transitionLine = this.buildTransitionLine({
      lang,
      intentTag,
      previousHistory,
      passwordContext,
      seed,
    });

    if (slot.type === "choice") {
      return this.generateChoice({
        lang,
        slot,
        seed,
        login,
        previousHistory,
        passwordContext,
        intentTag,
        rhetoricalForm,
        transitionLine,
      });
    }

    if (slot.type === "text") {
      return this.generateText({
        lang,
        slot,
        seed,
        login,
        previousHistory,
        passwordContext,
        intentTag,
        rhetoricalForm,
        transitionLine,
      });
    }

    throw new Error(`Unsupported slot type: ${slot.type}`);
  }

  resolveRhetoricalForm(arcConstraints, slot, seed) {
    const required = arcConstraints.requiredRhetoricalForm;
    if (required && RHETORICAL_FORMS.includes(required)) return required;
    const preferred = Array.isArray(slot?.preferredRhetoricalForms) ? slot.preferredRhetoricalForms : [];
    const validPreferred = preferred.filter((item) => RHETORICAL_FORMS.includes(item));
    if (validPreferred.length) return validPreferred[seed % validPreferred.length];
    return RHETORICAL_FORMS[seed % RHETORICAL_FORMS.length] || "probe";
  }

  buildTransitionLine({ lang, intentTag, previousHistory, passwordContext, seed }) {
    const last = Array.isArray(previousHistory) ? previousHistory[previousHistory.length - 1] : null;
    const lastAnswer = String(last?.answerLabel || last?.answerValue || "").trim();
    const firstPassword = passwordContext?.attempts?.[0]?.sanitized || "";

    const byIntent =
      lang === "pl"
        ? {
            motive_declaration: [
              "Zarejestrowano motyw wejścia. Przechodzę do autodefinicji.",
              "Cel sesji zapisany. Sprawdzam warstwę osobistą.",
            ],
            self_state_label: [
              `Słowo "${lastAnswer || "brak"}" zapisane. Przechodzę do reakcji na tarcie.`,
              "Autodefinicja zapisana. Teraz test reakcji pod presją.",
            ],
            friction_response: [
              "Reakcja na ocenę zanotowana. Wchodzimy w mechanizm autosabotażu.",
              "Wzorzec tarcia aktywny. Przechodzę do pętli nawyku.",
            ],
            self_sabotage_mechanism: [
              "Mechanizm nawykowy zapisany. Czas policzyć koszt.",
              firstPassword
                ? `Sekwencja haseł (${firstPassword}) i nawyk spięte. Przechodzę do bilansu.`
                : "Nawyk zakotwiczony. Przechodzę do kosztu i wyboru.",
            ],
            consequence_tradeoff: [
              "Bilans zamknięty. Kompiluję raport końcowy.",
              "Decyzja zapisana. Przechodzę do werdyktu.",
            ],
          }
        : {
            motive_declaration: [
              "Entry motive recorded. Moving to self-label.",
              "Session goal stored. Testing personal layer.",
            ],
            self_state_label: [
              `Word "${lastAnswer || "n/a"}" logged. Moving to friction response.`,
              "Self label stored. Now testing pressure response.",
            ],
            friction_response: [
              "Friction response captured. Entering self-sabotage layer.",
              "Pressure pattern detected. Moving to habit loop.",
            ],
            self_sabotage_mechanism: [
              "Habit mechanism logged. Calculating cost next.",
              firstPassword
                ? `Password sequence (${firstPassword}) linked with habit. Moving to tradeoff.`
                : "Habit anchored. Moving to cost and choice.",
            ],
            consequence_tradeoff: [
              "Tradeoff recorded. Compiling final report.",
              "Decision stored. Moving to final verdict.",
            ],
          };
    const list = byIntent[intentTag] || byIntent.motive_declaration;
    return pick(list, seed, 11);
  }

  generateChoice({
    lang,
    slot,
    seed,
    login,
    previousHistory,
    passwordContext,
    intentTag,
    rhetoricalForm,
    transitionLine,
  }) {
    const lastAnswer = previousHistory?.[previousHistory.length - 1]?.answerLabel || "";
    const pwdHint = passwordContext?.attempts?.[0]?.sanitized || "";

    const prompt =
      lang === "pl"
        ? pick(
            [
              "Po co uruchamiasz ten terminal właśnie teraz?",
              `Jaki cel deklarujesz tej procedurze, ${login || "użytkowniku"}?`,
              pwdHint ? `Po sekwencji z hasłem "${pwdHint}" po co kontynuujesz?` : "Jaki jest twój realny cel tej sesji?",
              lastAnswer ? `Po odpowiedzi "${lastAnswer}" określ cel tej sesji.` : "Jaki jest cel tej próby dostępu?",
            ],
            seed,
            3,
          )
        : pick(
            [
              "Why are you launching this terminal right now?",
              `What objective are you declaring to this procedure, ${login || "user"}?`,
              pwdHint ? `After a password like "${pwdHint}", why continue?` : "What is the real goal of this session?",
              lastAnswer ? `After answering "${lastAnswer}", define your goal for this session.` : "What is your objective in this access attempt?",
            ],
            seed,
            3,
          );

    return {
      id: slot.id,
      type: "choice",
      language: lang,
      prompt,
      transitionLine,
      intentTag,
      rhetoricalForm,
      options: (slot.options || []).map((opt) => ({
        value: opt.value,
        label: opt.label?.[lang] || opt.label?.pl || opt.value,
      })),
      maxLength: slot.maxLength || 32,
    };
  }

  generateText({
    lang,
    slot,
    seed,
    login,
    previousHistory,
    passwordContext,
    intentTag,
    rhetoricalForm,
    transitionLine,
  }) {
    const purpose = previousHistory?.find((h) => h.id === "purpose")?.answerLabel
      || previousHistory?.find((h) => h.id === "purpose")?.answerValue
      || "";
    const selfWord = previousHistory?.find((h) => h.id === "self_word")?.answerLabel
      || previousHistory?.find((h) => h.id === "self_word")?.answerValue
      || "";
    const frictionAnswer = previousHistory?.find((h) => h.id === "judged_or_ignored")?.answerLabel
      || previousHistory?.find((h) => h.id === "judged_or_ignored")?.answerValue
      || "";
    const habitAnswer = previousHistory?.find((h) => h.id === "defended_habit")?.answerLabel
      || previousHistory?.find((h) => h.id === "defended_habit")?.answerValue
      || "";
    const pwdHint = passwordContext?.attempts?.[0]?.sanitized || "";

    const promptsByIntent =
      lang === "pl"
        ? {
            self_state_label: [
              "Jedno słowo, które opisuje cię po tej sekwencji odrzuceń.",
              purpose ? `Po deklaracji "${purpose}" wpisz jedno słowo o sobie teraz.` : "Jedno słowo o twoim stanie teraz.",
              pwdHint ? `Jedno słowo po haśle w stylu "${pwdHint}".` : "Jedno słowo bez obrony.",
            ],
            friction_response: [
              "Gdy czujesz ocenę albo ciszę, co dzieje się z tobą najpierw?",
              purpose ? `Skoro celem było "${purpose}", jak reagujesz na podważenie?` : "Jak reagujesz na podważenie twojej racji?",
              selfWord ? `Po słowie "${selfWord}" opisz pierwszą reakcję pod tarciem.` : "Opisz pierwszą reakcję pod tarciem.",
            ],
            self_sabotage_mechanism: [
              "Jaki nawyk bronisz, choć wiesz, że obniża twoją skuteczność?",
              frictionAnswer ? `Po reakcji "${frictionAnswer}" jaki nawyk utrwala ten schemat?` : "Jaki nawyk utrzymuje ten sam schemat?",
              pwdHint ? `Który nawyk pasuje do tonu hasła "${pwdHint}"?` : "Jaki nawyk powtarzasz mimo kosztów?",
            ],
            consequence_tradeoff: [
              "Jaki koszt płacisz najczęściej za ten wzorzec i co wybierasz dalej?",
              habitAnswer ? `Po nawyku "${habitAnswer}" co tracisz i co zmienisz jako pierwsze?` : "Co tracisz i jaki kolejny wybór deklarujesz?",
              `Domknij sesję, ${login || "użytkowniku"}: koszt + następny wybór w jednym krótkim zdaniu.`,
            ],
          }
        : {
            self_state_label: [
              "One word that describes you after this rejection sequence.",
              purpose ? `After declaring "${purpose}", give one word for your current state.` : "One word for your current state.",
              pwdHint ? `One word after a password like "${pwdHint}".` : "One word, no defense.",
            ],
            friction_response: [
              "When you feel judged or ignored, what happens first in you?",
              purpose ? `If your goal was "${purpose}", how do you react when challenged?` : "How do you react when your position is challenged?",
              selfWord ? `After choosing "${selfWord}", describe your first friction response.` : "Describe your first friction response.",
            ],
            self_sabotage_mechanism: [
              "Which habit do you defend even though it lowers your effectiveness?",
              frictionAnswer ? `After "${frictionAnswer}", which habit keeps this loop alive?` : "Which habit keeps this loop alive?",
              pwdHint ? `Which habit matches the password tone "${pwdHint}"?` : "Which habit repeats despite the cost?",
            ],
            consequence_tradeoff: [
              "What cost does this pattern create most often, and what do you choose next?",
              habitAnswer ? `After the habit "${habitAnswer}", what do you lose and what changes first?` : "What do you lose, and what is your next declared choice?",
              `Close the session, ${login || "user"}: cost + next choice in one short sentence.`,
            ],
          };

    const placeholdersByIntent =
      lang === "pl"
        ? {
            self_state_label: ["np. spięty", "np. rozproszony", "np. czujny"],
            friction_response: ["np. spinam się i atakuję", "np. milknę i wycofuję", "np. tłumaczę się za długo"],
            self_sabotage_mechanism: ["np. odkładam start", "np. uciekam w multitasking", "np. przewijam zamiast kończyć"],
            consequence_tradeoff: ["np. tracę zaufanie i wybieram wolniejsze tempo", "np. tracę spokój i wybieram krótsze reakcje", "np. tracę czas i wybieram jeden priorytet"],
          }
        : {
            self_state_label: ["e.g. tense", "e.g. scattered", "e.g. alert"],
            friction_response: ["e.g. I tense up and attack", "e.g. I go quiet and withdraw", "e.g. I over-explain"],
            self_sabotage_mechanism: ["e.g. I delay the start", "e.g. I hide in multitasking", "e.g. I scroll instead of finishing"],
            consequence_tradeoff: ["e.g. I lose trust, so I choose slower responses", "e.g. I lose calm, so I choose shorter reactions", "e.g. I lose time, so I choose one priority"],
          };

    const intentPrompts = promptsByIntent[intentTag] || promptsByIntent.self_state_label;
    const intentPlaceholders = placeholdersByIntent[intentTag] || placeholdersByIntent.self_state_label;

    return {
      id: slot.id,
      type: "text",
      language: lang,
      prompt: pick(intentPrompts, seed, 5),
      transitionLine,
      intentTag,
      rhetoricalForm,
      placeholder: pick(intentPlaceholders, seed, 7),
      minLength: slot.minLength || 1,
      maxLength: slot.maxLength || 24,
    };
  }
}

module.exports = { AdaptiveQuestionFallbackService };
