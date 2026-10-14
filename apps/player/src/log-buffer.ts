/**
 * Bounded, never-throwing runtime log buffer for the player.
 *
 * The controller used to keep every log entry for the whole life of the page and ran
 * `structuredClone(data)` inside `#log`. Two consequences:
 *
 * - Memory grew without bound: scripts call `navigation.computePath` / `closestPoint` / input and
 *   animation helpers every frame and each call logs, so a long realtime session retained millions
 *   of entries and `runtime.readLogs` cloned the whole array every poll.
 * - `structuredClone` throws a `DataCloneError` for a function, a symbol or a DOM node. `#log` is
 *   reachable from the script context (`context.log(level, category, data)`), so a script logging
 *   such a value crashed its own `update()` instead of getting a log line.
 *
 * Sequence numbers keep increasing across evictions, so `readLogs(sinceSequence)` cursors stay
 * valid: a reader that fell behind simply misses the evicted entries (see `droppedCount`).
 *
 * Free of DOM / Electron / Three.js imports so it can be unit-tested under plain Node.
 */

export type PlayerRuntimeLogLevel = "debug" | "info" | "warning" | "error";

export interface PlayerRuntimeLog {
  sequence: number;
  level: PlayerRuntimeLogLevel;
  message: string;
  data?: Record<string, unknown>;
}

/** Enough for a long acceptance run, small enough that a day of realtime play cannot exhaust memory. */
export const DEFAULT_MAX_LOG_ENTRIES = 10_000;

/**
 * Clones `data` so later mutation by the caller cannot change a stored entry. A value that
 * `structuredClone` refuses is replaced by a JSON-safe copy (functions, symbols, bigints and cycles
 * become descriptive strings); a record that still cannot be copied is reported, never thrown.
 */
export function cloneLogData(data: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(data);
  } catch {
    // fall through to the lossy copy
  }
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(data, (_key, value: unknown) => {
      if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
      if (typeof value === "symbol") return value.toString();
      if (typeof value === "bigint") return `${value.toString()}n`;
      if (typeof value === "number" && !Number.isFinite(value)) return String(value);
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[circular]";
        seen.add(value);
      }
      return value;
    });
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>), logDataSanitized: true };
    }
  } catch {
    // fall through to the marker
  }
  return { logDataUnserializable: true };
}

export class RuntimeLogBuffer {
  #entries: PlayerRuntimeLog[] = [];
  #nextSequence = 1;
  #dropped = 0;
  readonly #maxEntries: number;

  constructor(maxEntries: number = DEFAULT_MAX_LOG_ENTRIES) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive integer");
    }
    this.#maxEntries = maxEntries;
  }

  /** Entries evicted so far because the buffer was full. */
  get droppedCount(): number {
    return this.#dropped;
  }

  get size(): number {
    return this.#entries.length;
  }

  push(level: PlayerRuntimeLogLevel, message: string, data?: Record<string, unknown>): PlayerRuntimeLog {
    const entry: PlayerRuntimeLog = {
      sequence: this.#nextSequence++,
      level,
      message,
      ...(data ? { data: cloneLogData(data) } : {}),
    };
    this.#entries.push(entry);
    const overflow = this.#entries.length - this.#maxEntries;
    if (overflow > 0) {
      this.#entries.splice(0, overflow);
      this.#dropped += overflow;
    }
    return entry;
  }

  /** Entries with a sequence greater than `sinceSequence`, as copies the caller may mutate. */
  read(sinceSequence = 0): PlayerRuntimeLog[] {
    return this.#entries
      .filter((entry) => entry.sequence > sinceSequence)
      .map((entry) => ({
        ...entry,
        ...(entry.data ? { data: cloneLogData(entry.data) } : {}),
      }));
  }
}
