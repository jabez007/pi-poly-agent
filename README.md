# Pi Poly Agent

Several models and runtimes in one [Pi](https://github.com/badlogic/pi-mono) session: native Codex, Kimi and Z.AI, plus opt-in Claude Code and Gemini adapters.
Pi owns the terminal, sessions and native packages.
Poly adds runtime selection and user-reviewed context handoffs.

Use Node >=22.19, then run:

```bash
npm ci --ignore-scripts
npm run bootstrap
npm run doctor
npm start
```

Use `/login` for Pi-managed providers and `/model` to switch models.
Claude and Gemini are off by default in `.poly/agent/poly.json`.

- Claude: run `claude auth login` yourself, set `claude.enabled` to `true`, then use `/poly-claude-discover` inside Pi.
  ACP is the default; `claude.mode: "bridge"` selects the alternative Pi tool loop.
- Gemini: run `agy` yourself and sign in, set `google.enabled` to `true`, then use `/poly-google-discover` inside Pi.

Use `/handoff` to review context, switch with `/model`, then `/handoff-use` to prepare the editor for your next submission.
MemPalace is optional.

See [provider settings](docs/providers.md), [native Pi resources](docs/pi-ecosystem.md), [Herdr setup](docs/herdr.md) and [migration to v0.6](docs/migration-v060.md).
Herdr handles background helpers and terminal sessions; Poly no longer manages workers, worktrees or review gates.

GPL-3.0-or-later; see [LICENSE](LICENSE).
