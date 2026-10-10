import * as THREE from "three";

export type RootMotionMode = "none" | "extract-xz" | "extract-xyz" | "extract-xz-yaw";

export interface RootMotionSample {
  time: number;
  position: [number, number, number];
  yaw: number;
}

export interface RootMotionDelta {
  time: number;
  translation: [number, number, number];
  yaw: number;
}

export interface RootMotionFrameDelta {
  translation: [number, number, number];
  yaw: number;
}

export interface RootMotionResult {
  mode: RootMotionMode;
  deltas: RootMotionDelta[];
  inPlace: RootMotionSample[];
}

export interface RootMotionDiagnostics {
  code: string;
  message: string;
  hint: string;
}

export interface ExtractedClipRootMotion {
  clipName: string;
  duration: number;
  mode: RootMotionMode;
  rootBoneName: string;
  samples: RootMotionSample[];
  inPlaceClip: THREE.AnimationClip;
  totalDisplacement: [number, number, number];
  totalYaw: number;
}

export interface RootMotionInspectionReport {
  clipName: string;
  duration: number;
  sampleCount: number;
  rootBoneName: string;
  firstPosition: [number, number, number];
  lastPosition: [number, number, number];
  netDisplacement: [number, number, number];
  maxDisplacementXZ: number;
  netYaw: number;
  isLocomotion: boolean;
  classification: "in-place" | "locomotion";
  reason: string;
}

const DEFAULT_ROOT_BONE_CANDIDATES = [
  "Hips",
  "hips",
  "root",
  "Root",
  "pelvis",
  "Pelvis",
  "Skeleton_torso_joint_1",
  "Armature|Hips",
  "mixamorig:Hips",
];

export function extractRootMotion(
  samples: RootMotionSample[],
  mode: RootMotionMode,
): RootMotionResult {
  if (samples.length === 0) return { mode, deltas: [], inPlace: [] };

  const deltas: RootMotionDelta[] = [];
  const first = samples[0]!;
  const inPlace = samples.map((sample) => ({
    time: sample.time,
    position: [...sample.position] as [number, number, number],
    yaw: sample.yaw,
  }));

  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1]!;
    const current = samples[i]!;
    const dx = current.position[0] - previous.position[0];
    const dy = current.position[1] - previous.position[1];
    const dz = current.position[2] - previous.position[2];
    const dyaw = current.yaw - previous.yaw;

    deltas.push({
      time: current.time,
      translation:
        mode === "extract-xyz"
          ? [dx, dy, dz]
          : mode === "extract-xz" || mode === "extract-xz-yaw"
            ? [dx, 0, dz]
            : [0, 0, 0],
      yaw: mode === "extract-xz-yaw" ? dyaw : 0,
    });
  }

  if (mode !== "none") {
    for (const sample of inPlace) {
      sample.position[0] -= sample.position[0] - first.position[0];
      sample.position[2] -= sample.position[2] - first.position[2];
      if (mode === "extract-xyz") {
        sample.position[1] -= sample.position[1] - first.position[1];
      }
      if (mode === "extract-xz-yaw") {
        sample.yaw = first.yaw;
      }
    }
  }

  return { mode, deltas, inPlace };
}

/**
 * Deterministically samples position and yaw at any time point along the root samples.
 */
