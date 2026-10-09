/**
 * Animation events: text-defined clip-time markers `{clip, time, name, payload}`.
 *
 * This module is a pure contract (no Three.js). It validates event definitions with
 * structured diagnostics and provides a deterministic tracker that reports which events a
 * playback head crossed. Playback head movement is owned by the caller (the runtime adds
 * `deltaSeconds * speed` per step), so the same events fire whether time advances in one big
 * step or many small ones.
 *
 * Crossing rules (the contract the tests pin down):
 * - Forward playback fires events whose time lies in the half-open interval (from, to].
 * - Reverse playback fires events whose time lies in [to, from).
 * - The first movement after creation also includes the starting point itself, so an event at
 *   the very start of playback (time 0 forward, duration in reverse) fires once. In a looping
 *   clip the start point belongs to the iteration the head stands in (a start at `duration`
 *   counts as time 0 of the next iteration).
 * - Looping clips repeat every `duration`; an event fires once per loop iteration it crosses,
 *   including when one step spans several loops. An event at `time === duration` fires at the
 *   wrap point, together with events at time 0 of the next iteration.
 * - Non-looping clips clamp to [0, duration]; every event fires at most once per direction and
 *   standing at the end fires nothing more.
 */

export type AnimationEventSeverity = "error" | "warning";

export interface AnimationEventDiagnostic {
  code: string;
  severity: AnimationEventSeverity;
  message: string;
  remediation: string;
  /** Index of the offending entry in the input array, when there is one. */
  index?: number | undefined;
}

export type AnimationEventPayload = Record<string, unknown>;

/** A validated, normalized event bound to a clip. */
export interface ClipAnimationEvent {
  clip: string;
  time: number;
  name: string;
  payload: AnimationEventPayload;
}

export interface AnimationEventNormalization {
  /** Valid events only, sorted by clip (code point), time, then input order. */
  events: ClipAnimationEvent[];
  diagnostics: AnimationEventDiagnostic[];
}

export const MAX_ANIMATION_EVENTS = 4096;
export const MAX_ANIMATION_EVENT_NAME_LENGTH = 128;
export const MAX_ANIMATION_EVENT_PAYLOAD_DEPTH = 8;
export const MAX_ANIMATION_EVENT_PAYLOAD_JSON_LENGTH = 4096;
/** Upper bound on events one `advance` call reports; beyond it the result is flagged truncated. */
export const DEFAULT_MAX_FIRES_PER_ADVANCE = 1024;

export type AnimationEventClipDurations =
  | ReadonlyMap<string, number>
  | Readonly<Record<string, number>>;

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  // defineProperty keeps a JSON-parsed "__proto__" key as data instead of invoking the setter.
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function durationOf(durations: AnimationEventClipDurations | undefined, clip: string): number | undefined {
  if (durations === undefined) return undefined;
  if (durations instanceof Map) return durations.get(clip);
  const record = durations as Readonly<Record<string, number>>;
  return Object.prototype.hasOwnProperty.call(record, clip) ? record[clip] : undefined;
}

/** Deep-copies a JSON-compatible value; returns undefined plus a reason when it is not one. */
function cloneJson(
  value: unknown,
  depth: number,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { ok: true, value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { ok: true, value }
      : { ok: false, reason: "numbers must be finite" };
  }
  if (depth >= MAX_ANIMATION_EVENT_PAYLOAD_DEPTH) {
    return { ok: false, reason: `nesting is deeper than ${MAX_ANIMATION_EVENT_PAYLOAD_DEPTH}` };
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const cloned = cloneJson(item, depth + 1);
      if (!cloned.ok) return cloned;
      out.push(cloned.value);
    }
    return { ok: true, value: out };
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const cloned = cloneJson(value[key], depth + 1);
      if (!cloned.ok) return cloned;
      setOwn(out, key, cloned.value);
    }
    return { ok: true, value: out };
  }
  return { ok: false, reason: `unsupported value of type ${typeof value}` };
}

function clonePayload(payload: AnimationEventPayload): AnimationEventPayload {
  const cloned = cloneJson(payload, 0);
  return cloned.ok ? (cloned.value as AnimationEventPayload) : {};
}

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validates and normalizes raw event definitions (for example parsed from project JSON).
 * Never throws: entries that cannot be used are dropped with an `error` diagnostic.
 *
 * When `clipDurations` is given, an event must name a known clip and lie within
 * `[0, duration]`; without it only structural checks run.
 */
