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
