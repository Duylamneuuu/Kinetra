# @kinetra/input

Semantic input actions on top of raw keyboard and gamepad state. Gameplay asks for `player.jump`, never for `Space`; the binding table decides which physical inputs feed each action.

The package has no DOM or Electron dependency. Callers hand it a `PhysicalInputSnapshot` (pressed key codes, gamepad button values, gamepad axes) each step, or push semantic actions directly (for example from an MCP/bridge command or a test).

## Entry points

| Export | Kind | What it does |
| --- | --- | --- |
| `InputMap`, `InputActionDefinition`, `InputBinding` | types | `{ schemaVersion: 1, actions: [{ id, type: "button" \| "axis", bindings }] }`. A binding is a `key` (by `KeyboardEvent.code`), a `gamepad-button` (index) or a `gamepad-axis` (index, optional `deadzone`, `direction`). Every binding takes an optional finite `scale`. |
| `DEFAULT_PLAYER_INPUT_MAP` | const | `player.moveRight/Left/Forward/Backward` (axes), `player.jump`, `player.attack`, `game.pause`, `ui.confirm`, `ui.back` (buttons), bound to WASD/arrows, Space/F/J/Enter/Escape and a standard-layout gamepad. |
| `InputRouter` | class | `value(actionId, snapshot)`, `getActionValue`, `isActionPressed`, `remap(actionId, bindings)`, `hasAction`, `exportMap()`, plus semantic injection: `setSemanticAction(id, phase, value?)`, `clearSemanticActions()`, `endStep()`. |
| `describeInvalidInputBinding(binding)` | function | Structural check for a binding from an untrusted source. Returns a human-readable problem or `undefined`. |
| `GamepadSnapshotProvider` | interface | `getSnapshot()` returns `{ buttons, axes }` or `undefined`. |
| `BrowserGamepadSnapshotProvider` / `FakeGamepadSnapshotProvider` | classes | First connected `navigator.getGamepads()` pad, or a settable fake for tests and headless runs. |

## Behaviour worth knowing

- Values are summed over all bindings of an action and clamped to `[-1, 1]`. `button` actions collapse to `0` or `1` (threshold `> 0.5`); `axis` actions keep the analogue value.
- A `gamepad-axis` binding ignores readings inside `deadzone` (default `0.12`); `direction: "positive" | "negative"` makes one physical axis feed two actions (move left and right).
- Non-finite readings (NaN from a glitching pad, a NaN `scale`) count as `0` and never reach gameplay.
- `remap` validates every binding with `describeInvalidInputBinding` and throws without changing the map when one is bad. `remap` and `value` throw for an unknown action id; `getActionValue` and `isActionPressed` return `0` / `false` for one.
- The router clones the map it is given and `exportMap()` returns a clone, so callers cannot mutate it behind its back.
- Semantic input wins over physical input for that action. `press` lasts until `endStep()`, `hold` stays until it is replaced or cleared, `release` forces the action to `0` (the router then falls back to physical input).

## Example

```ts doc-check
import assert from "node:assert/strict";
import {
  DEFAULT_PLAYER_INPUT_MAP,
  InputRouter,
  describeInvalidInputBinding,
  type PhysicalInputSnapshot,
} from "@kinetra/input";

const router = new InputRouter(DEFAULT_PLAYER_INPUT_MAP);
const snapshot = (keys: string[], axes: number[] = []): PhysicalInputSnapshot => ({
  keys: new Set(keys),
  gamepadButtons: [],
  gamepadAxes: axes,
});

// Keys and gamepad axes feed the same semantic action.
assert.equal(router.value("player.moveRight", snapshot(["KeyD"])), 1);
assert.equal(router.value("player.moveRight", snapshot([], [0.6])), 0.6);
// Inside the deadzone the stick is ignored; the opposite direction feeds the other action.
assert.equal(router.value("player.moveRight", snapshot([], [0.1])), 0);
assert.equal(router.value("player.moveLeft", snapshot([], [-0.5])), 0.5);
// Buttons collapse to 0 or 1.
assert.equal(router.value("player.jump", snapshot(["Space"])), 1);

// Remapping is validated before it is applied.
assert.equal(describeInvalidInputBinding({ kind: "key", code: "" }), "key binding needs a non-empty string code");
assert.throws(() => router.remap("player.jump", [{ kind: "key", code: "" }]), /Invalid binding 0/);
router.remap("player.jump", [{ kind: "key", code: "KeyZ" }]);
assert.equal(router.isActionPressed("player.jump", snapshot(["Space"])), false);
assert.equal(router.isActionPressed("player.jump", snapshot(["KeyZ"])), true);

// Semantic injection (bridge commands, tests): a press lasts one step.
router.setSemanticAction("player.attack", "press");
assert.equal(router.isActionPressed("player.attack"), true);
router.endStep();
assert.equal(router.isActionPressed("player.attack"), false);
```

## Proof level

Unit tests live in `packages/input/test` and run through the package `test` script. The Electron player feeds real keyboard and gamepad snapshots through `InputRouter` (see [`docs/STATUS.md`](../../docs/STATUS.md)). Bindings are data, so editor UI for remapping is not built yet.
