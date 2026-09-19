# Agent orchestration

Kinetra's autonomous supervisor sits **above** the engine.

The engine supplies deterministic primitives. The supervisor turns a user goal into iterative work.

## Loop

~~~text
goal
 ↓
explicit acceptance criteria
 ↓
inspect relevant project state
 ↓
bounded plan/tasks
 ↓
commands + TypeScript changes
 ↓
run game
 ↓
read state/logs
 ↓
inject semantic input
 ↓
capture frame when useful
 ↓
critique
 ↓
fix
 ↓
acceptance suite
 ↓
package Game.exe
 ↓
launch packaged build
 ↓
final acceptance
~~~

## Context economy

Never dump the whole project by default.

Prefer:

- scene searches with field selection;
- relevant entity/component details;
- recent warning/error logs;
- asset metadata before binary/visual content;
- revision diffs;
- condensed persistent project memory.

## Budgets

Supervisor configurations should support bounded tool calls/build attempts/visual loops and approval gates for destructive operations, dependency/license changes and release uploads.

## Godogen relationship

Godogen is a design reference for thin engine guidance, autonomous planning and "proof over claims". Kinetra should borrow the orchestration pattern rather than embed a specific provider or copy a second engine runtime.
