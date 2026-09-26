import { createHash } from "node:crypto";
import { NodeIO } from "@gltf-transform/core";
import * as THREE from "three";
import {
  type HumanoidBone,
  type SkeletonProfile,
  type RetargetPlan,
  buildRetargetPlan,
  skeletonSignature,
} from "./skeleton.js";

export interface RetargetDiagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  semanticBone?: HumanoidBone | undefined;
  nodeName?: string | undefined;
  hint?: string | undefined;
}

export type HipsTranslationPolicy = "ignore" | "preserve" | "relative" | "scale";

export interface RetargetSettings {
  hipsTranslationPolicy?: HipsTranslationPolicy | undefined;
  scaleFactor?: number | undefined;
  ignoreUnmappedBones?: boolean | undefined;
  version?: number | undefined;
  [key: string]: unknown;
}

export interface SkeletonJointInfo {
  name: string;
  parent?: string | undefined;
  restTranslation?: [number, number, number] | undefined;
  restRotation?: [number, number, number, number] | undefined;
  restScale?: [number, number, number] | undefined;
}

export interface SkeletonClipInfo {
  name: string;
  duration: number;
  channelCount: number;
  targetNodes: string[];
}

export interface SkeletonInspectionResult {
  skinName?: string | undefined;
  bones: SkeletonJointInfo[];
  clips: SkeletonClipInfo[];
  diagnostics: RetargetDiagnostic[];
}

export interface RestPoseTransform {
  rotation?: [number, number, number, number] | undefined;
  translation?: [number, number, number] | undefined;
  scale?: [number, number, number] | undefined;
}

export type RestPoseMap =
  | Map<string, RestPoseTransform>
  | Record<string, RestPoseTransform>;

export interface RetargetCacheKeyOptions {
  sourceAssetHash?: string | undefined;
  sourceClipId: string;
  source: SkeletonProfile;
  target: SkeletonProfile;
  semanticMapping?:
    | import("./skeleton.js").RetargetBonePair[]
    | Array<{ semantic: string; sourceBone: string; targetBone: string }>
    | undefined;
  settings?: Record<string, unknown> | RetargetSettings | undefined;
  retargetVersion?: number | undefined;
}

export function computeRetargetCacheKey(input: RetargetCacheKeyOptions): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        result[key] = stable((value as Record<string, unknown>)[key]);
      }
      return result;
    }
    return value;
  };

  const mapping = input.semanticMapping ?? buildRetargetPlan(input.source, input.target).pairs;
  const canonicalMapping = mapping
    .map((p) => ({
      semantic: p.semantic,
      sourceBone: p.sourceBone,
      targetBone: p.targetBone,
    }))
    .sort((a, b) => a.semantic.localeCompare(b.semantic));

  const payload = {
    sourceAssetHash: input.sourceAssetHash ?? "",
    sourceClipId: input.sourceClipId,
    source: skeletonSignature(input.source),
    target: skeletonSignature(input.target),
    mapping: canonicalMapping,
    settings: input.settings ?? {},
    retargetVersion: input.retargetVersion ?? 1,
  };

  return createHash("sha256")
    .update(JSON.stringify(stable(payload)))
    .digest("hex");
}

/**
 * Inspects a GLB/glTF binary to discover skin joints, parent hierarchy, rest poses,
 * and animation clips without requiring a DOM or WebGL context.
 */
