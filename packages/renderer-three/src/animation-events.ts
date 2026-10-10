/**
 * Runtime wiring for animation events (#90).
 *
 * The pure contract (`@kinetra/animation/events.js`) defines which events a playback head crosses.
 * This module feeds that contract from real `THREE.AnimationAction`s: one `ClipEventTracker` per
 * action, advanced by the same amount the mixer moved the action in the step.
 *
 * Three.js is never the source of truth for the event *definitions* (they are plain data handed
 * to `setEvents`); it only supplies the playback clock.
 *
 * Known limits (documented in docs/architecture/animation.md):
 * - Only clip actions (active and outgoing) fire events. Blend-space sample actions are driven by
 *   a normalized phase, not by clip time, and do not fire events yet.
 * - Ping-pong loops are not supported by the tracker contract; such actions fire nothing and
 *   produce one diagnostic.
 * - Events fire regardless of the action weight (a fading-out clip still reports its events).
 * - A discontinuity (restart, manual `action.time` change, start delay) re-synchronizes the
 *   tracker without firing the skipped range.
 */
import {
  createClipEventTracker,
  normalizeAnimationEvents,
  type AnimationEventDiagnostic,
  type AnimationEventFire,
  type AnimationEventNormalization,
  type ClipAnimationEvent,
  type ClipEventTracker,
} from "@kinetra/animation/events.js";
import * as THREE from "three";

/** An animation event as the runtime reports it: the contract's fire plus the entity it came from. */
export interface RuntimeAnimationEvent extends AnimationEventFire {
  entityId: string;
  /** Monotonic number assigned in firing order (survives log eviction, starts at 1). */
  sequence: number;
}

export type AnimationEventListener = (event: RuntimeAnimationEvent) => void;

export interface AnimationEventStats {
  /** Events delivered since creation (or the last `clearLog`). */
  fired: number;
  /** Steps where a tracker hit its per-advance cap and dropped events. */
  truncatedSteps: number;
  /** Listener exceptions that were caught and isolated. */
  listenerErrors: number;
  /** Events evicted from the bounded log. */
  evicted: number;
}

export const MAX_ANIMATION_EVENT_LOG = 256;
export const MAX_ANIMATION_EVENT_RUNTIME_DIAGNOSTICS = 64;

/** Comparison slack for clip times, in seconds (float accumulation across mixer steps). */
const TIME_EPSILON = 1e-6;

export interface AnimationEventTarget {
  clip: string;
  action: THREE.AnimationAction | undefined;
}

interface TrackerEntry {
  tracker: ClipEventTracker;
  loop: boolean;
  duration: number;
}

export interface AnimationEventProbe {
  entityId: string;
  items: Array<{ clip: string; action: THREE.AnimationAction; entry: TrackerEntry; before: number }>;
}

function circularDistance(a: number, b: number, period: number): number {
  const diff = (((a - b) % period) + period) % period;
  return Math.min(diff, period - diff);
}

export class AnimationEventDispatcher {
  #byClip = new Map<string, ClipAnimationEvent[]>();
  #entries = new Map<string, WeakMap<THREE.AnimationAction, TrackerEntry>>();
  #listeners = new Set<AnimationEventListener>();
  #log: RuntimeAnimationEvent[] = [];
  #pending: RuntimeAnimationEvent[] = [];
  #flushing = false;
  #diagnostics: AnimationEventDiagnostic[] = [];
  #diagnosticKeys = new Set<string>();
  #sequence = 0;
  #stats: AnimationEventStats = { fired: 0, truncatedSteps: 0, listenerErrors: 0, evicted: 0 };

