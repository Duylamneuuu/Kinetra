/** Where `capture.frame` with `saveArtifact` writes a PNG. The Node entry registers a disk writer. */
export interface PngArtifactWriter {
  write(directory: string, fileName: string, bytes: Uint8Array): Promise<void>;
}

let installed: PngArtifactWriter | undefined;

export function setPngArtifactWriter(writer: PngArtifactWriter): void {
  installed = writer;
}

export async function writePngArtifact(directory: string, fileName: string, bytes: Uint8Array): Promise<void> {
  if (!installed) {
    throw new Error(
      "[verification.artifact.noWriter] No PNG artifact writer is registered. Import @kinetra/verification so the Node entry can write files, or call setPngArtifactWriter.",
    );
  }
  await installed.write(directory, fileName, bytes);
}
