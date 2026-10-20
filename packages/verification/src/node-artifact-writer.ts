import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { setPngArtifactWriter } from "./artifact-writer.js";

setPngArtifactWriter({
  async write(directory, fileName, bytes) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, fileName), bytes);
  },
});
