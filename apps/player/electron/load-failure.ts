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
  return isMainFrame === true && errorCode !== ERR_ABORTED;
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
