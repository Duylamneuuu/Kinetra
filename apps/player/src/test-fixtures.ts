import type { GameScript, ScriptRegistry } from "@kinetra/core";

export class ReadOnlyScript implements GameScript {
  onCreate(): void {}
}

export class ThrowingRestoreScript implements GameScript {
  restoreState(): void {
    throw new Error("Intentional commit failure in restoreState");
  }
}

export class AdversarialMutationScript implements GameScript {
  value = 5;

  getState(): Record<string, unknown> {
    return { value: this.value };
  }

  validateRestoreState(
    state: Record<string, unknown>,
  ): boolean | { valid: boolean; error?: string } {
    if (typeof state.value !== "number" || !Number.isFinite(state.value)) {
      return { valid: false, error: "value must be a finite number" };
    }
    return { valid: true };
  }

  restoreState(state: Record<string, unknown>): void {
    this.value = state.value as number;
    if (state.throwAfterMutation) {
      throw new Error("Adversarial throw AFTER mutation");
    }
  }
}

export function registerSaveLoadTestFixtures(registry: ScriptRegistry): void {
  registry.register("ReadOnlyScript", () => new ReadOnlyScript());
  registry.register("ThrowingRestoreScript", () => new ThrowingRestoreScript());
  registry.register("AdversarialMutationScript", () => new AdversarialMutationScript());
}
