import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const policy = JSON.parse(
  await readFile(new URL("../.kinetra/license-policy.json", import.meta.url), "utf8"),
);

const allowed = new Set(policy.allowed);
const referenceOnly = new Set(policy.referenceOnly);

function splitExpression(expression) {
  if (allowed.has(expression) || referenceOnly.has(expression)) {
    return [expression];
  }

  if (/\bWITH\b/i.test(expression)) {
    return [expression];
  }

  return expression
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|AND)\s+/i)
    .map((token) => token.trim())
    .filter(Boolean);
}

function classify(expression) {
  const tokens = splitExpression(expression);

  if (tokens.some((token) => referenceOnly.has(token))) {
    return { ok: false, reason: "reference-only", tokens };
  }

  if (tokens.length > 0 && tokens.every((token) => allowed.has(token))) {
    return { ok: true, reason: "allowed", tokens };
  }

  return { ok: false, reason: "unreviewed", tokens };
}

async function collectPackageJsonFiles(root) {
  const results = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const fullPath = join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name === "package.json") {
        results.push(fullPath);
      }
    }
  }

  await walk(root);
  return results;
}

const storeRoot = fileURLToPath(new URL("../node_modules/.pnpm/", import.meta.url));

let packageFiles;
try {
  packageFiles = await collectPackageJsonFiles(storeRoot);
} catch (error) {
  throw new Error(
    `Unable to scan installed dependencies. Run "pnpm install" first. Cause: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const packages = new Map();

for (const path of packageFiles) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    continue;
  }

  if (typeof parsed.name !== "string" || typeof parsed.version !== "string") {
    continue;
  }

  const key = `${parsed.name}@${parsed.version}`;

  if (!packages.has(key)) {
    packages.set(key, {
      name: parsed.name,
      version: parsed.version,
      license: typeof parsed.license === "string" ? parsed.license.trim() : null,
    });
  }
}

const failures = [];

for (const dependency of [...packages.values()].sort((a, b) =>
  `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
)) {
  if (!dependency.license) {
    failures.push({ ...dependency, reason: "missing-license" });
    continue;
  }

  const classification = classify(dependency.license);
  if (!classification.ok) {
    failures.push({
      ...dependency,
      reason: classification.reason,
      tokens: classification.tokens,
    });
  }
}

if (failures.length > 0) {
  console.error("Kinetra dependency license policy failed:");
  for (const failure of failures) {
    console.error(
      `- ${failure.name}@${failure.version}: ${failure.license ?? "<missing>"} (${failure.reason})`,
    );
  }
  process.exitCode = 1;
} else {
  console.log(`Kinetra license policy passed for ${packages.size} installed packages.`);
}
