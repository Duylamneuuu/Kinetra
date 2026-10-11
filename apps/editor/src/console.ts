import type { CommandBus, CommandEvent } from "@kinetra/command-bus";
import type { JsonValue } from "@kinetra/project-model";

/**
 * Editor console model: a bounded, filterable, read-only view over what happened to the project.
 *
 * Two kinds of entry share one list:
 * - `command` entries mirror the command bus event log one-to-one (the same `CommandEvent` an MCP
 *   client sees through `diffSince`), so the console can never disagree with the replayable history.
 * - everything else (runtime output, editor notices) arrives through {@link EditorConsole.log}.
 *
 * The console never mutates the project and never sends commands. The bus has no subscription API,
 * so command entries are pulled by {@link EditorConsole.sync} (call it after edits or on a timer);
 * `log()` entries are pushed. A console that falls behind the bus's own bounded event log records a
 * warning entry saying how many events it missed instead of silently skipping them.
 */
export type ConsoleLevel = "debug" | "info" | "warn" | "error";

export const CONSOLE_LEVELS: readonly ConsoleLevel[] = ["debug", "info", "warn", "error"];

export interface ConsoleEntry {
  /** Monotonic per console, starting at 1; unaffected by trimming. */
  seq: number;
  level: ConsoleLevel;
  /** `command` for bus events, otherwise whatever the logger passed (e.g. `runtime`, `editor`). */
  source: string;
  message: string;
  /** Structured payload of a `log()` call, reduced to plain JSON (never throws, bounded size). */
  data?: JsonValue;
  /** The bus event a `command` entry mirrors (deep copy). */
  event?: CommandEvent;
}

export interface ConsoleFilter {
  /** Entries at this level or more severe. */
  minLevel?: ConsoleLevel;
  /** Exactly these levels (combined with `minLevel` when both are given). */
  levels?: readonly ConsoleLevel[];
  sources?: readonly string[];
  /** Only entries with `seq` greater than this. */
  sinceSeq?: number;
  /** Keep only the most recent N matches. */
  limit?: number;
}

export interface EditorConsoleOptions {
  /** Most entries kept; older ones are dropped (see `droppedCount`). Default 1000. */
  maxEntries?: number;
}

export type ConsoleListener = (entry: ConsoleEntry) => void;

const DEFAULT_MAX_ENTRIES = 1000;
const MAX_STRING = 2000;
const MAX_DEPTH = 8;
const MAX_CHILDREN = 100;

function levelRank(level: ConsoleLevel): number {
  return CONSOLE_LEVELS.indexOf(level);
}

function isLevel(value: unknown): value is ConsoleLevel {
  return typeof value === "string" && (CONSOLE_LEVELS as readonly string[]).includes(value);
}