export function sampleRootMotionAt(
  samples: RootMotionSample[],
  time: number,
  loopDuration: number,
): { position: [number, number, number]; yaw: number } {
  if (samples.length === 0) {
    return { position: [0, 0, 0], yaw: 0 };
  }
  // `!(x > 0)` also catches NaN; a non-finite time or duration has no defined
  // position, so fall back to the first sample instead of interpolating NaN.
  if (samples.length === 1 || !(loopDuration > 0) || Number.isNaN(time)) {
    const s = samples[0]!;
    return { position: [...s.position], yaw: s.yaw };
  }

  const clampedTime = Math.max(0, Math.min(loopDuration, time));

  if (clampedTime <= samples[0]!.time) {
    const s = samples[0]!;
    return { position: [...s.position], yaw: s.yaw };
  }
  if (clampedTime >= samples[samples.length - 1]!.time) {
    const s = samples[samples.length - 1]!;
    return { position: [...s.position], yaw: s.yaw };
  }

  // Binary search for interval
  let low = 0;
  let high = samples.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (samples[mid]!.time <= clampedTime) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const idx0 = Math.max(0, high);
  const idx1 = Math.min(samples.length - 1, idx0 + 1);
  const s0 = samples[idx0]!;
  const s1 = samples[idx1]!;

  const span = s1.time - s0.time;
  const alpha = span > 1e-6 ? (clampedTime - s0.time) / span : 0;

  const x = s0.position[0] + (s1.position[0] - s0.position[0]) * alpha;
  const y = s0.position[1] + (s1.position[1] - s0.position[1]) * alpha;
  const z = s0.position[2] + (s1.position[2] - s0.position[2]) * alpha;
  const yaw = s0.yaw + (s1.yaw - s0.yaw) * alpha;

  return { position: [x, y, z], yaw };
}

/**
 * Computes deterministic per-frame root motion delta between two playback times,
 * cleanly handling loop wrap boundaries without velocity/displacement spikes.
 */
export function computeRootMotionStepDelta(
  samples: RootMotionSample[],
  loopDuration: number,
  prevTime: number,
  deltaTime: number,
  mode: RootMotionMode,
  options?: {
    isLooping?: boolean;
    speed?: number;
  },
): RootMotionFrameDelta {
  if (samples.length < 2 || !(loopDuration > 0) || mode === "none") {
    return { translation: [0, 0, 0], yaw: 0 };
  }
  // A non-finite step (NaN/Infinity time, duration or speed) must never leak NaN
  // into an entity transform: treat the frame as "no motion".
  if (!Number.isFinite(loopDuration) || !Number.isFinite(prevTime) || !Number.isFinite(deltaTime)) {
    return { translation: [0, 0, 0], yaw: 0 };
  }

  const speed = typeof options?.speed === "number" ? options.speed : 1.0;
  const dt = deltaTime * speed;
  if (!Number.isFinite(dt) || Math.abs(dt) < 1e-8) {
    return { translation: [0, 0, 0], yaw: 0 };
  }

  const isLooping = options?.isLooping !== false;

  let rawDelta: [number, number, number];
  let rawYaw: number;

  if (!isLooping) {
    const t0 = Math.max(0, Math.min(loopDuration, prevTime));
    const t1 = Math.max(0, Math.min(loopDuration, prevTime + dt));
    const p0 = sampleRootMotionAt(samples, t0, loopDuration);
    const p1 = sampleRootMotionAt(samples, t1, loopDuration);
    rawDelta = [
      p1.position[0] - p0.position[0],
      p1.position[1] - p0.position[1],
      p1.position[2] - p0.position[2],
    ];
    rawYaw = p1.yaw - p0.yaw;
  } else {
    // Looping: express root displacement as a cumulative function of unwrapped
    // playback time, D(T) = wraps(T) * loopDelta + (pos(T mod L) - pos(0)), and
    // return D(prev + dt) - D(prev). This is exact for any number of loop
    // wraps, for reverse playback (negative speed) crossing the loop start, and
    // for negative playback times, and is additive across consecutive steps.
    const startP = sampleRootMotionAt(samples, 0, loopDuration);
    const endP = sampleRootMotionAt(samples, loopDuration, loopDuration);
    const loopDelta: [number, number, number] = [
      endP.position[0] - startP.position[0],
      endP.position[1] - startP.position[1],
      endP.position[2] - startP.position[2],
    ];
    const loopYaw = endP.yaw - startP.yaw;

    const cumulative = (time: number): { position: [number, number, number]; yaw: number } => {
      const wraps = Math.floor(time / loopDuration);
      const local = time - wraps * loopDuration;
      const p = sampleRootMotionAt(samples, local, loopDuration);
      return {
        position: [
          wraps * loopDelta[0] + (p.position[0] - startP.position[0]),
          wraps * loopDelta[1] + (p.position[1] - startP.position[1]),
          wraps * loopDelta[2] + (p.position[2] - startP.position[2]),
        ],
        yaw: wraps * loopYaw + (p.yaw - startP.yaw),
      };
    };

    // Re-base onto the current loop so large accumulated playback times do not
    // cost precision; the delta is invariant to whole-loop shifts.
    const base = Math.floor(prevTime / loopDuration) * loopDuration;
    const t0 = prevTime - base;
    const c0 = cumulative(t0);
    const c1 = cumulative(t0 + dt);
    rawDelta = [
      c1.position[0] - c0.position[0],
      c1.position[1] - c0.position[1],
      c1.position[2] - c0.position[2],
    ];
    rawYaw = c1.yaw - c0.yaw;
  }

  switch (mode) {
    case "extract-xz":
      return { translation: [rawDelta[0], 0, rawDelta[2]], yaw: 0 };
    case "extract-xyz":
      return { translation: [rawDelta[0], rawDelta[1], rawDelta[2]], yaw: 0 };
    case "extract-xz-yaw":
      return { translation: [rawDelta[0], 0, rawDelta[2]], yaw: rawYaw };
    default:
      return { translation: [0, 0, 0], yaw: 0 };
  }
}

