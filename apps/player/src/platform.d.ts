export {};

declare global {
  interface Window {
    kinetraPlatform?: {
      setFullscreen(value: boolean): Promise<{ fullscreen: boolean }>;
      getWindowState(): Promise<{ fullscreen: boolean }>;
      getUserDataPath(): Promise<string>;
    };
    kinetraRuntimeBridge?: {
      onCommand(
        handler: (request: {
          id: string;
          method: string;
          params?: unknown;
        }) => Promise<unknown>,
      ): void;
    };
  }
}
