export {};

declare global {
  interface Window {
    kinetraPlatform?: {
      setFullscreen(value: boolean): Promise<{ fullscreen: boolean }>;
      getWindowState(): Promise<{ fullscreen: boolean }>;
      getUserDataPath(): Promise<string>;
      storageGet(key: string): Promise<string | undefined>;
      storageSet(key: string, value: string): Promise<void>;
      storageDelete(key: string): Promise<void>;
      storageList(prefix: string): Promise<string[]>;
      quit(): Promise<void>;
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