export async function inspectSkeletonFromGlb(
  glbBytes: Uint8Array | ArrayBuffer,
): Promise<SkeletonInspectionResult> {
  const diagnostics: RetargetDiagnostic[] = [];
  const bytes = glbBytes instanceof Uint8Array ? glbBytes : new Uint8Array(glbBytes);

  const io = new NodeIO();
  const doc = await io.readBinary(bytes);
  const root = doc.getRoot();

  const skins = root.listSkins();
  if (skins.length === 0) {
    diagnostics.push({
      severity: "warning",
      code: "retarget.skin.not-found",
      message: "No skin or skeleton found in GLB binary",
      hint: "Verify that the GLB contains skinned mesh armature joints",
    });
  }

  const primarySkin = skins[0];
  const skinName = primarySkin ? primarySkin.getName() || "Armature" : undefined;
  const jointNodes = primarySkin ? primarySkin.listJoints() : [];

  // Build parent lookup map across all nodes
  const parentMap = new Map<string, string>();
  for (const node of root.listNodes()) {
    const parentName = node.getName();
    for (const child of node.listChildren()) {
      parentMap.set(child.getName(), parentName);
    }
  }

  const bones: SkeletonJointInfo[] = [];
  for (const node of jointNodes) {
    const nodeName = node.getName() || `Joint_${bones.length}`;
    const parentName = parentMap.get(nodeName);

    const translation = node.getTranslation();
    const rotation = node.getRotation();
    const scale = node.getScale();

    bones.push({
      name: nodeName,
      parent: parentName,
      restTranslation: translation ? [translation[0], translation[1], translation[2]] : [0, 0, 0],
      restRotation: rotation ? [rotation[0], rotation[1], rotation[2], rotation[3]] : [0, 0, 0, 1],
      restScale: scale ? [scale[0], scale[1], scale[2]] : [1, 1, 1],
    });
  }

  const clips: SkeletonClipInfo[] = [];
  for (const anim of root.listAnimations()) {
    const channels = anim.listChannels();
    const targetNodeSet = new Set<string>();
    let maxTime = 0;

    for (const channel of channels) {
      const targetNode = channel.getTargetNode();
      if (targetNode) {
        targetNodeSet.add(targetNode.getName());
      }
      const sampler = channel.getSampler();
      if (sampler) {
        const inputAccessor = sampler.getInput();
        if (inputAccessor) {
          const max = inputAccessor.getMax([]);
          if (max && max.length > 0 && typeof max[0] === "number") {
            maxTime = Math.max(maxTime, max[0]);
          }
        }
      }
    }

    clips.push({
      name: anim.getName() || `anim_${clips.length}`,
      duration: maxTime,
      channelCount: channels.length,
      targetNodes: Array.from(targetNodeSet).sort(),
    });
  }

  return {
    skinName,
    bones,
    clips,
    diagnostics,
  };
}

export interface BakeRetargetOptions {
  sourceClip: THREE.AnimationClip;
  sourceProfile: SkeletonProfile;
  targetProfile: SkeletonProfile;
  sourceRestPoses?: RestPoseMap | undefined;
  targetRestPoses?: RestPoseMap | undefined;
  settings?: RetargetSettings | undefined;
  clipName?: string | undefined;
  sourceAssetHash?: string | undefined;
}

export interface BakeRetargetResult {
  success: boolean;
  clip?: THREE.AnimationClip | undefined;
  cacheKey: string;
  plan: RetargetPlan;
  diagnostics: RetargetDiagnostic[];
  trackCount: number;
  duration: number;
  error?: string | undefined;
}

function getRestPose(
  map: RestPoseMap | undefined,
  boneName: string,
): { rotation: THREE.Quaternion; translation: THREE.Vector3 } {
  const rot = new THREE.Quaternion(0, 0, 0, 1);
  const pos = new THREE.Vector3(0, 0, 0);

  if (!map) return { rotation: rot, translation: pos };

  const entry =
    map instanceof Map ? map.get(boneName) : (map as Record<string, RestPoseTransform>)[boneName];

  if (entry) {
    if (entry.rotation && entry.rotation.length === 4) {
      rot.set(entry.rotation[0], entry.rotation[1], entry.rotation[2], entry.rotation[3]).normalize();
    }
    if (entry.translation && entry.translation.length === 3) {
      pos.set(entry.translation[0], entry.translation[1], entry.translation[2]);
    }
  }

  return { rotation: rot, translation: pos };
}

/**
 * Bakes a target-specific THREE.AnimationClip by retargeting source animation tracks
 * through Kinetra's semantic humanoid bone profile.
 */
