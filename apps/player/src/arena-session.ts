/**
 * Start / leave flows of the game shell, kept free of DOM and engine imports so
 * the failure paths can be unit tested under plain Node.
 */

export interface ArenaStartSteps {
  /** Tears down the running runtime (a no-op when none runs). */
  stop(): Promise<unknown>;
  /** Boots a fresh runtime on the arena scene. */
  start(): Promise<unknown>;
  /** Restores the saved slot after boot; `null` for a new game. */
  loadSave: (() => Promise<unknown>) | null;
  /** Success: show the playing view and refresh the HUD. */
  enterPlaying(): void;
  /** Failure: show the main menu again (and refresh the Continue button). */
  enterMainMenu(): Promise<void> | void;
}

/**
 * Starts (or restarts) the arena. When any step fails — a corrupt or missing
 * save during Continue, a scene that fails to boot — the half-started runtime is
 * torn down and the shell returns to the main menu instead of sitting in the
 * previous (paused / won / lost) view on top of a runtime that is running or
 * dead. The original error is rethrown so the caller can report it.
 */
export async function runArenaStart(steps: ArenaStartSteps): Promise<void> {
  try {
    await steps.stop();
    await steps.start();
    if (steps.loadSave) {
      await steps.loadSave();
    }
  } catch (error) {
    try {
      await steps.stop();
    } catch {
      // Best effort: the start error below is the one worth reporting.
    }
    try {
      await steps.enterMainMenu();
    } catch {
      // Same: never mask the start error.
    }
    throw error;
  }
  steps.enterPlaying();
}

export interface MainMenuReturnSteps {
  stop(): Promise<unknown>;
  refreshContinueAvailable(): Promise<unknown>;
  enterMainMenu(): void;
}

/**
 * Leaves the game for the main menu. The main menu is shown even when stopping
 * the runtime or probing the save slot throws; the error still propagates.
 */
export async function returnToMainMenu(steps: MainMenuReturnSteps): Promise<void> {
  try {
    await steps.stop();
  } finally {
    try {
      await steps.refreshContinueAvailable();
    } finally {
      steps.enterMainMenu();
    }
  }
}