function clip(text: string): string {
  return text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}… [truncated ${text.length - MAX_STRING} chars]` : text;
}

/**
 * Reduce any value to plain JSON without ever throwing: cycles, bigint, functions, symbols,
 * non-finite numbers, throwing getters/`toJSON`, huge or deeply nested structures all become short
 * marker strings so one bad log argument cannot take the console down.
 */
export function toConsoleJson(value: unknown): JsonValue | undefined {
  const ancestors = new Set<object>();
  const visit = (current: unknown, depth: number): JsonValue | undefined => {
    try {
      switch (typeof current) {
        case "undefined":
          return undefined;
        case "string":
          return clip(current);
        case "boolean":
          return current;
        case "number":
          return Number.isFinite(current) ? current : `[${String(current)}]`;
        case "bigint":
          return `${current.toString()}n`;
        case "function":
          return "[function]";
        case "symbol":
          return "[symbol]";
        default:
          break;
      }
      if (current === null) return null;
      const object = current as object;
      if (ancestors.has(object)) return "[circular]";
      if (depth >= MAX_DEPTH) return "[max depth]";
      if (object instanceof Date) {
        return Number.isNaN(object.getTime()) ? "[invalid date]" : object.toISOString();
      }
      if (object instanceof Error) return { name: clip(object.name), message: clip(object.message) };
      if (object instanceof Map) return `[Map(${object.size})]`;
      if (object instanceof Set) return `[Set(${object.size})]`;
      ancestors.add(object);
      try {
        if (Array.isArray(object)) {
          const items: JsonValue[] = [];
          for (const item of object.slice(0, MAX_CHILDREN)) items.push(visit(item, depth + 1) ?? null);
          if (object.length > MAX_CHILDREN) items.push(`[${object.length - MAX_CHILDREN} more]`);
          return items;
        }
        const result: { [key: string]: JsonValue } = {};
        const keys = Object.keys(object);
        for (const key of keys.slice(0, MAX_CHILDREN)) {
          // Reading the property can itself throw (a getter or a Proxy trap): keep the other keys.
          let child: JsonValue | undefined;
          try {
            child = visit((object as Record<string, unknown>)[key], depth + 1);
          } catch {
            child = "[unserializable]";
          }
          if (child !== undefined) result[key] = child;
        }
        if (keys.length > MAX_CHILDREN) result["…"] = `[${keys.length - MAX_CHILDREN} more keys]`;
        return result;
      } finally {
        ancestors.delete(object);
      }
    } catch {
      return "[unserializable]";
    }
  };
  return visit(value, 0);
}

function describeEvent(event: CommandEvent): string {
  const names = event.commands.map((command) => command.command);
  const unique = [...new Set(names)];
  const summary = unique.length === 0 ? "no commands" : unique.join(", ");
  const count = event.changes.length;
  return `${event.operation} r${event.revision}: ${summary} (${count} change${count === 1 ? "" : "s"})`;
}

export class EditorConsole {
  readonly #maxEntries: number;
  #entries: ConsoleEntry[] = [];
  #seq = 0;
  #dropped = 0;
  #listeners = new Set<ConsoleListener>();
  #listenerErrors = 0;
  #bus: CommandBus | undefined;
  /** How many bus events (dropped + retained) this console has already accounted for. */
  #consumed = 0;

  constructor(options: EditorConsoleOptions = {}) {
    const max = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!(Number.isInteger(max) && max >= 1)) {
      throw new RangeError(`maxEntries must be a positive integer, received ${String(max)}`);
    }
    this.#maxEntries = max;
  }

  /** Entries that fell out of the bounded list (so a consumer can tell the history is incomplete). */
  get droppedCount(): number {
    return this.#dropped;
  }

  /** Number of times a listener threw; the console keeps going and the throw is not rethrown. */
  get listenerErrorCount(): number {
    return this.#listenerErrors;
  }

  get size(): number {
    return this.#entries.length;
  }

  /**
   * Follow a command bus. With `replay` (default) the events already in its log become entries on
   * the next `sync()`; without it only events from now on do. Attaching another bus replaces the
   * previous one; entries already collected stay.
   */
  attachBus(bus: CommandBus, options: { replay?: boolean } = {}): void {
    this.#bus = bus;
    this.#consumed = options.replay === false ? bus.droppedEventCount + bus.eventLog().length : 0;
  }

  detachBus(): void {
    this.#bus = undefined;
    this.#consumed = 0;
  }

  /**
   * Pull events the bus has logged since the last sync into the console. Returns how many entries
   * were added (a gap warning counts as one). A no-op without an attached bus.
   */
  sync(): number {
    const bus = this.#bus;
    if (!bus) return 0;
    const events = bus.eventLog();
    const total = bus.droppedEventCount + events.length;
    const fresh = total - this.#consumed;
    if (fresh <= 0) {
      // The bus can only grow its counters; a smaller total means a different bus state, so resync.
      if (fresh < 0) this.#consumed = total;
      return 0;
    }
    let added = 0;
    if (fresh > events.length) {
      const missed = fresh - events.length;
      this.#push({
        level: "warn",
        source: "command",
        message: `${missed} command event${missed === 1 ? "" : "s"} left the bus event log before the console read ${missed === 1 ? "it" : "them"}`,
      });
      added += 1;
    }
    for (const event of events.slice(events.length - Math.min(fresh, events.length))) {
      this.#push({ level: "info", source: "command", message: describeEvent(event), event });
      added += 1;
    }
    this.#consumed = total;
    return added;
  }

  /**
   * Append one entry (runtime output, an editor notice). `data` is reduced to plain JSON; an
   * unknown level is recorded as `info` rather than rejected so logging can never throw.
   */
  log(level: ConsoleLevel, source: string, message: string, data?: unknown): ConsoleEntry {
    const json = data === undefined ? undefined : toConsoleJson(data);
    const entry = this.#push({
      level: isLevel(level) ? level : "info",
      source: typeof source === "string" && source.length > 0 ? clip(source) : "unknown",
      message: clip(typeof message === "string" ? message : (JSON.stringify(toConsoleJson(message)) ?? "")),
      ...(json === undefined ? {} : { data: json }),
    });
    return structuredClone(entry);
  }

  /** Entries (deep copies) in arrival order, optionally filtered. */
  entries(filter: ConsoleFilter = {}): ConsoleEntry[] {
    const minRank = filter.minLevel !== undefined && isLevel(filter.minLevel) ? levelRank(filter.minLevel) : 0;
    const levels = filter.levels ? new Set<string>(filter.levels) : undefined;
    const sources = filter.sources ? new Set<string>(filter.sources) : undefined;
    const since = typeof filter.sinceSeq === "number" && Number.isFinite(filter.sinceSeq) ? filter.sinceSeq : 0;
    let matches = this.#entries.filter(
      (entry) =>
        entry.seq > since &&
        levelRank(entry.level) >= minRank &&
        (!levels || levels.has(entry.level)) &&
        (!sources || sources.has(entry.source)),
    );
    if (typeof filter.limit === "number" && Number.isFinite(filter.limit) && filter.limit >= 0) {
      const limit = Math.floor(filter.limit);
      matches = limit === 0 ? [] : matches.slice(-limit);
    }
    return structuredClone(matches);
  }

  /** Subscribe to entries added from now on. Returns an idempotent unsubscribe function. */
  subscribe(listener: ConsoleListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Drop all entries (the sequence number keeps counting; the bus cursor is untouched). */
  clear(): void {
    this.#entries = [];
  }

  #push(partial: Omit<ConsoleEntry, "seq">): ConsoleEntry {
    this.#seq += 1;
    const entry: ConsoleEntry = { seq: this.#seq, ...partial };
    this.#entries.push(entry);
    const overflow = this.#entries.length - this.#maxEntries;
    if (overflow > 0) {
      this.#entries.splice(0, overflow);
      this.#dropped += overflow;
    }
    for (const listener of [...this.#listeners]) {
      // A listener removed by an earlier listener in this same dispatch must not be called.
      if (!this.#listeners.has(listener)) continue;
      try {
        listener(structuredClone(entry));
      } catch {
        this.#listenerErrors += 1;
      }
    }
    return entry;
  }
}
