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
};

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

          ipcRenderer.send("kinetra:runtime:response", response);
        })();
      },
    );
  },
};

contextBridge.exposeInMainWorld("kinetraPlatform", platformApi);
contextBridge.exposeInMainWorld("kinetraRuntimeBridge", runtimeBridge);
