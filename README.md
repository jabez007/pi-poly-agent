# Pi Poly Agent

Pi with optional, composable multi-provider orchestration. Configure ordinary Pi with several providers, occasional delegation, or a specialized agent team without changing the orchestration core.

Pi owns the TUI, agent loop, model picker, tools, and conversation history. Pi Poly Agent adds guarded provider instances, configurable agents, bounded workflows, durable tasks, isolated Git worktrees, and optional project context. There is no separate frontend or orchestration daemon.

## Install and choose a configuration

Use Node.js 22.19 or newer. The checked runtime is 22.21.1. Dependencies are pinned in [package.json](package.json) and [package-lock.json](package-lock.json).

```bash
npm ci --ignore-scripts
npm run bootstrap
npm run recipe -- minimal
npm run validate
npm run doctor
npm start
```

`recipe` creates `.poly/agent/platform.json` only when absent. It never overwrites an existing choice. To change recipes, edit that file explicitly. Bootstrap preserves existing Pi, Claude Code, Google, editor, and authentication configuration. Installation never starts a login or inference request.

The `minimal` recipe has no agent definitions, workflows, external memory, or worker status display. Use Pi's `/login` for native Codex or Kimi authentication and `/model` to switch. Z.AI requires coding-plan opt-in. Claude SDK and Google ACP start locked. See [provider setup](docs/providers.md).

Existing profiles without platform configuration retain the v0.3 compatibility agents and commands. Nothing migrates or deletes task history automatically.

[Getting started](docs/getting-started.md) covers one-agent delegation, custom workflows, separate profiles, recovery and removal. All managed commands accept explicit `--profile PATH` and `--project PATH`. `/poly-doctor` shows configuration and resource diagnostics inside Pi without resolving credentials or running third-party code.

## Bring your Pi customizations

Use native Pi packages, extensions, skills, prompt templates, and themes in the interactive session:

```bash
npm run pi -- install /absolute/path/to/reviewed/package
npm run pi -- config
npm start
```

The commands use the pinned Pi CLI and isolated profile. Installation is a trusted-code decision. Existing resources that were previously suppressed require `npm start -- --trust-native-resources` once. Project resources use Pi's own trust prompt. Personal credentials are never copied. [Native resource compatibility](docs/pi-ecosystem.md) covers personal references, package contributions, worker restrictions, and the compatibility matrix. See [resource migration](docs/migration-v041.md) before activating existing resources and [integration reapproval](docs/security.md#reapprove-existing-integrations) when upgrading to v0.4.2.

## Compose agents and workflows

Choose a supplied recipe or define your own in JSON:

| Recipe                                                      | Configuration                                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [minimal](recipes/minimal.json)                             | Ordinary Pi with multiple selectable providers                                            |
| [implementation-review](recipes/implementation-review.json) | An isolated change followed by independent inspection                                     |
| [agent-team](recipes/agent-team.json)                       | Coordination, parallel documentation analysis, implementation, and quality inspection     |
| [odoo-team](recipes/odoo-team.json)                         | Architecture and inventory/MRP specialists, Python implementation, and quality inspection |

For example, select `implementation-review` instead of `minimal` during installation, then run:

```text
/workflow implementation-review Implement the bounded change and its acceptance tests
```

Choose models available through `/model`. Review each focused context packet and approve each task. The recipe requires a different model for inspection. Results appear in Pi; applying the reviewed snapshot requires a separate confirmation. `/implement BRIEF` is a compatibility alias for this recipe, with no separate execution engine.

The same commands work with arbitrary agent and workflow names:

```text
/agents
/delegate database-specialist openai-codex/MODEL Inspect migration assumptions
/workflow domain-change Implement the approved inventory change
/tasks
/task ID diff
/task ID recover
/workflow-runs
```

Omit names or IDs in `/delegate`, `/workflow`, `/task` and `/workflow-runs` to use native pickers. Task commands also accept unique ID prefixes. Parent model selection and running child models remain independent.

Editing permissions come from intersected policies, not agent names. Agents may select approved tools, instruction skills, context sources, provider instances, and execution limits. [Configuration and extension contracts](docs/platform.md) describe layering, packages, custom endpoints, trusted integrations, and complete examples.

## Reliability and account protections

