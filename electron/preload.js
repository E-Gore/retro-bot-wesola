const { contextBridge, ipcRenderer } = require("electron");
const { QUESTIONS } = require("../src/shared/questions");
const { COPY } = require("../src/shared/i18n");
const { SCREEN_IDS, CONTENT_SOURCES, VERDICTS, RECEIPT_WIDTHS, LLM_REASON_CODES } = require("../src/shared/constants");
const { validateLogin, validateTextAnswer, normalizeTextInput } = require("../src/shared/validation");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

contextBridge.exposeInMainWorld("retroBot", {
  getBootstrap: () => ipcRenderer.invoke("retrobot:get-bootstrap"),
  getAttractorStats: () => ipcRenderer.invoke("retrobot:get-attractor-stats"),
  checkLlmAvailability: () => ipcRenderer.invoke("retrobot:check-llm-availability"),
  getAdaptiveQuestion: (payload) => ipcRenderer.invoke("retrobot:get-adaptive-question", payload),
  generateResult: (draft) => ipcRenderer.invoke("retrobot:generate-result", draft),
  logEvent: (eventType, payload) => ipcRenderer.invoke("retrobot:log-event", eventType, payload),
  logSessionEvent: (payload) => ipcRenderer.invoke("retrobot:log-session-event", payload),
  logQualityEvent: (payload) => ipcRenderer.invoke("retrobot:log-quality-event", payload),
  screenUserText: (key, value) => ipcRenderer.invoke("retrobot:screen-user-text", { key, value }),
  playCue: (cueName) => ipcRenderer.invoke("retrobot:audio-cue", cueName),
  getAnalyticsSummary: (payload) => ipcRenderer.invoke("retrobot:get-analytics-summary", payload || {}),
  getQualityReport: (payload) => ipcRenderer.invoke("retrobot:get-quality-report", payload || {}),
  exportAnalytics: (payload) => ipcRenderer.invoke("retrobot:export-analytics", payload || {}),
  getStaticData: () =>
    clone({
      questions: QUESTIONS,
      copy: COPY,
      constants: {
        SCREEN_IDS,
        CONTENT_SOURCES,
        VERDICTS,
        RECEIPT_WIDTHS,
        LLM_REASON_CODES,
      },
    }),
  validateLogin: (value) => validateLogin(value),
  validateTextAnswer: (value, options) => validateTextAnswer(value, options),
  normalizeTextInput: (value) => normalizeTextInput(value),
});
