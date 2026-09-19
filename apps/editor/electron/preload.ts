import { contextBridge, ipcRenderer } from "electron";

const editorApi = {
  loadProjectText(): Promise<{
    path: string | null;
    writable: boolean;
    text: string;
  }> {
    return ipcRenderer.invoke(
      "kinetra:editor:load-project-text",
    );
  },

  saveProjectText(
    text: string,
  ): Promise<{ saved: boolean; path: string | null }> {
    return ipcRenderer.invoke(
      "kinetra:editor:save-project-text",
      text,
    );
  },

  getProjectPath(): Promise<string | null> {
    return ipcRenderer.invoke(
      "kinetra:editor:project-path",
    );
  },
};

contextBridge.exposeInMainWorld(
  "kinetraEditor",
  editorApi,
);