Tasks retain source changes, results, artifacts, session references, and exact review revisions across restart. Interrupted tasks remain visible. Cleanup and pruning preserve task history; unavailable worktrees remain listed with diagnostics. A completed review association survives cleanup of the reviewer worktree when the builder snapshot is unchanged. See [restoration tests](tests/cleanup-recovery.test.ts). Recovery launches a separately approved replacement; it does not claim to restore provider-private execution state. Workflow runs also become interrupted after restart, without automatic replay. `/workflow-runs RUN_ID continue` can create an explicitly approved linked run from validated completed steps; uncertain workers require explicit task recovery.

Every task uses an isolated Git worktree with pinned host Git metadata. Host Git refuses nested repository metadata names, including case variants, and unregistered task-store paths; refusals require manual inspection. Consequential tests require single-use approval and Linux Bubblewrap with isolated networking, temporary HOME and no normal host authentication-store mounts. Commands can read all task source, so keep credentials out of that source. Failed sandbox startup has no unrestricted-shell fallback. Dependency preparation is explicit. Task source inspection, review, recovery and integration wait for preparation to settle. See [execution safeguards](docs/security.md#v02-provider-invocation-and-delegation) and [workflows](docs/workflows.md).

Integration requires a completed read-only review task tied to the exact snapshot and your final approval. New diff artifacts contain bounded views and exact revisions; the full patch remains in Git. Views escape unsafe characters, identify changed control files, name listed omitted files with line counts, and count any unlisted files. Unavailable Git line counts are labeled explicitly. Packets and `review_diff` use the same ordered pagination index, including refused names labeled without patch access. Full-index/patch commands keep the rest discoverable; insufficient context space is reported with the required size before editing. The approved packet reaches the reviewer unchanged. Integration previews also show that packet's visibility limits. Full patch content is secret-screened in chunks, independently of display size. Revision matching does not certify review quality. See [reviewing and integration](docs/workflows.md#request-an-independent-review), [the task controller](src/orchestration/tasks.ts) and [view implementation](src/orchestration/review-view.ts).

Google consumer ACP is direct-interaction-only and cannot become a worker through configuration or an adapter alias. Claude subscription delegation remains blocked. Request guards reject unexpected authentication environments, endpoint overrides, and billing fallback. Custom API instances require explicit activation; local instances use loopback endpoints. [Security](docs/security.md) documents the trust limits of executable integrations.

Native Pi handoffs work without an external service. MemPalace remains an optional adapter using your existing installation, supported MCP operations, project isolation, deduplication, and sourced retrieval. `/handoff` and `/handoff-use` keep context user-reviewed. Generated handoffs are never submitted automatically to Google.

## Verification and limits

```bash
npm run check
PI_POLY_SANDBOX_TEST=1 npm test
npm run qualify -- openai-codex
```

Tests use temporary authentication stores and deterministic transports. The opt-in sandbox tests need Linux namespace support. `PI_POLY_HISTORICAL_TEST=1 npm test` additionally checks the negative path cases against `525ec19`; it needs that local Git object and never fetches history automatically. See [the coverage test](tests/isolation-coverage.test.ts). Qualification prints a manual checklist without authentication or provider requests.

`npm run dogfood:offline` exercises a documentation change and independent review against a disposable clone of this repository, with real Pi SDK workers and a Bubblewrap acceptance test. It preserves results for inspection and never integrates into this checkout. See [dogfooding](docs/dogfooding.md) for the live exercise you must personally initiate, and [qualification evidence](docs/qualification.md) for observed compatibility and limitations.

**No live subscription execution has been qualified.** Mocked provider scenarios and a loopback fake OpenAI-compatible server establish local behavior only. Worker session continuation, recursive delegation, network-enabled worker tools, and arbitrary Pi extension hooks inside workers remain unsupported. Executable integrations require directory inventories or explicit entry-only trust; project JSON never imports code. See [migration](docs/migration-v04.md), [architecture](docs/architecture.md), [roadmap](docs/roadmap.md), and optional [terminal integrations](docs/terminal.md).

## License

Original source is GPL-3.0-or-later. See [LICENSE](LICENSE). Dependencies retain their own licenses.

The Claude Agent SDK is separately licensed by Anthropic. Review its [license](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/LICENSE.md) and [applicable terms](https://code.claude.com/docs/en/legal-and-compliance) before use or packaging. Claude Code and Antigravity remain separately installed runtimes. Source publication does not establish subscription authorization.
