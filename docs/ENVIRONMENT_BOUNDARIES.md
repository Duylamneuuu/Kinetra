# Environment boundaries

This file defines when an agent may legitimately stop and say external environment/configuration is required.

## Can be done entirely in repository + CI

Do **not** ask for a local developer machine merely for:

- TypeScript package work;
- project schemas and migrations;
- command/query APIs;
- unit/integration tests;
- Node/WASM Rapier/Recast experiments;
- headless Blender export tests;
- GLB validation;
- Electron Windows packaging on GitHub Actions;
- static release manifest/VDF generation;
- deterministic acceptance-runner logic.

GitHub Actions can provide Linux, Windows and installable Blender environments for these proofs.

## Requires a real Windows/local interactive environment only when CI is insufficient

Examples:

- diagnosing a GPU/driver-specific WebGL/WebGPU rendering issue;
- interactive editor UX behavior that cannot be represented by automation;
- controller hardware behavior unavailable to CI;
- filesystem/OS behavior that differs from the runner and cannot be reproduced there;
- profiling a specific target machine.

Before requesting this, first attempt a deterministic CI reproduction.

## Requires external assets or DCC content

A real production character/animation test may require:
- a deliberately licensed test model;
- a licensed animation clip;
- a Blender source fixture beyond synthetic geometry.

Synthetic fixtures should remain the default for engine logic tests.

## Requires signing credentials

Actual Authenticode signing requires:
- certificate/private key or certificate-provider access;
- any required secret/PIN/password;
- timestamp service configuration.

Repository code may generate a signing **plan**, but must never invent or commit secret material.

## Requires Steamworks environment

Actual Steam upload/integration requires:
- valid Steamworks AppID;
- depot IDs;
- authorized Steam account/build credentials;
- SteamCMD/SteamPipe environment;
- any SDK/runtime files permitted by Steamworks terms.

The engine runtime must continue to work without Steam.

## Requires provider/API credentials

Agent/model provider credentials are outside Kinetra runtime contracts.

MCP/tool schemas should remain provider-neutral. Do not hard-code one model vendor into the engine.

## Hard stop rule

An agent may stop for environment reasons only when all of these are true:

1. the remaining acceptance criterion genuinely depends on external hardware, credentials, or licensed content;
2. repository/CI simulation cannot prove it;
3. the exact missing dependency is documented;
4. all environment-independent work is already complete.

"Would be easier locally" is not an environment boundary.
