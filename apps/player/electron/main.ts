import { app, BrowserWindow, ipcMain } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const smokeTest = process.argv.includes("--smoke-test");

let mainWindow: BrowserWindow | null = null;
let smokeFinished = false;

function finishSmoke(exitCode: number): void {
  if (!smokeTest || smokeFinished) {
    return;
  }
  smokeFinished = true;
  setTimeout(() => app.exit(exitCode), 250);
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 640,
    minHeight: 360,
    show: !smokeTest,
    backgroundColor: "#0b0d12",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.once("did-fail-load", (_event, code, description) => {
    console.error(`Kinetra packaged player failed to load: ${code} ${description}`);
    finishSmoke(1);
  });

  window.webContents.once("did-finish-load", () => {
    console.log("KINETRA_PACKAGED_PLAYER_READY");
    finishSmoke(0);
  });

  const indexPath = join(app.getAppPath(), "web", "index.html");
  void window.loadFile(indexPath);

  return window;
}

ipcMain.handle("kinetra:window:get-state", () => ({
  fullscreen: mainWindow?.isFullScreen() ?? false,
}));

ipcMain.handle("kinetra:window:set-fullscreen", (_event, value: unknown) => {
  if (typeof value !== "boolean") {
    throw new TypeError("Fullscreen value must be boolean");
  }

  mainWindow?.setFullScreen(value);
  return { fullscreen: mainWindow?.isFullScreen() ?? value };
});

ipcMain.handle("kinetra:platform:user-data-path", () => app.getPath("userData"));

app.whenReady().then(() => {
  mainWindow = createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && !smokeTest) {
      mainWindow = createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