export function normalizeAnimationEvents(
  raw: unknown,
  clipDurations?: AnimationEventClipDurations,
): AnimationEventNormalization {
  const diagnostics: AnimationEventDiagnostic[] = [];
  if (!Array.isArray(raw)) {
    diagnostics.push({
      code: "animation.events.notArray",
      severity: "error",
      message: "Animation events must be an array of {clip, time, name, payload?} objects.",
      remediation: "Wrap the event definitions in a JSON array.",
    });
    return { events: [], diagnostics };
  }

  let entries: readonly unknown[] = raw;
  if (raw.length > MAX_ANIMATION_EVENTS) {
    diagnostics.push({
      code: "animation.events.tooMany",
      severity: "error",
      message: `${raw.length} animation events exceed the limit of ${MAX_ANIMATION_EVENTS}; extra entries were ignored.`,
      remediation: `Define at most ${MAX_ANIMATION_EVENTS} events.`,
    });
    entries = raw.slice(0, MAX_ANIMATION_EVENTS);
  }

  const accepted: Array<{ event: ClipAnimationEvent; order: number }> = [];
  const seen = new Set<string>();

  entries.forEach((entry, index) => {
    const fail = (code: string, message: string, remediation: string): void => {
      diagnostics.push({ code: `animation.events.${code}`, severity: "error", message, remediation, index });
    };

    if (!isPlainObject(entry)) {
      fail("invalidEvent", `Event ${index} is not an object.`, "Use {clip, time, name, payload?}.");
      return;
    }

    const { clip, time, name, payload } = entry;
    if (typeof clip !== "string" || clip.length === 0) {
      fail("invalidClip", `Event ${index} needs a non-empty string "clip".`, "Set clip to a clip name.");
      return;
    }
    const duration = durationOf(clipDurations, clip);
    if (clipDurations !== undefined && duration === undefined) {
      fail("unknownClip", `Event ${index} targets unknown clip "${clip}".`, "Use a clip name that exists on the model.");
      return;
    }
    if (typeof time !== "number" || !Number.isFinite(time) || time < 0) {
      fail("invalidTime", `Event ${index} needs a finite "time" >= 0 in seconds.`, "Set time to seconds from the clip start.");
      return;
    }
    if (duration !== undefined && Number.isFinite(duration) && time > duration) {
      fail(
        "timeOutOfRange",
        `Event ${index} time ${time} is past the end of clip "${clip}" (${duration}s).`,
        `Use a time between 0 and ${duration}.`,
      );
      return;
    }
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > MAX_ANIMATION_EVENT_NAME_LENGTH ||
      hasControlCharacter(name)
    ) {
      fail(
        "invalidName",
        `Event ${index} needs a "name" of 1-${MAX_ANIMATION_EVENT_NAME_LENGTH} printable characters.`,
        "Use a short identifier such as \"footstep\".",
      );
      return;
    }

    let normalizedPayload: AnimationEventPayload = {};
    if (payload !== undefined) {
      if (!isPlainObject(payload)) {
        fail("invalidPayload", `Event ${index} payload must be a plain object.`, "Use a JSON object or omit payload.");
        return;
      }
      const cloned = cloneJson(payload, 0);
      if (!cloned.ok) {
        fail("invalidPayload", `Event ${index} payload is not plain JSON: ${cloned.reason}.`, "Use only finite numbers, strings, booleans, null, arrays and objects.");
        return;
      }
      if (JSON.stringify(cloned.value).length > MAX_ANIMATION_EVENT_PAYLOAD_JSON_LENGTH) {
        fail(
          "payloadTooLarge",
          `Event ${index} payload is larger than ${MAX_ANIMATION_EVENT_PAYLOAD_JSON_LENGTH} characters of JSON.`,
          "Move bulky data into an asset and reference it by id.",
        );
        return;
      }
      normalizedPayload = cloned.value as AnimationEventPayload;
    }

    const key = `${clip}\u0000${name}\u0000${time}`;
    if (seen.has(key)) {
      diagnostics.push({
        code: "animation.events.duplicate",
        severity: "warning",
        message: `Event ${index} repeats "${name}" at ${time}s on clip "${clip}"; it will fire twice.`,
        remediation: "Remove the duplicate if a single firing is intended.",
        index,
      });
    }
    seen.add(key);
    accepted.push({ event: { clip, time, name, payload: normalizedPayload }, order: index });
  });

  accepted.sort(
    (a, b) =>
      compareCodePoints(a.event.clip, b.event.clip) || a.event.time - b.event.time || a.order - b.order,
  );
  return { events: accepted.map((item) => item.event), diagnostics };
}

