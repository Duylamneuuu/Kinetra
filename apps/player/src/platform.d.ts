export {};

declare global {
  interface Window {
    kinetraPlatform?: {
      setFullscreen(value: boolean): Promise<{ fullscreen: boolean }>;
      getWindowState(): Promise<{ fullscreen: boolean }>;
      getUserDataPath(): Promise<string>;
    };
  }
}
