import { app, BrowserWindow, ipcMain, net, protocol, session, shell } from "electron";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const isDev = process.argv.includes("--dev");
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5173";

/** Каталог собранного рендера (vite build). */
const DIST = path.join(__dirname, "..", "dist");
const APP_SCHEME = "app";
const APP_ORIGIN = `${APP_SCHEME}://range`;

// ВАЖНО: не отключаем ограничение частоты кадров. Со снятым лимитом Chromium
// рендерит мимо vsync (300+ FPS), кадры доезжают до композитора неравномерно —
// и картинка «дёргается» несмотря на высокий FPS. Vsync оставляем включённым,
// а дополнительный потолок задаётся настройкой «Ограничение FPS» в игре.
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("enable-gpu-rasterization");

// Своя схема вместо file://: ES-модули из file:// блокируются CORS-политикой
// Chromium, а сборка Vite — это именно модульный скрипт.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
  },
]);

let mainWindow: BrowserWindow | null = null;

function registerAppProtocol(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname) === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const filePath = path.normalize(path.join(DIST, relative));

    // Не отдаём ничего за пределами каталога сборки.
    if (!filePath.startsWith(DIST)) {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch {
      // Отсутствующий файл — штатная ситуация: звуковые сэмплы в public/audio
      // необязательны. Отвечаем 404, а не сыпем ошибками в лог.
      return new Response("Not found", { status: 404 });
    }
  });
}

/** CSP для собранного приложения: всё грузится только из app://. */
function applyContentSecurityPolicy(): void {
  const policy = [
    "default-src 'self' app:",
    "script-src 'self' app:",
    "style-src 'self' app: 'unsafe-inline'",
    "img-src 'self' app: data: blob:",
    "media-src 'self' app: data: blob:",
    "font-src 'self' app: data:",
    "worker-src 'self' app: blob:",
    "connect-src 'self' app: data: blob:",
  ].join("; ");

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [policy] },
    });
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1024,
    minHeight: 576,
    show: false,
    backgroundColor: "#05070a",
    title: "RANGE — FPS prototype",
    // Игра всегда стартует во весь экран — и в сборке, и в dev-режиме.
    // Переключается по F11.
    fullscreen: true,
    fullscreenable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    if (!mainWindow) return;
    // setFullScreen после show(): часть драйверов игнорирует флаг конструктора,
    // если окно ещё не показано.
    mainWindow.show();
    if (!mainWindow.isFullScreen()) mainWindow.setFullScreen(true);
    mainWindow.focus();
  });

  // Ошибки рендера видны в терминале — иначе их легко пропустить.
  mainWindow.webContents.on("did-fail-load", (_e, code, description, validatedURL) => {
    console.error(`[renderer] загрузка не удалась (${code}): ${description} — ${validatedURL}`);
  });
  mainWindow.webContents.on("console-message", (details) => {
    if (details.level === "error" || details.level === "warning") {
      console.error(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
    }
  });

  if (isDev) {
    void mainWindow.loadURL(DEV_SERVER_URL);
    if (process.argv.includes("--devtools")) {
      mainWindow.webContents.openDevTools({ mode: "detach", activate: false });
    }
  } else {
    void mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  }

  // Внешние ссылки — в системный браузер, новых окон не создаём.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.on("app:quit", () => app.quit());

ipcMain.on("app:toggle-fullscreen", () => {
  if (!mainWindow) return;
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

void app.whenReady().then(() => {
  registerAppProtocol();
  if (!isDev) applyContentSecurityPolicy();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
