# Migrate to v0.6.0

v0.6.0 removes Poly's workers, task scheduler, Git worktrees, review gates, agent definitions, workflow engine and recipes.
The `qualify`, `dogfood:offline` and `recipe` npm scripts are removed.
`/agents`, `/delegate`, `/tasks`, `/task`, `/review`, `/poly-qualify`, `/implement`, `/workflow` and `/workflow-runs` are no longer Poly commands.
Use [Herdr](herdr.md) for terminal hosting and helpers.
Use ordinary Git tools to inspect and integrate changes.
There is no replacement automatic merge or review gate.

## Keep your profile

Run the existing setup commands after updating dependencies:

```bash
npm ci --ignore-scripts
npm run bootstrap
npm run validate
npm run doctor
```

An existing `.poly/agent/poly.json` still loads.
Historical `review`, `runtime` and `sha256` fields are ignored, even when their old values are stale.
Retired orchestration fields and the separate `platform.json`, `orchestration.json` and `integrations.json` files are no longer used.
The loader prints one short notice per affected profile per process.
It does not rewrite `poly.json` or execute retired integration modules.

The retained configuration is shown in [provider settings](providers.md#configure-the-native-runtimes).
Old `enabled` flags remain effective.
Omitting `claude.mode` selects ACP.
If you need a specific executable, replace the old `runtime` setting with an absolute `claude.path` or `google.path`.
Otherwise the executable comes from `PATH`.
No checksum or reapproval step remains.

Bootstrap adds Poly's own extension to native `settings.json` if it is missing.
It preserves other resource selections and model preferences.
This makes the extension discoverable by ordinary Pi launches using the isolated profile.
The bridge is still opt-in; its startup retains only billing settings and the resolved executable path in `claude-bridge.json`.

## Preserve historical work

Pi session history, saved handoffs, task files, task branches and existing worktrees are not deleted.
Poly no longer discovers or manages historical task/workflow records.
Inspect retained worktrees and branches yourself before removing or integrating them.
Native Pi packages continue through Pi's package manager.
Orchestration-only JSON package contributions and the old `IntegrationHost` contract no longer run.
Move ordinary tools, providers and context integrations to native Pi extensions where needed.
MemPalace remains optional and its existing data is not migrated.
