import {
  evaluateBlendSpace,
  validateBlendSpace,
  type BlendSpaceDefinition,
  type BlendSpaceDiagnostic,
  type BlendSpaceWeight,
} from "@kinetra/animation/blend-space.js";
import * as THREE from "three";

/**
 * Runtime adapter that plays a `@kinetra/animation` blend space on a
 * `THREE.AnimationMixer`.
 *
 * Ownership: the blend-space definition and its input values are the source of
 * truth; `AnimationAction` weights and time scales are a projection of them and
 * are recomputed from that data on every input change and every step.
 *
 * Phase sync: every sample clip advances through the same normalized phase.
 * The shared cycle length is the weight-averaged clip duration, and each
 * action's time scale is `speed * clipDuration / cycleDuration`. Before every
 * mixer update the action times are re-anchored to `phase * clipDuration`, so
 * clips with different lengths (walk 1.0 s, run 0.6 s) keep their footfalls
 * aligned and floating-point drift cannot accumulate.
 */

export interface BlendSpaceClipBinding {
  /** Clip id as written in the blend-space definition. */
  clipId: string;
  /** Clip actually played (may be the `${clipId}_retargeted` variant). */
  resolvedClipName: string;
  clip: THREE.AnimationClip;
}

export interface BlendSpacePlaybackOptions {
  /** Playback speed multiplier for the whole blend space. Default 1. */
  speed?: number | undefined;
  /** Initial axis values. Axes not listed start at 0. */
  input?: Readonly<Record<string, number>> | undefined;
}

export interface BlendSpaceWeightState {
  clip: string;
  weight: number;
}

export interface BlendSpacePlaybackState {
  id: string;
  kind: BlendSpaceDefinition["kind"];
  parameters: string[];
  input: Record<string, number>;
  weights: BlendSpaceWeightState[];
  /** Normalized cycle phase in [0, 1). */
  phase: number;
  /** Weight-averaged cycle length in seconds (before speed). */
  cycleDuration: number;
  speed: number;
  /**
   * Weight of the whole blend space in [0, 1]. 1 unless a graph transition is
   * crossfading it in or out; each action's effective weight is
   * `weights[i].weight * groupWeight`.
   */
  groupWeight: number;
  /** Heaviest clip (resolved name). */
  dominantClip: string;
}

export type BlendSpaceStartResult =
  | { success: true; playback: BlendSpacePlayback }
  | { success: false; code: string; error: string; diagnostics?: BlendSpaceDiagnostic[] };

export type BlendSpaceInputResult =
  | { success: true; state: BlendSpacePlaybackState }
  | { success: false; code: string; error: string };

export function blendSpaceParameters(space: BlendSpaceDefinition): string[] {
  return space.kind === "1d" ? [space.parameter] : [space.parameters[0], space.parameters[1]];
}

function wrapPhase(value: number): number {
  const wrapped = value - Math.floor(value);
  // Guard against 1 - epsilon rounding up to exactly 1.
  return wrapped >= 1 ? 0 : wrapped;
}

/**
 * Resolve every sample clip of `space` against the clips available on an
 * entity. A sample may name either the clip or its retargeted variant, mirroring
 * `ThreeSceneRuntime.crossfadeAnimation` resolution.
 */
export function resolveBlendSpaceClips(
  space: BlendSpaceDefinition,
  clips: readonly THREE.AnimationClip[],
):
  | { success: true; bindings: BlendSpaceClipBinding[] }
  | { success: false; code: string; error: string } {
  const bindings: BlendSpaceClipBinding[] = [];
  const missing: string[] = [];
  const degenerate: string[] = [];
  for (const sample of space.samples) {
    let clip = clips.find((c) => c.name === sample.clipId);
    if (!clip && !sample.clipId.endsWith("_retargeted")) {
      clip = clips.find((c) => c.name === `${sample.clipId}_retargeted`);
    }
    if (!clip) {
      missing.push(sample.clipId);
      continue;
    }
    if (!(clip.duration > 0) || !Number.isFinite(clip.duration)) {
      degenerate.push(clip.name);
      continue;
    }
    bindings.push({ clipId: sample.clipId, resolvedClipName: clip.name, clip });
  }
  if (missing.length > 0) {
    return {
      success: false,
      code: "anim.blendSpace.clip.unknown",
      error: `Blend space "${space.id}" references unknown clip(s): ${missing.map((m) => `"${m}"`).join(", ")}`,
    };
  }
  if (degenerate.length > 0) {
    return {
      success: false,
      code: "anim.blendSpace.clip.zeroDuration",
      error: `Blend space "${space.id}" cannot phase-sync zero-length clip(s): ${degenerate.map((m) => `"${m}"`).join(", ")}`,
    };
  }
  // Two samples may name distinct clip ids that resolve to the same clip
  // ("walk" falling back to "walk_retargeted" next to a "walk_retargeted"
  // sample). They would share one mixer action, so one sample's weight would
  // silently overwrite the other's. Reject instead of mis-posing.
  const owners = new Map<string, string[]>();
  for (const binding of bindings) {
    const list = owners.get(binding.resolvedClipName) ?? [];
    list.push(binding.clipId);
    owners.set(binding.resolvedClipName, list);
  }
  const shared = [...owners.entries()].filter(([, ids]) => ids.length > 1);
  if (shared.length > 0) {
    return {
      success: false,
      code: "anim.blendSpace.clip.duplicate",
      error: `Blend space "${space.id}" plays the same clip from several samples: ${shared
        .map(([clip, ids]) => `"${clip}" (samples ${ids.map((id) => `"${id}"`).join(", ")})`)
        .join("; ")}`,
    };
  }
  return { success: true, bindings };
}

