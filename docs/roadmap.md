# Roadmap after v0.2

v0.2 delivers provider invocation hardening and a tested delegation slice: independent Pi SDK workers, parallel task status, isolated builder worktrees, read-only independent review, explicit integration, and reviewed memory context. Live authentication and model execution remain unqualified.

## Next three priorities

1. **Qualify the authorized native workflow.** With separate explicit authorization, test actual Codex → Kimi and Codex → Z.AI implementation/review in disposable repositories. Check cancellation, credential refresh, model availability, test approval, and failure reporting. Resolve Claude subscription authorization separately. Verify the official Google runtime and direct ACP recovery without introducing Google workers.
2. **Improve worker recovery and development tooling.** Add a per-project host lease, explicit interrupted-session continuation, dependency provisioning for isolated worktrees, scoped code-search tools, and safer cleanup of reviewed branches. Preserve independent review and final human approval. Distinct custom API or open-weight endpoints need explicit billing and credential policies before registration.
3. **Improve context quality.** Add indexed provenance links between stable knowledge IDs and session snapshots, stronger deduplication across paraphrases, conflict/supersession review, and reviewed incremental checkpoints. Expand deterministic retrieval fixtures before enabling automatic memory extraction. Keep task execution independent of MemPalace availability.

## Remaining P2 work

- Memory deduplication is stable for unchanged knowledge with stable sources. Paraphrases and changed source references may produce multiple backend drawers. Retrieval deduplicates normalized overlap but does not reconcile conflicting claims automatically.
- Handoff drafting uses deterministic Pi history and task results, not a model-authored summary. It deliberately marks summaries and findings unverified. Selection of source facts and verification still need human review.
- ACP restoration supports advertised stable `session/load`. Draft `session/resume`, session enumeration, stale remote bindings, and live interruption behavior need qualification. No provider-private state is simulated from a local handoff.
- Manual compaction is gated by a reviewed MemPalace checkpoint. Automatic compaction remains disabled. Bounded pre-request retries require proof that a failed transport accepted no prompt or non-idempotent operation; no retry policy is enabled speculatively.
- Worker progress shows activity and completed structured results. Live token streaming, richer findings renderers, task filtering, and notification quality can improve without a separate dashboard.
- Researchers inspect local code and supplied documentation only. A policy-reviewed web research tool is not implemented.

## Optional terminal integration

Add tmux and Neovim commands, Lazygit task-branch shortcuts, planning/review prompt templates, and compact status widgets as opt-in modules. Retain standalone Pi and normal Git workflows. No daemon, distributed queue, or web frontend is planned for these features.
