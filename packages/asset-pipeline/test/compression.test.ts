import assert from "node:assert/strict";
import test from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import {
  DEFAULT_COMPRESSION_POLICY,
  RUNTIME_DECODER_CAPABILITIES,
  RUNTIME_KNOWN_GLTF_EXTENSIONS,
  checkGlbCompression,
  evaluateCompressionPolicy,
  inspectGlbCompression,
  type CompressionPolicy,
} from "../src/index.js";

/** Build a GLB whose JSON chunk is `json` (the BIN chunk is omitted). */
function glbFromJson(json: unknown): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const padded = Math.ceil(text.length / 4) * 4;
  const out = new Uint8Array(20 + padded);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, padded, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length);
  return out;
}

const asset = { version: "2.0" };

function codes(diagnostics: Array<{ code: string }>): string[] {
  return diagnostics.map((d) => d.code);
}

test("capability constants match the extension list the loader understands", () => {
  assert.equal(RUNTIME_DECODER_CAPABILITIES.meshopt, true);
  assert.equal(RUNTIME_DECODER_CAPABILITIES.draco, false);
  assert.equal(RUNTIME_DECODER_CAPABILITIES.ktx2, false);
  assert.ok(RUNTIME_KNOWN_GLTF_EXTENSIONS.includes("EXT_meshopt_compression"));
  assert.ok(Object.isFrozen(DEFAULT_COMPRESSION_POLICY));
});

test("plain GLB from glTF-Transform reports no compression and no diagnostics", async () => {
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute("POSITION", position);
  const mesh = document.createMesh().addPrimitive(primitive);
  document.createScene().addChild(document.createNode().setMesh(mesh));
  const bytes = await new NodeIO().writeBinary(document);

  const { report, diagnostics } = checkGlbCompression(bytes);
  assert.equal(report.parsed, true);
  assert.deepEqual(report.extensionsUsed, []);
  assert.equal(report.meshopt.bufferViews, 0);
  assert.equal(report.dracoPrimitives, 0);
  assert.equal(report.ktx2Textures, 0);
  assert.equal(report.uncompressedGeometryBytes, 36);
  assert.deepEqual(diagnostics, []);
});

test("malformed input never throws and yields structured errors", () => {
  const cases: Uint8Array[] = [
    new Uint8Array(0),
    new Uint8Array(12),
    (() => {
      const b = glbFromJson({ asset });
      new DataView(b.buffer).setUint32(0, 0x12345678, true);
      return b;
    })(),
    (() => {
      const b = glbFromJson({ asset });
      new DataView(b.buffer).setUint32(4, 1, true);
      return b;
    })(),
    (() => {
      const b = glbFromJson({ asset });
      new DataView(b.buffer).setUint32(16, 0x004e4942, true);
      return b;
    })(),
    (() => {
      const b = glbFromJson({ asset });
      new DataView(b.buffer).setUint32(12, 9999, true);
      return b;
    })(),
    (() => {
      const b = glbFromJson({ asset });
      b[20] = 0xff; // invalid utf-8
      return b;
    })(),
    glbFromJson([1, 2, 3]),
    glbFromJson("string"),
  ];
  for (const bytes of cases) {
    const { report, diagnostics } = checkGlbCompression(bytes);
    assert.equal(report.parsed, false);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.severity, "error");
    assert.match(diagnostics[0]?.code ?? "", /^asset\.compression\.(glb|json)\.invalid$/);
  }
  assert.doesNotThrow(() => inspectGlbCompression(null as unknown as Uint8Array));
  assert.equal(inspectGlbCompression(null as unknown as Uint8Array).parsed, false);
});

