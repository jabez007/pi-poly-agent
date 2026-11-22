# Roadmap after v0.4.1

Pi remains the resource platform. Pi Poly Agent adds provider eligibility, bounded tasks/workflows, workspace isolation, artifacts, and attributed context. Native parent extensions, skills, prompts, themes, packages, filtering, project trust, and reloads work through the pinned Pi 1.5.2 mechanisms. Workers accept selected native instruction snapshots, with executable discovery disabled.

## Foundational work for v0.5

1. Qualify representative maintained Pi packages in real interactive sessions and explicitly authorized Codex → Kimi/Z.AI workflows. Include real local endpoints separately. Record resource versions, provider/model IDs, billing classification, cancellation, and observed tool behavior. Offline fixtures do not establish live compatibility.
2. Improve configuration diagnostics and reviewed resource provenance. Add an inspect-only report for native resources, effective worker permissions, configuration origins, and package contribution references. Evaluate immutable integration deployment with dependency lockfiles. Do not add a second package manager or claim whole-import attestation from entry hashing.
3. Evaluate release distribution and upgrades against the pinned SDK. Broader distribution needs package compatibility evidence, clear migration/trust prompts, and CI coverage for native local packages. Keep dependency updates separate and test Pi's actual installed APIs before adopting current documentation.

## Optional enhancements after qualification

- Supporting-file snapshots and native template arguments for selected worker instructions, within existing path and budget rules.
- Clearer artifact and workflow recovery inspection, review-driven revision recipes, and context supersession.
- Small language-specific preparation adapters and approved offline caches. Python and Go provisioning remain manual.
- Provider-private session continuation only after pending-tool reconciliation can establish that no uncertain action repeats.

## Current limits

- No provider has been live-qualified in automated checks. Claude subscription workers remain blocked; Google consumer ACP remains direct-only.
- Parent extensions are trusted application code. Arbitrary native extensions cannot run inside a restricted worker. Custom worker tools/provider factories still require reviewed application-code adapters; metadata is not a JavaScript sandbox.
- Existing suppressed executable resources require explicit trust acknowledgment. Project trust remains native. `models.json`, proxy overrides, automatic project trust, turn retries, compaction, and cache warming remain restricted in the managed profile.
- Workflow continuation is explicit and creates a linked run. Completed tasks are reused only after validation. Uncertain workers need explicit task recovery; ambiguous legacy dispatches require manual reconciliation. No provider request or completed tool operation is automatically replayed.
- All tasks use Git worktrees. Test execution needs effective read/write/test permissions, single-use approval, and Bubblewrap without network or host credentials. Graphs remain bounded DAGs without recursive delegation or unattended integration.
- Compatible endpoints use explicit model IDs and declared limits. Automatic endpoint discovery and real server compatibility remain unqualified. There is no adaptive routing, model hosting, OAuth bridge, subscription proxy, or billing fallback.
- MemPalace remains optional. Native context/MCP extensions can coexist without implementing `ContextBackend`. Generic backend writes remain reviewed extension operations; task events stay in local records.

Avoid building a generic plugin runtime, competing extension/skill formats, an orchestration daemon, or more autonomous planning to solve these compatibility and qualification gaps.
