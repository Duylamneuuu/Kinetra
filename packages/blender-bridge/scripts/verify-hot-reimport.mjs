import { readFile } from "node:fs/promises";
import {
  AssetDatabase,
  AssetReimportService,
  hashBytes,
  importFingerprint,
  inspectGlb,
} from "@kinetra/asset-pipeline";
import { BlenderGlbImporter } from "../dist/src/index.js";

async function main() {
  const [sourceBlend, targetGlb] = process.argv.slice(2);
  if (!sourceBlend || !targetGlb) {
    console.error("Usage: node verify-hot-reimport.mjs <sourceBlend> <targetGlb>");
    process.exit(1);
  }

  const sourceBytes = await readFile(sourceBlend);
  const sourceHash = hashBytes(sourceBytes);

  const db = new AssetDatabase();
  const importer = new BlenderGlbImporter({
    blenderExecutable: process.env.BLENDER_PATH || "blender",
  });

  const reimportService = new AssetReimportService({
    database: db,
    importers: new Map([["blender-glb", importer]]),
  });

  const initialRecord = {
    id: "asset_blender_ci",
    kind: "model",
    source: { path: sourceBlend, kind: "source", contentHash: "dummy_initial_hash" },
    importedPath: targetGlb,
    recipe: { importer: "blender-glb", importerVersion: "1.0.0", settings: {} },
    fingerprint: "dummy_initial_fp",
    dependencies: [],
    diagnostics: [],
    metadata: {},
  };
  db.upsert(initialRecord);

  console.log("Running AssetReimportService with real Blender on:", sourceBlend);
  const result = await reimportService.reimport("asset_blender_ci");
  console.log("Reimport result:", result);

  if (result.status !== "reimported") {
    console.error("Reimport failed:", result.error);
    process.exit(1);
  }

  const glbBytes = await readFile(targetGlb);
  const header = inspectGlb(glbBytes);
  console.log("Validated exported GLB header:", header);

  if (glbBytes.byteLength < 500) {
    console.error(`Exported GLB is too small: ${glbBytes.byteLength} bytes`);
    process.exit(1);
  }

  console.log("BLENDER_HOT_REIMPORT_GATE_VERIFIED");
}

main().catch((err) => {
  console.error("verify-hot-reimport failed:", err);
  process.exit(1);
});
