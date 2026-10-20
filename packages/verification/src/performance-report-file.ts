import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { PerformanceReport } from "./performance.js";

/** Writes a performance report as pretty JSON, creating parent directories. Node-only. */
export async function writePerformanceReport(
  filePath: string,
  report: PerformanceReport,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(report, null, 2), "utf8");
}
