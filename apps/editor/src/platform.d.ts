export {};

declare global {
  interface Window {
    kinetraEditor?: {
      loadProjectText(): Promise<{
        path: string | null;
        writable: boolean;
        text: string;
      }>;
      saveProjectText(text: string): Promise<{
        saved: boolean;
        path: string | null;
      }>;
      getProjectPath(): Promise<string | null>;
    };
  }
}