export function bakeRetargetedClip(options: BakeRetargetOptions): BakeRetargetResult {
  const diagnostics: RetargetDiagnostic[] = [];
  const settings: RetargetSettings = {
    hipsTranslationPolicy: "ignore",
    scaleFactor: 1.0,
    version: 1,
    ...options.settings,
  };

  const plan = buildRetargetPlan(options.sourceProfile, options.targetProfile);
  const cacheKey = computeRetargetCacheKey({
    sourceAssetHash: options.sourceAssetHash,
    sourceClipId: options.sourceClip.name || options.sourceClip.uuid,
    source: options.sourceProfile,
    target: options.targetProfile,
    settings,
    retargetVersion: settings.version,
  });

  // Verify essential bone mapping: hips is required for humanoid retargeting
  if (!options.targetProfile.bones.hips) {
    const errorMsg = "Required humanoid bone 'hips' is not mapped on target skeleton profile";
    diagnostics.push({
      severity: "error",
      code: "retarget.bone.missing-required",
      message: errorMsg,
      semanticBone: "hips",
      hint: "Map the 'hips' bone on target skeleton profile to enable humanoid retargeting",
    });
    return {
      success: false,
      cacheKey,
      plan,
      diagnostics,
      trackCount: 0,
      duration: options.sourceClip.duration,
      error: errorMsg,
    };
  }

  if (!options.sourceProfile.bones.hips) {
    const errorMsg = "Required humanoid bone 'hips' is not mapped on source skeleton profile";
    diagnostics.push({
      severity: "error",
      code: "retarget.bone.missing-required",
      message: errorMsg,
      semanticBone: "hips",
      hint: "Map the 'hips' bone on source skeleton profile to enable humanoid retargeting",
    });
    return {
      success: false,
      cacheKey,
      plan,
      diagnostics,
      trackCount: 0,
      duration: options.sourceClip.duration,
      error: errorMsg,
    };
  }

  // Build lookup from source physical bone name -> target physical bone name and semantic bone
  const sourceToTarget = new Map<string, { targetBone: string; semantic: HumanoidBone }>();
  for (const pair of plan.pairs) {
    sourceToTarget.set(pair.sourceBone, {
      targetBone: pair.targetBone,
      semantic: pair.semantic,
    });
  }

  const bakedTracks: THREE.KeyframeTrack[] = [];
  const hipsPolicy = settings.hipsTranslationPolicy ?? "ignore";
  const scaleFactor = settings.scaleFactor ?? 1.0;

  for (const track of options.sourceClip.tracks) {
    const dotIndex = track.name.indexOf(".");
    if (dotIndex === -1) {
      diagnostics.push({
        severity: "warning",
        code: "retarget.track.invalid-name",
        message: `Track "${track.name}" lacks a property delimiter; skipping`,
        hint: "Track names must be formatted as 'nodeName.property'",
      });
      continue;
    }

    const sourceNodeName = track.name.slice(0, dotIndex);
    const property = track.name.slice(dotIndex + 1);

    const mapping = sourceToTarget.get(sourceNodeName);
    if (!mapping) {
      // Source node is not mapped to any target bone
      diagnostics.push({
        severity: "info",
        code: "retarget.track.unmapped",
        message: `Track "${track.name}" targets node "${sourceNodeName}" which is unmapped on target skeleton`,
        nodeName: sourceNodeName,
      });
      continue;
    }

    const { targetBone, semantic } = mapping;

    if (property === "quaternion" || property === "rotation") {
      const sourceRest = getRestPose(options.sourceRestPoses, sourceNodeName);
      const targetRest = getRestPose(options.targetRestPoses, targetBone);

      const times = new Float32Array(track.times);
      const values = new Float32Array(track.values.length);
      const sourceRestInv = sourceRest.rotation.clone().invert();

      const qSrc = new THREE.Quaternion();
      const qDelta = new THREE.Quaternion();
      const qTgt = new THREE.Quaternion();

      for (let i = 0; i < times.length; i++) {
        const offset = i * 4;
        qSrc.set(
          track.values[offset + 0]!,
          track.values[offset + 1]!,
          track.values[offset + 2]!,
          track.values[offset + 3]!,
        ).normalize();

        // qDelta = qSrc * qSrcRest^-1
        qDelta.copy(qSrc).multiply(sourceRestInv);

        // qTgt = qDelta * qTgtRest
        qTgt.copy(qDelta).multiply(targetRest.rotation).normalize();

        values[offset + 0] = qTgt.x;
        values[offset + 1] = qTgt.y;
        values[offset + 2] = qTgt.z;
        values[offset + 3] = qTgt.w;
      }

      bakedTracks.push(
        new THREE.QuaternionKeyframeTrack(`${targetBone}.quaternion`, times, values),
      );
    } else if (property === "position") {
      if (semantic === "hips" && hipsPolicy !== "ignore") {
        const sourceRest = getRestPose(options.sourceRestPoses, sourceNodeName);
        const targetRest = getRestPose(options.targetRestPoses, targetBone);

        const times = new Float32Array(track.times);
        const values = new Float32Array(track.values.length);

        for (let i = 0; i < times.length; i++) {
          const offset = i * 3;
          const sx = track.values[offset + 0]!;
          const sy = track.values[offset + 1]!;
          const sz = track.values[offset + 2]!;

          if (hipsPolicy === "relative") {
            const dx = (sx - sourceRest.translation.x) * scaleFactor;
            const dy = (sy - sourceRest.translation.y) * scaleFactor;
            const dz = (sz - sourceRest.translation.z) * scaleFactor;
            values[offset + 0] = targetRest.translation.x + dx;
            values[offset + 1] = targetRest.translation.y + dy;
            values[offset + 2] = targetRest.translation.z + dz;
          } else if (hipsPolicy === "scale") {
            values[offset + 0] = sx * scaleFactor;
            values[offset + 1] = sy * scaleFactor;
            values[offset + 2] = sz * scaleFactor;
          } else {
            // preserve
            values[offset + 0] = sx;
            values[offset + 1] = sy;
            values[offset + 2] = sz;
          }
        }

        bakedTracks.push(
          new THREE.VectorKeyframeTrack(`${targetBone}.position`, times, values),
        );
      } else {
        diagnostics.push({
          severity: "info",
          code: "retarget.translation.omitted",
          message: `Translation track for bone "${sourceNodeName}" (${semantic}) omitted per hipsTranslationPolicy "${hipsPolicy}"`,
          semanticBone: semantic,
          nodeName: sourceNodeName,
        });
      }
    } else if (property === "scale") {
      // Scale tracks generally ignored for standard humanoid retargeting
      diagnostics.push({
        severity: "info",
        code: "retarget.track.scale-ignored",
        message: `Scale track for bone "${sourceNodeName}" ignored`,
        nodeName: sourceNodeName,
      });
    } else {
      diagnostics.push({
        severity: "warning",
        code: "retarget.track.unsupported-binding",
        message: `Track property "${property}" on "${sourceNodeName}" is unsupported for retargeting; skipped`,
        nodeName: sourceNodeName,
        hint: "Only rotation and translation keyframe tracks are supported for humanoid retargeting",
      });
    }
  }

  if (bakedTracks.length === 0) {
    const errorMsg = `Source clip "${options.sourceClip.name}" produced 0 usable tracks for target skeleton`;
    diagnostics.push({
      severity: "error",
      code: "retarget.clip.no-usable-tracks",
      message: errorMsg,
      hint: "Verify that source skeleton profile bone names match GLTF animation track targets",
    });
    return {
      success: false,
      cacheKey,
      plan,
      diagnostics,
      trackCount: 0,
      duration: options.sourceClip.duration,
      error: errorMsg,
    };
  }

  const bakedClipName =
    options.clipName ||
    `${options.sourceClip.name || "clip"}_retargeted_${plan.targetSignature.slice(0, 8)}`;

  const bakedClip = new THREE.AnimationClip(
    bakedClipName,
    options.sourceClip.duration,
    bakedTracks,
  );

  return {
    success: true,
    clip: bakedClip,
    cacheKey,
    plan,
    diagnostics,
    trackCount: bakedTracks.length,
    duration: bakedClip.duration,
  };
}

