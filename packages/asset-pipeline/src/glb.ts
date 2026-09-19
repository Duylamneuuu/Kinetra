export interface GlbHeader {
  magic: number;
  version: number;
  length: number;
}

const GLB_MAGIC = 0x46546c67;

export function inspectGlb(bytes: Uint8Array): GlbHeader {
  if (bytes.byteLength < 12) throw new Error("GLB is smaller than its 12-byte header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = {
    magic: view.getUint32(0, true),
    version: view.getUint32(4, true),
    length: view.getUint32(8, true),
  };
  if (header.magic !== GLB_MAGIC) throw new Error("Invalid GLB magic");
  if (header.version !== 2) throw new Error(`Unsupported GLB version ${header.version}`);
  if (header.length !== bytes.byteLength) {
    throw new Error(`GLB declared length ${header.length} does not match ${bytes.byteLength}`);
  }
  return header;
}
