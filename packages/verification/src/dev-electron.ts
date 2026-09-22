export interface DevElectronRuntimeSupportInput {
  platform: NodeJS.Platform;
  display: string | undefined;
  force: string | undefined;
}

/**
 * Dev Electron acceptance runs on Windows, and on Linux when a display
 * server is already available or the caller explicitly opts in
 * (`KINETRA_LINUX_REAL_ELECTRON=1`, typically under xvfb).
 * Packaged `KinetraGame.exe` proof stays Windows-only.
 */
export function devElectronRuntimeSupportedOn(
  input: DevElectronRuntimeSupportInput,
): boolean {
  if (input.platform === "win32") {
    return true;
  }
  if (input.platform !== "linux") {
    return false;
  }
  if (input.force === "1") {
    return true;
  }
  return typeof input.display === "string" && input.display.length > 0;
}

export function devElectronRuntimeSupported(): boolean {
  return devElectronRuntimeSupportedOn({
    platform: process.platform,
    display: process.env.DISPLAY,
    force: process.env.KINETRA_LINUX_REAL_ELECTRON,
  });
}

export function linuxSoftwareGlEnabled(): boolean {
  return (
    process.platform === "linux" && process.env.KINETRA_LINUX_GL !== "hardware"
  );
}
