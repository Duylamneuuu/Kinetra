export type InputBinding =
  | { kind: "key"; code: string; scale?: number }
  | { kind: "gamepad-button"; button: number; scale?: number }
  | { kind: "gamepad-axis"; axis: number; scale?: number; deadzone?: number; direction?: "positive" | "negative" };

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

export interface GamepadSnapshot {
  buttons: readonly number[];
  axes: readonly number[];
}

export interface GamepadSnapshotProvider {
  getSnapshot(): GamepadSnapshot | undefined;
}

export class BrowserGamepadSnapshotProvider implements GamepadSnapshotProvider {
  getSnapshot(): GamepadSnapshot | undefined {
    if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") {
      return undefined;
    }
    const gamepads = navigator.getGamepads();
    if (!gamepads) return undefined;
    for (let i = 0; i < gamepads.length; i++) {
      const pad = gamepads[i];
      if (pad && pad.connected) {
        return {
          buttons: pad.buttons.map(b => b.value),
          axes: [...pad.axes],
        };
      }
    }
    return undefined;
  }
}

export class FakeGamepadSnapshotProvider implements GamepadSnapshotProvider {
  #current: GamepadSnapshot | undefined;

  setSnapshot(snapshot: GamepadSnapshot | undefined): void {
    this.#current = snapshot;
  }

  getSnapshot(): GamepadSnapshot | undefined {
    return this.#current;
  }
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
        { kind: "gamepad-axis", axis: 0, scale: 1, deadzone: 0.15, direction: "positive" },
        { kind: "gamepad-button", button: 15, scale: 1 },
      ],
    },
    {
      id: "player.moveLeft",
      type: "axis",
      bindings: [
        { kind: "key", code: "ArrowLeft", scale: 1 },
        { kind: "key", code: "KeyA", scale: 1 },
        { kind: "gamepad-axis", axis: 0, scale: 1, deadzone: 0.15, direction: "negative" },
        { kind: "gamepad-button", button: 14, scale: 1 },
      ],
    },
    {
      id: "player.moveForward",
      type: "axis",
      bindings: [
        { kind: "key", code: "ArrowUp", scale: 1 },
        { kind: "key", code: "KeyW", scale: 1 },
        { kind: "gamepad-axis", axis: 1, scale: 1, deadzone: 0.15, direction: "negative" },
        { kind: "gamepad-button", button: 12, scale: 1 },
      ],
    },
    {
      id: "player.moveBackward",
      type: "axis",
      bindings: [
        { kind: "key", code: "ArrowDown", scale: 1 },
        { kind: "key", code: "KeyS", scale: 1 },
        { kind: "gamepad-axis", axis: 1, scale: 1, deadzone: 0.15, direction: "positive" },
        { kind: "gamepad-button", button: 13, scale: 1 },
      ],
    },
    {
      id: "player.jump",
      type: "button",
      bindings: [
        { kind: "key", code: "Space", scale: 1 },
        { kind: "gamepad-button", button: 0, scale: 1 },
      ],
    },
    {
      id: "player.attack",
      type: "button",
      bindings: [
        { kind: "key", code: "KeyF", scale: 1 },
        { kind: "key", code: "KeyJ", scale: 1 },
        { kind: "gamepad-button", button: 2, scale: 1 },
      ],
    },
    {
      id: "game.pause",
      type: "button",
      bindings: [
        { kind: "key", code: "Escape", scale: 1 },
        { kind: "gamepad-button", button: 9, scale: 1 },
      ],
    },
    {
      id: "ui.confirm",
      type: "button",
      bindings: [
        { kind: "key", code: "Enter", scale: 1 },
        { kind: "key", code: "Space", scale: 1 },
        { kind: "gamepad-button", button: 0, scale: 1 },
      ],
    },
    {
      id: "ui.back",
      type: "button",
      bindings: [
        { kind: "key", code: "Escape", scale: 1 },
        { kind: "key", code: "Backspace", scale: 1 },
        { kind: "gamepad-button", button: 1, scale: 1 },
      ],
    },
  ],
};

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Structural check for one binding from an untrusted source (settings files,
 * IPC). Returns a human-readable problem, or undefined when the binding is valid.
 */
