import { NodeIO } from "@gltf-transform/core";
import { dedup, prune, resample } from "@gltf-transform/functions";

export interface NormalizeGlbResult {
  bytes: Uint8Array;
  beforeBytes: number;
  afterBytes: number;
}

export async function normalizeGlb(bytes: Uint8Array): Promise<NormalizeGlbResult> {
  const io = new NodeIO();
  const document = await io.readBinary(bytes);

  await document.transform(
    resample(),
    prune(),
    dedup(),
  );

  const output = await io.writeBinary(document);

  return {
    bytes: output,
    beforeBytes: bytes.byteLength,
    afterBytes: output.byteLength,
  };
}
