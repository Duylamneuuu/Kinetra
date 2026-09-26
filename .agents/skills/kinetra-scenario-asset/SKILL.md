---
name: kinetra-scenario-asset
description: Use when generating, importing, and integrating 3D assets from Scenario into Kinetra projects. Governs the bridge from Scenario MCP (model discovery, dry-run cost estimation, generation, and GLB download) to Kinetra's deterministic asset pipeline (validation, hashing, assetId assignment, command-bus authoring, and runtime verification).
license: MIT
---

# Kinetra Scenario Asset Pipeline

This skill teaches coding agents how to bridge **Scenario** generative 3D workflows into **Kinetra's deterministic asset pipeline and runtime**.

Scenario is an optional, external, production-time asset provider. The packaged Kinetra game and runtime engine **never** require Scenario MCP, API keys, network access, or runtime libraries.

---

## Architectural Boundary

```text
External Creative Boundary (Production-Time Only):
AI Supervisor / Antigravity
        |
        +---- Scenario MCP (https://mcp.scenario.com/mcp)
        |       - Model discovery & schema inspection
        |       - Dry-run cost estimation
        |       - Image/text-to-3D generation
        |       - GLB download
        |
Engine Authoring & Ingestion Boundary (Deterministic & Local):
        +---- Kinetra Asset Pipeline (@kinetra/asset-pipeline)
        |       - GLB parse & structure validation
        |       - Content hashing (sha256) & fingerprinting
        |       - Stable Kinetra assetId assignment
        |       - Provider-neutral provenance metadata recording
        |
        +---- Kinetra Command Bus (@kinetra/command-bus)
        |       - Typed entity authoring (Model component with assetId)
        |       - Revision tracking, diffs, transactions, undo
        |
        +---- Real Electron Runtime / Packaged Executable
                - ThreeSceneRuntime / AssetResolver loads GLB via assetId
                - Structured runtime observation (entity.model.loaded)
                - Headless WebGL frame capture & acceptance verification
```

---

## Core End-to-End Workflow

### 1. Asset Brief & Budget Guardrails
- Define asset requirements: prop type, bounding dimensions (meters), polycount target (< 50,000 tris for props), and visual material expectations.
- **Budget Rule**: Never execute unpriced generations. Inspect the model schema and use `dry_run: true` to confirm Creative Unit (CU) costs before committing.
- For props and hard-surface objects, prefer:
  - Concept generation: Text-to-Image (`recommend` with capability `txt2img`)
  - 3D reconstruction: Image-to-3D (`recommend` with capability `img23d`, e.g. Astra 3D or Trellis)

### 2. Scenario MCP Scope Resolution
Scenario tools require team and project scope:
1. Call `teams_list` to discover team IDs.
2. Call `projects_list(team_id)` to select the target project.
3. Pass `team_id` and `project_id` on subsequent calls.

### 3. Model Discovery & Schema Inspection
```json
// Example: Recommend model
recommend({
  "capability": "img23d",
  "prompt": "stylized sci-fi energy crate prop with glowing power cells"
})

// Always inspect model schema before running
model_schema_get({
  "model_id": "<discovered_model_id>"
})
```

### 4. Dry-Run Cost Check & Generation
```json
// 1. Dry run to check exact Creative Units
model_run({
  "model_id": "<model_id>",
  "parameters": { ... },
  "dry_run": true
})

// 2. Dispatch real generation
model_run({
  "model_id": "<model_id>",
  "parameters": { ... }
})

// 3. Await job completion without polling in a tight loop
jobs_wait({
  "job_ids": ["<job_id>"]
})

// 4. Obtain download URL
asset_download({
  "asset_id": "<scenario_asset_id>"
})
```

### 5. Download & Ingestion into Kinetra
Download the GLB asset to a local staging directory (e.g. `examples/reference-game/assets/props/`).

Then invoke Kinetra asset pipeline ingestion:
1. **Header & Structure Inspection**:
   ```ts
   import { inspectGlb, validateAssetRecord } from "@kinetra/asset-pipeline";
   inspectGlb(glbBytes); // Validates magic 0x46546c67 and version 2
   ```
2. **Content Hash & Fingerprint**:
   Compute deterministic sha256 hash of the GLB payload.
3. **Stable Identity**:
   Assign stable Kinetra `assetId`, e.g. `stableId("asset", "prop-energy-crate")`.
4. **Provenance Metadata**:
   Record provider-neutral provenance in the asset database:
   ```json
   {
     "id": "asset_prop_energy_crate",
     "kind": "model",
     "source": {
       "path": "assets/props/energy-crate.glb",
       "kind": "generated",
       "contentHash": "<sha256>"
     },
     "metadata": {
       "provenance": {
         "provider": "scenario",
         "model": "gpt-6-astra-3d",
         "prompt": "stylized sci-fi energy crate prop",
         "sourceAssetId": "<scenario_asset_id>",
         "creativeUnitsCost": 15
       }
     }
   }
   ```

### 6. Author Entity Through Kinetra Command Bus
Never mutate Three.js directly. Author through the command bus:
```ts
service.execute({
  type: "entity.create",
  sceneId: arenaSceneId,
  entity: {
    id: stableId("entity", "prop-energy-crate-1"),
    name: "EnergyCrate",
    components: {
      Transform: {
        position: [2.0, 0.5, -2.0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      Model: {
        assetId: "asset_prop_energy_crate",
      },
    },
  },
});
```

### 7. Real Electron Runtime Verification
Verify through an `AcceptanceManifest`:
```json
{
  "schemaVersion": 1,
  "suite": "scenario-asset-verification",
  "target": "runtime",
  "steps": [
    { "type": "runtime.start", "sceneId": "scene_arena" },
    { "type": "assert.equal", "path": "state.byName.EnergyCrate.model.loaded", "expected": true },
    { "type": "assert.equal", "path": "state.byName.EnergyCrate.model.assetId", "expected": "asset_prop_energy_crate" },
    { "type": "assert.near", "path": "state.byName.EnergyCrate.position.0", "expected": 2.0, "tolerance": 0.01 },
    { "type": "assert.logAbsent", "messageContains": "model.loadFailed" },
    { "type": "assert.screenshotValidPng", "minBytes": 1000 },
    { "type": "runtime.stop" }
  ]
}
```

---

## Hard Rules & Invariants

1. **No External URLs at Runtime**: Runtime scenes reference only Kinetra `assetId`. The renderer never downloads from `scenario.com` or external CDN endpoints.
2. **Zero Runtime Dependencies**: The final packaged game (`KinetraGame.exe` / `KinetraGame`) must have zero imports or dependencies on Scenario.
3. **No Secrets in Repository**: Never commit API keys, OAuth tokens, or secrets into git or project data.
4. **Deterministic Ingestion**: Re-importing the same GLB file with the same recipe must produce the exact same content hash and fingerprint.
5. **Truthful Status**: If Scenario MCP or credentials are unavailable, do not fake a generation. Use the local deterministic prop fixture and state auth status truthfully.
