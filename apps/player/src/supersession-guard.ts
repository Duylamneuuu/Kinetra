/**
 * Detects that a long async operation was overtaken by a lifecycle change.
 *
 * `PlayerRuntimeController.loadSave` awaits storage reads and script `prepareRestoreState` hooks.
 * `stop()`/`start()` can run during any of those awaits and replace the runtime and script host.
 * The operation captures the objects it started with and, after every await, asks the guard
 * whether any of them was replaced. Identity comparison only: no equality, no deep inspection.
 */
export interface SupersessionGuard {
  /** True once any captured value is no longer the one the guard was created with. */
  isSuperseded(): boolean;
}

/**
 * Captures the current values returned by `read` and returns a guard that reports whether the
 * live values still match (by `Object.is`, so a `NaN`-style surprise cannot hide a swap).
 * A changed array length also counts as superseded.
 */
export function createSupersessionGuard(
  read: () => readonly unknown[],
): SupersessionGuard {
  const captured = [...read()];
  return {
    isSuperseded(): boolean {
      const live = read();
      if (live.length !== captured.length) {
        return true;
      }
      return captured.some((value, index) => !Object.is(value, live[index]));
    },
  };
}
