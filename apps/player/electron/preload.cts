import { contextBridge, ipcRenderer } from "electron";

interface RuntimeBridgeRequest {
  id: string;
  method: string;
  params?: unknown;
}

interface RuntimeBridgeResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const platformApi = {
  setFullscreen(value: boolean): Promise<{ fullscreen: boolean }> {
    return ipcRenderer.invoke("kinetra:window:set-fullscreen", value);
  },
  getWindowState(): Promise<{ fullscreen: boolean }> {
    return ipcRenderer.invoke("kinetra:window:get-state");
  },
  getUserDataPath(): Promise<string> {
    return ipcRenderer.invoke("kinetra:platform:user-data-path");
  },
  storageGet(key: string): Promise<string | undefined> {
    return ipcRenderer.invoke("kinetra:storage:get", key);
  },
  storageSet(key: string, value: string): Promise<void> {
    return ipcRenderer.invoke("kinetra:storage:set", key, value);
  },
  storageDelete(key: string): Promise<void> {
    return ipcRenderer.invoke("kinetra:storage:delete", key);
  },
  quit(): Promise<void> {
    return ipcRenderer.invoke("kinetra:app:quit");
  },
};

/**
 * Sends one reply to the main process. `ipcRenderer.send` structured-clones its payload and throws
 * on a value that cannot be cloned (a function, a DOM node, a Symbol). Inside the un-awaited async
 * handler below that throw was an unhandled rejection: no reply was ever sent, so the main process
 * (and the probe / MCP client behind it) waited for its whole request timeout. A reply that cannot
 * be cloned is replaced by a structured failure that keeps the request id.
 *
 * Sandboxed preloads cannot require sibling modules, so this stays in this file.
 */
function sendRuntimeResponse(response: RuntimeBridgeResponse): void {
  try {
    ipcRenderer.send("kinetra:runtime:response", response);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ipcRenderer.send("kinetra:runtime:response", {
      id: response.id,
      ok: false,
      error: `BRIDGE_UNCLONEABLE_RESPONSE: ${reason}`,
    } satisfies RuntimeBridgeResponse);
  }
}

const runtimeBridge = {
  onCommand(
    handler: (request: RuntimeBridgeRequest) => Promise<unknown>,
  ): void {
    ipcRenderer.removeAllListeners("kinetra:runtime:command");

    ipcRenderer.on(
      "kinetra:runtime:command",
      (_event, request: RuntimeBridgeRequest) => {
        void (async () => {
          let response: RuntimeBridgeResponse;

          try {
            response = {
              id: request.id,
              ok: true,
              result: await handler(request),
            };
          } catch (error) {
            response = {
              id: request.id,
              ok: false,
              error:
                error instanceof Error
                  ? error.stack ?? error.message
                  : String(error),
            };
          }

          sendRuntimeResponse(response);
        })();
      },
    );

    ipcRenderer.send("kinetra:runtime:renderer-ready");
  },
};

contextBridge.exposeInMainWorld("kinetraPlatform", platformApi);
contextBridge.exposeInMainWorld("kinetraRuntimeBridge", runtimeBridge);
