import assert from "node:assert/strict";
import test from "node:test";

import { RecastNavMesh } from "@kinetra/navigation-recast";

import {
  ORB_RUN_AUDIO_ASSET,
  ORB_RUN_MODEL_ASSET,
  createOrbRunAssetPipeline,
  createOrbRunProject,
  orbRunSourcePath,
  type OrbRunAssetPipeline,
} from "../src/index.js";
import { planOrbRunRoute } from "../src/navigation.js";

// ---- #411 / #415 item 1: planOrbRunRoute only reports route_blocked for the navmesh's "nothing walkable" answer ----

async function planWithClosestPoint(impl: () => never) {
  const prototype = RecastNavMesh.prototype as unknown as { closestPoint: unknown };
  const original = prototype.closestPoint;
  prototype.closestPoint = impl;
  try {
    return await planOrbRunRoute(createOrbRunProject());
  } finally {
    prototype.closestPoint = original;
  }
}

test("a closestPoint failure that is not 'no walkable floor' keeps its cause instead of posing as route_blocked", async () => {
  const plan = await planWithClosestPoint(() => {
    throw new Error("wasm trap: out of memory");
  });
  assert.equal(plan.ok, false);
  assert.ok(plan.diagnostics.length > 0);
  assert.ok(plan.diagnostics.every((entry) => entry.code === "navmesh_error"), JSON.stringify(plan.diagnostics));
  assert.ok(plan.diagnostics.every((entry) => entry.severity === "error" && entry.entityId !== undefined));
  assert.match(plan.diagnostics[0]!.message, /wasm trap: out of memory/);
});

test("a non-Error value thrown by closestPoint is still reported as navmesh_error with its text", async () => {
  const plan = await planWithClosestPoint(() => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw "plain string failure";
  });
  assert.equal(plan.ok, false);
  assert.ok(plan.diagnostics.every((entry) => entry.code === "navmesh_error"));
  assert.match(plan.diagnostics[0]!.message, /plain string failure/);
});

test("the navmesh's own 'No closest point found' answer is still route_blocked", async () => {
  const plan = await planWithClosestPoint(() => {
    throw new Error("No closest point found on NavMesh for position (0, 0, 0) within extents (1, 0.5, 1)");
  });
  assert.equal(plan.ok, false);
  assert.ok(plan.diagnostics.every((entry) => entry.code === "route_blocked"), JSON.stringify(plan.diagnostics));
});

// ---- #413 / #415: WAV and model importer follow-ups -----------------------------------------------------

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));
const le16 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];
const le32 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
const PCM_GUID = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

function chunk(id: string, body: number[]): number[] {
  return [...ascii(id), ...le32(body.length), ...body, ...(body.length % 2 === 1 ? [0] : [])];
}

function fmtChunk(options: { tag?: number; channels?: number; rate?: number; bits?: number; extensible?: number[] | "short" } = {}): number[] {
  const channels = options.channels ?? 1;
  const rate = options.rate ?? 22050;
  const bits = options.bits ?? 16;
  const blockAlign = Math.max(1, (channels * bits) >> 3);
  const base = [...le16(options.tag ?? 1), ...le16(channels), ...le32(rate), ...le32(rate * blockAlign), ...le16(blockAlign), ...le16(bits)];
  if (options.extensible === undefined) return chunk("fmt ", base);
  const tail = options.extensible === "short" ? [] : [...le16(22), ...le16(bits), ...le32(3), ...options.extensible];
  return chunk("fmt ", [...base, ...tail]);
}

function riff(...chunks: number[][]): Uint8Array {
  const body = [...ascii("WAVE"), ...chunks.flat()];
  return new Uint8Array([...ascii("RIFF"), ...le32(body.length), ...body]);
}

const samples = (count: number): number[] => Array.from({ length: count }, (_, index) => (index * 7) & 0xff);

async function importWav(pipeline: OrbRunAssetPipeline, bytes: Uint8Array) {
  const id = ORB_RUN_AUDIO_ASSET.win;
  pipeline.fileSystem.files.set(orbRunSourcePath(id), bytes);
  const result = await pipeline.service.reimport(id);
  return { id, result };
}