/**
 * Finds the candidate root bone name present in an animation clip.
 */
export function findRootBoneName(clip: THREE.AnimationClip, preferredName?: string): string | undefined {
  if (preferredName) {
    const hasPreferred = clip.tracks.some((t) => t.name.startsWith(`${preferredName}.`));
    if (hasPreferred) return preferredName;
  }

  for (const candidate of DEFAULT_ROOT_BONE_CANDIDATES) {
    const found = clip.tracks.some((t) => t.name.startsWith(`${candidate}.`));
    if (found) return candidate;
  }

  // Fallback: search for any track ending in .position
  for (const track of clip.tracks) {
    if (track.name.endsWith(".position")) {
      return track.name.slice(0, -9);
    }
  }

  return undefined;
}

/**
 * Creates an in-place version of the clip where visual skeleton root displacement
 * is stripped according to RootMotionMode, leaving only in-place local motion (e.g. Y bobbing).
 */
export function stripVisualRootDisplacement(
  clip: THREE.AnimationClip,
  rootBoneName: string,
  mode: RootMotionMode,
): THREE.AnimationClip {
  if (mode === "none") {
    return clip.clone();
  }

  const inPlaceTracks: THREE.KeyframeTrack[] = [];
  const posTrackName = `${rootBoneName}.position`;
  const rotTrackName = `${rootBoneName}.quaternion`;

  for (const track of clip.tracks) {
    if (track.name === posTrackName && track instanceof THREE.VectorKeyframeTrack) {
      const times = new Float32Array(track.times);
      const values = new Float32Array(track.values.length);
      const firstX = track.values[0] ?? 0;
      const firstY = track.values[1] ?? 0;
      const firstZ = track.values[2] ?? 0;

      for (let i = 0; i < times.length; i++) {
        const offset = i * 3;
        const curY = track.values[offset + 1] ?? firstY;

        if (mode === "extract-xz" || mode === "extract-xz-yaw") {
          // X and Z are locked in-place; Y (hip bobbing/vertical oscillation) is preserved!
          values[offset + 0] = firstX;
          values[offset + 1] = curY;
          values[offset + 2] = firstZ;
        } else if (mode === "extract-xyz") {
          // Complete in-place locking
          values[offset + 0] = firstX;
          values[offset + 1] = firstY;
          values[offset + 2] = firstZ;
        }
      }
      inPlaceTracks.push(new THREE.VectorKeyframeTrack(posTrackName, times, values));
    } else if (
      mode === "extract-xz-yaw" &&
      track.name === rotTrackName &&
      track instanceof THREE.QuaternionKeyframeTrack
    ) {
      // For extract-xz-yaw: remove yaw twist from visual rotation so local skeleton does not turn
      const times = new Float32Array(track.times);
      const values = new Float32Array(track.values.length);

      const q = new THREE.Quaternion();
      const firstQ = new THREE.Quaternion(
        track.values[0] ?? 0,
        track.values[1] ?? 0,
        track.values[2] ?? 0,
        track.values[3] ?? 1,
      ).normalize();

      // Decompose first rotation into twist around Y
      const firstTwistY = new THREE.Quaternion(0, firstQ.y, 0, firstQ.w).normalize();
      if (firstTwistY.lengthSq() < 1e-6) firstTwistY.set(0, 0, 0, 1);

      for (let i = 0; i < times.length; i++) {
        const offset = i * 4;
        q.set(
          track.values[offset + 0] ?? 0,
          track.values[offset + 1] ?? 0,
          track.values[offset + 2] ?? 0,
          track.values[offset + 3] ?? 1,
        ).normalize();

        // Twist around Y axis
        const twistY = new THREE.Quaternion(0, q.y, 0, q.w).normalize();
        if (twistY.lengthSq() < 1e-6) twistY.set(0, 0, 0, 1);

        // swing = q * twistY^-1
        const twistYInv = twistY.clone().invert();
        const swing = q.clone().multiply(twistYInv).normalize();

        // In-place rotation = swing * firstTwistY
        const inPlaceRot = swing.multiply(firstTwistY).normalize();

        values[offset + 0] = inPlaceRot.x;
        values[offset + 1] = inPlaceRot.y;
        values[offset + 2] = inPlaceRot.z;
        values[offset + 3] = inPlaceRot.w;
      }
      inPlaceTracks.push(new THREE.QuaternionKeyframeTrack(rotTrackName, times, values));
    } else {
      inPlaceTracks.push(track.clone());
    }
  }

  const cloned = new THREE.AnimationClip(
    `${clip.name}_in_place`,
    clip.duration,
    inPlaceTracks,
    clip.blendMode,
  );
  return cloned;
}