test("garbage in every JSON field is tolerated", () => {
  const bytes = glbFromJson({
    asset,
    extensionsUsed: "nope",
    extensionsRequired: [1, null, "KHR_texture_transform"],
    bufferViews: [null, 5, { extensions: "x" }, { extensions: { EXT_meshopt_compression: 7 } }],
    accessors: [null, { count: -1 }, { componentType: 5126, type: "VEC3", count: 1.5 }],
    meshes: [null, { primitives: [null, { attributes: 3, indices: "a", targets: [null, 4] }] }],
    textures: [null, { extensions: { KHR_texture_basisu: "x" } }],
    images: [null, { uri: 5 }, { bufferView: 99, mimeType: "image/png" }],
  });
  const { report, diagnostics } = checkGlbCompression(bytes);
  assert.equal(report.parsed, true);
  assert.deepEqual(report.extensionsRequired, ["KHR_texture_transform"]);
  assert.equal(report.meshopt.bufferViews, 1);
  assert.equal(report.uncompressedGeometryBytes, 0);
  assert.ok(codes(diagnostics).includes("asset.compression.meshopt.bufferView.invalid"));
});

function meshoptGlb(options: {
  required: boolean;
  declared?: boolean;
  extension?: Record<string, unknown>;
}): Uint8Array {
  const ext = options.extension ?? {
    buffer: 1,
    byteLength: 40,
    count: 3,
    byteStride: 12,
    mode: "ATTRIBUTES",
    filter: "NONE",
  };
  const json: Record<string, unknown> = {
    asset,
    extensionsUsed: options.declared === false ? [] : ["EXT_meshopt_compression"],
    extensionsRequired: options.required ? ["EXT_meshopt_compression"] : [],
    buffers: [{ byteLength: 4 }, { byteLength: 40 }],
    bufferViews: [{ buffer: 0, byteLength: 36, extensions: { EXT_meshopt_compression: ext } }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  };
  return glbFromJson(json);
}

test("valid Meshopt GLB is accepted and counted by the default policy", () => {
  const { report, diagnostics } = checkGlbCompression(meshoptGlb({ required: true }));
  assert.equal(report.meshopt.bufferViews, 1);
  assert.equal(report.meshopt.compressedBytes, 40);
  assert.equal(report.uncompressedGeometryBytes, 0, "meshopt accessors are not counted as uncompressed");
  assert.deepEqual(codes(diagnostics), ["asset.compression.meshopt.supported"]);
  assert.equal(diagnostics[0]?.severity, "info");
});

test("Meshopt GLB is an error when a policy says the runtime cannot decode it", () => {
  const policy: CompressionPolicy = {
    ...DEFAULT_COMPRESSION_POLICY,
    decoders: { meshopt: false, draco: false, ktx2: false },
  };
  const required = evaluateCompressionPolicy(inspectGlbCompression(meshoptGlb({ required: true })), policy);
  assert.equal(required.find((d) => d.code === "asset.compression.meshopt.runtimeUnsupported")?.severity, "error");
  const optional = evaluateCompressionPolicy(inspectGlbCompression(meshoptGlb({ required: false })), policy);
  assert.equal(optional.find((d) => d.code === "asset.compression.meshopt.runtimeUnsupported")?.severity, "warning");
});

test("invalid Meshopt extension fields are reported with bufferView path", () => {
  const bad: Array<Record<string, unknown>> = [
    { buffer: -1, byteLength: 40, count: 3, byteStride: 12, mode: "ATTRIBUTES" },
    { buffer: 1, byteLength: 1.5, count: 3, byteStride: 12, mode: "ATTRIBUTES" },
    { buffer: 1, byteLength: 40, count: 0, byteStride: 12, mode: "ATTRIBUTES" },
    { buffer: 1, byteLength: 40, count: 3, byteStride: 300, mode: "ATTRIBUTES" },
    { buffer: 1, byteLength: 40, count: 3, byteStride: 12, mode: "WRONG" },
    { buffer: 1, byteLength: 40, count: 4, byteStride: 4, mode: "TRIANGLES" },
    { buffer: 1, byteLength: 40, count: 3, byteStride: 6, mode: "ATTRIBUTES" },
    { buffer: 1, byteLength: 40, count: 3, byteStride: 12, mode: "ATTRIBUTES", filter: "SPIN" },
  ];
  for (const extension of bad) {
    const diagnostics = checkGlbCompression(meshoptGlb({ required: true, extension })).diagnostics;
    const found = diagnostics.find((d) => d.code === "asset.compression.meshopt.bufferView.invalid");
    assert.ok(found, JSON.stringify(extension));
    assert.equal(found?.severity, "error");
    assert.equal(found?.path, "bufferViews[0]");
  }
  const noObject = checkGlbCompression(meshoptGlb({ required: true, extension: 5 as never })).diagnostics;
  assert.ok(codes(noObject).includes("asset.compression.meshopt.bufferView.invalid"));
});

test("Meshopt used but not declared in extensionsUsed is an error", () => {
  const { diagnostics } = checkGlbCompression(meshoptGlb({ required: false, declared: false }));
  assert.ok(codes(diagnostics).includes("asset.compression.meshopt.undeclared"));
});

function dracoGlb(required: boolean): Uint8Array {
  return glbFromJson({
    asset,
    extensionsUsed: ["KHR_draco_mesh_compression"],
    extensionsRequired: required ? ["KHR_draco_mesh_compression"] : [],
    accessors: [{ componentType: 5126, count: 1000000, type: "VEC3" }],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0 },
            extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } },
          },
        ],
      },
    ],
  });
}

