/**
 * Asset browser model: a pure, read-only, deterministic description of what the observer editor's
 * asset panel shows. It reshapes asset-database records (the shape `@kinetra/asset-pipeline` stores,
 * declared structurally here so the editor does not depend on the pipeline package) into entries
 * grouped by kind and folder, with an import status and the dependency graph.
 *
 * It never reads the file system and never writes anything; re-import and other mutations stay on
 * their own paths (the asset coordinator / command bus). The caller supplies what only the host
 * knows (the content hash each source file has on disk right now) through `currentSourceHashes`.
 *
 * Status rules, strongest first:
 * - `failed`: an `error` diagnostic on the record, a dependency id that is not in the database, or
 *   membership of a dependency cycle (a cycle can never be rebuilt in a valid order).
 * - `stale`: the source file's current hash differs from the one the record was imported from, or any
 *   (transitive) dependency is failed or stale, because the asset has to be rebuilt after it.
 * - `fresh`: none of the above.
 *
 * Malformed records never throw: they are skipped and reported in `invalid`.
 */
export type AssetImportStatus = "fresh" | "stale" | "failed";

export type AssetBrowserIssueCode =
  | "asset.diagnostic.error"
  | "asset.dependency.missing"
  | "asset.dependency.cycle"
  | "asset.dependency.failed"
  | "asset.dependency.stale"
  | "asset.source.changed";

export interface AssetBrowserIssue {
  code: AssetBrowserIssueCode;
  message: string;
  /** Asset ids involved (the missing id, the failed/stale dependency, the other cycle members). */
  assetIds?: string[];
}

/** The slice of an asset record the browser reads. `AssetRecord` from the pipeline satisfies it. */
export interface AssetBrowserRecord {
  id: string;
  kind: string;
  source: { path: string; contentHash: string };
  importedPath: string;
  dependencies: readonly string[];
  diagnostics?: readonly { severity: string; code?: string; message?: string }[];
}

export interface AssetBrowserOptions {
  /**
   * Content hash each source file has on disk right now, keyed by `source.path`. A path that is
   * absent is not checked (the host did not look); a differing hash marks the asset stale.
   */
  currentSourceHashes?: Readonly<Record<string, string>>;
}

export interface AssetBrowserEntry {
  id: string;
  kind: string;
  /** File name of the source (last path segment). */
  name: string;
  /** Folder of the source file, `/`-separated, "" for the project root. */
  folder: string;
  sourcePath: string;
  importedPath: string;
  status: AssetImportStatus;
  issues: AssetBrowserIssue[];
  /** Direct dependencies, de-duplicated and sorted. */
  dependencies: string[];
  /** Direct dependencies that are not in the database. */
  missingDependencies: string[];
  /** Assets that directly depend on this one, sorted. */
  dependents: string[];
  inCycle: boolean;
  diagnosticCounts: { info: number; warning: number; error: number };
}

export interface AssetBrowserGroup {
  /** The kind, or the folder path. */
  key: string;
  assetIds: string[];
}

export interface AssetBrowserInvalid {
  /** Position in the input array. */
  index: number;
  id?: string;
  message: string;
}

export interface AssetBrowserModel {
  /** Every valid asset, sorted by id (UTF-16 order, locale independent). */
  entries: AssetBrowserEntry[];
  byKind: AssetBrowserGroup[];
  byFolder: AssetBrowserGroup[];
  summary: { total: number; fresh: number; stale: number; failed: number };
  /** Records that were skipped (not an object, id/kind/source/dependencies malformed, duplicate id). */
  invalid: AssetBrowserInvalid[];
}

export interface AssetBrowserFilter {
  kinds?: readonly string[];
  statuses?: readonly AssetImportStatus[];
  /** Exact folder match (use "" for the root). */
  folder?: string;
  /** Case-insensitive substring of id, source path or imported path. */
  search?: string;
}

const KIND_ORDER = ["model", "texture", "audio", "animation", "other"] as const;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function splitSourcePath(path: string): { name: string; folder: string } {
  const segments = path.replace(/\\/g, "/").split("/").filter((segment) => segment.length > 0 && segment !== ".");
  const name = segments.pop() ?? path;
  return { name, folder: segments.join("/") };
}

function kindRank(kind: string): number {
  const index = (KIND_ORDER as readonly string[]).indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
}

