import { contextBridge, ipcRenderer } from "electron";

import type { ProjectDocument } from "@kinetra/project-model";

const editorApi = {
  loadProject(): Promise<{
    path: string | null;
    writable: boolean;
    project: ProjectDocument;
  }> {
    return ipcRenderer.invoke("kinetra:editor:load-project");
  },

  saveProject(
    project: ProjectDocument,
  ): Promise<{ saved: boolean; path: string | null }> {
    return ipcRenderer.invoke(
      "kinetra:editor:save-project",
      project,
    );
  },

  getProjectPath(): Promise<string | null> {
    return ipcRenderer.invoke("kinetra:editor:project-path");
  },
};

contextBridge.exposeInMainWorld(
  "kinetraEditor",
  editorApi,
);