test("required Draco is an error because the runtime has no Draco decoder", () => {
  const { report, diagnostics } = checkGlbCompression(dracoGlb(true));
  assert.equal(report.dracoPrimitives, 1);
  assert.equal(report.uncompressedGeometryBytes, 0, "Draco primitives do not count accessor bytes");
  const draco = diagnostics.find((d) => d.code === "asset.compression.draco.runtimeUnsupported");
  assert.equal(draco?.severity, "error");
  assert.match(draco?.message ?? "", /Meshopt/);
  assert.equal(draco?.path, "extensionsRequired");
  assert.equal(codes(diagnostics).includes("asset.compression.extension.unknownRequired"), false);
});

test("optional Draco is only a warning", () => {
  const draco = checkGlbCompression(dracoGlb(false)).diagnostics.find(
    (d) => d.code === "asset.compression.draco.runtimeUnsupported",
  );
  assert.equal(draco?.severity, "warning");
  assert.equal(draco?.path, "extensionsUsed");
});

test("Draco enabled in policy turns the error into an info", () => {
  const policy: CompressionPolicy = {
    ...DEFAULT_COMPRESSION_POLICY,
    decoders: { meshopt: true, draco: true, ktx2: false },
  };
  const diagnostics = evaluateCompressionPolicy(inspectGlbCompression(dracoGlb(true)), policy);
  assert.deepEqual(codes(diagnostics), ["asset.compression.draco.supported"]);
});

function ktx2Glb(required: boolean): Uint8Array {
  return glbFromJson({
    asset,
    extensionsUsed: ["KHR_texture_basisu"],
    extensionsRequired: required ? ["KHR_texture_basisu"] : [],
    bufferViews: [{ buffer: 0, byteLength: 2000 }],
    textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }],
    images: [{ bufferView: 0, mimeType: "image/ktx2" }],
  });
}

test("required KTX2 texture is an error and counts embedded KTX2 bytes", () => {
  const { report, diagnostics } = checkGlbCompression(ktx2Glb(true));
  assert.equal(report.ktx2Textures, 1);
  assert.equal(report.embeddedImageBytes.ktx2, 2000);
  const ktx2 = diagnostics.find((d) => d.code === "asset.compression.ktx2.runtimeUnsupported");
  assert.equal(ktx2?.severity, "error");
  assert.equal(checkGlbCompression(ktx2Glb(false)).diagnostics.find((d) => d.code.endsWith("runtimeUnsupported"))?.severity, "warning");
});

