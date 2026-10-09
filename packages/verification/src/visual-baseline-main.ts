import { runVisualBaselineCli } from "./visual-baseline-cli.js";

// Entry point for `pnpm --filter @kinetra/verification visual-baseline <check|update> ...`.
process.exitCode = await runVisualBaselineCli(process.argv.slice(2));
