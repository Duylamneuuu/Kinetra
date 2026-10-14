/**
 * What a successful `reloadAsset` could not carry over to the new asset (root bone gone, IK chain
 * missing, morph target missing). Every field is absent when empty.
 */
export interface ReloadDegradation {
  droppedRootMotion?: Record<string, string> | undefined;
  droppedIkChains?: Record<string, string[]> | undefined;
  droppedMorphOverrides?: Record<string, string[]> | undefined;
}

export interface ReloadDegradationLog {
  message: "animation.morphOverridesDropped" | "animation.ikChainsDropped" | "animation.rootMotionDropped";
  data: { assetId: string; entities: Record<string, string | string[]> };
}

/**
 * One warning log entry per kind of feature the reload switched off, so the agent that triggered the
 * reload (bridge/MCP `runtime logs`) can see it instead of root motion silently stopping. Empty maps
 * produce nothing; the order is stable (morph, IK, root motion).
 */
export function reloadDegradationLogs(assetId: string, result: ReloadDegradation): ReloadDegradationLog[] {
  const logs: ReloadDegradationLog[] = [];
  const entries: Array<[ReloadDegradationLog["message"], Record<string, string | string[]> | undefined]> = [
    ["animation.morphOverridesDropped", result.droppedMorphOverrides],
    ["animation.ikChainsDropped", result.droppedIkChains],
    ["animation.rootMotionDropped", result.droppedRootMotion],
  ];
  for (const [message, entities] of entries) {
    if (entities && Object.keys(entities).length > 0) {
      logs.push({ message, data: { assetId, entities } });
    }
  }
  return logs;
}

/**
 * The dropped maps of a reload result that belong in the bridge reply: only non-empty ones, and
 * nothing at all for a failed reload (a failed reload changed nothing).
 */
export function reloadDegradationFields(result: ReloadDegradation & { success: boolean }): ReloadDegradation {
  if (!result.success) return {};
  const fields: ReloadDegradation = {};
  if (result.droppedRootMotion && Object.keys(result.droppedRootMotion).length > 0) {
    fields.droppedRootMotion = result.droppedRootMotion;
  }
  if (result.droppedIkChains && Object.keys(result.droppedIkChains).length > 0) {
    fields.droppedIkChains = result.droppedIkChains;
  }
  if (result.droppedMorphOverrides && Object.keys(result.droppedMorphOverrides).length > 0) {
    fields.droppedMorphOverrides = result.droppedMorphOverrides;
  }
  return fields;
}
