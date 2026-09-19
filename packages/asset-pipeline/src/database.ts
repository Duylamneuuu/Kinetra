import type { AssetDatabaseDocument, AssetRecord } from "./types.js";

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
    this.#records.set(record.id, structuredClone(record));
    this.#assertAcyclic();
  }

  get(id: string): AssetRecord | undefined {
    const value = this.#records.get(id);
    return value ? structuredClone(value) : undefined;
  }

  list(): AssetRecord[] {
    return [...this.#records.values()]
      .map((value) => structuredClone(value))
      .sort((a, b) => a.id.localeCompare(b.id));
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
