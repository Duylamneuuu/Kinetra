# @kinetra/asset-pipeline

Deterministic asset identity, import recipes, hashes/cache keys, dependency invalidation, hot reimport and structured validation.

This package intentionally does **not** require Blender to run its unit tests. Blender execution is isolated behind `@kinetra/blender-bridge`; CI can verify the deterministic pipeline core before a DCC environment is attached. It never imports Three.js: the runtime side of a hot reload is reached through the `RuntimeReloadTarget` interface.

## Entry points

| Export | Kind | What it does |
| --- | --- | --- |
| `AssetDatabase` | class | In-memory, cycle-checked store of `AssetRecord`s. `upsert`, `get`, `list` (copies, sorted by id), `dependentsOf` and `invalidationSet` (the asset plus its transitive dependents, dependents sorted by id), `dependentsInRebuildOrder` (topological order). A rejected `upsert` leaves the database unchanged. |
| `hashBytes` / `hashFile` / `hashJson` | functions | SHA-256 hex. `hashJson` hashes a canonical form (sorted keys) and throws `CanonicalJsonError` (`hash.nonFiniteNumber`, `hash.cycle`, `hash.unsupportedValue`) instead of silently collapsing `NaN`, cycles or `undefined`. |
| `importFingerprint(input)` | function | Cache key of an import: source hash + importer + importer version + settings + sorted dependency fingerprints. |
| `validateAssetRecord(record)` | function | Returns `AssetDiagnostic[]` (`severity`, `code`, `message`): bad hashes, empty paths, polycount/texture-size/bounds limits, and provenance rules (a synthetic fixture cannot claim an external provider, creative-unit cost or AI model). |
| `inspectGlb(bytes)` | function | Validates the 12-byte GLB header (magic, version 2, declared length). Throws on malformed input. |
| `normalizeGlb(bytes)` | function | Parse + rewrite with glTF-Transform core only; returns the new bytes and node/mesh/animation/material/texture counts. |
| `inspectGlbCompression` / `evaluateCompressionPolicy` / `checkGlbCompression` | functions | Read-only compression policy, see below. Never throws on malformed input. |
| `AssetReimportService` | class | `reimport(id)` and `reimportWithDependents(id)`: re-hash the source, compute the fingerprint, run the registered `AssetImporter`, replace the artifact atomically (temp file + rename), update the database and emit `ReimportEvent`s. Returns `status: "noop" \| "reimported" \| "failed"`; on failure the last known-good artifact stays in place. Overlapping reimports of the same asset are serialized (an older import can never overwrite a newer one); different assets reimport concurrently. |
| `SourceAssetWatcher` | class | Debounced file watcher (`addAsset`, `removeAsset`, `onEvent`, `start()`, `stop()`) that emits `asset.changeDetected` when the content hash really changes. |
| `AssetHotReloadCoordinator` | class | Glues watcher → reimport service → `RuntimeReloadTarget` and records an `AssetHotReloadTransaction` per change (rebuild order, failed/blocked assets, reloaded entities). |
| `createSyntheticGlb` and friends | functions | Deterministic generated GLBs for tests and demos: `createSyntheticAnimatedGlb`, `createSyntheticPropGlb`, `createSyntheticCharacterGlb`, `createSyntheticRootMotionGlb`, `createSyntheticMorphGlb`. |

## Compression policy

`checkGlbCompression(bytes, policy?)` reads only the GLB JSON chunk and reports which codecs a file uses. The default policy (`DEFAULT_COMPRESSION_POLICY`) states what the shipped runtime can decode today (`RUNTIME_DECODER_CAPABILITIES`):

| Codec | glTF extension | Runtime decodes it? | If the file uses it |
| --- | --- | --- | --- |
| Meshopt | `EXT_meshopt_compression` | yes (WASM ships inside three.js) | `info` diagnostic `asset.compression.meshopt.supported` |
| Draco | `KHR_draco_mesh_compression` | **no** (no decoder files in the packaged player) | `warning`, or `error` if the extension is in `extensionsRequired` |
| KTX2/Basis | `KHR_texture_basisu` | **no** (no transcoder in the packaged player) | `warning`, or `error` if required |

Extra rules: a required extension the runtime loader does not know is an `error`; extensions used but not declared are an `error`; more than 256 KiB of uncompressed geometry (or 512 KiB of embedded PNG/JPEG when KTX2 is decodable) produces an advisory warning to run an offline pass. Diagnostics use the stable `asset.compression.*` codes, so an agent can branch on them.

## Examples

Fingerprints, the dependency graph and validation:

```ts doc-check
import assert from "node:assert/strict";
import {
  AssetDatabase,
  hashBytes,
  hashJson,
  importFingerprint,
  validateAssetRecord,
  type AssetRecord,
} from "@kinetra/asset-pipeline";

// Key order never changes a hash; the same settings always give the same fingerprint.
assert.equal(hashJson({ a: 1, b: 2 }), hashJson({ b: 2, a: 1 }));

const record = (id: string, dependencies: string[] = []): AssetRecord => {
  const sourceHash = hashBytes(new TextEncoder().encode(id));
  return {
    id,
    kind: "model",
    source: { path: `src/${id}.glb`, kind: "source", contentHash: sourceHash },
    importedPath: `imported/${id}.glb`,
    recipe: { importer: "glb", importerVersion: "1", settings: {} },
    fingerprint: importFingerprint({
      sourceHash,
      importer: "glb",
      importerVersion: "1",
      settings: {},
    }),
    dependencies,
    diagnostics: [],
    metadata: {},
  };
};

const db = new AssetDatabase();
db.upsert(record("crate"));
db.upsert(record("room", ["crate"]));
db.upsert(record("level", ["room"]));

// Changing "crate" invalidates everything built on top of it. The invalidation set sorts dependents
// by id; the rebuild order is topological (a dependency always comes before what depends on it).
assert.deepEqual(db.invalidationSet("crate"), ["crate", "level", "room"]);
assert.deepEqual(db.dependentsInRebuildOrder("crate"), ["room", "level"]);

// A dependency cycle is rejected and the database is left unchanged.
assert.throws(() => db.upsert(record("crate", ["level"])));
assert.deepEqual(db.get("crate")?.dependencies, []);

assert.deepEqual(validateAssetRecord(record("crate")), []);
```

