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

export interface ModelMetadata {
  assetId: string;
  loaded: boolean;
  meshCount: number;
  nodeCount: number;
  bounds?: ModelBounds;
  error?: string;
}
