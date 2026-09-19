# ADR 0001 — Own the runtime kernel

**Status:** Accepted

## Decision

Kinetra will build and own a coherent runtime/project/command kernel rather than wholesale-forking an experimental Three.js engine.

Permissively licensed projects may donate ideas or targeted implementation where appropriate, but their entity models will not be merged into a Frankenstein runtime.

## Why

The engine's long-term value is the consistency of its agent-facing contracts, asset lifecycle and verification model. Mixing several small engines would import incompatible assumptions exactly where Kinetra needs stable semantics.
