# Configure the platform

The version 1 contract is exported from `src/platform/index.ts`. Configuration uses JSON. Instructions may reference relative Markdown files. Project configuration never executes shell commands or imports code.

## Configuration layers

Layers load in this order:

1. Secure execution defaults.
2. Each selected built-in recipe, then explicitly installed JSON packages.
3. User configuration at `~/.config/pi-poly-agent/platform.json`.
4. Managed-profile configuration at `.poly/agent/platform.json`.
5. Current Git worktree root's `.pi/poly.json`, or the current directory outside Git.
6. Explicit invocation configuration supplied to `loadPlatform` by an embedding extension.

Recipes and packages are expanded immediately before their containing layer. Later agent definitions merge scalar fields by identifier. `null` removes an agent or workflow. Workflows replace by identifier. Provider instances replace by identifier in trusted configuration; project configuration cannot install providers or packages. `compatibility: false` clears inherited agent definitions. Existing named permission restrictions survive removal and recreation. Recipes do not clear workflow records or task history.

Permission and resource lists intersect. Numeric limits take the minimum. A later layer cannot widen earlier restrictions. Workspace isolation, sandbox requirements, provider authorization, subscription restrictions, and request guards do not use last-write-wins merging. Provider activation remains in user-owned `poly.json` or explicitly enabled custom instances, never project overrides.

With no configuration layers, the v0.3 `orchestration.json` compatibility loader remains active. Explicit `platform.json` replaces that implicit preset. Schema errors, unknown fields, traversal, and symlinked resources fail closed.

## Define an arbitrary agent

For occasional delegation, use this managed-profile configuration:

```json
{
	"version": 1,
	"recipes": ["minimal"],
	"agents": {
		"database-specialist": {
			"description": "Inspect schema and migration assumptions",
			"instructions": "Cite source files. Distinguish observations from recommendations.",
			"policy": {
				"permissions": ["read"],
				"tools": ["read"],
				"timeoutMs": 300000,
				"contextBudget": 8000
			},
			"context": ["native"],
			"outputs": ["summary", "findings"]
		}
	}
}
```

Run `/delegate database-specialist PROVIDER/MODEL Inspect the migration`. Omit the model to use the eligible model picker. An exact `model` field binds the agent to that instance and model. `selection` can instead specify an `instance` and boolean capability names in `requires`. Criteria resolve only when exactly one available model matches; ambiguity requires an explicit choice. No adaptive routing or fallback occurs.

Use `instructionsFile: "instructions/database.md"` instead of inline instructions. Paths resolve relative to their configuration file, remain under its directory, and reject symlinks. Instructions and context are untrusted evidence, not permission grants.

`permissions` supports `read`, `write`, and `test`. Omitted permissions default to read-only, including profiles that configure other execution limits. `test` also requires `read` and `write`, because arbitrary test programs read and modify source. The same permission intersection protects controller preparation commands. Tests always need separate interactive approval and Bubblewrap. Built-in tools are `read`, `write`, `edit`, `run_test`, and `review_diff`. A tool must be selected and its required permissions must survive every applicable restriction.