export class BlendSpacePlayback {
  readonly definition: BlendSpaceDefinition;
  readonly #mixer: THREE.AnimationMixer;
  readonly #bindings: BlendSpaceClipBinding[];
  readonly #actions = new Map<string, THREE.AnimationAction>();
  readonly #input: Record<string, number> = {};
  readonly #parameters: string[];
  #weights: BlendSpaceWeight[] = [];
  #phase = 0;
  #groupWeight = 1;
  #speed: number;
  #stopped = false;

  private constructor(
    definition: BlendSpaceDefinition,
    mixer: THREE.AnimationMixer,
    bindings: BlendSpaceClipBinding[],
    speed: number,
  ) {
    this.definition = definition;
    this.#mixer = mixer;
    this.#bindings = bindings;
    this.#speed = speed;
    this.#parameters = blendSpaceParameters(definition);
    for (const name of this.#parameters) this.#input[name] = 0;
  }

  /**
   * Validate the definition, clips, speed and initial input, and compute the
   * initial weights. The mixer is not touched: call `begin()` to start the
   * actions. Splitting the two lets the runtime stop whatever was playing only
   * once the new blend space is known to be valid.
   */
  static create(
    definition: BlendSpaceDefinition,
    mixer: THREE.AnimationMixer,
    clips: readonly THREE.AnimationClip[],
    options: BlendSpacePlaybackOptions = {},
  ): BlendSpaceStartResult {
    const diagnostics = validateBlendSpace(definition);
    if (diagnostics.length > 0) {
      return {
        success: false,
        code: diagnostics[0]!.code,
        error: `Invalid blend space: ${diagnostics.map((d) => d.message).join("; ")}`,
        diagnostics,
      };
    }
    const speed = options.speed ?? 1;
    if (typeof speed !== "number" || !Number.isFinite(speed)) {
      return { success: false, code: "anim.blendSpace.speed.invalid", error: "Blend space speed must be a finite number" };
    }
    const resolved = resolveBlendSpaceClips(definition, clips);
    if (!resolved.success) return resolved;

    const playback = new BlendSpacePlayback(definition, mixer, resolved.bindings, speed);
    if (options.input) {
      const inputError = playback.#checkInput(options.input);
      if (inputError) return { success: false, ...inputError };
      Object.assign(playback.#input, options.input);
    }
    playback.#weights = evaluateBlendSpace(definition, playback.#input);
    return { success: true, playback };
  }

  /** Start every sample action at phase 0 with the current weights. Idempotent. */
  begin(): void {
    if (this.#stopped || this.#actions.size > 0) return;
    for (const binding of this.#bindings) {
      const action = this.#mixer.clipAction(binding.clip);
      action.reset();
      action.loop = THREE.LoopRepeat;
      action.clampWhenFinished = false;
      action.enabled = true;
      action.play();
      this.#actions.set(binding.resolvedClipName, action);
    }
    this.#applyWeights();
  }

  get started(): boolean {
    return this.#actions.size > 0;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  get speed(): number {
    return this.#speed;
  }

  get groupWeight(): number {
    return this.#groupWeight;
  }

  /**
   * Scale every sample action by `weight` (clamped to [0, 1]); used to
   * crossfade the whole blend space with a clip or another blend space.
   * Returns false for a non-finite weight or a stopped blend space.
   */
  setGroupWeight(weight: number): boolean {
    if (this.#stopped || typeof weight !== "number" || !Number.isFinite(weight)) return false;
    this.#groupWeight = Math.min(1, Math.max(0, weight));
    this.#applyWeights();
    return true;
  }

  /** Resolved clip names in sample order. */
  get clipNames(): string[] {
    return this.#bindings.map((b) => b.resolvedClipName);
  }

  getAction(resolvedClipName: string): THREE.AnimationAction | undefined {
    return this.#actions.get(resolvedClipName);
  }

  #checkInput(values: Readonly<Record<string, number>>): { code: string; error: string } | undefined {
    if (typeof values !== "object" || values === null) {
      return { code: "anim.blendSpace.input.invalid", error: "Blend space input must be an object of axis values" };
    }
    for (const [name, value] of Object.entries(values)) {
      if (!this.#parameters.includes(name)) {
        return {
          code: "anim.blendSpace.input.unknownParameter",
          error: `Blend space "${this.definition.id}" has no parameter "${name}" (expected ${this.#parameters.map((p) => `"${p}"`).join(", ")})`,
        };
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return {
          code: "anim.blendSpace.input.invalid",
          error: `Blend space "${this.definition.id}" parameter "${name}" must be a finite number`,
        };
      }
    }
    return undefined;
  }

  /**
   * Update one or more axes. Atomic: an invalid value leaves the previous
   * input and weights untouched.
   */
  setInput(values: Readonly<Record<string, number>>): BlendSpaceInputResult {
    if (this.#stopped) {
      return { success: false, code: "anim.blendSpace.stopped", error: `Blend space "${this.definition.id}" is not playing` };
    }
    const inputError = this.#checkInput(values);
    if (inputError) return { success: false, ...inputError };
    Object.assign(this.#input, values);
    this.#weights = evaluateBlendSpace(this.definition, this.#input);
    this.#applyWeights();
    return { success: true, state: this.state() };
  }

  setSpeed(speed: number): boolean {
    if (this.#stopped || typeof speed !== "number" || !Number.isFinite(speed)) return false;
    this.#speed = speed;
    this.#applyWeights();
    return true;
  }

  /** Weight-averaged cycle length of the clips that currently contribute. */
  cycleDuration(): number {
    let duration = 0;
    for (const weight of this.#weights) {
      const binding = this.#bindingFor(weight.clipId);
      if (binding) duration += weight.weight * binding.clip.duration;
    }
    return duration > 0 ? duration : this.#bindings[0]!.clip.duration;
  }

  #bindingFor(clipId: string): BlendSpaceClipBinding | undefined {
    return this.#bindings.find((b) => b.clipId === clipId);
  }

  #weightOf(binding: BlendSpaceClipBinding): number {
    return this.#weights.find((w) => w.clipId === binding.clipId)?.weight ?? 0;
  }

  #applyWeights(): void {
    const cycle = this.cycleDuration();
    for (const binding of this.#bindings) {
      const action = this.#actions.get(binding.resolvedClipName);
      if (!action) continue;
      action.setEffectiveWeight(this.#weightOf(binding) * this.#groupWeight);
      action.setEffectiveTimeScale((this.#speed * binding.clip.duration) / cycle);
    }
  }

  /**
   * Re-anchor every action to the shared phase, then advance the phase by
   * `deltaSeconds`. The caller runs `mixer.update(deltaSeconds)` afterwards,
   * which moves each action by exactly the same normalized amount.
   */
  prepareStep(deltaSeconds: number): void {
    if (this.#stopped) return;
    for (const binding of this.#bindings) {
      const action = this.#actions.get(binding.resolvedClipName);
      if (action) action.time = this.#phase * binding.clip.duration;
    }
    this.#phase = wrapPhase(this.#phase + (deltaSeconds * this.#speed) / this.cycleDuration());
  }

  state(): BlendSpacePlaybackState {
    const weights = this.#weights.map((w) => ({
      clip: this.#bindingFor(w.clipId)?.resolvedClipName ?? w.clipId,
      weight: w.weight,
    }));
    return {
      id: this.definition.id,
      kind: this.definition.kind,
      parameters: [...this.#parameters],
      input: { ...this.#input },
      weights,
      phase: this.#phase,
      cycleDuration: this.cycleDuration(),
      speed: this.#speed,
      groupWeight: this.#groupWeight,
      dominantClip: weights[0]?.clip ?? this.#bindings[0]!.resolvedClipName,
    };
  }

  /** Stop and zero every sample action. Idempotent. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const action of this.#actions.values()) {
      action.stop();
      action.setEffectiveWeight(0);
    }
    this.#actions.clear();
  }
}
