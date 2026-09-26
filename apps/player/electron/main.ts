import { app, BrowserWindow, ipcMain } from "electron";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { FileKeyValueStorage } from "@kinetra/save-state/file";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const smokeTest = process.argv.includes("--smoke-test");
const runtimeBridgePipe = process.env.KINETRA_RUNTIME_BRIDGE_PIPE;
const runtimeBridgeMode =
  Boolean(runtimeBridgePipe) ||
  process.env.KINETRA_RUNTIME_BRIDGE_STDIO === "1" ||
  process.argv.includes("--runtime-bridge-stdio");
// Hidden bridge windows produce DOM-stale capturePage() frames (the menu layer
// freezes at first paint while the WebGL canvas keeps updating). Linux cloud
// smoke and packaged launches set this flag so captures composite truthfully.
// Default stays hidden: Windows behavior is unchanged.
const bridgeShowWindow =
  process.env.KINETRA_RUNTIME_BRIDGE_SHOW_WINDOW === "1";

const userDataDirArg =
  process.env.KINETRA_USER_DATA_DIR ||
  process.argv
    .find((arg) => arg.startsWith("--user-data-dir="))
    ?.slice("--user-data-dir=".length);
if (userDataDirArg) {
  app.setPath("userData", userDataDirArg);
}

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

interface BridgeRequest {
  id: string;
  method: string;
  params?: unknown;
}

interface BridgeResponse {
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface RendererResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingRendererRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

let mainWindow: BrowserWindow | null = null;
let smokeFinished = false;
let rendererRequestCounter = 0;
let bridgeSocket: Socket | undefined;
let documentLoaded = false;
let rendererReady = false;
let bridgeReadyEmitted = false;
const rendererPending = new Map<string, PendingRendererRequest>();

function maybeEmitBridgeReady(): void {
  if (
    !runtimeBridgeMode ||
    bridgeReadyEmitted ||
    !documentLoaded ||
    !rendererReady ||
    (runtimeBridgePipe && (!bridgeSocket || bridgeSocket.destroyed))
  ) {
    return;
  }

  bridgeReadyEmitted = true;
  bridgeWrite({ type: "event", event: "ready" });
}

function bridgeWrite(value: unknown): void {
  const line = `${JSON.stringify(value)}\n`;

  if (bridgeSocket && !bridgeSocket.destroyed) {
    bridgeSocket.write(line, "utf8");
    return;
  }

  if (
    process.env.KINETRA_RUNTIME_BRIDGE_STDIO === "1" ||
    process.argv.includes("--runtime-bridge-stdio")
  ) {
    process.stdout.write(line);
  }
}

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
    show: bridgeShowWindow ? true : !(smokeTest || runtimeBridgeMode),
    paintWhenInitiallyHidden: true,
    backgroundColor: "#0b0d12",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`[preload-error] ${preloadPath}:`, error);
  });

  window.webContents.once("did-fail-load", (_event, code, description) => {
    const message = `Kinetra packaged player failed to load: ${code} ${description}`;
    console.error(message);

    if (runtimeBridgeMode) {
      bridgeWrite({ type: "event", event: "fatal", message });
      app.exit(1);
    }

    finishSmoke(1);
  });

  window.webContents.once("did-finish-load", () => {
    documentLoaded = true;

    if (runtimeBridgeMode) {
      maybeEmitBridgeReady();
      return;
    }

    console.log("KINETRA_PACKAGED_PLAYER_READY");
    finishSmoke(0);
  });

  const indexPath = join(__dirname, "..", "web", "index.html");
  void window.loadFile(indexPath);

  return window;
}