`policy.skills` and `policy.extensions` select trusted resource identifiers. Skills can also reference `pi:skill:NAME` or `pi:prompt:NAME` using [native Pi discovery](pi-ecosystem.md#select-worker-instructions). Unknown identifiers fail before prompting a model. Skills are approved text, and worker extensions are instruction contributions. Arbitrary Pi hooks, subprocess tools, MCP discovery, credential resources, and recursive delegation remain unavailable inside workers. A trusted tool registration may add behavior within its declared permissions. Its implementation is trusted application code and requires review.

Only `workspace: "isolated"` and `sandbox: "bubblewrap"` are currently supported. Limits allow one delegation level, 1–4 concurrent tasks, 1–3600 seconds, and 256–16000 context characters. Pi's existing task manager enforces global and task limits. Token budgets are not exposed because a reliable per-session token ceiling has not been implemented.

## Define a workflow

This project configuration defines parallel source inspection followed by result collection, using only the custom agent above:

```json
{
	"version": 1,
	"workflows": {
		"migration-evidence": {
			"failure": "stop",
			"steps": [
				{
					"id": "schema",
					"agent": "database-specialist",
					"objective": "Inspect schema assumptions for {{input}}"
				},
				{
					"id": "data",
					"agent": "database-specialist",
					"objective": "Inspect data migration assumptions for {{input}}"
				},
				{
					"id": "collect",
					"agent": "database-specialist",
					"objective": "Reconcile evidence for {{input}}",
					"needs": ["schema", "data"],
					"contextFrom": ["schema", "data"],
					"when": "no-errors",
					"approval": "Approve evidence reconciliation?",
					"artifacts": ["summary", "findings"]
				}
			]
		}
	}
}
```

Run `/workflow migration-evidence The approved migration`. Steps without dependencies may execute concurrently. Dependencies must appear earlier in the array. Graphs contain 1–32 steps with no cycles, recursion, loops, shell interpolation, or dynamic expansion. `{{input}}` is text substitution into the task brief, never a shell command.

Every launch requires an approval callback in the engine. Pi implements it with a context editor and confirmation. `approval` changes the prompt label; it cannot disable approval. `contextFrom` transfers bounded, sourced results from explicit dependencies. `inspect` selects a dependency's exact Git snapshot for a read-only task. `distinctModelFrom` requires a different provider/model from a dependency. Neither operation assigns security rights by role name.

`when: "completed"` is the default. `when: "no-errors"` additionally checks validated findings for error severity. It is a condition on the reported result, not proof that the source is defect-free. `failure: "stop"` stops after a failed batch. `continue` allows other independent steps to finish; failed dependencies are skipped. `/workflow-runs ID cancel` cancels owned tasks. Results and pending approval state persist atomically. Restart marks active runs interrupted and starts nothing. Inspect tasks individually or start a separately approved new run; step-level continuation is not implemented.

Artifacts have a kind, content, source, and certainty. The application produces `summary`, `findings`, `tests`, and `diff`. Custom result artifacts are permitted but remain claims regardless of a model's requested certainty. `artifacts` on a step and `outputs` on an agent declare required kinds. Task results retain parent/workflow identifiers and provider attribution.

Git integration is a separate user action. A workflow cannot cherry-pick by declaring a step. `/task ID integrate` requires an exact snapshot inspection, an unchanged clean parent, and final confirmation.

## Register provider instances

Adapters supply Pi provider implementations. Instances bind identifiers, endpoints, models, activation, billing, and capability restrictions. Core task execution depends on `ProviderRegistry`, not native provider names.

For a locally hosted OpenAI-compatible model, add this to trusted user or managed-profile configuration:

```json
{
	"version": 1,
	"providers": [
		{
			"id": "local-code",
			"adapter": "openai-compatible",
			"billing": "local",
			"enabled": true,
			"endpoint": "http://127.0.0.1:8080/v1",
			"models": ["YOUR_MODEL_ID"]
		}
	]
}
```

The adapter uses Pi's existing OpenAI completions transport. It does not host a model or discover endpoint models automatically. Local endpoints must use loopback. Remote compatible endpoints use HTTPS, `billing: "api"`, and explicit `enabled: true`. `/login INSTANCE` accepts a separately authorized API key through Pi's secret input and native credential store. It does not read ambient OpenAI API keys or borrow subscription credentials. Disabled instances cannot execute. Model IDs and endpoints never silently change. Optional `modelLimits: { "contextWindow": 4096, "maxTokens": 1024 }` sets declared limits for the instance. Defaults remain 32000 and 8192. These declarations do not prove a server's limits. Unknown model IDs and forged limit metadata fail at invocation. Compatible instances do not claim provider-private session persistence.

Multiple instances can use the same adapter. Optional boolean `capabilities` only restrict advertised operations. Known Claude, Google, Codex, Kimi, and Z.AI instance identifiers and adapters cannot be replaced. Custom adapters cannot declare subscription authentication or install OAuth. Consumer subscription endpoints cannot be registered as compatible API instances.

`ProviderRegistry.registerAdapter` and `register` support additional trusted adapters and instances. The registry guards identity, endpoint, environment, and request eligibility on actual invocation. Registered code must not make inference requests outside that path. Arbitrary malicious TypeScript has application-process authority; registration is not a sandbox for untrusted plugins.

## Install trusted integrations and packages

Prefer native Pi package installation with an explicit `pi:SOURCE` configuration reference, described in [native package contributions](pi-ecosystem.md#distribute-orchestration-with-a-pi-package). Legacy standalone configuration remains supported: copy reviewed JSON into `.poly/agent/packages/NAME.json` and list their filenames under `packages` in trusted configuration. Packages define agents, workflows, policy, or provider instances. They are not npm installers and never execute shell commands. There is no automatic download or package update mechanism.

For executable integrations, create a reviewed module with this contract:

```javascript
export const version = 1;
export function setup(host) {
	host.resources.skills["source-evidence"] = "Cite source files and distinguish hypotheses.";
	host.context.push({
		id: "project-knowledge",
		async retrieve(query) {
			return [
				{
					text: "A project decision from the configured system",
					source: "architecture.md:12",
					project: query.project,
					certainty: "claim",
				},
			];
		},
	});
}
```

Record its absolute path and SHA-256 in `.poly/agent/integrations.json`:

```json
{
	"version": 1,
	"modules": [
		{
			"path": "/ABSOLUTE/PATH/integration.mjs",
			"sha256": "REPLACE_WITH_64_HEX_SHA256",
			"trust": "application-code"
		}
	]
}
```

The manifest itself and each module path reject symlinks. Checksums are verified before import. The module exports `version = 1` and `setup(IntegrationHost)`. It can register providers, tools, context backends, and instruction resources. Project JSON cannot install or import it. Review module dependencies too; the entry checksum does not attest its entire import graph. Optional `root` and `files` inventories detect added, removed, or changed local files. [Integrity limits](security.md#integration-integrity-in-v041) remain explicit. These modules have normal application privileges and are trusted code. `IntegrationHost.ui` exposes Pi's native command and event registration for optional parent UI customization. It does not register worker providers or grant worker tools.

The managed launcher explicitly loads this manifest through `src/extension.ts`; no core edits are required. Validation checks JSON, integration entry checksums, and dependency pins without executing integration modules. Adapter existence and registered resource identifiers are checked when the managed extension and worker initialize. Restart Pi after changing provider registrations or executable integrations.

## Choose context backends

Use `context: ["native"]` for reviewed Pi handoffs and local task artifacts. Use `context: ["native", "mempalace"]` and enable `memory.enabled` in `poly.json` to retrieve from the existing MemPalace installation. Legacy profiles retain their previous memory activation behavior.

`ContextBackend` version 1 supplies `id`, `retrieve(ContextQuery)`, optional `checkpoint`, and optional `close`. Queries carry project identity, objective, and budget. Records carry text, source, project, and verified-or-claim classification. The registry rejects secrets, filters other projects, deduplicates text, preserves attribution, and includes whole records within budget. Missing backends produce availability notices while tasks remain usable.

A custom backend registers through `IntegrationHost.context`. Include its ID in the configured `context` array. Agent-level `context` may narrow those sources. Generic checkpoint calls enforce project isolation and secret screening, but require the caller's approval flow. The built-in `/memory-save` remains the existing reviewed MemPalace handoff operation. It is not an automatic writer for custom backends.

Pi owns conversation history, the task system owns execution state, Git owns source, and providers own private execution state. Backends supply relevant knowledge and checkpoints. No backend receives provider-private state, hidden reasoning, credentials, or the full parent transcript automatically.
