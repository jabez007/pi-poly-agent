# Pi Poly Agent

An isolated, terminal-first Pi profile for ChatGPT Codex, Kimi Coding, Z.AI Coding Plan, Claude Agent SDK, and Google's official Antigravity ACP runtime.

Pi supplies the TUI, streaming display, tools, model picker, branching history, and session files. This project adds account safeguards and structured MemPalace handoffs. It does not install another agent orchestrator.

## Install and launch

Use Node.js 22.19 or newer and npm. The implementation was checked with Node 22.21.1. Dependency versions are pinned in [package.json](package.json) and [package-lock.json](package-lock.json).

```bash
npm ci --ignore-scripts
npm run bootstrap
npm run validate
npm start
```

Bootstrap creates `.poly/agent` in this checkout. It never copies credentials, starts a login, contacts a provider, or writes to your existing Pi, Claude, Google, or Neovim configuration. Repeating bootstrap preserves the profile. A conflicting managed settings file causes an error instead of an overwrite.

Validation reports conflicting environment variable names, never their values. Resolve those conflicts in the terminal where you intend to run Pi. An inherited `ANTHROPIC_API_KEY`, proxy, or billing override prevents launch. See [provider setup](docs/providers.md).

Pi must run in an interactive terminal. Startup uses `--offline` to prevent automatic authenticated catalog refreshes. Normal user prompts and explicitly invoked native login flows can use the network. The managed launcher accepts `--continue`, `--resume`, and `--model provider/model`.

```bash
npm start -- --continue
npm start -- --resume
```

Use `/login` for native Codex or Kimi authentication, `/model` to switch, and `/poly-status` to inspect authentication paths. Claude and Google start locked. Their local code is implemented and mock-tested; no subscription authentication or model execution has been validated. Enabling either requires the review and activation steps in [providers.md](docs/providers.md).

## Continue a task across providers

1. Run `/handoff` and fill in the structured JSON checkpoint.
2. Keep verified facts, source references, and hypotheses distinct.
3. Review the checkpoint and confirm that it contains no secrets.
4. Switch with `/model`.
5. Run `/handoff-use`, review the text in the editor, and submit it yourself.

The checkpoint lives in Pi's native history. To use your existing MemPalace, set `memory.enabled` to `true` in `.poly/agent/poly.json` and restart. `/memory-save` persists the reviewed checkpoint. `/memory-recall` retrieves project knowledge, `/memory-show` previews it, and `/handoff-use` prepares it for manual submission. No memory command automatically prompts Gemini.

## First milestone

Implemented and checked without account access:

- Reproducible dependencies, non-destructive bootstrap, strict validation, and isolated auth storage.
- Native coding-plan providers, a locked upstream Claude bridge, and a locked official-ACP adapter.
- Pi model selection, approvals, streamed ACP text and reasoning, and cancellation with mock transports.
- Structured local handoffs and optional project-isolated MemPalace MCP checkpoints and retrieval.
- Lint, complexity checks, type checks, formatting checks, and isolated automated tests.

Deferred work includes live qualification, automated checkpoint drafting, quota display, image attachments for ACP, delegated reviews, worktree task management, and optional tmux or Neovim bindings. See [roadmap](docs/roadmap.md).

## Development

```bash
npm run check
```

Tests use temporary home and configuration directories. They do not load your subscription credentials or start provider runtimes. There is no automatic live-test command or CI activation path.

Read the [architecture](docs/architecture.md), [provider reference](docs/providers.md), [security assessment](docs/security.md), and [workflows](docs/workflows.md).

## License

This project's original source code is licensed under GPL-3.0-or-later. See [LICENSE](LICENSE). Third-party dependencies retain their own licenses. This repository's license does not relicense them.

The Claude Agent SDK is separately licensed by Anthropic. Review its [license](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/LICENSE.md) and [applicable terms](https://code.claude.com/docs/en/legal-and-compliance) before use or packaging. Claude Code and Antigravity are external runtimes installed independently and are not redistributed in this repository. Any packaged distribution needs a separate review of the dependencies and runtimes it includes. Publishing this source does not establish permission to use subscription authentication through an integration.
