const INTENT_TAGS = {
  MOTIVE_DECLARATION: "motive_declaration",
  SELF_STATE_LABEL: "self_state_label",
  FRICTION_RESPONSE: "friction_response",
  SELF_SABOTAGE_MECHANISM: "self_sabotage_mechanism",
  CONSEQUENCE_TRADEOFF: "consequence_tradeoff",
};

const RHETORICAL_FORMS = ["probe", "contrast", "counterfactual", "cost_frame", "commitment"];

const QUESTION_ARC = [
  {
    id: "purpose",
    type: "choice",
    maxLength: 32,
    intentTag: INTENT_TAGS.MOTIVE_DECLARATION,
    stageLabel: {
      pl: "ETAP 1: MOTYW WEJŚCIA",
      en: "STAGE 1: ENTRY MOTIVE",
    },
    forbiddenIntentOverlap: [],
    preferredRhetoricalForms: ["probe", "contrast"],
    prompt: {
      pl: "Po co tu jesteś?",
      en: "Why are you here?",
    },
    options: [
      { value: "curiosity", label: { pl: "Ciekawość", en: "Curiosity" } },
      {
        value: "beat_machine",
        label: { pl: "Chcę wygrać z maszyną", en: "I want to beat the machine" },
      },
      {
        value: "proof",
        label: { pl: "Chcę dowodu", en: "I want proof" },
      },
      { value: "bored", label: { pl: "Nudzę się", en: "I'm bored" } },
      {
        value: "self_search",
        label: { pl: "Szukam czegoś o sobie", en: "Looking for something about myself" },
      },
      { value: "other", label: { pl: "Inne", en: "Other" } },
    ],
  },
  {
    id: "self_word",
    type: "text",
    minLength: 1,
    maxLength: 24,
    intentTag: INTENT_TAGS.SELF_STATE_LABEL,
    stageLabel: {
      pl: "ETAP 2: AUTODEFINICJA",
      en: "STAGE 2: SELF LABEL",
    },
    forbiddenIntentOverlap: [],
    preferredRhetoricalForms: ["probe", "contrast"],
    prompt: {
      pl: "Wpisz jedno słowo, które ostatnio cię opisuje.",
      en: "Type one word that describes you lately.",
    },
    placeholder: {
      pl: "np. zmęczony",
      en: "e.g. tired",
    },
  },
  {
    id: "judged_or_ignored",
    type: "text",
    minLength: 1,
    maxLength: 32,
    intentTag: INTENT_TAGS.FRICTION_RESPONSE,
    stageLabel: {
      pl: "ETAP 3: REAKCJA NA TARCIE",
      en: "STAGE 3: FRICTION RESPONSE",
    },
    forbiddenIntentOverlap: [INTENT_TAGS.CONSEQUENCE_TRADEOFF],
    preferredRhetoricalForms: ["counterfactual", "contrast"],
    prompt: {
      pl: "Kiedy czujesz ocenę albo ignorowanie, co to z tobą robi? (krótko)",
      en: "When you feel judged or ignored, what does it do to you? (short)",
    },
    placeholder: {
      pl: "np. spinam się i wycofuję",
      en: "e.g. I tense up and withdraw",
    },
  },
  {
    id: "defended_habit",
    type: "text",
    minLength: 1,
    maxLength: 32,
    intentTag: INTENT_TAGS.SELF_SABOTAGE_MECHANISM,
    stageLabel: {
      pl: "ETAP 4: MECHANIZM AUTOSABOTAŻU",
      en: "STAGE 4: SELF-SABOTAGE MECHANISM",
    },
    forbiddenIntentOverlap: [],
    preferredRhetoricalForms: ["counterfactual", "commitment"],
    prompt: {
      pl: "Podaj nawyk, którego bronisz, choć wiesz, że jest głupi.",
      en: "Name a habit you defend even though you know it's stupid.",
    },
    placeholder: {
      pl: "np. odkładanie wszystkiego",
      en: "e.g. delaying everything",
    },
  },
  {
    id: "right_or_peace",
    type: "text",
    minLength: 1,
    maxLength: 32,
    intentTag: INTENT_TAGS.CONSEQUENCE_TRADEOFF,
    stageLabel: {
      pl: "ETAP 5: KOSZT I WYBÓR",
      en: "STAGE 5: COST AND CHOICE",
    },
    forbiddenIntentOverlap: [INTENT_TAGS.FRICTION_RESPONSE],
    preferredRhetoricalForms: ["cost_frame", "commitment"],
    prompt: {
      pl: "Jaki koszt płacisz najczęściej za swoje reakcje i co wybierasz dalej?",
      en: "What cost do your reactions usually create, and what do you choose next?",
    },
    placeholder: {
      pl: "np. tracę relacje, ale wybieram wolniejsze tempo",
      en: "e.g. I lose trust, so I choose slower responses",
    },
  },
];

const QUESTIONS = QUESTION_ARC;

module.exports = {
  QUESTIONS,
  QUESTION_ARC,
  INTENT_TAGS,
  RHETORICAL_FORMS,
};