test("KTX2 used without declaration is an error; undeclared draco likewise", () => {
  const bytes = glbFromJson({
    asset,
    textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }],
    images: [{ uri: "tex.ktx2" }],
    meshes: [{ primitives: [{ attributes: {}, extensions: { KHR_draco_mesh_compression: {} } }] }],
  });
  const diagnostics = checkGlbCompression(bytes).diagnostics;
  assert.ok(codes(diagnostics).includes("asset.compression.ktx2.undeclared"));
  assert.ok(codes(diagnostics).includes("asset.compression.draco.undeclared"));
});

test("unknown required extension is an error; known required extensions are fine", () => {
  const unknown = checkGlbCompression(
    glbFromJson({ asset, extensionsUsed: ["VENDOR_magic"], extensionsRequired: ["VENDOR_magic"] }),
  ).diagnostics;
  assert.equal(unknown.find((d) => d.code === "asset.compression.extension.unknownRequired")?.severity, "error");

  const known = checkGlbCompression(
    glbFromJson({
      asset,
      extensionsUsed: ["KHR_texture_transform", "KHR_mesh_quantization"],
      extensionsRequired: ["KHR_mesh_quantization"],
    }),
  ).diagnostics;
  assert.deepEqual(known, []);

  const notUsed = checkGlbCompression(glbFromJson({ asset, extensionsRequired: ["KHR_mesh_quantization"] })).diagnostics;
  assert.deepEqual(codes(notUsed), ["asset.compression.extension.requiredNotUsed"]);
});

test("large uncompressed geometry gets a Meshopt advisory; small does not", () => {
  const large = glbFromJson({
    asset,
    buffers: [{ byteLength: 900000 }],
    bufferViews: [
      { buffer: 0, byteLength: 360000 },
      { buffer: 0, byteOffset: 360000, byteLength: 360000 },
      { buffer: 0, byteOffset: 720000, byteLength: 180000 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 30000, type: "VEC3" },
      { bufferView: 1, componentType: 5126, count: 30000, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 90000, type: "SCALAR" },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
  });
  const { report, diagnostics } = checkGlbCompression(large);
  assert.equal(report.uncompressedGeometryBytes, 360000 + 360000 + 180000);
  assert.equal(diagnostics.find((d) => d.code === "asset.compression.geometry.uncompressedLarge")?.severity, "warning");

  const small = glbFromJson({
    asset,
    buffers: [{ byteLength: 1200 }],
    bufferViews: [{ buffer: 0, byteLength: 1200 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 100, type: "VEC3" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  });
  assert.deepEqual(checkGlbCompression(small).diagnostics, []);
});

test("shared accessors are counted once and morph targets are included", () => {
  const bytes = glbFromJson({
    asset,
    buffers: [{ byteLength: 240 }],
    bufferViews: [
      { buffer: 0, byteLength: 120 },
      { buffer: 0, byteOffset: 120, byteLength: 120 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 10, type: "VEC3" },
      { bufferView: 1, componentType: 5126, count: 10, type: "VEC3" },
    ],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0 }, targets: [{ POSITION: 1 }] },
          { attributes: { POSITION: 0 } },
        ],
      },
    ],
  });
  assert.equal(inspectGlbCompression(bytes).uncompressedGeometryBytes, 240);
});

test("embedded image bytes are measured from bufferViews and data URIs", () => {
  const bytes = glbFromJson({
    asset,
    bufferViews: [{ buffer: 0, byteLength: 1000 }],
    images: [
      { bufferView: 0, mimeType: "image/png" },
      { uri: `data:image/jpeg;base64,${"A".repeat(400)}` },
      { uri: "data:image/png,abcd" },
      { uri: "data:application/octet-stream;base64,AAAA" },
      { uri: "external.png" },
    ],
  });
  const report = inspectGlbCompression(bytes);
  assert.deepEqual(report.embeddedImageBytes, { png: 1004, jpeg: 300, ktx2: 0, other: 3 });
  assert.equal(report.externalImages, 1);
});

