export type AssetKind = "model" | "texture" | "audio" | "animation" | "other";

export interface AssetSource {
  path: string;
  kind: "source" | "generated";
  contentHash: string;
}

export interface ImportRecipe {
  importer: string;
  importerVersion: string;
  settings: Record<string, unknown>;
}

export interface AssetDiagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  path?: string;
}

export interface AssetProvenance {
  provider: string;
  generator?: string;
  model?: string;
  prompt?: string;
  sourceAssetId?: string;
  generatedAt?: string;
  license?: string;
  creativeUnitsCost?: number;
}

export interface AssetMetadata extends Record<string, unknown> {
  polycount?: number;
  maxTextureDimension?: number;
  dimensions?: [number, number, number];
  boundsRadius?: number;
  provenance?: AssetProvenance;
}

export interface AssetRecord {
  id: string;
  kind: AssetKind;
  source: AssetSource;
  importedPath: string;
  recipe: ImportRecipe;
  fingerprint: string;
  dependencies: string[];
  diagnostics: AssetDiagnostic[];
  metadata: AssetMetadata;
}

export interface AssetDatabaseDocument {
  schemaVersion: 1;
  assets: AssetRecord[];
}