test("the WAV importer accepts WAVE_FORMAT_EXTENSIBLE whose sub-format is integer PCM (multi-channel, 24-bit)", async () => {
  const pipeline = await createOrbRunAssetPipeline();
  const wav = riff(fmtChunk({ tag: 0xfffe, channels: 6, rate: 48000, bits: 24, extensible: PCM_GUID }), chunk("data", samples(36)));
  const { id, result } = await importWav(pipeline, wav);
  assert.equal(result.status, "reimported", result.error);
  assert.equal(pipeline.database.get(id)!.metadata.sampleRate, 48000);
  assert.equal(pipeline.database.get(id)!.metadata.channels, 6);
  assert.deepEqual((result.diagnostics ?? []).map((d) => d.code), ["asset.wav.sampleRate"], "48 kHz is flagged against the authored 22.05 kHz");
});

test("the WAV importer rejects WAVE_FORMAT_EXTENSIBLE with a non-PCM sub-format or a truncated fmt chunk", async () => {
  const pipeline = await createOrbRunAssetPipeline();
  const float = [0x03, ...PCM_GUID.slice(1)];
  const cases: Array<[string, Uint8Array, RegExp]> = [
    ["float sub-format", riff(fmtChunk({ tag: 0xfffe, extensible: float }), chunk("data", samples(8))), /not PCM WAV \(extensible sub-format tag 3\)/],
    ["foreign GUID", riff(fmtChunk({ tag: 0xfffe, extensible: [...PCM_GUID.slice(0, 15), 0x72] }), chunk("data", samples(8))), /not PCM WAV/],
    ["fmt too short for the extension", riff(fmtChunk({ tag: 0xfffe, extensible: "short" }), chunk("data", samples(8))), /truncated WAVE_FORMAT_EXTENSIBLE/],
  ];
  for (const [label, bytes, expected] of cases) {
    const { result } = await importWav(pipeline, bytes);
    assert.equal(result.status, "failed", label);
    assert.match(result.error ?? "", expected, label);
  }
});

test("the WAV importer rejects an empty data chunk and bit depths that are not whole bytes", async () => {
  const pipeline = await createOrbRunAssetPipeline();
  const cases: Array<[string, Uint8Array, RegExp]> = [
    ["empty data", riff(fmtChunk(), chunk("data", [])), /empty data chunk/],
    ["12-bit samples", riff(fmtChunk({ bits: 12 }), chunk("data", samples(8))), /invalid fmt chunk/],
    ["4-bit samples", riff(fmtChunk({ bits: 4 }), chunk("data", samples(8))), /invalid fmt chunk/],
  ];
  for (const [label, bytes, expected] of cases) {
    const { result } = await importWav(pipeline, bytes);
    assert.equal(result.status, "failed", label);
    assert.match(result.error ?? "", expected, label);
  }
});

test("the WAV importer reads a data chunk with an odd size (pad byte) that comes before fmt", async () => {
  const pipeline = await createOrbRunAssetPipeline();
  const wav = riff(chunk("data", samples(5)), fmtChunk({ rate: 22050 }));
  const { id, result } = await importWav(pipeline, wav);
  assert.equal(result.status, "reimported", result.error);
  assert.deepEqual(result.diagnostics ?? [], []);
  assert.equal(pipeline.database.get(id)!.metadata.sampleRate, 22050);
});

async function reimportModel(settings: Record<string, unknown>, assetId: string = ORB_RUN_MODEL_ASSET.orb) {
  const pipeline = await createOrbRunAssetPipeline();
  const record = pipeline.database.get(assetId)!;
  pipeline.database.upsert({ ...record, recipe: { ...record.recipe, settings } });
  const result = await pipeline.service.reimport(assetId);
  return { pipeline, result, record: pipeline.database.get(assetId)! };
}