/**
 * Yaw (rotation about +Y, Euler YXZ) of a quaternion track at `time`: the two
 * keys around `time` are slerped, and the first/last key are held outside the
 * track's range. Sampling by time (not by key index) keeps the yaw correct when
 * the rotation track has different key times than the position track.
 */
function yawOfTrackAt(track: THREE.QuaternionKeyframeTrack, time: number): number {
  const count = track.times.length;
  if (count === 0) return 0;
  const keyQuat = (index: number, out: THREE.Quaternion): THREE.Quaternion =>
    out
      .set(
        track.values[index * 4 + 0] ?? 0,
        track.values[index * 4 + 1] ?? 0,
        track.values[index * 4 + 2] ?? 0,
        track.values[index * 4 + 3] ?? 1,
      )
      .normalize();

  const q = new THREE.Quaternion();
  if (count === 1 || time <= track.times[0]!) {
    keyQuat(0, q);
  } else if (time >= track.times[count - 1]!) {
    keyQuat(count - 1, q);
  } else {
    let high = 1;
    while (high < count - 1 && track.times[high]! <= time) high++;
    const low = high - 1;
    const span = track.times[high]! - track.times[low]!;
    const alpha = span > 1e-9 ? (time - track.times[low]!) / span : 0;
    const q1 = new THREE.Quaternion();
    keyQuat(low, q);
    keyQuat(high, q1);
    q.slerp(q1, alpha);
  }
  return new THREE.Euler(0, 0, 0, "YXZ").setFromQuaternion(q, "YXZ").y;
}

/**
 * Extracts root motion data from a THREE.AnimationClip with strict validation.
 */
