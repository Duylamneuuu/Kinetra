# Contributing

Kinetra is pre-alpha and architecture-sensitive.

Before opening an implementation PR:

1. read \`VISION.md\`, \`AGENTS.md\` and \`ARCHITECTURE.md\`;
2. identify the roadmap phase and acceptance gate;
3. keep the change inside existing package boundaries unless an ADR justifies a new one;
4. preserve the agent-first command/query model;
5. include proof appropriate to the change.

## PR expectations

A good PR explains:

- problem;
- chosen contract;
- alternatives rejected;
- compatibility/migration impact;
- tests/proof;
- licensing provenance for reused code;
- follow-up work explicitly deferred.

Avoid giant mixed PRs. A feature that changes project data, runtime behavior and agent tools should ideally establish the data/runtime contract first, then expose MCP/UI adapters.

## Commit style

Conventional prefixes are preferred:

- \`feat:\`
- \`fix:\`
- \`refactor:\`
- \`test:\`
- \`docs:\`
- \`chore:\`
- \`build:\`
- \`ci:\`

## Early project rule

Do not optimize for backward compatibility before schemas have a stable public release, but do write migrations/fixtures once persistent project data exists. Breaking changes must be explicit rather than accidental.
