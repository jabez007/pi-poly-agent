# Roadmap

## v0.6.0

The supported scope is several models and runtimes in one Pi session.
Native Codex, Kimi and Z.AI remain available.
Claude ACP is the default Claude mode; the bridge remains opt-in.
Gemini uses official Antigravity ACP.
Context handoffs remain user-reviewed, with optional MemPalace storage.
Native Pi owns resource loading and configuration.
Herdr integration uses its existing Pi extension.
Workers, worktrees, review gates, agent recipes and workflow execution have been removed.

## Qualification still pending

The automated suite uses mocked providers, local protocol fixtures and native Pi resource fixtures.
It does not establish live subscription compatibility or Anthropic endorsement.
Live Claude, Gemini, Codex, Kimi and Z.AI usage needs separate owner testing.
Herdr commands are documented from upstream; live restoration in a Herdr pane still needs owner testing.

The next useful work is supervised provider qualification and reporting concrete model-switching or handoff failures.
No additional orchestration engine is planned here.
