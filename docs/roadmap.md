# Roadmap after v0.3

v0.3 retains the Pi SDK worker architecture and adds durable recovery, a project host lease, exact-revision integration, worktree prerequisites, categorized failures, guided implementation/review, task selection, focused memory context, qualification plans, and optional terminal integration examples. It does not establish live provider compatibility.

## Priorities for v0.4

1. Qualify Codex → Kimi and Codex → Z.AI with explicitly authorized accounts using the [manual checklist](qualification.md). Measure cancellation, credential refresh, model availability, approval behavior, and naturally occurring provider errors. Keep Claude authorization and Google direct-only runtime qualification separate.
2. Qualify explicit Pi session continuation, including pending-tool detection and model-generation interruption. Until replay safety is established, keep fresh replacement workers and preserve original records. Improve recovery for missing worktrees, moved parent branches, interrupted acquisition guards, and interrupted Git integration without automatic resets.
3. Extend preparation through small language adapters: offline package caches, Python dependency checks, and Go vendor validation. Keep installers opt-in, isolate cache contents, and avoid copying credentials. Current Node copying is intentionally strict and can refuse legitimate dependency fixtures; no code automatically runs an installer to work around refusal.
4. Improve context with indexed source links, paraphrase deduplication, reviewed supersession of conflicting knowledge, and incremental checkpoints. Keep agent claims unverified and task state outside MemPalace.
5. Add guided revision requests after review and richer scoped code search. Keep roles independent of models, explicit launch/integration approvals, bounded concurrency, and depth one.

## Deliberate limits

- No authenticated provider tests have run for this milestone. Mock transport tests and local sandbox/TUI tests are separate evidence.
- Worker private execution state is not resumed. Replacement is explicit, starts a new transcript, and preserves source/history.
- Automatic retries, compaction, and provider switching remain disabled. A failed stream does not prove that a generation or tool action had no effects.
- Managed host exclusion applies to the same project/profile on a local Linux filesystem. It is not a distributed lock or a guard against unmanaged programs and manual Git changes.
- Python and Go preparation reports prerequisites; it does not provision virtual environments, external module caches, or language runtimes.
- Reviewers inspect source and diffs with read-only tools. Researchers inspect local code and supplied documentation, without web tools.
- Memory retrieval is optional and bounded. It does not automatically verify agent findings or reconcile contradictions.
- Custom API/open-weight endpoints remain unconfigured pending separate billing and credential policies. Google consumer ACP workers remain forbidden, and Claude subscription workers remain blocked.