Checking a GLB against the runtime's compression policy:

```ts doc-check
import assert from "node:assert/strict";
import { checkGlbCompression, createSyntheticGlb, inspectGlb } from "@kinetra/asset-pipeline";

const bytes = await createSyntheticGlb({ meshName: "Crate" });
assert.equal(inspectGlb(bytes).version, 2);

const { report, diagnostics } = checkGlbCompression(bytes);
assert.equal(report.parsed, true);
assert.equal(report.meshopt.bufferViews, 0);
assert.equal(report.dracoPrimitives, 0);
assert.deepEqual(
  diagnostics.filter((d) => d.severity === "error"),
  [],
);

// Garbage never throws: it becomes a diagnostic.
const broken = checkGlbCompression(new Uint8Array([1, 2, 3]));
assert.equal(broken.report.parsed, false);
assert.ok(broken.diagnostics.length > 0);
```

Reimport with dependents, using an in-memory `FileSystemAdapter` (the default one uses `node:fs`):

```ts doc-check
import assert from "node:assert/strict";
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

const files = new Map<string, Uint8Array>();
const fileSystem: FileSystemAdapter = {
  async readFile(path) {
    const bytes = files.get(path);
    if (!bytes) throw new Error(`ENOENT ${path}`);
    return bytes;
  },
  async writeFile(path, data) {
    files.set(path, data);
  },
  async rename(from, to) {
    files.set(to, files.get(from) ?? new Uint8Array());
    files.delete(from);
  },
  async unlink(path) {
    files.delete(path);
  },
  async mkdir() {
    return undefined;
  },
};

const sourceV1 = await createSyntheticGlb({ meshName: "Crate" });
files.set("src/crate.glb", sourceV1);
files.set("src/room.glb", await createSyntheticGlb({ meshName: "Room" }));

const recipe = { importer: "glb", importerVersion: "1", settings: {} };
const make = (id: string, dependencies: string[]): AssetRecord => {
  const contentHash = hashBytes(files.get(`src/${id}.glb`) ?? new Uint8Array());
  return {
    id,
    kind: "model",
    source: { path: `src/${id}.glb`, kind: "source", contentHash },
    importedPath: `imported/${id}.glb`,
    recipe,
    fingerprint: importFingerprint({ sourceHash: contentHash, ...recipe }),
    dependencies,
    diagnostics: [],
    metadata: {},
  };
};

const database = new AssetDatabase();
database.upsert(make("crate", []));
database.upsert(make("room", ["crate"]));

const events: ReimportEvent[] = [];
const service = new AssetReimportService({
  database,
  fileSystem,
  onEvent: (event) => events.push(event),
});

// First import writes the artifacts; an unchanged source is then a no-op.
assert.equal((await service.reimport("crate")).status, "reimported");
assert.equal((await service.reimport("crate")).status, "noop");

// Edit the source: the crate and everything that depends on it are rebuilt, in order.
files.set("src/crate.glb", await createSyntheticGlb({ meshName: "Crate", size: [2, 2, 2] }));
const rebuilt = await service.reimportWithDependents("crate");
assert.equal(rebuilt.status, "reimported");
assert.deepEqual(rebuilt.rebuiltAssetIds, ["crate", "room"]);
assert.ok(events.some((event) => event.type === "asset.reimportSucceeded"));

// A source that is not a valid GLB fails without touching the last good artifact.
const good = files.get("imported/crate.glb");
files.set("src/crate.glb", new Uint8Array([0, 1, 2, 3]));
const failed = await service.reimport("crate");
assert.equal(failed.status, "failed");
assert.equal(files.get("imported/crate.glb"), good);
```

## Proof level

| Capability | Proof |
| --- | --- |
| Hashing, canonical JSON, fingerprints, database integrity, rebuild order | `hash-canonical.test.ts`, `database-integrity.test.ts`, `rebuild-order.test.ts` (Node, no Blender) |
| Reimport, atomic replace, failure rollback, per-asset serialization | `reimport.test.ts`, `reimport-concurrency.test.ts` |
| Watcher and hot-reload coordinator (lifecycle, start failure) | `watcher-reassign.test.ts`, `watcher-lifecycle.test.ts`, `coordinator.test.ts`, `coordinator-start-failure.test.ts` |
| Record validation edge cases | `validation-edge.test.ts` |
| Compression policy | `compression.test.ts` (inspection + policy). Draco and KTX2 decoding are **not** implemented in the runtime. |
| Real Blender export → import | Not here: see `@kinetra/blender-bridge` and the verification suite. |

Run them with `pnpm --filter @kinetra/asset-pipeline test`.
