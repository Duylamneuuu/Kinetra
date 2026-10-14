// Classifies Electron `did-fail-load` events for the packaged player.
//
// Kept free of any `electron` import so it can be unit-tested under plain Node.
// main.ts used to register `webContents.once("did-fail-load", ...)` and treat
// the FIRST event as fatal, whatever it was. That has two holes: (1) a failure
// of a sub-frame, or a navigation cancelled with ERR_ABORTED (-3), is not a
// failed player load, yet it killed the player (`app.exit(1)` + a bridge
// `fatal` event); (2) because the listener was `once`, such a benign first
// event consumed it, so a later genuine main-frame failure went unnoticed and
// the host waited for its ready timeout instead of getting a structured error.

/** Chromium net error for a navigation that was cancelled/superseded. */
export const ERR_ABORTED = -3;

/**
 * True when a `did-fail-load` event means the player document itself failed to
 * load: it must be the main frame, and not a cancelled navigation.
 */
export function isFatalLoadFailure(
  errorCode: number,
  isMainFrame: boolean,
): boolean {
  // Only an explicit `false` marks a sub-frame: if the argument were ever
  // missing, a real failure must not be swallowed.
  return isMainFrame !== false && errorCode !== ERR_ABORTED;
}

/** True for the rejection `loadFile` produces for a cancelled navigation. */
export function isAbortedLoadError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { errno, code } = error as { errno?: unknown; code?: unknown };
  return errno === ERR_ABORTED || code === "ERR_ABORTED";
}

/**
 * "First exit code wins". The bridge `close` handler exits with 0 while a fatal
 * load failure exits with 1 after a short flush delay; without arbitration the
 * host closing the pipe inside that window would turn a failure into exit 0.
 */
export class FirstExitCode {
  #code: number | undefined;

  /** Records `code` unless one was already claimed; returns the winning code. */
  claim(code: number): number {
    if (this.#code === undefined) {
      this.#code = code;
    }
    return this.#code;
  }
}

/** The message reported on stderr and in the bridge `fatal` event. */
export function describeLoadFailure(
  errorCode: number,
  errorDescription: string,
  validatedUrl?: string,
): string {
  const where =
    typeof validatedUrl === "string" && validatedUrl.length > 0
      ? ` (${validatedUrl})`
      : "";
  return `Kinetra packaged player failed to load: ${errorCode} ${errorDescription}${where}`;
}