export function describeInvalidInputBinding(binding: unknown): string | undefined {
  if (typeof binding !== "object" || binding === null || Array.isArray(binding)) {
    return "binding must be an object";
  }
  const candidate = binding as Record<string, unknown>;
  if (candidate.scale !== undefined && finiteOr(candidate.scale, Number.NaN) !== candidate.scale) {
    return "scale must be a finite number";
  }
  switch (candidate.kind) {
    case "key":
      return typeof candidate.code === "string" && candidate.code.length > 0
        ? undefined
        : "key binding needs a non-empty string code";
    case "gamepad-button":
      return isNonNegativeInteger(candidate.button)
        ? undefined
        : "gamepad-button binding needs a non-negative integer button";
    case "gamepad-axis":
      if (!isNonNegativeInteger(candidate.axis)) {
        return "gamepad-axis binding needs a non-negative integer axis";
      }
      if (
        candidate.deadzone !== undefined &&
        (typeof candidate.deadzone !== "number" || !(candidate.deadzone >= 0 && candidate.deadzone < 1))
      ) {
        return "deadzone must be a number in [0, 1)";
      }
      if (
        candidate.direction !== undefined &&
        candidate.direction !== "positive" &&
        candidate.direction !== "negative"
      ) {
        return 'direction must be "positive" or "negative"';
      }
      return undefined;
    default:
      return `unknown binding kind ${JSON.stringify(candidate.kind)}`;
  }
}

/**
 * Structural check for a whole input map from an untrusted source (settings files,
 * IPC, MCP). Returns a human-readable problem, or undefined when the map is valid.
 * Checks the container shapes, unique non-empty action ids, the action type, and every
 * binding with {@link describeInvalidInputBinding}.
 */
export function describeInvalidInputMap(map: unknown): string | undefined {
  if (typeof map !== "object" || map === null || Array.isArray(map)) {
    return "input map must be an object";
  }
  const candidate = map as Record<string, unknown>;
  if (candidate.schemaVersion !== 1) {
    return `unsupported schemaVersion ${JSON.stringify(candidate.schemaVersion)}`;
  }
  if (!Array.isArray(candidate.actions)) {
    return "actions must be an array";
  }
  const seen = new Set<string>();
  for (let index = 0; index < candidate.actions.length; index += 1) {
    const action: unknown = candidate.actions[index];
    if (typeof action !== "object" || action === null || Array.isArray(action)) {
      return `actions[${index}] must be an object`;
    }
    const entry = action as Record<string, unknown>;
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      return `actions[${index}] needs a non-empty string id`;
    }
    if (seen.has(entry.id)) {
      return `duplicate action id "${entry.id}"`;
    }
    seen.add(entry.id);
    if (entry.type !== "button" && entry.type !== "axis") {
      return `action "${entry.id}" type must be "button" or "axis"`;
    }
    if (!Array.isArray(entry.bindings)) {
      return `action "${entry.id}" bindings must be an array`;
    }
    for (let bindingIndex = 0; bindingIndex < entry.bindings.length; bindingIndex += 1) {
      const problem = describeInvalidInputBinding(entry.bindings[bindingIndex] as unknown);
      if (problem) return `action "${entry.id}" binding ${bindingIndex}: ${problem}`;
    }
  }
  return undefined;
}

export class InputRouter {
  #map: InputMap;
  #semanticActions = new Map<string, { phase: InputPhase; value: number }>();

  constructor(map: InputMap = DEFAULT_PLAYER_INPUT_MAP) {
    // A malformed map used to be accepted and only blew up later (hasAction/value threw
    // TypeErrors, duplicate ids silently shadowed each other); fail at construction.
    const problem = describeInvalidInputMap(map);
    if (problem) throw new Error(`Invalid input map: ${problem}`);
    this.#map = structuredClone(map);
  }

  remap(actionId: string, bindings: InputBinding[]): void {
    const action = this.#map.actions.find(candidate => candidate.id === actionId);
    if (!action) throw new Error(`Unknown input action "${actionId}"`);
    if (!Array.isArray(bindings)) throw new Error(`Bindings for "${actionId}" must be an array`);
    bindings.forEach((binding, index) => {
      const problem = describeInvalidInputBinding(binding);
      if (problem) throw new Error(`Invalid binding ${index} for "${actionId}": ${problem}`);
    });
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
      rawValue = finiteOr(semantic.value, 0);
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
      const scale = finiteOr(binding.scale, 1);
      switch (binding.kind) {
        case "key":
          if (snapshot.keys.has(binding.code)) value += scale;
          break;
        case "gamepad-button":
          value += finiteOr(snapshot.gamepadButtons[binding.button], 0) * scale;
          break;
        case "gamepad-axis": {
          // Disconnected/glitching pads can report NaN; never let it reach gameplay.
          const raw = finiteOr(snapshot.gamepadAxes[binding.axis], 0);
          const deadzone = finiteOr(binding.deadzone, 0.12);
          const direction = binding.direction;
          if (direction === "positive") {
            if (raw > deadzone) value += raw * scale;
          } else if (direction === "negative") {
            if (raw < -deadzone) value += -raw * scale;
          } else {
            if (Math.abs(raw) > deadzone) value += raw * scale;
          }
          break;
        }
      }
    }

    value = Math.max(-1, Math.min(1, finiteOr(value, 0)));
    return action.type === "button" ? (value > 0.5 ? 1 : 0) : value;
  }

  exportMap(): InputMap {
    return structuredClone(this.#map);
  }
}
