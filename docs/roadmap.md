# Roadmap after v0.4

The platform now supports arbitrary JSON agents, intersected execution policy, registered provider instances, bounded declarative workflows, generic artifacts, optional context backends, trusted integration modules, and four recipes. It retains the v0.3 task controller, recovery, worktrees, sandbox, native Pi sessions, provider adapters, and account protections.

## Highest-value next work

1. Qualify live Codex → Kimi and Codex → Z.AI using explicitly authorized accounts and the [manual checklist](qualification.md). Qualify real local/open-weight endpoints separately. Mock and loopback-fixture results do not establish live compatibility.
2. Add explicit interrupted workflow-step continuation and safe SDK session continuation after pending-tool reconciliation. Preserve original runs and require approval; never infer that an uncertain generation can be replayed.
3. Improve integration distribution with whole-package integrity, dependency manifests, resource provenance, and a dry-run configuration inspector. Entry-module checksums currently do not cover transitive imports. Keep project configuration declarative and trusted code explicit.
4. Extend workspace preparation through small language adapters and approved offline caches. Python and Go provisioning remain manual. Consider additional workspace strategies only when their filesystem and Git contracts can be enforced.
5. Improve review-driven revision recipes, artifact inspection, memory supersession, and source relevance without adding an autonomous planner or another task database.

## Current limits

- All subscription providers remain live-unqualified. Claude subscription workers remain blocked, and Google consumer ACP remains direct-only.
- Task recovery uses approved replacement workers. Workflow restart preserves records but does not continue steps automatically.
- Graphs are bounded DAGs with text input and explicit dependencies. There are no loops, recursive delegation, expression evaluation, unattended gates, or integration steps that silently apply changes.
- All tasks use Git worktrees. Read-only filesystem tools cannot write; executable tests require effective write permission, single-use approval, and Bubblewrap without networking.
- Skills and worker extensions contribute approved instructions. Arbitrary Pi hooks and subprocess access are unavailable inside workers. Trusted custom tool and adapter code has application-process authority and must be reviewed.
- Native compatible-endpoint configuration uses static model IDs. Routing is exact or requires one unambiguous capability match. There is no model hosting, adaptive routing, subscription proxy, or billing fallback.
- MemPalace remains optional. Generic custom-backend writes are not wired to automatic checkpointing. Task events stay in local records rather than MemPalace logstream.
- Automatic retries and compaction remain disabled. Local host exclusion is not a distributed lock or protection against unmanaged programs and manual Git operations.
