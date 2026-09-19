import type { ProjectDocument } from "@kinetra/project-model";

export {};

declare global {
  interface Window {
    kinetraEditor?: {
      loadProject(): Promise<{
        path: string | null;
        writable: boolean;
        project: ProjectDocument;
      }>;
      saveProject(project: ProjectDocument): Promise<{
        saved: boolean;
        path: string | null;
      }>;
      getProjectPath(): Promise<string | null>;
    };
  }
}
