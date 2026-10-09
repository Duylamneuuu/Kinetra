import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateBundleBudget, findInitialChunks, measureBundle } from "./bundle-budget.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(
  await readFile(join(repoRoot, ".kinetra", "bundle-budget.json"), "utf8"),
);

const files = await measureBundle(join(repoRoot, config.assetsDir));
let initialChunks;
if (config.entryHtml) {
  initialChunks = findInitialChunks(await readFile(join(repoRoot, config.entryHtml), "utf8"));
}
const result = evaluateBundleBudget(files, config.budgets, initialChunks);

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
console.log(`Kinetra bundle size (${config.assetsDir}):`);
for (const file of files) {
  console.log(`- ${file.name}: ${kb(file.rawBytes)} raw, ${kb(file.gzipBytes)} gzip`);
}
for (const [metric, value] of Object.entries(result.metrics)) {
  const budget = config.budgets[metric];
  const pct = budget ? ` (${((value / budget) * 100).toFixed(1)}% of ${kb(budget)})` : "";
  console.log(`  ${metric}: ${kb(value)}${pct}`);
}

if (!result.ok) {
  console.error(JSON.stringify({ ok: false, violations: result.violations }, null, 2));
  console.error("Bundle budget exceeded. Shrink the bundle or raise .kinetra/bundle-budget.json deliberately.");
  process.exitCode = 1;
} else {
  console.log("Kinetra bundle budget passed.");
}
