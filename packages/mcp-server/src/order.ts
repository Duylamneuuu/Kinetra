/**
 * Locale-independent ordering. `String.prototype.localeCompare` depends on the host ICU/locale, so
 * agent-visible listings (scenes, runtime entities) could change order between machines.
 * Compares by UTF-16 code unit, matching the engine's other deterministic orderings.
 */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
