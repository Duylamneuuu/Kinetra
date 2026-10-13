import { app, BrowserWindow, ipcMain } from "electron";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { FileKeyValueStorage } from "@kinetra/save-state/file";
import {
  BRIDGE_MALFORMED_RENDERER_RESPONSE,
  normalizeRendererResponse,
  parseBridgeLine,
  recoverRendererResponseId,
  serializeBridgeMessage,
  type BridgeRequest,
} from "./bridge-protocol.js";
import { describeLoadFailure, isFatalLoadFailure } from "./load-failure.js";
import { RendererRequestTracker } from "./renderer-requests.js";

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

const captureModeArg =
  process.env.KINETRA_CAPTURE_MODE ||
  process.argv
    .find((arg) => arg.startsWith("--capture-mode="))
    ?.slice("--capture-mode=".length);
const captureMode =
  captureModeArg === "visual" || process.argv.includes("--capture-mode=visual")
    ? "visual"
    : "performance";

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

interface BridgeResponse {
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

let mainWindow: BrowserWindow | null = null;
let smokeFinished = false;
let bridgeSocket: Socket | undefined;
let documentLoaded = false;
let rendererReady = false;
let bridgeReadyEmitted = false;
const rendererRequests = new RendererRequestTracker({
  send(message) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      throw new Error("Kinetra player window is unavailable");
    }
    mainWindow.webContents.send("kinetra:runtime:command", message);
  },
});

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
  // serializeBridgeMessage never throws: an unserialisable result becomes a structured failure
  // reply instead of an unhandled rejection that leaves the client waiting for its timeout.
  const line = serializeBridgeMessage(value);

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

  // Requests in flight when the renderer dies or the window closes would
  // otherwise each wait out the 10 s renderer timeout (and, for a closed
  // window, never be answerable at all). Fail them now.
  window.webContents.on("render-process-gone", (_event, details) => {
    rendererRequests.rejectAll(
      new Error(`Kinetra renderer process is gone (${details.reason})`),
    );
  });

  window.on("closed", () => {
    rendererRequests.close(new Error("Kinetra player window is unavailable"));
  });

  // Only a failure of the main frame that is not a cancelled navigation is
  // fatal. A permanent listener (not `once`): a benign sub-frame/ERR_ABORTED
  // event must not consume it and hide a later genuine main-frame failure.
  let loadFailureHandled = false;
  window.webContents.on(
    "did-fail-load",
    (_event, code, description, validatedUrl, isMainFrame) => {
      if (loadFailureHandled || !isFatalLoadFailure(code, isMainFrame)) {
        return;
      }
      loadFailureHandled = true;

      const message = describeLoadFailure(code, description, validatedUrl);
      console.error(message);

      if (runtimeBridgeMode) {
        bridgeWrite({ type: "event", event: "fatal", message });
        // Give the socket/stdout a moment to flush the fatal line; an
        // immediate app.exit() could cut it off and leave the host waiting.
        setTimeout(() => app.exit(1), 250);
      }

      finishSmoke(1);
    },
  );

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
  void window.loadFile(indexPath, {
    query: {
      captureMode,
    },
  });

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

  return rendererRequests.call(method, params, timeoutMs);
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
  (event, rawResponse: unknown) => {
    if (event.sender !== mainWindow?.webContents) {
      return;
    }

    // A malformed reply must not throw inside the listener (uncaught main-process exception).
    const response = normalizeRendererResponse(rawResponse);
    if (!response) {
      // With a recoverable id, fail that pending request now (structured) rather than letting it
      // wait for the renderer timeout; without one nothing can be correlated, so it is dropped.
      const malformedId = recoverRendererResponseId(rawResponse);
      if (
        malformedId !== null &&
        rendererRequests.fail(
          malformedId,
          new Error(
            `${BRIDGE_MALFORMED_RENDERER_RESPONSE}: renderer replied to "${malformedId}" with a malformed response`,
          ),
        )
      ) {
        return;
      }
      console.error("[bridge] ignored a malformed renderer response");
      return;
    }

    rendererRequests.respond(
      response.id,
      response.ok
        ? { ok: true, result: response.result }
        : { ok: false, error: response.error },
    );
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
        captureMode,
        preserveDrawingBuffer: captureMode === "visual",
      };

    case "runtime.start":
    case "runtime.stop":
    case "runtime.pause":
    case "runtime.resume":
    case "runtime.query":
    case "runtime.injectInput":
    case "runtime.readLogs":
    case "runtime.step":
    case "performance.sample":
    case "asset.register":
    case "animation.play":
    case "animation.crossfade":
    case "animation.blendSpace.play":
    case "animation.blendSpace.setInput":
    case "animation.graph.init":
    case "animation.graph.setParameter":
    case "animation.graph.trigger":
    case "animation.graph.evaluate":
    case "animation.stop":
    case "animation.registerClip":
    case "animation.setMorphWeights":
    case "animation.clearMorphWeights":
    case "animation.ik.setChains":
    case "animation.ik.setTarget":
    case "animation.ik.clearTarget":
    case "animation.rootMotion.configure":
    case "model.detach":
    case "model.attach":
    case "model.reloadAsset":
    case "asset.update":
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
      try {
        const directCapture = (await callRenderer("runtime.captureFrame", {})) as {
          available?: boolean;
          mimeType?: string;
          base64?: string;
        };
        if (
          directCapture &&
          directCapture.available &&
          typeof directCapture.base64 === "string" &&
          directCapture.base64.length > 0
        ) {
          return directCapture;
        }
      } catch {
        // Fall back to window capturePage if renderer canvas capture is unavailable
      }

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
      const parsed = parseBridgeLine(line);

      if (!parsed.ok) {
        // Answer instead of dropping the line, so the client fails fast with
        // a structured error rather than waiting for its request timeout.
        console.error(parsed.response.error);
        bridgeWrite(parsed.response);
        return;
      }

      const request: BridgeRequest = parsed.request;

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

      // A permanent listener: a `once` handler is spent by the first error, and
      // a second socket error (EPIPE after the host went away) would then be an
      // uncaught exception in the main process.
      socket.on("error", (error) => {
        if (bridgeSocket === socket) {
          console.error(`[bridge] socket error: ${error.message}`);
        } else {
          reject(error);
        }
      });
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
