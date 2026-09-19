# Agent layer

The agent layer is intentionally outside the game runtime.

It will contain:

- compact engine guides;
- task/skill descriptions;
- provider adapters when needed;
- supervisor policy/budgets;
- completion/acceptance protocol.

Model/provider changes must not force runtime architecture changes.
