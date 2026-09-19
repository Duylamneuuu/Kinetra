export type IdKind = "project" | "scene" | "entity" | "asset" | "prefab" | "test";

function fnv1a64(input: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * prime) & mask;
  }

  return hash;
}

export function stableId(kind: IdKind, seed: string): string {
  if (seed.length === 0) {
    throw new Error("stableId seed must not be empty");
  }

  return `${kind}_${fnv1a64(seed).toString(36)}`;
}

export function newId(kind: IdKind): string {
  const cryptoApi = globalThis.crypto;
  const entropy =
    cryptoApi && typeof cryptoApi.randomUUID === "function"
      ? cryptoApi.randomUUID()
      : `${Date.now()}-${Math.random()}-${Math.random()}`;

  return stableId(kind, entropy);
}
