import type { AssetDiagnostic, AssetRecord } from "./types.js";

export function validateAssetRecord(record: AssetRecord): AssetDiagnostic[] {
  const diagnostics: AssetDiagnostic[] = [];

  if (!record.source.path) diagnostics.push({
    severity:"error", code:"asset.source.path.empty", message:"Source path is required"
  });
  if (!/^[a-f0-9]{64}$/.test(record.source.contentHash)) diagnostics.push({
    severity:"error", code:"asset.source.hash.invalid", message:"Source contentHash must be sha256 hex"
  });
  if (!/^[a-f0-9]{64}$/.test(record.fingerprint)) diagnostics.push({
    severity:"error", code:"asset.fingerprint.invalid", message:"Asset fingerprint must be sha256 hex"
  });
  if (!record.importedPath) diagnostics.push({
    severity:"error", code:"asset.imported.path.empty", message:"Imported path is required"
  });
  if (!record.recipe.importer) diagnostics.push({
    severity:"error", code:"asset.recipe.importer.empty", message:"Importer name is required"
  });

  const polycount = record.metadata.polycount;
  if (typeof polycount === "number" && polycount > 2_000_000) diagnostics.push({
    severity:"warning", code:"model.polycount.high", message:`Polycount ${polycount} exceeds default review threshold`
  });

  const maxTexture = record.metadata.maxTextureDimension;
  if (typeof maxTexture === "number" && maxTexture > 8192) diagnostics.push({
    severity:"warning", code:"texture.dimension.high", message:`Texture dimension ${maxTexture} exceeds 8192`
  });

  return diagnostics;
}
