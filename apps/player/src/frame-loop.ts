/**
 * The requestAnimationFrame driver of the player page.
 *
 * The next frame is always scheduled, even when a tick throws (a lost WebGL context, a shell
 * update error): previously the schedule call sat after the tick, so one exception ended the loop
 * for good and the page stayed frozen on its last image with no way to recover.
 */
export interface FrameLoopOptions {
  /** Timestamp the first delta is measured from (performance.now() at creation). */
  readonly initialTime: number;
  /** Largest delta handed to tick: a long pause (hidden tab) must not become one huge step. */
  readonly maxDeltaSeconds?: number;
  /** Schedules `callback` for the next frame (requestAnimationFrame). */
  schedule(callback: (now: number) => void): void;
  /** Advances the game by `deltaSeconds` (always finite, in [0, maxDeltaSeconds]). */
  tick(deltaSeconds: number): void;
  /** Receives anything `tick` throws; the loop keeps running. */
  onError(error: unknown): void;
}

export interface FrameLoop {
  /** Schedules the first frame. */
  start(): void;
  /** One frame callback; exposed for tests. */
  frame(now: number): void;
}

export function createFrameLoop(options: FrameLoopOptions): FrameLoop {
  const maxDelta = options.maxDeltaSeconds ?? 0.1;
  let lastTime = options.initialTime;

  const frame = (now: number): void => {
    // A non-finite timestamp must not reach the scripts (ScriptHost.update rejects NaN deltas).
    const raw = (now - lastTime) / 1000;
    const deltaSeconds = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), maxDelta) : 0;
    if (Number.isFinite(now)) {
      lastTime = now;
    }
    try {
      options.tick(deltaSeconds);
    } catch (error) {
      try {
        options.onError(error);
      } catch {
        // An error reporter that throws must not stop the loop either.
      }
    } finally {
      options.schedule(frame);
    }
  };

  return {
    start: () => options.schedule(frame),
    frame,
  };
}
