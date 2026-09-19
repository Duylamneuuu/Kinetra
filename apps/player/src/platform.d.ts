export {};

interface RuntimeBridgeRequest {
  id: string;
  method: string;
  params?: unknown;
}

declare global {
  interface Window {
    kinetraPlatform?: {
      setFullscreen(value: boolean): Promise<{ fullscreen: boolean }>;
      getWindowState(): Promise<{ fullscreen: boolean }>;
      getUserDataPath(): Promise<string>;
    };
    kinetraRuntimeBridge?: {
      onCommand(
        handler: (request: RuntimeBridgeRequest) => Promise<unknown>,
      ): void;
    };
  }
}
