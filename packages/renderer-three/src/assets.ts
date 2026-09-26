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

export interface ModelAnimationState {
  clips: ClipMetadata[];
  activeClip?: string;
  playing: boolean;
  time: number;
  duration?: number;
  retargetSource?: string;
  retargetCacheKey?: string;
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