function validateRecord(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) return "asset record must be an object";
  const candidate = record as Partial<AssetBrowserRecord>;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return "asset id must be a non-empty string";
  if (typeof candidate.kind !== "string") return "asset kind must be a string";
  const source = candidate.source as { path?: unknown; contentHash?: unknown } | undefined;
  if (typeof source !== "object" || source === null || typeof source.path !== "string") {
    return "asset source.path must be a string";
  }
  if (typeof source.contentHash !== "string") return "asset source.contentHash must be a string";
  if (typeof candidate.importedPath !== "string") return "asset importedPath must be a string";
  if (!Array.isArray(candidate.dependencies) || candidate.dependencies.some((dep) => typeof dep !== "string")) {
    return "asset dependencies must be an array of asset id strings";
  }
  if (candidate.diagnostics !== undefined && !Array.isArray(candidate.diagnostics)) {
    return "asset diagnostics must be an array when present";
  }
  return undefined;
}

/**
 * Strongly connected components with more than one member, or a single member that depends on
 * itself. Iterative Tarjan so a long dependency chain cannot overflow the call stack.
 */
function findCycleMembers(graph: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result = new Map<string, string[]>();
  let counter = 0;

  for (const root of [...graph.keys()].sort(compareText)) {
    if (index.has(root)) continue;
    const work: Array<{ node: string; edges: string[]; next: number }> = [];
    const enter = (node: string): void => {
      index.set(node, counter);
      lowlink.set(node, counter);
      counter += 1;
      stack.push(node);
      onStack.add(node);
      work.push({ node, edges: (graph.get(node) ?? []).filter((dep) => graph.has(dep)), next: 0 });
    };
    enter(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      if (frame.next < frame.edges.length) {
        const target = frame.edges[frame.next]!;
        frame.next += 1;
        if (!index.has(target)) {
          enter(target);
        } else if (onStack.has(target)) {
          lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, index.get(target)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) lowlink.set(parent.node, Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!));
      if (lowlink.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let member: string | undefined;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        const selfLoop = component.length === 1 && (graph.get(component[0]!) ?? []).includes(component[0]!);
        if (component.length > 1 || selfLoop) {
          const members = component.sort(compareText);
          for (const id of members) result.set(id, members);
        }
      }
    }
  }
  return result;
}

