/**
 * Wraps an async action so a call made while a previous call is still pending
 * joins that call instead of starting a second one. The shared promise settles
 * with the first call's result (including its rejection); the arguments of the
 * joining call are ignored. Once the pending call settles, the next call runs
 * the action again, so deliberate restarts keep working.
 *
 * Kept free of DOM and engine imports so it can be unit tested under plain Node.
 */
export function singleFlight<Args extends readonly unknown[]>(
  action: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return (...args: Args): Promise<void> => {
    if (inFlight) return inFlight;
    // The async wrapper turns a synchronous throw into a rejection so the guard
    // is always released through finally().
    const tracked: Promise<void> = (async () => action(...args))().finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  };
}
