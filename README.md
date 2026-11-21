# Pi Poly Agent

A terminal-first Pi environment with native Codex, Kimi, and Z.AI providers, guarded Claude SDK and Google ACP adapters, independent worker sessions, and optional MemPalace context.

Pi supplies the TUI, agent loop, model picker, tools, and conversation history. This project adds provider policy, focused delegation, task worktrees, and reviewed handoffs. No separate frontend or orchestration daemon is required.

## Install and launch

Use Node.js 22.19 or newer and npm. The checked runtime is Node 22.21.1. Dependencies are pinned in [package.json](package.json) and [package-lock.json](package-lock.json).

```bash
npm ci --ignore-scripts
npm run bootstrap
npm run validate
npm start
```

Bootstrap preserves existing configuration and creates only this checkout's `.poly/agent` profile. It never copies credentials, starts a login, contacts a provider, or changes your Pi, Claude, Google, or Neovim settings. Validation reports conflicting environment variable names without values.

Use `/login` for native Codex or Kimi authentication, `/model` to switch, and `/poly-status` to inspect authentication paths. Z.AI requires coding-plan opt-in. Claude and Google start locked. See [provider setup](docs/providers.md).

The launcher requires a terminal, starts offline, and accepts `--continue`, `--resume`, and `--model provider/model`. To work in a different repository, invoke the launcher by absolute path from that repository. See [workflows](docs/workflows.md).

## Implement, then independently review

Start with a clean, committed project. Substitute model IDs shown by `/model`.

```text
/agents
/implement Implement the bounded change and its acceptance tests
```

Choose an authorized Builder and a different Reviewer in the guided model pickers. Review each context packet and launch approval. When the builder finishes, Pi offers the independent review and then shows review/integration actions. Final integration always requires confirmation.

The individual commands remain available:

```text
/delegate builder openai-codex/MODEL Implement the bounded change and its acceptance tests
/tasks
/task BUILDER_ID
/review BUILDER_ID kimi-coding/MODEL
/task REVIEW_ID
/task BUILDER_ID diff
/task BUILDER_ID integrate
```

Each launch previews the focused brief and context for approval. Builders edit dedicated Git worktrees. Reviewers inspect a separate worktree at the builder's snapshot using read-only tools. Task completions appear inside Pi. Integration requires a completed review, a clean unchanged parent, and explicit confirmation.

Two tasks can run concurrently by default. `/task ID cancel` propagates cancellation. `/task ID cleanup` removes only clean, inactive worktrees and retains branches. Interrupted tasks are discovered on restart. `/task ID recover` reviews a new worker from preserved source changes. The original task remains in history; no provider request is automatically replayed.

Delegated test commands require a separate single-use confirmation and Linux Bubblewrap at `/usr/bin/bwrap`, with unprivileged namespaces enabled. The sandbox exposes task source and system runtimes, without host credentials or networking. There is no host-shell fallback. Node dependency preparation offers a screened, approved copy of parent `node_modules`. Python and Go prerequisite checks explain missing tooling and dependencies. Nothing installs packages automatically. See [workflow restrictions](docs/workflows.md).

## Continue across providers

`/handoff` drafts a Markdown context packet from Pi history, completed tasks, existing decisions, and retrieved memory. Review and correct it, keeping verified facts and unverified findings separate. Switch with `/model`, then use `/handoff-use` to place the packet in the editor for your own submission.

Set `memory.enabled` in `.poly/agent/poly.json` to reuse an existing MemPalace installation. `/memory-save` stores independent knowledge items and a separate session snapshot. `/memory-recall` retrieves project-scoped records; `/memory-show` previews them. No memory or task command automatically submits a prompt to Google ACP.

## v0.3 scope

Implemented with offline fixtures:

- Central inherited and per-request environment checks, contextual single-use ACP approvals, and fail-closed provider invocation.
- Capability-driven delegation to native Codex, Kimi, or opted-in Z.AI; configurable planner, builder, reviewer, and researcher roles.
- Independent Pi SDK sessions, bounded concurrency, cancellation, structured results, durable local task records, and isolated worktrees.
- Builder → Reviewer workflow with explicit integration, sourced memory selection, guided handoffs, and advertised ACP session restoration.
- Crash recovery with a project host lease, atomic synced task records, preserved source/session references, and explicit replacement workers.
- Exact-revision integration guards, interrupted integration reporting, worktree readiness, guided `/implement`, and selectable task actions.
- Task-specific optional memory retrieval and offline-generated [live qualification plans](docs/qualification.md).
- Manual compaction gated by a successful reviewed MemPalace checkpoint. Automatic compaction, turn replay, and native transport retries remain disabled.

**Live provider authentication and execution remain unqualified.** Claude subscription workers and Google consumer ACP workers are blocked. True provider-session continuation, custom API endpoints, automatic retries, and memory verification remain deferred. [Optional terminal examples](docs/terminal.md) support tmux, AstroNvim/Neovim, and Lazygit. See [roadmap](docs/roadmap.md).

## Development

```bash
npm run check
PI_POLY_SANDBOX_TEST=1 npm test
```

The second command also exercises real Bubblewrap isolation and requires Linux namespace support. Ordinary tests use temporary authentication stores and deterministic provider transports. They do not authenticate accounts. CI has no live-provider activation path. `npm run qualify -- openai-codex` prints a manual checklist without logging in or contacting a provider.

Read the [architecture](docs/architecture.md), [provider reference](docs/providers.md), [security assessment](docs/security.md), and [workflows](docs/workflows.md).

## License

Original source is GPL-3.0-or-later. See [LICENSE](LICENSE). Dependencies retain their own licenses.

The Claude Agent SDK is separately licensed by Anthropic. Review its [license](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/LICENSE.md) and [applicable terms](https://code.claude.com/docs/en/legal-and-compliance) before use or packaging. Claude Code and Antigravity are independently installed external runtimes. Bundled distributions require a separate dependency and runtime license review. Source publication does not establish permission for subscription authentication through an integration.
