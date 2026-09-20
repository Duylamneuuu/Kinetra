import type { GameScript, ScriptRegistry, PreparedScriptRestore } from "@kinetra/core";

export class ReadOnlyScript implements GameScript {
  onCreate(): void {}
}

export class ThrowingRestoreScript implements GameScript {
  prepareRestoreState(): PreparedScriptRestore {
    return {
      commit: () => {
        throw new Error("Intentional commit failure in prepareRestoreState");
      },
      rollback: () => {
        // safe no-op
      },
    };
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

  prepareRestoreState(state: Record<string, unknown>): PreparedScriptRestore {
    const oldValue = this.value;
    const nextValue = state.value as number;
    const throwAfterMutation = Boolean(state.throwAfterMutation);

    return {
      commit: () => {
        this.value = nextValue;
        if (throwAfterMutation) {
          throw new Error("Adversarial throw AFTER mutation");
        }
      },
      rollback: () => {
        this.value = oldValue;
      },
    };
  }
}

export class LegacyRestoreScript implements GameScript {
  legacyValue = 100;

  getState(): Record<string, unknown> {
    return { legacyValue: this.legacyValue };
  }

  restoreState(state: Record<string, unknown>): void {
    if (typeof state.legacyValue === "number") {
      this.legacyValue = state.legacyValue;
    }
  }
}

export function registerSaveLoadTestFixtures(registry: ScriptRegistry): void {
  registry.register("ReadOnlyScript", () => new ReadOnlyScript());
  registry.register("ThrowingRestoreScript", () => new ThrowingRestoreScript());
  registry.register("AdversarialMutationScript", () => new AdversarialMutationScript());
  registry.register("LegacyRestoreScript", () => new LegacyRestoreScript());
}
