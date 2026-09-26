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

  const boundsRadius = record.metadata.boundsRadius;
  if (typeof boundsRadius === "number") {
    if (!Number.isFinite(boundsRadius) || boundsRadius <= 0) {
      diagnostics.push({
        severity: "error", code: "model.bounds.invalid", message: `Bounds radius ${boundsRadius} must be a positive finite number`
      });
    } else if (boundsRadius > 500) {
      diagnostics.push({
        severity: "warning", code: "model.bounds.large", message: `Bounds radius ${boundsRadius}m exceeds 500m threshold`
      });
    }
  }

  const provenance = record.metadata.provenance;
  if (provenance) {
    if (!provenance.provider) {
      diagnostics.push({
        severity: "error",
        code: "asset.provenance.provider.empty",
        message: "Provenance provider is required when provenance is specified",
      });
    }

    const isSyntheticGenerator =
      typeof provenance.generator === "string" &&
      /^(kinetra|createSynthetic)/i.test(provenance.generator);
    const isSyntheticProvider =
      provenance.provider === "kinetra" ||
      provenance.provider === "kinetra-synthetic" ||
      provenance.provider === "synthetic";

    if (isSyntheticGenerator && !isSyntheticProvider) {
      diagnostics.push({
        severity: "error",
        code: "asset.provenance.synthetic.invalidProvider",
        message: `Deterministic synthetic fixture (${provenance.generator}) cannot claim external provider provenance "${provenance.provider}"`,
      });
    }

    if (isSyntheticProvider || isSyntheticGenerator) {
      if (typeof provenance.creativeUnitsCost === "number" && provenance.creativeUnitsCost > 0) {
        diagnostics.push({
          severity: "error",
          code: "asset.provenance.synthetic.externalCost",
          message: `Deterministic synthetic fixture cannot claim external creative units cost (${provenance.creativeUnitsCost})`,
        });
      }
      if (provenance.sourceAssetId) {
        diagnostics.push({
          severity: "error",
          code: "asset.provenance.synthetic.externalAssetId",
          message: `Deterministic synthetic fixture cannot claim external provider sourceAssetId "${provenance.sourceAssetId}"`,
        });
      }
      if (
        provenance.model &&
        /^(gpt|claude|scenario|dall-e|stable-diffusion|midjourney)/i.test(provenance.model)
      ) {
        diagnostics.push({
          severity: "error",
          code: "asset.provenance.synthetic.externalModel",
          message: `Deterministic synthetic fixture cannot claim external AI model "${provenance.model}"`,
        });
      }
    }
  }

  return diagnostics;
}
