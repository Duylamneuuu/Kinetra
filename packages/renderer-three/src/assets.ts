export interface AssetResolver {
  resolve(
    assetId: string,
  ):
    | Promise<Uint8Array | ArrayBuffer | string | undefined>
    | Uint8Array
    | ArrayBuffer
    | string
    | undefined;
  getFingerprint?(assetId: string): string | undefined;
}

export interface ModelBounds {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}

export interface ClipMetadata {
  name: string;
  duration: number;
}

export interface ModelAnimationActionState {
  clip: string;
  weight: number;
  role: "incoming" | "outgoing" | "active";
}

export interface ModelAnimationGraphState {
  state: string;
  previousState?: string | undefined;
  transitionId?: string | undefined;
  transitioning: boolean;
  blendSeconds?: number | undefined;
  blendElapsed?: number | undefined;
  blendProgress?: number | undefined;
}

import type { RootMotionMode } from "@kinetra/animation/root-motion.js";

export interface ModelRootMotionState {
  enabled: boolean;
  mode: RootMotionMode;
  sourceClip?: string | undefined;
  requestedDelta: [number, number, number];
  appliedDelta: [number, number, number];
  blockedDelta: [number, number, number];
  requestedYaw: number;
  appliedYaw: number;
  collisionClipped: boolean;
  accumulatedDistance: number;
  error?: string | undefined;
}

export interface ModelAnimationState {
  clips: ClipMetadata[];
  activeClip?: string | undefined;
  playing: boolean;
  time: number;
  duration?: number | undefined;
  retargetSource?: string | undefined;
  retargetCacheKey?: string | undefined;
  graph?: ModelAnimationGraphState | undefined;
  actions?: ModelAnimationActionState[] | undefined;
  rootMotion?: ModelRootMotionState | undefined;
}

export interface ModelNodeState {
  name: string;
  position: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}

export interface ModelInstanceMetadata {
  assetId: string;
  instanceId: string;
  sharedTemplateId: string;
  skinnedMeshCount: number;
  skeletonCount: number;
  fingerprint?: string | undefined;
  templateRevision?: number | undefined;
}

export interface ModelResourceSharingMetadata {
  templateRefCount: number;
}

export interface ModelMetadata {
  assetId: string;
  loaded: boolean;
  meshCount: number;
  nodeCount: number;
  skinnedMeshCount?: number | undefined;
  hasSkin?: boolean | undefined;
  bounds?: ModelBounds | undefined;
  animation?: ModelAnimationState | undefined;
  nodes?: ModelNodeState[] | undefined;
  instance?: ModelInstanceMetadata | undefined;
  resourceSharing?: ModelResourceSharingMetadata | undefined;
  assetFingerprint?: string | undefined;
  templateRevision?: number | undefined;
  error?: string | undefined;
}