function callRenderer(
  method: string,
  params: unknown = {},
  timeoutMs = 10_000,
): Promise<unknown> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return Promise.reject(new Error("Kinetra player window is unavailable"));
  }

  const id = `renderer_${++rendererRequestCounter}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rendererPending.delete(id);
      reject(new Error(`Renderer command "${method}" timed out`));
    }, timeoutMs);

    rendererPending.set(id, { resolve, reject, timer });
    mainWindow?.webContents.send("kinetra:runtime:command", {
      id,
      method,
      params,
    });
  });
}

ipcMain.on("kinetra:runtime:renderer-ready", (event) => {
  if (event.sender !== mainWindow?.webContents) {
    return;
  }

  rendererReady = true;
  maybeEmitBridgeReady();
});

ipcMain.on(
  "kinetra:runtime:response",
  (event, response: RendererResponse) => {
    if (event.sender !== mainWindow?.webContents) {
      return;
    }

    const pending = rendererPending.get(response.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    rendererPending.delete(response.id);

    if (response.ok) {
      pending.resolve(response.result);
    } else {
      pending.reject(
        new Error(
          response.error ?? "Unknown renderer runtime failure",
        ),
      );
    }
  },
);

async function handleBridgeRequest(
  request: BridgeRequest,
): Promise<unknown> {
  switch (request.method) {
    case "ping":
      return { ready: true };

    case "runtime.hostInfo":
      return {
        isPackaged: app.isPackaged,
        execPath: process.execPath,
        platform: process.platform,
        arch: process.arch,
      };

    case "runtime.start":
    case "runtime.stop":
    case "runtime.pause":
    case "runtime.resume":
    case "runtime.query":
    case "runtime.injectInput":
    case "runtime.readLogs":
    case "runtime.step":
    case "asset.register":
    case "animation.play":
    case "animation.stop":
    case "animation.registerClip":
    case "audio.play":
    case "audio.stop":
    case "audio.setBusGain":
    case "audio.setBusMuted":
    case "navigation.bake":
    case "navigation.load":
    case "navigation.closestPoint":
    case "navigation.computePath":
    case "save.capture":
    case "save.get":
    case "save.load":
    case "testHarness.enableTestFixtures":
      return callRenderer(request.method, request.params ?? {});

    case "runtime.captureFrame": {
      await callRenderer("runtime.render", {});
      await new Promise((resolve) => setTimeout(resolve, 32));

      if (!mainWindow || mainWindow.isDestroyed()) {
        throw new Error("Kinetra player window is unavailable");
      }

      const image = await mainWindow.webContents.capturePage();
      const png = image.toPNG();

      if (png.length === 0) {
        throw new Error("Electron capturePage returned an empty PNG");
      }

      return {
        available: true,
        mimeType: "image/png",
        base64: png.toString("base64"),
      };
    }

    default:
      throw new Error(`Unsupported runtime bridge method "${request.method}"`);
  }
}

function attachBridgeInput(
  input: NodeJS.ReadableStream,
  closeQuitsApp: boolean,
): void {
  const lines = createInterface({
    input,
    crlfDelay: Infinity,
  });

  lines.on("line", (line) => {
    if (!line.trim()) {
      return;
    }

    void (async () => {
      let request: BridgeRequest;

      try {
        const parsed = JSON.parse(line) as unknown;
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          throw new TypeError("Bridge request must be an object");
        }

        const candidate = parsed as Record<string, unknown>;

        if (
          typeof candidate.id !== "string" ||
          typeof candidate.method !== "string"
        ) {
          throw new TypeError("Bridge request requires string id and method");
        }

        request = {
          id: candidate.id,
          method: candidate.method,
          ...(candidate.params !== undefined
            ? { params: candidate.params }
            : {}),
        };
      } catch (error) {
        console.error(
          error instanceof Error ? error.message : String(error),
        );
        return;
      }

      let response: BridgeResponse;

      try {
        response = {
          type: "response",
          id: request.id,
          ok: true,
          result: await handleBridgeRequest(request),
        };
      } catch (error) {
        response = {
          type: "response",
          id: request.id,
          ok: false,
          error:
            error instanceof Error
              ? error.stack ?? error.message
              : String(error),
        };
      }

      bridgeWrite(response);
    })();
  });

  if (closeQuitsApp) {
    lines.once("close", () => app.exit(0));
  }
}

function startRuntimeBridge(): Promise<void> {
  if (runtimeBridgePipe) {
    return new Promise((resolve, reject) => {
      const socket = connect(runtimeBridgePipe, () => {
        bridgeSocket = socket;
        attachBridgeInput(socket, true);
        maybeEmitBridgeReady();
        resolve();
      });

      socket.once("error", reject);
    });
  }

  if (
    process.env.KINETRA_RUNTIME_BRIDGE_STDIO === "1" ||
    process.argv.includes("--runtime-bridge-stdio")
  ) {
    attachBridgeInput(process.stdin, false);
  }

  return Promise.resolve();
}

ipcMain.handle("kinetra:window:get-state", () => ({
  fullscreen: mainWindow?.isFullScreen() ?? false,
}));

ipcMain.handle("kinetra:window:set-fullscreen", (_event, value: unknown) => {
  if (typeof value !== "boolean") {
    throw new TypeError("Fullscreen value must be boolean");
  }

  mainWindow?.setFullScreen(value);
  return {
    fullscreen: mainWindow?.isFullScreen() ?? value,
  };
});

ipcMain.handle("kinetra:platform:user-data-path", () =>
  app.getPath("userData"),
);

ipcMain.handle("kinetra:app:quit", () => {
  app.quit();
});

let fileStorage: FileKeyValueStorage | undefined;
function getFileStorage(): FileKeyValueStorage {
  if (!fileStorage) {
    const saveDirArg = process.argv
      .find((arg) => arg.startsWith("--save-dir="))
      ?.slice("--save-dir=".length);
    const saveRootDir =
      process.env.KINETRA_SAVE_DIR ||
      saveDirArg ||
      join(app.getPath("userData"), "saves");
    fileStorage = new FileKeyValueStorage(saveRootDir);
  }
  return fileStorage;
}

ipcMain.handle("kinetra:storage:get", async (_event, key: unknown) => {
  if (typeof key !== "string") {
    throw new TypeError("Storage key must be a string");
  }
  return getFileStorage().get(key);
});

ipcMain.handle(
  "kinetra:storage:set",
  async (_event, key: unknown, value: unknown) => {
    if (typeof key !== "string") {
      throw new TypeError("Storage key must be a string");
    }
    if (typeof value !== "string") {
      throw new TypeError("Storage value must be a string");
    }
    await getFileStorage().set(key, value);
  },
);

ipcMain.handle("kinetra:storage:delete", async (_event, key: unknown) => {
  if (typeof key !== "string") {
    throw new TypeError("Storage key must be a string");
  }
  await getFileStorage().delete(key);
});


app.whenReady().then(async () => {
  if (runtimeBridgeMode) {
    await startRuntimeBridge();
  }

  mainWindow = createWindow();

  app.on("activate", () => {
    if (
      BrowserWindow.getAllWindows().length === 0 &&
      !smokeTest &&
      !runtimeBridgeMode
    ) {
      mainWindow = createWindow();
    }
  });
}).catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.stack ?? error.message : String(error),
  );
  app.exit(1);
});

app.on("window-all-closed", () => {
  if (!runtimeBridgeMode) {
    app.quit();
  }
});
