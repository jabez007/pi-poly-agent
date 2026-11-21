# Pi Poly Agent

A composable, terminal-native orchestration platform around Pi Coding Agent. Configure ordinary Pi with several providers, occasional delegation, or a specialized agent team without changing the orchestration core.

Pi owns the TUI, agent loop, model picker, tools, and conversation history. Pi Poly Agent adds guarded provider instances, configurable agents, bounded workflows, durable tasks, isolated Git worktrees, and optional project context. There is no separate frontend or orchestration daemon.

## Install and choose a configuration

Use Node.js 22.19 or newer. The checked runtime is 22.21.1. Dependencies are pinned in [package.json](package.json) and [package-lock.json](package-lock.json).

```bash
npm ci --ignore-scripts
npm run bootstrap
npm run recipe -- minimal
npm run validate
npm start
```

`recipe` creates `.poly/agent/platform.json` only when absent. It never overwrites an existing choice. To change recipes, edit that file explicitly. Bootstrap preserves existing Pi, Claude Code, Google, editor, and authentication configuration. Installation never starts a login or inference request.

The `minimal` recipe has no agent definitions, workflows, external memory, or worker status display. Use Pi's `/login` for native Codex or Kimi authentication and `/model` to switch. Z.AI requires coding-plan opt-in. Claude SDK and Google ACP start locked. See [provider setup](docs/providers.md).

Existing profiles without platform configuration retain the v0.3 compatibility agents and commands. Nothing migrates or deletes task history automatically.

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

Editing permissions come from intersected policies, not agent names. Agents may select approved tools, instruction skills, context sources, provider instances, and execution limits. [Configuration and extension contracts](docs/platform.md) describe layering, packages, custom endpoints, trusted integrations, and complete examples.

## Reliability and account protections

Tasks retain source changes, results, artifacts, session references, and exact review revisions across restart. Interrupted tasks remain visible. Recovery launches a separately approved replacement; it does not claim to restore provider-private execution state. Workflow runs also become interrupted after restart, without automatic replay.

Every task uses an isolated Git worktree. Consequential test commands require single-use approval and Linux Bubblewrap. Tests have no network or host credentials, and failed sandbox startup never falls back to an unrestricted shell. Dependency preparation is explicit. See [workflows and recovery](docs/workflows.md).

Google consumer ACP is direct-interaction-only and cannot become a worker through configuration or an adapter alias. Claude subscription delegation remains blocked. Request guards reject unexpected authentication environments, endpoint overrides, and billing fallback. Custom API instances require explicit activation; local instances use loopback endpoints. [Security](docs/security.md) documents the trust limits of executable integrations.

Native Pi handoffs work without an external service. MemPalace remains an optional adapter using your existing installation, supported MCP operations, project isolation, deduplication, and sourced retrieval. `/handoff` and `/handoff-use` keep context user-reviewed. Generated handoffs are never submitted automatically to Google.

## Verification and limits

```bash
npm run check
PI_POLY_SANDBOX_TEST=1 npm test
npm run qualify -- openai-codex
```

Tests use temporary authentication stores and deterministic transports. The opt-in sandbox tests need Linux namespace support. Qualification prints a manual checklist without authentication or provider requests.

**No live subscription execution has been qualified.** Mocked provider scenarios and a loopback fake OpenAI-compatible server establish local behavior only. Worker session continuation, recursive delegation, network-enabled worker tools, and arbitrary Pi extension hooks inside workers remain unsupported. Executable integrations require explicit checksum pinning; project JSON never imports code. See [migration](docs/migration-v04.md), [architecture](docs/architecture.md), [roadmap](docs/roadmap.md), and optional [terminal integrations](docs/terminal.md).

## License

Original source is GPL-3.0-or-later. See [LICENSE](LICENSE). Dependencies retain their own licenses.

The Claude Agent SDK is separately licensed by Anthropic. Review its [license](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/LICENSE.md) and [applicable terms](https://code.claude.com/docs/en/legal-and-compliance) before use or packaging. Claude Code and Antigravity remain separately installed runtimes. Source publication does not establish subscription authorization.
