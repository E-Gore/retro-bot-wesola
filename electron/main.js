const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { loadLocalEnvFiles } = require("../src/main/utils/loadLocalEnv");

const { getConfig } = require("../src/main/config");
const { registerIpcHandlers } = require("../src/main/ipc");
const { SessionRepository } = require("../src/main/services/sessionRepository");
const { StatsService } = require("../src/main/services/statsService");
const { ConnectivityService } = require("../src/main/services/connectivityService");
const { SafetyService } = require("../src/main/services/safetyService");
const { ContentGenerationService } = require("../src/main/services/contentGenerationService");
const { ReceiptFormatter } = require("../src/main/services/receiptFormatter");
const { SessionAnalysisService } = require("../src/main/services/sessionAnalysisService");
const { AudioCueService } = require("../src/main/services/audioCueService");
const { QuestionGenerationService } = require("../src/main/services/questionGenerationService");
const { AnalyticsService } = require("../src/main/services/analyticsService");

let mainWindow = null;

function createMainWindow(config) {
  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 800,
    backgroundColor: "#05070a",
    autoHideMenuBar: true,
    fullscreen: config.app.fullscreen,
    kiosk: config.app.kiosk,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  window.webContents.on("before-input-event", (event, input) => {
    const disallow =
      input.key === "F5" ||
      (input.key === "r" && (input.control || input.meta)) ||
      (input.key === "w" && (input.control || input.meta));
    if (disallow) event.preventDefault();
  });

  window.once("ready-to-show", () => {
    window.show();
    if (config.app.fullscreen) window.setFullScreen(true);
    if (config.app.kiosk) window.setKiosk(true);
  });

  window.loadFile(path.join(__dirname, "..", "src", "renderer", "index.html"));
  return window;
}

async function bootstrap() {
  loadLocalEnvFiles(path.join(__dirname, ".."));
  const config = getConfig({ userDataPath: app.getPath("userData") });

  const repository = new SessionRepository(config);
  const safetyService = new SafetyService(config);
  const contentGenerationService = new ContentGenerationService(config);
  const receiptFormatter = new ReceiptFormatter();
  const connectivityService = new ConnectivityService(config);
  const statsService = new StatsService(repository);
  const analyticsService = new AnalyticsService(repository);
  const audioCueService = new AudioCueService();
  const questionGenerationService = new QuestionGenerationService({
    config,
    contentGenerationService,
    safetyService,
    connectivityService,
    repository,
  });
  const sessionAnalysisService = new SessionAnalysisService({
    config,
    repository,
    contentGenerationService,
    safetyService,
    receiptFormatter,
    connectivityService,
  });

  registerIpcHandlers({
    ipcMain,
    config,
    repository,
    statsService,
    connectivityService,
    sessionAnalysisService,
    safetyService,
    audioCueService,
    questionGenerationService,
    analyticsService,
    contentGenerationService,
  });

  repository.logEvent("app_start", {
    version: config.app.version,
    storage_mode: repository.mode,
    llm_configured: Boolean(config.llm.apiKey),
    tone_preset: config.tone.current,
  });

  mainWindow = createMainWindow(config);
}

app.whenReady().then(bootstrap);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && mainWindow) {
    mainWindow = createMainWindow(getConfig({ userDataPath: app.getPath("userData") }));
  }
});
