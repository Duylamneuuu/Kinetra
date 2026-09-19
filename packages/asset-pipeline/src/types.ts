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

export interface AssetRecord {
  id: string;
  kind: AssetKind;
  source: AssetSource;
  importedPath: string;
  recipe: ImportRecipe;
  fingerprint: string;
  dependencies: string[];
  diagnostics: AssetDiagnostic[];
  metadata: Record<string, unknown>;
}

export interface AssetDatabaseDocument {
  schemaVersion: 1;
  assets: AssetRecord[];
}
