import { formatOrbRunSuiteReport, orbRunAcceptanceDirectory, runOrbRunAcceptanceSuite } from "./acceptance-suite.js";

/**
 * `pnpm --filter @kinetra/example-orb-run acceptance [--json] [directory]`: runs every Orb Run acceptance manifest
 * headless and exits 0 only when all pass (1: a manifest failed, 2: bad arguments). `--json` prints the structured
 * report instead of the text lines, for agents and CI.
 */
const args = process.argv.slice(2);
const json = args.includes("--json");
const positional = args.filter((arg) => arg !== "--json");
if (positional.length > 1 || positional.some((arg) => arg.startsWith("-"))) {
  console.error("usage: acceptance [--json] [directory]");
  process.exit(2);
}

const report = await runOrbRunAcceptanceSuite(positional[0] ?? orbRunAcceptanceDirectory());
console.log(json ? JSON.stringify(report, null, 2) : formatOrbRunSuiteReport(report));
process.exit(report.passed ? 0 : 1);
