import type { AssetDatabaseDocument, AssetRecord } from "./types.js";

/**
 * UTF-16 code-unit comparison. `localeCompare` depends on the host ICU/locale, which would make the
 * serialized database and the rebuild order differ between machines.
 */
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class AssetDatabase {
  #records = new Map<string, AssetRecord>();

  constructor(document: AssetDatabaseDocument = { schemaVersion: 1, assets: [] }) {
    if (document.schemaVersion !== 1) {
      throw new Error(`Unsupported asset database schema ${String(document.schemaVersion)}`);
    }
    for (const asset of document.assets) this.upsert(asset);
  }

  upsert(record: AssetRecord): void {
    if (!record.id) throw new Error("Asset id is required");
    if (record.dependencies.includes(record.id)) {
      throw new Error(`Asset "${record.id}" cannot depend on itself`);
    }
    const previous = this.#records.get(record.id);
    this.#records.set(record.id, structuredClone(record));
    try {
      this.#assertAcyclic();
    } catch (error) {
      // A rejected upsert must leave the database exactly as it was; otherwise
      // the cyclic record stays stored and every later upsert throws too.
      if (previous) this.#records.set(record.id, previous);
      else this.#records.delete(record.id);
      throw error;
    }
  }

  get(id: string): AssetRecord | undefined {
    const value = this.#records.get(id);
    return value ? structuredClone(value) : undefined;
  }

  list(): AssetRecord[] {
    return [...this.#records.values()]
      .map((value) => structuredClone(value))
      .sort((a, b) => compareIds(a.id, b.id));
  }

  dependentsOf(id: string): string[] {
    const result = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const asset of this.#records.values()) {
        if (
          !result.has(asset.id) &&
          asset.dependencies.some((dependency) => dependency === id || result.has(dependency))
        ) {
          result.add(asset.id);
          changed = true;
        }
      }
    }
    return [...result].sort();
  }

  invalidationSet(id: string): string[] {
    return [id, ...this.dependentsOf(id)];
  }

  dependentsInRebuildOrder(id: string): string[] {
    const affected = new Set(this.dependentsOf(id));
    if (affected.size === 0) return [];

    const inDegree = new Map<string, number>();
    for (const depId of affected) {
      const record = this.#records.get(depId);
      let count = 0;
      // Count each distinct dependency once: it is decremented once below, so a
      // duplicated entry would otherwise keep the asset out of the order forever.
      for (const dep of new Set(record?.dependencies ?? [])) {
        if (affected.has(dep)) {
          count++;
        }
      }
      inDegree.set(depId, count);
    }

    const queue: string[] = [];
    for (const [depId, degree] of inDegree) {
      if (degree === 0) {
        queue.push(depId);
      }
    }
    queue.sort(compareIds);

    const result: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);

      const newlyReady: string[] = [];
      for (const depId of affected) {
        if (result.includes(depId) || queue.includes(depId)) continue;
        const record = this.#records.get(depId);
        if (record?.dependencies.includes(current)) {
          const currentDegree = inDegree.get(depId)! - 1;
          inDegree.set(depId, currentDegree);
          if (currentDegree === 0) {
            newlyReady.push(depId);
          }
        }
      }
      newlyReady.sort(compareIds);
      queue.push(...newlyReady);
    }

    return result;
  }

  rebuildOrder(id: string): string[] {
    return [id, ...this.dependentsInRebuildOrder(id)];
  }

  serialize(): AssetDatabaseDocument {
    return { schemaVersion: 1, assets: this.list() };
  }

  #assertAcyclic(): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (id: string): void => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error(`Asset dependency cycle detected at "${id}"`);
      visiting.add(id);
      for (const dep of this.#records.get(id)?.dependencies ?? []) {
        if (this.#records.has(dep)) visit(dep);
      }
      visiting.delete(id);
      visited.add(id);
    };

    for (const id of this.#records.keys()) visit(id);
  }
}
