# Move from v0.3 configuration

v0.4 preserves `.poly/agent`, native Pi sessions, task UUIDs, worktree branches, result records, original review relationships, and replacement history. It does not rewrite existing files or restart workers.

Without a new platform configuration, `orchestration.json` continues to supply the four compatibility examples, their model/instruction overrides, concurrency, and timeout. Unknown legacy role names now receive an error directing you to arbitrary agent definitions in `platform.json`. The legacy `editing` override still grants no rights.

To choose a new configuration, create `.poly/agent/platform.json` with `npm run recipe -- NAME`, provided the file does not exist. Supported recipes are `minimal`, `implementation-review`, `agent-team`, and `odoo-team`. If it exists, inspect and edit it yourself. `bootstrap` and `recipe` do not overwrite it.

An explicit platform configuration replaces implicit legacy role loading. Copy any desired limits into `policy`, and model assignments into the matching agent definitions. For example:

```json
{
	"version": 1,
	"recipes": ["implementation-review"],
	"policy": { "concurrency": 2, "timeoutMs": 900000 },
	"agents": {
		"builder": { "model": "openai-codex/YOUR_MODEL_ID" },
		"reviewer": { "model": "kimi-coding/YOUR_MODEL_ID" }
	}
}
```

The legacy `/implement` command is now an alias for `/workflow implementation-review`. `/review` selects the compatibility reviewer or a configured read-only agent tagged `inspection`. These aliases are registered only when the relevant recipe or agent exists. Arbitrary agents and workflows need no new command handler.

Task JSON retains `role` as the historical assigned-agent field. New records add effective policy and artifacts. Existing records without those fields retain conservative compatibility permissions. Review/integration still checks the recorded snapshot and original base. Old `workflowReviewModel` values remain inspectable but do not restart a review offer automatically.

Unfinished workflow runs become interrupted on restart. There is no automatic workflow or provider continuation. v0.4.1 adds [explicit validated workflow continuation](migration-v041.md). Inspect task IDs, preserved changes, and results before explicitly replacing a task or starting another run. Corrupt workflow records fail closed and remain on disk for manual inspection.

Minimal configuration disables external context even if an earlier profile used MemPalace. To retain memory in an explicit configuration, add `context: ["native", "mempalace"]` and keep `memory.enabled` in `poly.json`. Project isolation, secret screening, reviewed `/handoff`, and manual `/memory-save` remain unchanged. The palace is never initialized or migrated.

Keep executable integrations in the checksum-pinned managed-profile manifest. Native Pi settings and resources remain separate from orchestration JSON. v0.4.1 enables them through [the native trust path](pi-ecosystem.md). Do not move provider credentials into project JSON. See [configuration and trust rules](platform.md).
