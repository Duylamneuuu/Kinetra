# AI-first design rule

Kinetra's primary operator is an AI agent.

This has concrete consequences:

## The primary UI is structured tooling

The canonical operation is not:

> "drag this object to the left in the viewport"

It is:

~~~json
{
  "command": "component.patch",
  "entityId": "player",
  "component": "Transform",
  "patch": { "position": [2, 1, 0] }
}
~~~

The human viewport may generate that same command.

## Humans do not need to learn Kinetra

Human UX is valuable for:

- watching;
- debugging;
- inspecting;
- profiling;
- approving risky operations;
- manually overriding exceptional cases.

A human should not need engine-specific editor expertise for an agent to succeed.

## API before panel

When adding a new subsystem, build in this order:

1. data/schema;
2. runtime contract;
3. command/query API;
4. deterministic tests;
5. MCP exposure;
6. minimal observer UI if useful.

Do not start with the panel.

## Text before opaque graphs

Visual graphs are alternate views of text/structured data. Animation graphs, input maps and acceptance manifests must remain machine-readable without screenshot interpretation.

## Completion is executable behavior

An AI-generated game is incomplete until required behavior is exercised against the running game and, for shipping tasks, the packaged executable.