/** Parses JSON text with {@link normalizeAnimationEvents}; malformed JSON becomes a diagnostic. */
export function parseAnimationEventsText(
  text: string,
  clipDurations?: AnimationEventClipDurations,
): AnimationEventNormalization {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      events: [],
      diagnostics: [
        {
          code: "animation.events.invalidJson",
          severity: "error",
          message: `Animation events are not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
          remediation: "Fix the JSON syntax.",
        },
      ],
    };
  }
  return normalizeAnimationEvents(parsed, clipDurations);
}

export interface AnimationEventFire {
  clip: string;
  name: string;
  /** Event time inside the clip, in seconds. */
  time: number;
  /** Fresh copy of the authored payload; safe for the receiver to mutate. */
  payload: AnimationEventPayload;
  /** Loop iteration the crossing happened in (0 for the first pass; negative when reversing). */
  loop: number;
  /** Unwrapped playback position at which the event fired (`loop * duration + time`). */
  position: number;
}

export interface ClipEventTrackerOptions {
  clip: string;
  /** Clip length in seconds; must be finite and positive. */
  duration: number;
  /** Events of any clips; only those whose `clip` matches are tracked. */
  events: readonly ClipAnimationEvent[];
  loop: boolean;
  /** Initial playback time in seconds (default 0); clamped into [0, duration]. */
  startTime?: number | undefined;
  maxFiresPerAdvance?: number | undefined;
}

export interface ClipEventAdvanceResult {
  fired: AnimationEventFire[];
  /** True when the per-call cap cut the list short. The head still moved the full distance. */
  truncated: boolean;
  /** Playback time inside the clip after the move, in [0, duration]. */
  time: number;
  /** Unwrapped playback position after the move. */
  position: number;
  /** A non-looping clip reached the end it was moving toward. */
  finished: boolean;
}

export class ClipEventTracker {
  readonly clip: string;
  readonly duration: number;
  readonly loop: boolean;
  readonly #events: readonly ClipAnimationEvent[];
  readonly #cap: number;
  #position: number;
  #started = false;

  constructor(options: ClipEventTrackerOptions, events: readonly ClipAnimationEvent[]) {
    this.clip = options.clip;
    this.duration = options.duration;
    this.loop = options.loop;
    this.#events = events;
    this.#cap = options.maxFiresPerAdvance ?? DEFAULT_MAX_FIRES_PER_ADVANCE;
    const start = options.startTime ?? 0;
    this.#position = Math.min(this.duration, Math.max(0, Number.isFinite(start) ? start : 0));
  }

  get position(): number {
    return this.#position;
  }

  get time(): number {
    return this.#wrap(this.#position);
  }

  /** Moves the head without firing anything (a seek). The next advance does not include the start point. */
  seek(time: number): void {
    if (!Number.isFinite(time)) return;
    this.#position = this.loop ? time : Math.min(this.duration, Math.max(0, time));
    this.#started = true;
  }

  /** Moves the head back to `startTime` and re-arms the start-point inclusion. */
  reset(startTime = 0): void {
    const start = Number.isFinite(startTime) ? startTime : 0;
    this.#position = Math.min(this.duration, Math.max(0, start));
    this.#started = false;
  }

  /**
   * Advances the head by `deltaSeconds` (negative to play in reverse) and returns the events it
   * crossed in playback order. A non-finite or zero delta moves nothing and fires nothing.
   */
  advance(deltaSeconds: number): ClipEventAdvanceResult {
    const from = this.#position;
    if (!Number.isFinite(deltaSeconds) || deltaSeconds === 0) {
      return this.#result([], false, undefined);
    }
    let to = from + deltaSeconds;
    if (!Number.isFinite(to)) to = from;
    if (!this.loop) to = Math.min(this.duration, Math.max(0, to));
    const includeStart = !this.#started;
    this.#started = true;
    this.#position = to;

    if (this.#events.length === 0) return this.#result([], false, deltaSeconds > 0);

    const fired: AnimationEventFire[] = [];
    let truncated = false;
    const forward = deltaSeconds > 0;
    const D = this.duration;
    // Budget for loop iterations so absurd deltas cannot spin the CPU.
    let budget = this.#cap + 4;

    // The start point belongs to the loop iteration the head is standing in, never to the
    // neighbouring iteration whose end (or start) coincides with it.
    const atStart = (k: number): boolean => !this.loop || k === Math.floor(from / D);

    const emit = (event: ClipAnimationEvent, k: number, value: number): boolean => {
      if (fired.length >= this.#cap) {
        truncated = true;
        return false;
      }
      fired.push({
        clip: event.clip,
        name: event.name,
        time: event.time,
        payload: clonePayload(event.payload),
        loop: k,
        position: value,
      });
      return true;
    };

    if (forward) {
      const kFirst = this.loop ? Math.floor(from / D) - 1 : 0;
      const kLast = this.loop ? Math.floor(to / D) : 0;
      outer: for (let k = kFirst; k <= kLast; k += 1) {
        if (budget-- <= 0) {
          truncated = true;
          break;
        }
        for (const event of this.#events) {
          const value = k * D + event.time;
          const after = value > from || (includeStart && value === from && atStart(k));
          if (after && value <= to && !emit(event, k, value)) break outer;
        }
      }
    } else {
      const kFirst = this.loop ? Math.floor(from / D) : 0;
      const kLast = this.loop ? Math.floor(to / D) - 1 : 0;
      outer: for (let k = kFirst; k >= kLast; k -= 1) {
        if (budget-- <= 0) {
          truncated = true;
          break;
        }
        for (let i = this.#events.length - 1; i >= 0; i -= 1) {
          const event = this.#events[i] as ClipAnimationEvent;
          const value = k * D + event.time;
          const before = value < from || (includeStart && value === from && atStart(k));
          if (before && value >= to && !emit(event, k, value)) break outer;
        }
      }
    }
    return this.#result(fired, truncated, forward);
  }

  #wrap(position: number): number {
    if (!this.loop) return Math.min(this.duration, Math.max(0, position));
    const wrapped = ((position % this.duration) + this.duration) % this.duration;
    return wrapped;
  }

  /**
   * `forward` is the direction of the move; `undefined` (zero or non-finite delta) keeps the
   * head where it is and is judged against the end of the clip.
   */
  #result(fired: AnimationEventFire[], truncated: boolean, forward: boolean | undefined): ClipEventAdvanceResult {
    const position = this.#position;
    return {
      fired,
      truncated,
      time: this.#wrap(position),
      position,
      finished: !this.loop && (forward === false ? position <= 0 : position >= this.duration),
    };
  }
}

/**
 * Builds a tracker for one clip. Never throws: an unusable duration yields an inert tracker
 * (no events fire) plus an `error` diagnostic.
 */
export function createClipEventTracker(options: ClipEventTrackerOptions): {
  tracker: ClipEventTracker;
  diagnostics: AnimationEventDiagnostic[];
} {
  const diagnostics: AnimationEventDiagnostic[] = [];
  let usable = true;
  if (!Number.isFinite(options.duration) || options.duration <= 0) {
    diagnostics.push({
      code: "animation.events.invalidDuration",
      severity: "error",
      message: `Clip "${options.clip}" has duration ${String(options.duration)}; its events cannot fire.`,
      remediation: "Use a clip with a finite, positive duration.",
    });
    usable = false;
  }
  if (
    options.maxFiresPerAdvance !== undefined &&
    (!Number.isInteger(options.maxFiresPerAdvance) || options.maxFiresPerAdvance < 1)
  ) {
    diagnostics.push({
      code: "animation.events.invalidCap",
      severity: "warning",
      message: "maxFiresPerAdvance must be a positive integer; the default was used.",
      remediation: `Pass an integer >= 1 or omit it (default ${DEFAULT_MAX_FIRES_PER_ADVANCE}).`,
    });
  }
  const own = usable
    ? options.events
        .filter(
          (event) =>
            event.clip === options.clip &&
            Number.isFinite(event.time) &&
            event.time >= 0 &&
            event.time <= options.duration,
        )
        .sort((a, b) => a.time - b.time)
    : [];
  const safe: ClipEventTrackerOptions = {
    ...options,
    duration: usable ? options.duration : 1,
    maxFiresPerAdvance:
      options.maxFiresPerAdvance !== undefined &&
      Number.isInteger(options.maxFiresPerAdvance) &&
      options.maxFiresPerAdvance >= 1
        ? options.maxFiresPerAdvance
        : DEFAULT_MAX_FIRES_PER_ADVANCE,
  };
  return { tracker: new ClipEventTracker(safe, own), diagnostics };
}
