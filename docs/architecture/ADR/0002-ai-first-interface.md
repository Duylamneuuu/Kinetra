# ADR 0002 — Agent API is the primary authoring interface

**Status:** Accepted

## Decision

Typed command/query APIs exposed through MCP are the primary authoring surface. Human editor controls call the same commands.

## Consequences

- no editor-only mutation path;
- schemas are product UX;
- commands require structured results;
- project revisions/transactions/undo matter early;
- observer UI can stay smaller than traditional engines;
- GUI automation is never required for normal agent operation.
