import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class InfrastructureError extends Error {
  readonly code: string;

  constructor(message: string, code = "INFRASTRUCTURE_ERROR") {
    super(message);
    this.name = "InfrastructureError";
    this.code = code;
  }
}

export function findRepositoryRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

export interface PackagedExecutableResolution {
  path: string;
  source: "env" | "repository";
}

export function resolvePackagedExecutable(): PackagedExecutableResolution {
  if (process.env.KINETRA_RUNTIME_EXECUTABLE) {
    const envPath = resolve(process.env.KINETRA_RUNTIME_EXECUTABLE);
    if (existsSync(envPath)) {
      return { path: envPath, source: "env" };
    }
    throw new InfrastructureError(
      `Configured KINETRA_RUNTIME_EXECUTABLE not found: ${envPath}`,
      "CONFIGURED_EXECUTABLE_NOT_FOUND",
    );
  }

  const repoRoot = findRepositoryRoot();
  const repoCandidate = resolve(
    repoRoot,
    "apps/player/release/KinetraGame-win32-x64/KinetraGame.exe",
  );

  if (existsSync(repoCandidate)) {
    return { path: repoCandidate, source: "repository" };
  }

  throw new InfrastructureError(
    `Packaged executable not found at "${repoCandidate}". Build it first with: pnpm --filter @kinetra/player package:win`,
    "PACKAGED_EXECUTABLE_NOT_FOUND",
  );
}

export function isPackagedExecutableAvailable(): boolean {
  try {
    resolvePackagedExecutable();
    return true;
  } catch {
    return false;
  }
}
