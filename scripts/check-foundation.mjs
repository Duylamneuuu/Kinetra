import { access, readFile } from "node:fs/promises";

const required = [
  "README.md",
  "VISION.md",
  "AGENTS.md",
  "ARCHITECTURE.md",
  "ROADMAP.md",
  "LICENSE-POLICY.md",
  "docs/principles/AI_FIRST.md",
  "docs/architecture/COMMAND_API.md",
  "docs/architecture/ASSET_PIPELINE.md",
  "docs/architecture/VERIFICATION.md",
  "agents/engine-guide/three.md"
];

for (const path of required) {
  await access(path);
}

JSON.parse(await readFile("package.json", "utf8"));
JSON.parse(await readFile("tsconfig.base.json", "utf8"));

console.log("Kinetra foundation checks passed.");
