# Start with ordinary Pi

Use Node >=22.19. The verified runtime is 22.21.1. From the checkout, run:

```bash
npm ci --ignore-scripts
npm run bootstrap
npm run recipe -- minimal
npm run doctor
npm start
```

Bootstrap creates only the isolated `.poly/agent` profile. Recipe selection refuses to overwrite an existing `platform.json`. Doctor is read-only and exits nonzero for errors. It reports configuration origins, effective permissions, provider modes, resource paths and trust decisions without resolving credentials, importing extensions, starting servers or making model requests. A sandbox warning means namespace startup was not tested, even when Bubblewrap is installed.

In Pi, use `/poly-doctor` for a compact report. Authenticate deliberately through the supported `/login` command, then select an available model with `/model`. Before login, the picker may show only locked Claude/Google placeholders. Those entries do not authorize execution. Kimi and Z.AI coding-plan activation is described in [provider setup](providers.md). Claude and Google require their separate activation reviews.

There is no mandatory wizard, external memory or agent team. Keep using ordinary Pi commands and native resources.

## Inspect a separate profile or project

Every managed CLI command accepts explicit `--profile` and `--project` paths. Defaults remain the checkout's `.poly/agent` and the current working directory.

```bash
npm run bootstrap -- --profile /absolute/path/to/dev-agent
npm run recipe -- minimal --profile /absolute/path/to/dev-agent
npm run doctor -- --profile /absolute/path/to/dev-agent --project /absolute/path/to/repository
npm start -- --profile /absolute/path/to/dev-agent --project /absolute/path/to/repository
```

This does not inherit or copy another profile's credentials. Log into the chosen profile yourself if needed. Doctor reports authentication configuration, not whether a credential is valid. It lists registered native/custom models without authenticating or contacting their endpoints. Executable integration adapters are not imported just to inspect them; unresolved adapters require review.

## Bring reviewed Pi resources

```bash
npm run pi -- install /absolute/path/to/reviewed/package
npm run pi -- list
npm run pi -- config
npm start
```

Pi owns installation, filtering, discovery, project trust and `/reload`. Installation is a trusted-code decision; review dependencies and scripts first. Existing personal resource paths can be referenced through native settings, as described in [native resources](pi-ecosystem.md). No Poly adapter is needed for ordinary interactive extensions. Package compatibility does not authorize worker extension execution.

## Add one agent and one workflow

Edit `.poly/agent/platform.json` with the existing version 1 configuration format:

```json
{
	"version": 1,
	"recipes": ["minimal"],
	"agents": {
		"source-reader": {
			"instructions": "Inspect the bounded source question and cite file paths and lines.",
			"policy": { "permissions": ["read"], "tools": ["read"] }
		}
	},
	"workflows": {
		"source-note": {
			"steps": [{ "id": "inspect", "agent": "source-reader", "objective": "{{input}}" }]
		}
	}
```

Run doctor and restart Pi after changing orchestration configuration. Commit or stash source changes before delegation. `/delegate` now offers an agent picker, followed by the objective and exact eligible model. Review the context packet and confirm the launch. `/workflow` similarly offers configured workflows. Role names do not determine permissions.

Use `/tasks` or `/task` to select work without memorizing IDs. `/task SHORT_ID diff` accepts a unique prefix. Task results include actual test commands, sourced findings, worktree paths and integration status. The optional status line identifies each child's model; changing the parent model does not change a running child.

## Add independent inspection

Choose `implementation-review` when creating a new profile, or explicitly edit the existing recipe list. Run `/workflow` and select that recipe. Choose an implementation model and a different inspection model. Approve each focused packet and each sandbox command separately. Inspect the final diff and findings before deciding whether to integrate. There is one generic workflow engine for supplied and custom recipes.

For local models, use the [host-independent endpoint example](providers.md#local-open-weight-example). No GPU or particular serving application is required by the platform. Actual server behavior must be qualified separately.

## Recover and disable safely

After interruption, `/tasks` shows retained source and results. Recovery creates a separately approved replacement, not a resumed private provider session. `/workflow-runs` offers inspection and continuation from validated checkpoints. Completed operations are not automatically replayed. See [recovery procedures](workflows.md).

To stop using Poly, close Pi after canceling active tasks. Remove optional editor bindings or packages through their normal mechanisms. Inspect retained task branches/worktrees before removing this checkout or its profile. Your personal Pi, editor and provider configuration was never overwritten. No destructive uninstall command runs automatically.

The [dogfooding exercise](dogfooding.md) prepares a small self-development task. Its live execution still requires your initiation and approval.