test("large embedded rasters only trigger a KTX2 advisory when KTX2 is decodable", () => {
  const bytes = glbFromJson({
    asset,
    bufferViews: [{ buffer: 0, byteLength: 2_000_000 }],
    images: [{ bufferView: 0, mimeType: "image/png" }],
  });
  const report = inspectGlbCompression(bytes);
  assert.deepEqual(evaluateCompressionPolicy(report), []);
  const withKtx2: CompressionPolicy = {
    ...DEFAULT_COMPRESSION_POLICY,
    decoders: { meshopt: true, draco: false, ktx2: true },
  };
  assert.ok(codes(evaluateCompressionPolicy(report, withKtx2)).includes("asset.compression.texture.uncompressedLarge"));
});

test("evaluating an unparsed report returns only its own diagnostics", () => {
  const report = inspectGlbCompression(new Uint8Array(3));
  assert.deepEqual(evaluateCompressionPolicy(report), report.diagnostics);
});

test("inspection is deterministic and does not mutate its input", () => {
  const bytes = meshoptGlb({ required: true });
  const copy = bytes.slice();
  const a = checkGlbCompression(bytes);
  const b = checkGlbCompression(bytes);
  assert.deepEqual(a, b);
  assert.deepEqual(bytes, copy);
});

test("works on a Uint8Array view with a non-zero byteOffset", () => {
  const inner = meshoptGlb({ required: true });
  const outer = new Uint8Array(inner.length + 8);
  outer.set(inner, 8);
  const view = outer.subarray(8);
  assert.equal(inspectGlbCompression(view).meshopt.bufferViews, 1);
});

test("Meshopt extension is checked against every EXT_meshopt_compression validity rule", () => {
  // Each entry violates exactly one rule of the ratified spec ("For the
  // extension object to be valid, the following must hold"). Before the fix
  // these were accepted and only failed later inside the runtime decoder.
  const parent = (byteLength: number, byteStride?: number): Record<string, unknown> => ({
    buffer: 0,
    byteLength,
    ...(byteStride !== undefined ? { byteStride } : {}),
  });
  const cases: Array<{ rule: string; view: Record<string, unknown>; ext: Record<string, unknown> }> = [
    {
      rule: "INDICES byteStride must be 2 or 4",
      view: parent(9),
      ext: { buffer: 1, byteLength: 8, count: 3, byteStride: 3, mode: "INDICES" },
    },
    {
      rule: "TRIANGLES byteStride must be 2 or 4",
      view: parent(24),
      ext: { buffer: 1, byteLength: 8, count: 3, byteStride: 8, mode: "TRIANGLES" },
    },
    {
      rule: "TRIANGLES/INDICES filter must be NONE",
      view: parent(12),
      ext: { buffer: 1, byteLength: 8, count: 3, byteStride: 4, mode: "INDICES", filter: "OCTAHEDRAL" },
    },
    {
      rule: "OCTAHEDRAL byteStride must be 4 or 8",
      view: parent(36),
      ext: { buffer: 1, byteLength: 8, count: 3, byteStride: 12, mode: "ATTRIBUTES", filter: "OCTAHEDRAL" },
    },
    {
      rule: "QUATERNION byteStride must be 8",
      view: parent(12),
      ext: { buffer: 1, byteLength: 8, count: 3, byteStride: 4, mode: "ATTRIBUTES", filter: "QUATERNION" },
    },
    {
      rule: "parent byteLength must equal byteStride * count",
      view: parent(40),
      ext: { buffer: 1, byteLength: 8, count: 3, byteStride: 12, mode: "ATTRIBUTES" },
    },
    {
      rule: "parent byteStride must match the extension byteStride",
      view: parent(36, 16),
      ext: { buffer: 1, byteLength: 8, count: 3, byteStride: 12, mode: "ATTRIBUTES" },
    },
  ];
  for (const { rule, view, ext } of cases) {
    const json = {
      asset,
      extensionsUsed: ["EXT_meshopt_compression"],
      extensionsRequired: ["EXT_meshopt_compression"],
      buffers: [{ byteLength: 64 }, { byteLength: 8 }],
      bufferViews: [{ ...view, extensions: { EXT_meshopt_compression: ext } }],
    };
    const found = checkGlbCompression(glbFromJson(json)).diagnostics.find(
      (d) => d.code === "asset.compression.meshopt.bufferView.invalid",
    );
    assert.ok(found, `expected a diagnostic for: ${rule}`);
    assert.equal(found?.severity, "error", rule);
  }

  // Spec-valid combinations stay clean.
  const valid: Array<{ view: Record<string, unknown>; ext: Record<string, unknown> }> = [
    { view: parent(6), ext: { buffer: 1, byteLength: 8, count: 3, byteStride: 2, mode: "TRIANGLES" } },
    { view: parent(20), ext: { buffer: 1, byteLength: 8, count: 5, byteStride: 4, mode: "INDICES", filter: "NONE" } },
    { view: parent(24, 8), ext: { buffer: 1, byteLength: 8, count: 3, byteStride: 8, mode: "ATTRIBUTES", filter: "OCTAHEDRAL" } },
    { view: parent(24), ext: { buffer: 1, byteLength: 8, count: 3, byteStride: 8, mode: "ATTRIBUTES", filter: "QUATERNION" } },
    { view: parent(36), ext: { buffer: 1, byteLength: 8, count: 3, byteStride: 12, mode: "ATTRIBUTES", filter: "EXPONENTIAL" } },
  ];
  for (const { view, ext } of valid) {
    const json = {
      asset,
      extensionsUsed: ["EXT_meshopt_compression"],
      buffers: [{ byteLength: 64 }, { byteLength: 8 }],
      bufferViews: [{ ...view, extensions: { EXT_meshopt_compression: ext } }],
    };
    const diagnostics = checkGlbCompression(glbFromJson(json)).diagnostics;
    assert.ok(
      !codes(diagnostics).includes("asset.compression.meshopt.bufferView.invalid"),
      `unexpected diagnostic for ${JSON.stringify(ext)}: ${JSON.stringify(diagnostics)}`,
    );
  }
});

