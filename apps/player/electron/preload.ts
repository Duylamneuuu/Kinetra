import { contextBridge, ipcRenderer } from "electron";

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

contextBridge.exposeInMainWorld("kinetraPlatform", platformApi);
