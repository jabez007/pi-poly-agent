# Migrate from v0.4 to v0.4.1

No task, workflow, recipe, session, credential, or memory migration runs automatically. Pi and provider dependencies stay pinned. Bootstrap remains repeatable and leaves existing files intact.

## Enable native resources intentionally

Native Pi resources can now load in the interactive host. Review previously ignored resources before launching with `--trust-native-resources`. Native `npm run pi -- install SOURCE` and `npm run pi -- config` also acknowledge trusted user-resource execution. Project resources retain a separate native trust decision. See [native Pi resources](pi-ecosystem.md).

Native settings may now manage packages, extensions, skills, prompts, themes, display preferences, and tools. Preserve the managed compaction, retry, and cache-warming values. Proxy overrides, automatic project trust, and `models.json` remain restricted. Use explicit provider instances for custom endpoints. Existing authentication stores are never imported.

Worker skills may select `pi:skill:NAME` and `pi:prompt:NAME`. Existing text registrations and instruction functions continue to work. Native executable extensions do not automatically enter workers.

## Review executable integration trust

Existing `integrations.json` entries retain their path and digest but now require `"trust": "application-code"`. Add that field only after reviewing imports and dependencies. An entry digest does not attest the import graph. Optional `root` and `files` inventories detect local package changes. See [integration integrity](security.md#integration-integrity-in-v041). The loader never edits the manifest or silently grants this trust.

## Continue recoverable workflows

Use `/workflow-runs`, inspect task results, then `/workflow-runs RUN_ID continue`. Confirm continuation. Completed validated steps are reused in a new linked run; pending steps require new approval. Uncertain workers, unavailable source, stale revisions, missing artifacts, canceled runs, and changed provider policies block continuation. Recover uncertain tasks explicitly before continuing. Provider-private sessions are not resumed.

Older records without durable workflow-step dispatch identities cannot always reconcile an unlinked task after a crash. They remain available for manual inspection. No uncertain operation is replayed to repair such a record.
