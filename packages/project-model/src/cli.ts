import { readFile } from "node:fs/promises";

import { reportProjectText } from "./project-file.js";

const filePath = process.argv[2];
if (process.argv.length !== 3 || filePath === undefined || filePath.length === 0) {
  process.stderr.write("Usage: node packages/project-model/dist/src/cli.js <project.kinetra.json>\n");
  process.exitCode = 2;
} else {
  try {
    const text = await readFile(filePath, "utf8");
    const report = reportProjectText(text);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `${JSON.stringify({ ok: false, message: `Cannot read project file: ${message}` }, null, 2)}\n`,
    );
    process.exitCode = 1;
  }
}
