# @kinetra/navigation-recast

Offline-first Recast/Detour adapter.

Current proof:
- synthetic geometry navmesh bake
- Detour closest-point/path query
- binary export/import for build-time baking
- library-neutral Vec3 API
- explicit lifetime disposal

Static worlds should ship baked navmesh bytes rather than regenerate at startup.