test("base64 data URI image size excludes '=' padding", () => {
  // 4 PNG signature bytes + 1 byte = 5 bytes -> "iVBORwA=" (one pad char).
  // 4 bytes -> "iVBORw==" (two pad chars).
  const five = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]).toString("base64");
  const four = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  assert.ok(five.endsWith("=") && !five.endsWith("=="));
  assert.ok(four.endsWith("=="));
  const report = inspectGlbCompression(
    glbFromJson({
      asset,
      images: [
        { uri: `data:image/png;base64,${five}` },
        { uri: `data:image/png;base64,${four}` },
      ],
    }),
  );
  assert.equal(report.embeddedImageBytes.png, 9);
});

test("accessors without a bufferView do not count as stored geometry; sparse payload does", () => {
  const report = inspectGlbCompression(
    glbFromJson({
      asset,
      buffers: [{ byteLength: 1024 }],
      bufferViews: [
        { buffer: 0, byteLength: 36 },
        { buffer: 0, byteLength: 4 },
        { buffer: 0, byteLength: 24 },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
        // Morph target delta stored only as two sparse entries: base is all zeros.
        {
          componentType: 5126,
          count: 1000,
          type: "VEC3",
          sparse: {
            count: 2,
            indices: { bufferView: 1, componentType: 5121 },
            values: { bufferView: 2 },
          },
        },
        // Fully implicit (no bufferView, no sparse): zero bytes in the file.
        { componentType: 5126, count: 1000, type: "VEC3" },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 1 }, { NORMAL: 2 }] }] }],
    }),
  );
  // 36 (dense POSITION) + 2 * 1 (sparse indices) + 2 * 12 (sparse values) = 62.
  assert.equal(report.uncompressedGeometryBytes, 62);
});