test("a malformed recipe.settings.size warns (orbrun.model.invalidDeclaredSize) instead of being ignored silently", async () => {
  const bad: unknown[] = [[1, 2], [1, 2, 3, 4], [-1, 1, 1], ["a", 1, 1], "0.6", 0.6, null, { x: 1 }];
  for (const size of bad) {
    const { result, record } = await reimportModel({ size });
    assert.equal(result.status, "reimported", String(size));
    assert.deepEqual(
      (result.diagnostics ?? []).map((d) => [d.severity, d.code]),
      [["warning", "orbrun.model.invalidDeclaredSize"]],
      `size ${String(size)}`,
    );
    assert.deepEqual(record.metadata.dimensions, [0.6, 0.6, 0.6], "the measured size is still recorded");
  }
});

test("an absent or well-formed recipe.settings.size adds no invalidDeclaredSize warning", async () => {
  for (const settings of [{}, { size: [0.6, 0.6, 0.6] }]) {
    const { result } = await reimportModel(settings);
    assert.deepEqual(result.diagnostics ?? [], [], JSON.stringify(settings));
  }
});

test("declared and measured sizes within the 1e-4 m tolerance are the same size; just past it warns", async () => {
  const inside = await reimportModel({ size: [0.60009, 0.6, 0.6] });
  assert.deepEqual(inside.result.diagnostics ?? [], []);
  const outside = await reimportModel({ size: [0.6002, 0.6, 0.6] });
  assert.deepEqual((outside.result.diagnostics ?? []).map((d) => d.code), ["orbrun.model.sizeMismatch"]);
});

/** Rewrites a GLB's JSON chunk (re-padded with spaces) so tests can break one field after the fact. */
function editGlbJson(glb: Uint8Array, edit: (json: Record<string, unknown>) => void): Uint8Array {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as Record<string, unknown>;
  edit(json);
  let text = JSON.stringify(json);
  while (text.length % 4 !== 0) text += " ";
  const jsonBytes = new TextEncoder().encode(text);
  const rest = glb.subarray(20 + jsonLength);
  const out = new Uint8Array(20 + jsonBytes.byteLength + rest.byteLength);
  out.set(glb.subarray(0, 20), 0);
  out.set(jsonBytes, 20);
  out.set(rest, 20 + jsonBytes.byteLength);
  const outView = new DataView(out.buffer);
  outView.setUint32(12, jsonBytes.byteLength, true);
  outView.setUint32(8, out.byteLength, true);
  return out;
}

async function reimportUnmeasurable(settings: Record<string, unknown>) {
  const pipeline = await createOrbRunAssetPipeline();
  const id = ORB_RUN_MODEL_ASSET.orb;
  const record = pipeline.database.get(id)!;
  pipeline.database.upsert({ ...record, recipe: { ...record.recipe, settings } });
  // The mesh is still in the file but no node in any scene uses it: a valid GLB with no measurable bounding box.
  const source = editGlbJson(pipeline.sources[id]!, (json) => {
    for (const node of json.nodes as Array<Record<string, unknown>>) delete node.mesh;
  });
  pipeline.fileSystem.files.set(orbRunSourcePath(id), source);
  const result = await pipeline.service.reimport(id);
  return { result, record: pipeline.database.get(id)! };
}

test("an unmeasurable model with a declared size records it with an orbrun.model.unmeasured warning", async () => {
  const { result, record } = await reimportUnmeasurable({ size: [0.6, 0.6, 0.6] });
  assert.equal(result.status, "reimported", result.error);
  assert.deepEqual((result.diagnostics ?? []).map((d) => [d.severity, d.code]), [["warning", "orbrun.model.unmeasured"]]);
  assert.deepEqual(record.metadata.dimensions, [0.6, 0.6, 0.6]);
});

test("an unmeasurable model with no declared size imports quietly and invents no dimensions warning", async () => {
  const { result, record } = await reimportUnmeasurable({});
  assert.equal(result.status, "reimported", result.error);
  assert.deepEqual(result.diagnostics ?? [], []);
  assert.equal(record.metadata.polycount, 12);
});