  /**
   * Replaces the event set. Input is validated (never throws); invalid entries are dropped with
   * diagnostics. All trackers are rebuilt on the next step. Unknown clip names are accepted: a
   * clip may be registered later, and an event for a clip nobody plays simply never fires.
   */
  setEvents(raw: unknown): AnimationEventNormalization {
    const result = normalizeAnimationEvents(raw);
    this.#byClip = new Map();
    for (const event of result.events) {
      const list = this.#byClip.get(event.clip);
      if (list) list.push(event);
      else this.#byClip.set(event.clip, [event]);
    }
    this.#entries = new Map();
    this.#diagnostics = [];
    this.#diagnosticKeys = new Set();
    return result;
  }

  get eventCount(): number {
    let count = 0;
    for (const list of this.#byClip.values()) count += list.length;
    return count;
  }

  onEvent(listener: AnimationEventListener): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("onAnimationEvent expects a function listener");
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  getLog(): readonly RuntimeAnimationEvent[] {
    return this.#log;
  }

  clearLog(): void {
    this.#log = [];
    this.#stats = { fired: 0, truncatedSteps: 0, listenerErrors: 0, evicted: 0 };
  }

  getStats(): AnimationEventStats {
    return { ...this.#stats };
  }

  /** Runtime diagnostics (unusable clip duration, unsupported loop mode), bounded and de-duplicated. */
  getDiagnostics(): readonly AnimationEventDiagnostic[] {
    return this.#diagnostics;
  }

  /** Drops tracker state for an entity (model detached or reloaded). */
  forget(entityId: string): void {
    this.#entries.delete(entityId);
  }

  dispose(): void {
    this.#listeners.clear();
    this.#entries.clear();
    this.#byClip.clear();
    this.#pending = [];
    this.#log = [];
  }

  /**
   * Call right before `mixer.update`. Returns undefined when nothing about this step can fire
   * (no events, or no target clip has events), so the common case costs one map lookup.
   */
  begin(entityId: string, targets: readonly AnimationEventTarget[]): AnimationEventProbe | undefined {
    if (this.#byClip.size === 0) return undefined;
    let probe: AnimationEventProbe | undefined;
    for (const target of targets) {
      const action = target.action;
      if (!action || !this.#byClip.has(target.clip)) continue;
      if (probe?.items.some((item) => item.action === action)) continue;
      const entry = this.#entryFor(entityId, target.clip, action);
      if (!entry) continue;
      probe ??= { entityId, items: [] };
      probe.items.push({ clip: target.clip, action, entry, before: action.time });
    }
    return probe;
  }

  /** Call right after `mixer.update` with the same delta; queues fired events for `flush`. */
  end(probe: AnimationEventProbe | undefined, deltaSeconds: number, mixerTimeScale: number): void {
    if (!probe) return;
    const mixerScale = Number.isFinite(mixerTimeScale) ? mixerTimeScale : 1;
    for (const { action, entry, before } of probe.items) {
      const { tracker, loop, duration } = entry;
      this.#syncTracker(entry, before);
      const after = action.time;
      if (!Number.isFinite(after)) continue;

      let delta: number;
      if (loop) {
        const expected = deltaSeconds * mixerScale * action.getEffectiveTimeScale();
        const observed = after - before;
        if (
          Number.isFinite(expected) &&
          circularDistance(observed, expected, duration) <= Math.max(TIME_EPSILON, Math.abs(expected) * 1e-9)
        ) {
          delta = expected;
        } else {
          // The mixer did not move this action the way its time scale says (start delay, manual
          // time change): follow the real clock and do not report the range we cannot see.
          tracker.seek(after);
          continue;
        }
      } else {
        // Non-looping playback clamps at the ends, so the observed move is the truth.
        delta = after - before;
      }
      if (delta === 0) continue;

      const result = tracker.advance(delta);
      if (result.truncated) this.#stats.truncatedSteps += 1;
      for (const fire of result.fired) {
        this.#pending.push({ ...fire, entityId: probe.entityId, sequence: (this.#sequence += 1) });
      }
      if (!loop) tracker.seek(after);
    }
  }

  /**
   * Delivers queued events to the log and listeners. Listener exceptions are caught so a bad
   * handler can never stall the animation loop. Reentrant-safe: a listener that triggers another
   * step queues that step's events, and the delivery already in progress hands them out after the
   * current batch, so listeners and the log always see strictly increasing sequence numbers.
   */
  flush(): void {
    // A listener may step the animation again, which calls flush from inside this one. Delivering
    // the nested step's events right there would overtake the rest of the batch in progress
    // (log and listeners would see sequence 1, 3, 4, 2). The outer call owns delivery and drains
    // what the nested step queued once the batch in progress is done, so order stays the firing order.
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      while (this.#pending.length > 0) {
        const batch = this.#pending;
        this.#pending = [];
        for (const event of batch) {
          this.#log.push(event);
          this.#stats.fired += 1;
          if (this.#log.length > MAX_ANIMATION_EVENT_LOG) {
            this.#log.shift();
            this.#stats.evicted += 1;
          }
          for (const listener of Array.from(this.#listeners)) {
            try {
              listener({ ...event, payload: structuredClone(event.payload) });
            } catch {
              this.#stats.listenerErrors += 1;
            }
          }
        }
      }
    } finally {
      this.#flushing = false;
    }
  }

  #entryFor(entityId: string, clip: string, action: THREE.AnimationAction): TrackerEntry | undefined {
    let perEntity = this.#entries.get(entityId);
    if (!perEntity) {
      perEntity = new WeakMap();
      this.#entries.set(entityId, perEntity);
    }
    const loopMode = action.loop;
    const loop = loopMode === THREE.LoopRepeat;
    const duration = action.getClip().duration;
    const existing = perEntity.get(action);
    if (existing && existing.loop === loop && existing.duration === duration) return existing;

    if (loopMode === THREE.LoopPingPong) {
      this.#diagnose({
        code: "animation.events.pingPongUnsupported",
        severity: "warning",
        message: `Clip "${clip}" uses a ping-pong loop; its animation events will not fire.`,
        remediation: "Play the clip with LoopRepeat or LoopOnce to receive its events.",
      });
      return undefined;
    }

    const created = createClipEventTracker({
      clip,
      duration,
      events: this.#byClip.get(clip) ?? [],
      loop,
      startTime: action.time,
    });
    for (const diagnostic of created.diagnostics) this.#diagnose(diagnostic);
    // A tracker standing mid-clip must not report an event exactly at its current time.
    if (action.time > TIME_EPSILON && duration - action.time > TIME_EPSILON) {
      created.tracker.seek(action.time);
    }
    const entry: TrackerEntry = { tracker: created.tracker, loop, duration };
    perEntity.set(action, entry);
    return entry;
  }

  /**
   * Brings the tracker to the action's pre-step time. A match keeps the tracker's own state (so
   * loop counts continue); a mismatch means a restart or jump: re-arm the start point when the
   * clip is at an end, otherwise seek silently.
   */
  #syncTracker(entry: TrackerEntry, before: number): void {
    if (!Number.isFinite(before)) return;
    const { tracker, loop, duration } = entry;
    const matches = loop
      ? circularDistance(tracker.time, before, duration) <= TIME_EPSILON
      : Math.abs(tracker.position - before) <= TIME_EPSILON;
    if (matches) return;
    if (before <= TIME_EPSILON) tracker.reset(0);
    else if (duration - before <= TIME_EPSILON) tracker.reset(duration);
    else tracker.seek(before);
  }

  #diagnose(diagnostic: AnimationEventDiagnostic): void {
    const key = `${diagnostic.code}\u0000${diagnostic.message}`;
    if (this.#diagnosticKeys.has(key)) return;
    if (this.#diagnostics.length >= MAX_ANIMATION_EVENT_RUNTIME_DIAGNOSTICS) return;
    this.#diagnosticKeys.add(key);
    this.#diagnostics.push(diagnostic);
  }
}
