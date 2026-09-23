export type LogLevel = "debug" | "info" | "warning" | "error";

export interface LogRecord {
  sequence: number;
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
}

const DROP_ORDER: readonly LogLevel[] = ["debug", "info", "warning", "error"];

export class BoundedLogBuffer {
  readonly capacity: number;
  #entries: LogRecord[] = [];
  #nextSequence = 1;
  #dropped = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("Log capacity must be an integer >= 1");
    }
    this.capacity = capacity;
  }

  get dropped(): number {
    return this.#dropped;
  }

  get retained(): number {
    return this.#entries.length;
  }

  append(
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>,
  ): LogRecord {
    if (!DROP_ORDER.includes(level)) {
      throw new TypeError(`Unknown log level "${String(level)}"`);
    }
    if (typeof message !== "string") {
      throw new TypeError("Log message must be a string");
    }

    const entry: LogRecord = {
      sequence: this.#nextSequence++,
      level,
      message,
      ...(data !== undefined ? { data: structuredClone(data) } : {}),
    };
    this.#entries.push(entry);
    this.#trim();
    const retained = this.#entries.find((item) => item.sequence === entry.sequence);
    return retained ? structuredClone(retained) : structuredClone(entry);
  }

  read(sinceSequence = 0): LogRecord[] {
    if (!Number.isInteger(sinceSequence) || sinceSequence < 0) {
      throw new RangeError("sinceSequence must be an integer >= 0");
    }
    return this.#entries
      .filter((entry) => entry.sequence > sinceSequence)
      .map((entry) => structuredClone(entry));
  }

  #trim(): void {
    while (this.#entries.length > this.capacity) {
      let dropAt = -1;
      for (const level of DROP_ORDER) {
        dropAt = this.#entries.findIndex((entry) => entry.level === level);
        if (dropAt >= 0) break;
      }
      if (dropAt < 0) dropAt = 0;
      this.#entries.splice(dropAt, 1);
      this.#dropped += 1;
    }
  }
}