export function extractRootMotionFromClip(
  clip: THREE.AnimationClip,
  options: {
    mode: RootMotionMode;
    rootBoneName?: string;
  },
): {
  success: boolean;
  extracted?: ExtractedClipRootMotion;
  error?: string;
  diagnostics?: RootMotionDiagnostics;
} {
  const mode = options.mode;
  if (mode === "none") {
    const inPlaceClip = clip.clone();
    return {
      success: true,
      extracted: {
        clipName: clip.name,
        duration: clip.duration,
        mode: "none",
        rootBoneName: options.rootBoneName ?? "none",
        samples: [],
        inPlaceClip,
        totalDisplacement: [0, 0, 0],
        totalYaw: 0,
      },
    };
  }

  const rootBoneName = options.rootBoneName ?? findRootBoneName(clip);
  if (!rootBoneName) {
    const diag: RootMotionDiagnostics = {
      code: "animation.rootMotion.invalidRoot",
      message: `No candidate root bone found in clip "${clip.name}"`,
      hint: "Specify an explicit rootBoneName or ensure skeleton contains a standard root joint like 'Hips'",
    };
    return { success: false, error: diag.message, diagnostics: diag };
  }

  const posTrackName = `${rootBoneName}.position`;
  const rotTrackName = `${rootBoneName}.quaternion`;

  const posTrack = clip.tracks.find(
    (t) => t.name === posTrackName && t instanceof THREE.VectorKeyframeTrack,
  ) as THREE.VectorKeyframeTrack | undefined;

  if (!posTrack) {
    const diag: RootMotionDiagnostics = {
      code: "animation.rootMotion.trackMissing",
      message: `Root motion track "${posTrackName}" missing in clip "${clip.name}"`,
      hint: `Ensure the animation clip contains a translation track for designated root bone "${rootBoneName}"`,
    };
    return { success: false, error: diag.message, diagnostics: diag };
  }

  // Validate sample times (monotonicity and finiteness)
  for (let i = 0; i < posTrack.times.length; i++) {
    const t = posTrack.times[i]!;
    if (typeof t !== "number" || !Number.isFinite(t) || (i > 0 && t < posTrack.times[i - 1]!)) {
      const diag: RootMotionDiagnostics = {
        code: "animation.rootMotion.malformedSamples",
        message: `Sample times in track "${posTrackName}" are malformed or non-monotonic at index ${i}`,
        hint: "Ensure sample times are monotonically increasing finite numbers without NaN",
      };
      return { success: false, error: diag.message, diagnostics: diag };
    }
  }

  const rotTrack = clip.tracks.find(
    (t) => t.name === rotTrackName && t instanceof THREE.QuaternionKeyframeTrack,
  ) as THREE.QuaternionKeyframeTrack | undefined;

  const samples: RootMotionSample[] = [];

  for (let i = 0; i < posTrack.times.length; i++) {
    const time = posTrack.times[i]!;
    const offsetPos = i * 3;
    const px = posTrack.values[offsetPos + 0] ?? 0;
    const py = posTrack.values[offsetPos + 1] ?? 0;
    const pz = posTrack.values[offsetPos + 2] ?? 0;

    // Sample the rotation track at this position key's TIME (not its index): the two tracks
    // may have different key counts / times.
    let yaw = rotTrack ? yawOfTrackAt(rotTrack, time) : 0;

    // Euler yaw lives in (-pi, pi]; a turn through 180 degrees would otherwise show up as a
    // +/-2pi jump between two samples (a huge spurious yaw delta, and interpolation sweeping
    // the long way round). Keep the sequence continuous by unwrapping against the previous sample.
    if (samples.length > 0) {
      const previousYaw = samples[samples.length - 1]!.yaw;
      while (yaw - previousYaw > Math.PI) yaw -= 2 * Math.PI;
      while (yaw - previousYaw < -Math.PI) yaw += 2 * Math.PI;
    }

    samples.push({
      time,
      position: [px, py, pz],
      yaw,
    });
  }

  const firstPos = samples[0]!.position;
  const lastPos = samples[samples.length - 1]!.position;
  const totalDisplacement: [number, number, number] = [
    lastPos[0] - firstPos[0],
    lastPos[1] - firstPos[1],
    lastPos[2] - firstPos[2],
  ];
  const totalYaw = samples[samples.length - 1]!.yaw - samples[0]!.yaw;

  const inPlaceClip = stripVisualRootDisplacement(clip, rootBoneName, mode);

  return {
    success: true,
    extracted: {
      clipName: clip.name,
      duration: clip.duration,
      mode,
      rootBoneName,
      samples,
      inPlaceClip,
      totalDisplacement,
      totalYaw,
    },
  };
}

/**
 * Truthfully inspects an animation clip to determine whether it is an in-place animation
 * or carries actual locomotion translation.
 */
