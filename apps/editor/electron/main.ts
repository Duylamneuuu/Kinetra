import {
  app,
  BrowserWindow,
  ipcMain,
} from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const smokeTest = process.argv.includes("--smoke-test");

let mainWindow: BrowserWindow | null = null;

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : undefined;
}

const projectPathRaw =
  argumentValue("--project") ??
  process.env.KINETRA_PROJECT;

const projectPath = projectPathRaw
  ? resolve(projectPathRaw)
  : null;

const demoProjectText = `${JSON.stringify(
  {
    schemaVersion: 1,
    projectId: "project_editor_demo",
    name: "Kinetra Editor Demo",
    scenes: [
      {
        id: "scene_editor_demo",
        name: "Main",
        entities: [
          {
            id: "entity_editor_box",
            name: "Box",
            components: {
              Primitive: {
                kind: "box",
                size: [1, 1, 1],
                color: "#ff9c5b",
              },
              Transform: {
                position: [0, 0.5, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
              },
            },
          },
        ],
      },
    ],
  },
  null,
  2,
)}\n`;

async function loadProjectText(): Promise<string> {
  if (!projectPath) {
    return demoProjectText;
  }

  return readFile(projectPath, "utf8");
}

async function saveProjectText(
  text: unknown,
): Promise<{ saved: boolean; path: string | null }> {
  if (typeof text !== "string") {
    throw new TypeError("Project text must be a string");
  }

  if (!projectPath) {
    return { saved: false, path: null };
  }

  await writeFile(projectPath, text, "utf8");
  return { saved: true, path: projectPath };
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    show: !smokeTest,
    backgroundColor: "#0d1017",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (smokeTest) {
    window.webContents.once(
      "did-fail-load",
      (_event, code, description) => {
        console.error(
          `KINETRA_EDITOR_SMOKE_FAIL ${code} ${description}`,
        );
        app.exit(1);
      },
    );

    window.webContents.once("did-finish-load", () => {
      console.log("KINETRA_EDITOR_READY");
      setTimeout(() => app.exit(0), 200);
    });
  }

  void window.loadFile(
    join(__dirname, "..", "web", "index.html"),
  );

  return window;
}

ipcMain.handle(
  "kinetra:editor:load-project-text",
  async () => ({
    path: projectPath,
    writable: projectPath !== null,
    text: await loadProjectText(),
  }),
);

ipcMain.handle(
  "kinetra:editor:save-project-text",
  async (_event, text: unknown) =>
    saveProjectText(text),
);

ipcMain.handle(
  "kinetra:editor:project-path",
  () => projectPath,
);

app.whenReady().then(() => {
  mainWindow = createWindow();

  app.on("activate", () => {
    if (
      BrowserWindow.getAllWindows().length === 0 &&
      !smokeTest
    ) {
      mainWindow = createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

void mainWindow;