export interface BakedClipInspectionResult {
  name: string;
  duration: number;
  trackCount: number;
  targetBonesAnimated: string[];
  unmappedTracks: string[];
  diagnostics: RetargetDiagnostic[];
}

/**
 * Inspects a baked THREE.AnimationClip against a target SkeletonProfile
 * to verify track binding and identify animated humanoid bones.
 */
export function inspectRetargetedClip(
  clip: THREE.AnimationClip,
  targetProfile: SkeletonProfile,
): BakedClipInspectionResult {
  const diagnostics: RetargetDiagnostic[] = [];
  const targetBoneSet = new Set(Object.values(targetProfile.bones).filter(Boolean) as string[]);
  const targetBonesAnimated = new Set<string>();
  const unmappedTracks: string[] = [];

  for (const track of clip.tracks) {
    const dotIdx = track.name.indexOf(".");
    const nodeName = dotIdx !== -1 ? track.name.slice(0, dotIdx) : track.name;

    if (targetBoneSet.has(nodeName)) {
      targetBonesAnimated.add(nodeName);
    } else {
      unmappedTracks.push(track.name);
      diagnostics.push({
        severity: "warning",
        code: "retarget.inspection.unmapped-track",
        message: `Track "${track.name}" targets node "${nodeName}" which is not in target skeleton profile`,
        nodeName,
        hint: "Ensure baked clip tracks only target nodes mapped in the target skeleton profile",
      });
    }
  }

  return {
    name: clip.name,
    duration: clip.duration,
    trackCount: clip.tracks.length,
    targetBonesAnimated: Array.from(targetBonesAnimated).sort(),
    unmappedTracks,
    diagnostics,
  };
}
