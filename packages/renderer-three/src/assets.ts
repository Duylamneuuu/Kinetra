export interface AssetResolver {
  resolve(
    assetId: string,
  ):
    | Promise<Uint8Array | ArrayBuffer | string | undefined>
    | Uint8Array
    | ArrayBuffer
    | string
    | undefined;
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
}

export interface ModelNodeState {
  name: string;
  position: [number, number, number];
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
}

export interface ModelMetadata {
  assetId: string;
  loaded: boolean;
  meshCount: number;
  nodeCount: number;
  skinnedMeshCount?: number;
  hasSkin?: boolean;
  bounds?: ModelBounds;
  animation?: ModelAnimationState;
  nodes?: ModelNodeState[];
  error?: string;
}
