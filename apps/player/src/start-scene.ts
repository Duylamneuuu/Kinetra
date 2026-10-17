// Resolves the scene a player start request names. Extracted from the runtime controller so the
// rule can be tested under plain Node (the controller needs a WebGL renderer).
//
// The lookup has to happen BEFORE the controller tears down the running game: a start request for
// a scene that does not exist used to stop the current runtime and re-register assets first and
// only then throw, leaving the player stopped (and its assets replaced) after a request that was
// rejected.

export interface StartSceneProject<TScene extends { readonly id: string }> {
  readonly scenes: readonly TScene[];
}

export function resolveStartScene<TScene extends { readonly id: string }>(
  project: StartSceneProject<TScene>,
  sceneId: string,
): TScene {
  const scene = project.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene) {
    throw new Error(`Scene "${sceneId}" does not exist`);
  }
  return scene;
}

/**
 * Validates the requested scene and only then runs `teardown` (stop the running game, replace its
 * assets). The runtime controller starts every game through this, so the ordering "reject an
 * unknown scene first, tear down second" is a single enforced rule instead of a convention.
 */
export async function resolveSceneThenTearDown<TScene extends { readonly id: string }>(
  project: StartSceneProject<TScene>,
  sceneId: string,
  teardown: () => Promise<void>,
): Promise<TScene> {
  const scene = resolveStartScene(project, sceneId);
  await teardown();
  return scene;
}
