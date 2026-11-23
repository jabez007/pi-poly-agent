# Roadmap after v0.5

Pi remains the resource platform. Pi Poly Agent adds provider eligibility, bounded tasks/workflows, workspace isolation, artifacts, and attributed context. Native parent extensions, skills, prompts, themes, packages, filtering, project trust, and reloads work through the pinned Pi 1.5.2 mechanisms. Workers accept selected native instruction snapshots, with executable discovery disabled.

## Foundational work for v0.6

1. Qualify representative maintained Pi packages in real interactive sessions and explicitly authorized Codex → Kimi/Z.AI workflows. Include real local endpoints separately. Record resource versions, provider/model IDs, billing classification, cancellation, and observed tool behavior. Offline fixtures do not establish live compatibility.
2. Use doctor and the supervised dogfooding recipe in everyday projects. Refine diagnostics from observed user friction, including unsupported adapters and language-specific preparation. The read-only report now lists resource scopes, effective permissions, layer origins and integration approval state. It deliberately does not validate credentials or execute third-party code.
3. Verify release distribution and upgrades against the pinned SDK. Resolve the pin-specific Pi extension-loader subpath workaround through an independently tested upstream fix. Offline native local-package and integrity fixtures now run in CI; hosted sandbox results remain dependent on namespace availability. Broader distribution still needs maintained-package compatibility evidence, observed hosted CI results for the release, and reviewed upgrade artifacts. Keep dependency updates separate and test Pi's actual installed APIs before adopting current documentation.

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

## v0.5 readiness

Native package/resource fixtures, generic recipes, durable recovery and centrally restricted workers are ready for wider offline testing. Executable integrations now default to directory review; entry-only approvals require an explicit acknowledgment of unverified imports. Neither mode attests imports outside its recorded scope or sandboxes trusted application code.

Wider live-use claims remain blocked on explicitly authorized Codex, Kimi, Z.AI and real compatible-endpoint qualification. Claude account authorization remains unresolved and its workers remain disabled. Google requires its existing activation review and direct interactive qualification; consumer ACP workers remain forbidden. A successful fixture or CI run cannot remove those blockers.

The next priorities are maintained native package and authorized provider qualification, terminal recovery acceptance, and reproducible release/upgrade verification. Supporting-file snapshots, template arguments and provider-private worker session continuation can wait. No new scheduler or extension runtime is needed.

## v0.6 recommendation

Keep the established coding harness as the primary implementation environment until a user-authorized live self-development exercise passes. v0.5 delivered doctor, separate profile/project selection, native command pickers, a bounded opt-in probe, real package/resource tests and an offline self-development workflow. These are ready for supervised trials, not a daily-driver certification.

Prioritize live Codex → Kimi/Z.AI qualification and human dogfooding, then actual terminal/package update/recovery acceptance, and reproducible release/upgrade verification. Broader extension curation, automatic setup wizards and additional autonomous workflows can wait. Namespace-limited hosted CI still needs local Bubblewrap evidence.
