export type InputBinding =
  | {kind:"key";code:string;scale?:number}
  | {kind:"gamepad-button";button:number;scale?:number}
  | {kind:"gamepad-axis";axis:number;scale?:number;deadzone?:number};

export interface InputActionDefinition {
  id:string;
  type:"button"|"axis";
  bindings:InputBinding[];
}

export interface InputMap {
  schemaVersion:1;
  actions:InputActionDefinition[];
}

export interface PhysicalInputSnapshot {
  keys:ReadonlySet<string>;
  gamepadButtons:readonly number[];
  gamepadAxes:readonly number[];
}

export type InputPhase = "press" | "release" | "hold";

export interface SemanticActionInput {
  phase: InputPhase;
  value?: number;
}

export const DEFAULT_PLAYER_INPUT_MAP: InputMap = {
  schemaVersion: 1,
  actions: [
    {
      id: "player.moveRight",
      type: "axis",
      bindings: [
        { kind: "key", code: "ArrowRight", scale: 1 },
        { kind: "key", code: "KeyD", scale: 1 },
      ],
    },
    {
      id: "player.moveLeft",
      type: "axis",
      bindings: [
        { kind: "key", code: "ArrowLeft", scale: 1 },
        { kind: "key", code: "KeyA", scale: 1 },
      ],
    },
    {
      id: "player.jump",
      type: "button",
      bindings: [
        { kind: "key", code: "Space", scale: 1 },
      ],
    },
  ],
};

export class InputRouter {
  #map: InputMap;
  #semanticActions = new Map<string, { phase: InputPhase; value: number }>();

  constructor(map: InputMap = DEFAULT_PLAYER_INPUT_MAP) {
    this.#map = structuredClone(map);
  }

  remap(actionId: string, bindings: InputBinding[]): void {
    const action = this.#map.actions.find(candidate => candidate.id === actionId);
    if (!action) throw new Error(`Unknown input action "${actionId}"`);
    action.bindings = structuredClone(bindings);
  }

  hasAction(actionId: string): boolean {
    return this.#map.actions.some(candidate => candidate.id === actionId);
  }

  setSemanticAction(actionId: string, phase: InputPhase, value?: number): void {
    if (phase === "release") {
      this.#semanticActions.set(actionId, { phase, value: 0 });
    } else {
      this.#semanticActions.set(actionId, { phase, value: value ?? 1 });
    }
  }

  clearSemanticActions(): void {
    this.#semanticActions.clear();
  }

  endStep(): void {
    for (const [id, entry] of this.#semanticActions.entries()) {
      if (entry.phase === "press") {
        this.#semanticActions.delete(id);
      }
    }
  }

  getActionValue(actionId: string, snapshot?: PhysicalInputSnapshot): number {
    const action = this.#map.actions.find(candidate => candidate.id === actionId);
    const semantic = this.#semanticActions.get(actionId);
    const hasSemantic = semantic !== undefined && semantic.phase !== "release";

    let rawValue: number;
    if (hasSemantic) {
      rawValue = semantic.value;
    } else if (snapshot && action) {
      rawValue = this.value(actionId, snapshot);
    } else {
      rawValue = 0;
    }

    const clamped = Math.max(-1, Math.min(1, rawValue));
    if (action?.type === "button") {
      return clamped > 0.5 ? 1 : 0;
    }
    return clamped;
  }

  isActionPressed(actionId: string, snapshot?: PhysicalInputSnapshot): boolean {
    return this.getActionValue(actionId, snapshot) > 0.5;
  }

  value(actionId: string, snapshot: PhysicalInputSnapshot): number {
    const action = this.#map.actions.find(candidate => candidate.id === actionId);
    if (!action) throw new Error(`Unknown input action "${actionId}"`);

    let value = 0;
    for (const binding of action.bindings) {
      const scale = binding.scale ?? 1;
      switch (binding.kind) {
        case "key":
          if (snapshot.keys.has(binding.code)) value += scale;
          break;
        case "gamepad-button":
          value += (snapshot.gamepadButtons[binding.button] ?? 0) * scale;
          break;
        case "gamepad-axis": {
          const raw = snapshot.gamepadAxes[binding.axis] ?? 0;
          const deadzone = binding.deadzone ?? 0.12;
          if (Math.abs(raw) > deadzone) value += raw * scale;
          break;
        }
      }
    }

    value = Math.max(-1, Math.min(1, value));
    return action.type === "button" ? (value > 0.5 ? 1 : 0) : value;
  }

  exportMap(): InputMap {
    return structuredClone(this.#map);
  }
}
