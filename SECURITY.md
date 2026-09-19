# Security

Kinetra will eventually execute user/agent-authored scripts, invoke Blender, access the filesystem through desktop bridges and optionally integrate with Steam. Treat these boundaries as privileged.

## Rules

- The renderer/game web context does not receive unrestricted Node access.
- Electron uses context isolation and a narrow preload/main-process API.
- MCP tools expose explicit operations, not arbitrary shell execution by default.
- File access is project-root scoped unless a tool explicitly requires otherwise.
- Build/release credentials never live in project files.
- Steam credentials and signing material are CI secrets.
- Imported assets are treated as untrusted input and validated before runtime use.
- High-risk autonomous actions should require explicit approval gates.

## Reporting

Until a dedicated private disclosure channel exists, do not publish an exploitable vulnerability as a public issue. Contact the repository owner privately through an available GitHub profile contact method.
