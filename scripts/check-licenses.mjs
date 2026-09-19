import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const storeRoot = join(repoRoot, "node_modules", ".pnpm");
const policy = JSON.parse(
  await readFile(join(repoRoot, ".kinetra", "license-policy.json"), "utf8"),
);

const allowed = new Set(policy.allowed ?? []);
const allowedWithNotice = new Set(policy.allowedWithNotice ?? []);
const referenceOnly = new Set(policy.referenceOnly ?? []);

function splitExpression(expression) {
  if (
    allowed.has(expression) ||
    allowedWithNotice.has(expression) ||
    referenceOnly.has(expression)
  ) {
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
    return { ok: false, reason: "reference-only", tokens, notice: false };
  }

  if (
    tokens.length > 0 &&
    tokens.every((token) => allowed.has(token) || allowedWithNotice.has(token))
  ) {
    return {
      ok: true,
      reason: "allowed",
      tokens,
      notice: tokens.some((token) => allowedWithNotice.has(token)),
    };
  }

  return { ok: false, reason: "unreviewed", tokens, notice: false };
}

function isInstalledPackageRoot(packageJsonPath, packageName) {
  const rel = relative(storeRoot, packageJsonPath);
  const parts = rel.split(sep);
  const nodeModulesIndex = parts.lastIndexOf("node_modules");

  if (nodeModulesIndex < 0) {
    return false;
  }

  const tail = parts.slice(nodeModulesIndex + 1);
  const expected = packageName.startsWith("@")
    ? [...packageName.split("/"), "package.json"]
    : [packageName, "package.json"];

  return (
    tail.length === expected.length &&
    tail.every((segment, index) => segment === expected[index])
  );
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

let packageFiles;
try {
  packageFiles = await collectPackageJsonFiles(storeRoot);
} catch (error) {
  throw new Error(
    `Unable to scan installed dependencies. Run "pnpm install" first. Cause: ${
      error instanceof Error ? error.message : String(error)
    }`,
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

  if (
    typeof parsed.name !== "string" ||
    typeof parsed.version !== "string" ||
    !isInstalledPackageRoot(path, parsed.name)
  ) {
    continue;
  }

  const key = `${parsed.name}@${parsed.version}`;

  if (!packages.has(key)) {
    packages.set(key, {
      name: parsed.name,
      version: parsed.version,
      license: typeof parsed.license === "string" ? parsed.license.trim() : null,
      path,
    });
  }
}

const failures = [];
const notices = [];

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
    continue;
  }

  if (classification.notice) {
    notices.push(dependency);
  }
}

if (notices.length > 0) {
  console.log("Kinetra dependencies requiring attribution/notice review:");
  for (const dependency of notices) {
    console.log(
      `- ${dependency.name}@${dependency.version}: ${dependency.license}`,
    );
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
  console.log(
    `Kinetra license policy passed for ${packages.size} installed package roots.`,
  );
}
