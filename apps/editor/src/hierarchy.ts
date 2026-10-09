import type { SceneDefinition } from "@kinetra/project-model";

/** One row of the hierarchy panel: the scene's entities flattened depth-first. */
export interface HierarchyNode {
  entityId: string;
  name: string;
  /** 0 for a root, +1 per ancestor. */
  depth: number;
  /** Present only when the parent exists in the scene (the row is nested under it). */
  parentId?: string;
  childCount: number;
  /** Component names on the entity, in code-unit order. */
  components: string[];
  /**
   * True when the entity names a parent that is not in the scene, or sits in a parent cycle.
   * The command bus refuses to create either, but a hand-edited document could carry one and the
   * panel must still show every entity rather than hide it.
   */
  detached: boolean;
}

/**
 * Flattens a scene into display order: roots in document order, each followed by its descendants
 * (siblings in document order). Pure and total: every entity appears exactly once, even for a
 * malformed hierarchy.
 */
export function buildHierarchy(scene: SceneDefinition): HierarchyNode[] {
  const ids = new Set(scene.entities.map((entity) => entity.id));
  const childrenOf = new Map<string, string[]>();
  for (const entity of scene.entities) {
    if (entity.parentId !== undefined && ids.has(entity.parentId) && entity.parentId !== entity.id) {
      const siblings = childrenOf.get(entity.parentId);
      if (siblings) {
        siblings.push(entity.id);
      } else {
        childrenOf.set(entity.parentId, [entity.id]);
      }
    }
  }

  const byId = new Map(scene.entities.map((entity) => [entity.id, entity]));
  const visited = new Set<string>();
  const rows: HierarchyNode[] = [];

  const emit = (rootId: string, detached: boolean): void => {
    // Iterative DFS: a deep chain must not overflow the call stack.
    const stack: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
    while (stack.length > 0) {
      const { id, depth } = stack.pop()!;
      if (visited.has(id)) {
        continue;
      }
      visited.add(id);
      const entity = byId.get(id)!;
      const children = (childrenOf.get(id) ?? []).filter((childId) => !visited.has(childId));
      rows.push({
        entityId: id,
        name: entity.name,
        depth,
        ...(depth > 0 ? { parentId: entity.parentId! } : {}),
        childCount: children.length,
        components: Object.keys(entity.components).sort(),
        detached: detached && depth === 0,
      });
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ id: children[index]!, depth: depth + 1 });
      }
    }
  };

  for (const entity of scene.entities) {
    const hasParentInScene =
      entity.parentId !== undefined && ids.has(entity.parentId) && entity.parentId !== entity.id;
    if (!hasParentInScene) {
      emit(entity.id, entity.parentId !== undefined);
    }
  }
  // Anything still unvisited sits in a parent cycle with no root: surface it rather than drop it.
  for (const entity of scene.entities) {
    if (!visited.has(entity.id)) {
      emit(entity.id, true);
    }
  }
  return rows;
}