export function inspectClipRootMotion(
  clip: THREE.AnimationClip,
  rootBoneName?: string,
): RootMotionInspectionReport {
  const resolvedBone = rootBoneName ?? findRootBoneName(clip) ?? "unknown";
  const posTrack = clip.tracks.find(
    (t) => t.name.startsWith(`${resolvedBone}.`) && t.name.endsWith(".position"),
  ) as THREE.VectorKeyframeTrack | undefined;

  if (!posTrack || posTrack.times.length === 0) {
    return {
      clipName: clip.name,
      duration: clip.duration,
      sampleCount: 0,
      rootBoneName: resolvedBone,
      firstPosition: [0, 0, 0],
      lastPosition: [0, 0, 0],
      netDisplacement: [0, 0, 0],
      maxDisplacementXZ: 0,
      netYaw: 0,
      isLocomotion: false,
      classification: "in-place",
      reason: `No translation track found for designated root bone "${resolvedBone}"`,
    };
  }

  const count = posTrack.times.length;
  const p0: [number, number, number] = [
    posTrack.values[0] ?? 0,
    posTrack.values[1] ?? 0,
    posTrack.values[2] ?? 0,
  ];
  const pLast: [number, number, number] = [
    posTrack.values[(count - 1) * 3 + 0] ?? 0,
    posTrack.values[(count - 1) * 3 + 1] ?? 0,
    posTrack.values[(count - 1) * 3 + 2] ?? 0,
  ];

  const netDisplacement: [number, number, number] = [
    pLast[0] - p0[0],
    pLast[1] - p0[1],
    pLast[2] - p0[2],
  ];

  let maxDisplacementXZ = 0;
  for (let i = 0; i < count; i++) {
    const x = posTrack.values[i * 3 + 0] ?? 0;
    const z = posTrack.values[i * 3 + 2] ?? 0;
    const dx = x - p0[0];
    const dz = z - p0[2];
    const dist = Math.hypot(dx, dz);
    if (dist > maxDisplacementXZ) {
      maxDisplacementXZ = dist;
    }
  }

  const netXZ = Math.hypot(netDisplacement[0], netDisplacement[2]);

  const rotTrack = clip.tracks.find(
    (t) => t.name === `${resolvedBone}.quaternion` && t instanceof THREE.QuaternionKeyframeTrack,
  ) as THREE.QuaternionKeyframeTrack | undefined;
  let netYaw = 0;
  if (rotTrack && rotTrack.times.length > 0) {
    // Unwrap along the position keys like extractRootMotionFromClip, so a turn
    // through 180 degrees is not reported as a spurious +/-2pi.
    let previous = yawOfTrackAt(rotTrack, posTrack.times[0]!);
    const firstYaw = previous;
    for (let i = 1; i < count; i++) {
      let yaw = yawOfTrackAt(rotTrack, posTrack.times[i]!);
      while (yaw - previous > Math.PI) yaw -= 2 * Math.PI;
      while (yaw - previous < -Math.PI) yaw += 2 * Math.PI;
      previous = yaw;
    }
    netYaw = previous - firstYaw;
  }

  // A clip is locomotion if net forward travel over the clip exceeds 0.1m
  // or if max deviation exceeds 0.5m.
  const isLocomotion = netXZ > 0.1 || maxDisplacementXZ > 0.5;
  const classification = isLocomotion ? "locomotion" : "in-place";
  const reason = isLocomotion
    ? `Net XZ displacement is ${netXZ.toFixed(4)}m (max deviation ${maxDisplacementXZ.toFixed(4)}m), carrying meaningful locomotion translation`
    : `Net XZ displacement is ${netXZ.toFixed(4)}m (max deviation ${maxDisplacementXZ.toFixed(4)}m), characteristic of an in-place cycle (treadmill walk / pelvic oscillation)`;

  return {
    clipName: clip.name,
    duration: clip.duration,
    sampleCount: count,
    rootBoneName: resolvedBone,
    firstPosition: p0,
    lastPosition: pLast,
    netDisplacement,
    maxDisplacementXZ,
    netYaw,
    isLocomotion,
    classification,
    reason,
  };
}
