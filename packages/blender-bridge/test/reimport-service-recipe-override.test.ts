import assert from "node:assert/strict";
import test from "node:test";
import {
  AssetDatabase,
  AssetReimportService,
  createSyntheticGlb,
  hashBytes,
  importFingerprint,
  type AssetRecord,
  type FileSystemAdapter,
  type ReimportEvent,
} from "@kinetra/asset-pipeline";
import { BlenderGlbImporter, type ProcessRunner } from "../src/index.js";

// The importer is exercised the way the engine really uses it: through AssetReimportService, not by
// calling import() directly. A recipe is project data, so a recipe that tries to choose which program
// runs must come out as a structured `asset.reimportFailed` event and a failed result, never a raw
// exception, and Blender must never be spawned.

const SOURCE_PATH = "art/hero.blend";
const IMPORTED_PATH = "out/hero.glb";

function memoryFs(files: Map<string, Uint8Array>): FileSystemAdapter {
  return {
    async readFile(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`ENOENT ${path}`);
      return bytes.slice();
    },
    async writeFile(path, data) {
      files.set(path, data.slice());
    },
    async rename(from, to) {
      const bytes = files.get(from);
      if (!bytes) throw new Error(`ENOENT ${from}`);
      files.delete(from);
      files.set(to, bytes);
    },
    async unlink(path) {
      files.delete(path);
    },
    async mkdir() {
      return undefined;
    },
  };
}

function heroRecord(settings: Record<string, unknown>, sourceBytes: Uint8Array): AssetRecord {
  const recipe = { importer: "blender-glb", importerVersion: "1", settings };
  const sourceHash = hashBytes(sourceBytes);
  return {
    id: "asset_hero",
    kind: "model",
    source: { path: SOURCE_PATH, kind: "source", contentHash: "0".repeat(64) },
    importedPath: IMPORTED_PATH,
    recipe,
    fingerprint: importFingerprint({ sourceHash: "0".repeat(64), ...recipe }),
    dependencies: [],
    diagnostics: [],
    metadata: {},
  };
}

interface Harness {
  service: AssetReimportService;
  files: Map<string, Uint8Array>;
  events: ReimportEvent[];
  runs: Array<{ executable: string; args: string[] }>;
}

async function harness(settings: Record<string, unknown>, allowRecipeExecutableOverrides: boolean): Promise<Harness> {
  const sourceBytes = new Uint8Array([9, 9, 9]);
  const previousArtifact = new Uint8Array([1, 2, 3, 4]);
  const files = new Map<string, Uint8Array>([
    [SOURCE_PATH, sourceBytes],
    [IMPORTED_PATH, previousArtifact],
  ]);
  const fs = memoryFs(files);
  const runs: Harness["runs"] = [];
  const glb = await createSyntheticGlb({ size: [1, 1, 1], meshName: "Hero" });
  const runner: ProcessRunner = {
    async run(executable, args) {
      runs.push({ executable, args });
      // Behave like Blender: write the GLB to the --output staging path given on the command line.
      const outputIndex = args.indexOf("--output");
      const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
      if (output) files.set(output, glb);
      return { code: 0, stdout: "KINETRA_BLENDER_EXPORT_OK", stderr: "" };
    },
  };
  const database = new AssetDatabase();
  database.upsert(heroRecord(settings, sourceBytes));
  const events: ReimportEvent[] = [];
  const importer = new BlenderGlbImporter({
    blenderExecutable: "blender-configured",
    runner,
    fileSystem: fs,
    allowRecipeExecutableOverrides,
  });
  const service = new AssetReimportService({
    database,
    fileSystem: fs,
    importers: new Map([["blender-glb", importer]]),
    onEvent: (event) => events.push(event),
  });
  return { service, files, events, runs };
}

for (const key of ["blenderExecutable", "pythonScript"] as const) {
  test(`a recipe that sets ${key} fails the reimport with a structured blender.invalidOption, and Blender never runs`, async () => {
    const h = await harness({ [key]: "/tmp/evil-program" }, false);

    const result = await h.service.reimport("asset_hero");

    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "blender.invalidOption");
    assert.match(result.error ?? "", new RegExp(key));
    assert.deepEqual(h.runs, [], "the runner must not be spawned for a rejected recipe");
    // The last known-good artifact is untouched and no staging file is left behind.
    assert.deepEqual([...(h.files.get(IMPORTED_PATH) ?? [])], [1, 2, 3, 4]);
    assert.deepEqual([...h.files.keys()].sort(), [IMPORTED_PATH, SOURCE_PATH].sort());

    const failed = h.events.filter((event) => event.type === "asset.reimportFailed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.assetId, "asset_hero");
    assert.equal(failed[0]?.errorCode, "blender.invalidOption");
  });
}

test("a failure without a code (importer threw a plain Error) carries no errorCode", async () => {
  const h = await harness({}, false);
  const throwing = {
    async import(): Promise<never> {
      throw new Error("plain boom");
    },
  };
  const service = new AssetReimportService({
    database: h.service.getDatabase(),
    fileSystem: memoryFs(h.files),
    importers: new Map([["blender-glb", throwing]]),
  });

  const result = await service.reimport("asset_hero");

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, undefined);
  assert.match(result.error ?? "", /plain boom/);
});

test("with allowRecipeExecutableOverrides the same recipe is honoured: the override executable runs and the reimport succeeds", async () => {
  const h = await harness({ blenderExecutable: "/opt/blender-special" }, true);

  const result = await h.service.reimport("asset_hero");

  assert.equal(result.status, "reimported", result.error);
  assert.equal(result.errorCode, undefined);
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0]?.executable, "/opt/blender-special");
  assert.equal(h.events.filter((event) => event.type === "asset.reimportFailed").length, 0);
});
