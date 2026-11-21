# Work with independent Pi agents

## Launch in your project

Install and bootstrap the Pi Poly checkout once. To preserve your project's working directory, invoke the launcher from that project:

```bash
pi_poly_checkout=/absolute/path/to/pi-poly-agent
cd /path/to/your/project
node --import "$pi_poly_checkout/node_modules/tsx/dist/loader.mjs" "$pi_poly_checkout/scripts/cli.ts" launch
```

Use Node 22.19 or newer. This command uses the checkout's isolated `.poly/agent` profile. Add `--continue` or `--resume` for Pi's native session history. No shell, tmux, Neovim, or Lazygit changes are required.

Unknown project `.pi/settings.json`, `models.json`, and `mcp.json` files cause launch to stop for review. They are preserved. Parent sessions retain Pi's normal AGENTS.md discovery. Workers receive fresh context and must read relevant AGENTS.md files through their scoped tools.

## Delegate implementation

Commit or stash your changes first. Delegation refuses a dirty parent, including untracked files. It never stashes or overwrites them.

1. Use `/agents` to inspect roles and provider capabilities.
2. Run `/delegate builder openai-codex/MODEL task objective and acceptance criteria`. Omit `provider/model` to select an authenticated, authorized model through Pi's UI.
3. Review the proposed brief and approved context in the editor. This packet does not include the entire parent transcript.
4. Confirm the selected role and provider/model.
5. Watch the task's status and completion message. Use `/tasks` or `/task ID` for results.

Tasks run as independent Pi SDK sessions with their own session files. Each task has a UUID, parent session, role, provider/model, Git base, branch, and worktree. Two may run concurrently. Additional dispatches fail clearly at the concurrency limit.

Builders can read, edit, and write text files inside their worktree. Access outside the worktree, symlinks, and sensitive configuration paths is denied. They cannot use a general shell, arbitrary MCP tools, or another delegation tool.

A builder can request `run_test`. Inspect its command before the single-use approval. Bubblewrap gives it network-disabled execution with a temporary HOME, system runtimes, and the task worktree at `/workspace`. No provider credentials or Git common directory are mounted. Tool commands cannot fall back to the host shell if Bubblewrap or namespaces are unavailable. Test results record actual tool execution, replacing model-authored test claims.

Dependencies must exist in the task worktree. Network installation and access to the parent's `node_modules` are unavailable inside the sandbox. Provision dependencies manually when appropriate. Build scripts may modify the task worktree and produce outputs. Successful task snapshots include all resulting non-ignored changes, so inspect the diff before integration.

## Request an independent review

After the builder completes:

```text
/review BUILDER_ID kimi-coding/MODEL
/task REVIEW_ID
/task BUILDER_ID diff
```

The reviewer receives the objective, approved project context, changed files, and the builder's result labeled as unverified. It starts at the builder's captured commit in a separate worktree. Its tools can read scoped files and compare each file against the builder's original base. It cannot edit files, run a shell, or launch subagents.

Use another authorized provider/model if desired. Roles are independent of provider choice. A review is a separate execution even when you choose the same provider. Only fixtures using Codex and Kimi identities have been tested; live model quality is unqualified.

The parent model can request `delegate_task` and inspect `task_status`. To review a builder, it must set `role: "reviewer"` and `reviewOf` to that builder's ID. Dispatch through this tool uses the same capability checks, context preview, and human confirmation as `/delegate`. Completion messages do not automatically start a parent or Google turn.

## Accept or discard changes

Run `/task BUILDER_ID integrate` after a completed independent review. Pi shows the diff and review findings, then asks for approval. Integration cherry-picks the captured commit into the parent only if the parent is clean and still at the recorded base. A changed builder worktree also prevents integration. Review findings are evidence for your decision; a completed review does not mean the change is correct.

If the parent moved, use your normal Git tools to inspect or integrate the task branch manually. If a cherry-pick reports a conflict, inspect it with Git or Lazygit. The extension does not reset or overwrite conflicts.

Run `/task ID cancel` to stop active work. Timeout defaults to 15 minutes. Native provider cancellation and sandbox process termination propagate from the task signal. Worktrees remain available on success, failure, timeout, and cancellation. `/task ID cleanup` removes a clean inactive worktree without forcing deletion or removing its branch. Dirty worktrees require manual inspection and preservation of changes first.

Task records live under `.poly/agent/tasks/PROJECT_WING/ID/task.json`. Child Pi session files live next to that task's worktree in `sessions/`. On restart, running records become `interrupted`. Results and worktrees survive; provider work is not replayed. Use one Pi task host per project. Cross-process dispatch coordination is not implemented.

## Configure roles and limits

Optionally create `.poly/agent/orchestration.json`:

```json
{
	"concurrency": 2,
	"timeoutMs": 900000,
	"roles": {
		"builder": { "model": "openai-codex/MODEL" },
		"reviewer": { "model": "kimi-coding/MODEL" },
		"researcher": { "instructions": "Investigate project code and cite file paths and lines." }
	}
}
```

Concurrency is 1–4, timeout is 1–3600 seconds, and delegation depth is fixed at one. `model` and `instructions` are configurable. Role editing permissions are fixed: only builders edit. No provider is selected as an implicit fallback.

## Preserve useful context

Run `/handoff` after implementation and review. The draft includes the current session objective, completed task summaries, changed files, sourced findings, outstanding questions, and selected historical memory. Agent-authored summaries and review findings remain unverified until you verify them. Edit the Markdown sections and use `text | source` for facts. Confirm the preview before saving.

`/memory-save` persists the reviewed packet through the existing MemPalace MCP interface. Durable facts, decisions, questions, and hypotheses are separate items in `knowledge`; the session packet remains in `handoffs`. Stable knowledge IDs exclude session IDs and timestamps. Backend exact deduplication and retrieval deduplication complement these IDs. Near-duplicate wording and source changes can still create multiple backend records.

Configure `memory.contextBudget` in `.poly/agent/poly.json` to set the retrieval budget in characters, from 256 to 24000; the default is 12000. Retrieval parses records, ranks relevance and certainty, applies a modest recency preference, and retains older relevant decisions. Conflicting claims remain separate. Explicit `memory.sharedWings` enable additional project retrieval. There is no automatic personal-vault access.

When memory is unavailable, delegation and Pi history still work. Nothing automatically promotes agent output to verified knowledge or sends memory to a provider.

## Switch providers and recover sessions

Use `/model`, then `/handoff-use`. Review the packet in the editor and submit it yourself. Google ACP always requires this direct submission.

After explicit Google activation, `/poly-google-discover` can attempt documented `session/load` when the runtime advertises support and Pi has a saved binding for the same project directory. Failed or unsupported restoration preserves the binding and Pi history. Prepare `/handoff`, then use `/poly-google-discover new` and confirm if you want a new official session. A local handoff never claims to restore provider-private execution state.

Automatic compaction and turn retries remain disabled. Manual `/compact` requires a reviewed `/handoff`, enabled MemPalace, confirmation, and a successful checkpoint first. Compaction that would replay a turn is denied. Google ACP compaction is denied because its consumer session cannot receive an automated summary request.