export function buildAssetBrowser(
  records: readonly AssetBrowserRecord[],
  options: AssetBrowserOptions = {},
): AssetBrowserModel {
  const invalid: AssetBrowserInvalid[] = [];
  const valid = new Map<string, AssetBrowserRecord>();
  const input: readonly unknown[] = Array.isArray(records) ? records : [];
  if (!Array.isArray(records)) invalid.push({ index: -1, message: "asset records must be an array" });

  input.forEach((record, index) => {
    const problem = validateRecord(record);
    if (problem) {
      const id = (record as { id?: unknown } | null)?.id;
      invalid.push({ index, ...(typeof id === "string" ? { id } : {}), message: problem });
      return;
    }
    const typed = record as AssetBrowserRecord;
    if (valid.has(typed.id)) {
      invalid.push({ index, id: typed.id, message: `duplicate asset id "${typed.id}" (first occurrence kept)` });
      return;
    }
    valid.set(typed.id, typed);
  });

  const graph = new Map<string, string[]>();
  for (const [id, record] of valid) graph.set(id, sortedUnique(record.dependencies));
  const dependents = new Map<string, string[]>();
  for (const id of graph.keys()) dependents.set(id, []);
  for (const [id, deps] of graph) for (const dep of deps) dependents.get(dep)?.push(id);

  const cycles = findCycleMembers(graph);
  const hashes = options.currentSourceHashes ?? {};

  const issues = new Map<string, AssetBrowserIssue[]>();
  const failedRoots: string[] = [];
  const staleRoots: string[] = [];
  const counts = new Map<string, { info: number; warning: number; error: number }>();

  for (const id of [...valid.keys()].sort(compareText)) {
    const record = valid.get(id)!;
    const own: AssetBrowserIssue[] = [];
    const tally = { info: 0, warning: 0, error: 0 };
    for (const diagnostic of record.diagnostics ?? []) {
      const severity = (diagnostic as { severity?: unknown } | null)?.severity;
      if (severity === "info" || severity === "warning" || severity === "error") tally[severity] += 1;
    }
    counts.set(id, tally);
    if (tally.error > 0) {
      own.push({
        code: "asset.diagnostic.error",
        message: `${tally.error} error diagnostic${tally.error === 1 ? "" : "s"} from the last import`,
      });
    }
    const missing = (graph.get(id) ?? []).filter((dep) => !valid.has(dep));
    if (missing.length > 0) {
      own.push({
        code: "asset.dependency.missing",
        message: `depends on ${missing.length} asset${missing.length === 1 ? "" : "s"} that are not in the database`,
        assetIds: missing,
      });
    }
    const cycle = cycles.get(id);
    if (cycle) {
      own.push({
        code: "asset.dependency.cycle",
        message: "part of a dependency cycle",
        assetIds: cycle.filter((member) => member !== id),
      });
    }
    if (own.length > 0) failedRoots.push(id);
    const current = Object.prototype.hasOwnProperty.call(hashes, record.source.path)
      ? hashes[record.source.path]
      : undefined;
    if (typeof current === "string" && current !== record.source.contentHash) {
      own.push({
        code: "asset.source.changed",
        message: `source "${record.source.path}" changed since it was imported`,
      });
      staleRoots.push(id);
    }
    issues.set(id, own);
  }

  // Propagate to dependents: failed upstream -> stale, stale upstream -> stale. Plain BFS over the
  // reverse edges with a visited set, so cycles terminate.
  const propagate = (roots: readonly string[], code: "asset.dependency.failed" | "asset.dependency.stale"): void => {
    const causes = new Map<string, Set<string>>();
    for (const root of roots) {
      const seen = new Set<string>([root]);
      const queue = [root];
      for (let head = 0; head < queue.length; head += 1) {
        const current = queue[head]!;
        for (const dependent of dependents.get(current) ?? []) {
          if (seen.has(dependent)) continue;
          seen.add(dependent);
          queue.push(dependent);
          if (!causes.has(dependent)) causes.set(dependent, new Set());
          causes.get(dependent)!.add(root);
        }
      }
    }
    for (const [id, rootsFor] of causes) {
      const list = sortedUnique(rootsFor);
      issues.get(id)!.push({
        code,
        message: `${code === "asset.dependency.failed" ? "a dependency failed" : "a dependency is stale"}; rebuild after it`,
        assetIds: list.filter((root) => root !== id),
      });
    }
  };
  propagate(failedRoots, "asset.dependency.failed");
  propagate(staleRoots, "asset.dependency.stale");

  const entries: AssetBrowserEntry[] = [];
  for (const id of [...valid.keys()].sort(compareText)) {
    const record = valid.get(id)!;
    const own = issues.get(id)!;
    const hasFailure = own.some(
      (issue) =>
        issue.code === "asset.diagnostic.error" ||
        issue.code === "asset.dependency.missing" ||
        issue.code === "asset.dependency.cycle",
    );
    const status: AssetImportStatus = hasFailure ? "failed" : own.length > 0 ? "stale" : "fresh";
    const { name, folder } = splitSourcePath(record.source.path);
    own.sort((a, b) => compareText(a.code, b.code));
    entries.push({
      id,
      kind: record.kind,
      name,
      folder,
      sourcePath: record.source.path,
      importedPath: record.importedPath,
      status,
      issues: own,
      dependencies: graph.get(id) ?? [],
      missingDependencies: (graph.get(id) ?? []).filter((dep) => !valid.has(dep)),
      dependents: sortedUnique(dependents.get(id) ?? []),
      inCycle: cycles.has(id),
      diagnosticCounts: counts.get(id)!,
    });
  }

  const group = (keyOf: (entry: AssetBrowserEntry) => string, order: (a: string, b: string) => number) => {
    const buckets = new Map<string, string[]>();
    for (const entry of entries) {
      const key = keyOf(entry);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(entry.id);
    }
    return [...buckets.keys()].sort(order).map((key) => ({ key, assetIds: buckets.get(key)! }));
  };

  return {
    entries,
    byKind: group(
      (entry) => entry.kind,
      (a, b) => kindRank(a) - kindRank(b) || compareText(a, b),
    ),
    byFolder: group((entry) => entry.folder, compareText),
    summary: {
      total: entries.length,
      fresh: entries.filter((entry) => entry.status === "fresh").length,
      stale: entries.filter((entry) => entry.status === "stale").length,
      failed: entries.filter((entry) => entry.status === "failed").length,
    },
    invalid,
  };
}

/** Entries matching every given criterion, in the model's stable order. Pure; never mutates. */
export function filterAssetBrowser(model: AssetBrowserModel, filter: AssetBrowserFilter): AssetBrowserEntry[] {
  const needle = typeof filter.search === "string" ? filter.search.toLowerCase() : undefined;
  return model.entries.filter((entry) => {
    if (filter.kinds && !filter.kinds.includes(entry.kind)) return false;
    if (filter.statuses && !filter.statuses.includes(entry.status)) return false;
    if (filter.folder !== undefined && entry.folder !== filter.folder) return false;
    if (needle !== undefined && needle.length > 0) {
      const haystack = `${entry.id}\n${entry.sourcePath}\n${entry.importedPath}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}
