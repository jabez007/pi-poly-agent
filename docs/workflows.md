# Run configured agents and workflows

The commands below for builder and reviewer apply to the optional `implementation-review` recipe or legacy compatibility profiles. Custom agents use `/delegate AGENT`; custom recipes use `/workflow NAME OBJECTIVE`. See [configuration examples](platform.md). Minimal profiles do not require these agents or enable the `/implement` and `/review` aliases.

## Launch in your project

Install and bootstrap the Pi Poly checkout once. To preserve your project's working directory, invoke the launcher from that project:

```bash
pi_poly_checkout=/absolute/path/to/pi-poly-agent
cd /path/to/your/project
node --import "$pi_poly_checkout/node_modules/tsx/dist/loader.mjs" "$pi_poly_checkout/scripts/cli.ts" launch
```

Use Node 22.19 or newer. This command uses the checkout's isolated `.poly/agent` profile. Add `--continue` or `--resume` for Pi's native session history. No shell, tmux, Neovim, or Lazygit changes are required.

Project resources use Pi's native trust decision. The managed profile still rejects unsafe authentication/proxy, retry and compaction overrides. Parent sessions retain Pi's normal AGENTS.md discovery. Workers receive fresh context and must read relevant AGENTS.md files through their scoped tools. See [native resource trust](pi-ecosystem.md) rather than treating all project configuration as forbidden.

For a separate development profile or project, add `--profile /absolute/path/to/agent --project /absolute/path/to/repository` to the managed command. `npm run doctor` and `/poly-doctor` report prerequisites without executing models. [Getting started](getting-started.md) gives the short installation path.

## Implement with guided independent review

Select the `implementation-review` recipe, then run `/workflow implementation-review Objective and acceptance criteria` or its `/implement` alias. Select an authorized Builder and a different provider/model for review. Pi previews each focused packet and asks for each launch. When the builder completes, accept the review offer. The final action picker can show the diff and review findings, then ask whether to integrate. Declining any prompt preserves existing results and worktrees.

Use `/tasks` for a compact list with elapsed time, operation, provider/model, branch, result availability, and integration state. Select a task for its next action. `/tasks all` prints every record without opening a picker. Guided offers stop when switching or shutting down Pi sessions. Restart never starts a reviewer automatically.

`/workflow` without arguments selects any configured recipe. `/delegate` selects an agent. `/task` selects a task and its actions; unique ID prefixes also work with explicit commands. `/workflow-runs` selects preserved runs and offers checkpoint continuation for interrupted work. Every continuation still requires confirmation and revalidation. Workflow approval requirements have a separate optional status indicator.

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

The preparation check detects Node, Python, and Go manifests before worker execution. For Node builders, Pi offers a screened copy of the parent's `node_modules` into the task worktree. It requires confirmation, an ignored destination, no existing destination, no external/absolute symlinks, no sensitive filenames, and content screening. A refusal leaves the destination absent. No installer, lifecycle script, or network operation runs. Strict screening can refuse legitimate dependency fixtures; inspect and provision dependencies manually rather than bypassing screening.

Python reports system-runtime availability and asks you to verify package requirements manually. Go reports runtime and vendor availability; its external module cache is not mounted. Neither check promises that dependencies match the manifests. Approve the actual test command to establish readiness. `/task ID prepare` offers the same screened Node copy for an inactive task. It does not install Python or Go packages. `/task ID prepare COMMAND` runs a specifically confirmed command for an inactive builder in the same network-disabled sandbox and records its exit status. This path has no host-shell fallback. Review any lifecycle scripts before approving a command; offline caches must already exist inside the worktree. Build scripts may modify the task worktree and produce outputs. Successful task snapshots include all resulting non-ignored changes, so inspect the diff before integration.

## Request an independent review

After the builder completes:

```text
/review BUILDER_ID kimi-coding/MODEL
/task REVIEW_ID
/task BUILDER_ID diff
```

The reviewer receives the objective, approved project context, changed files, and the builder's result labeled as unverified. It starts at the builder's captured commit in a separate worktree. Its tools can read scoped files and compare each file against the builder's original base. It cannot edit files, run a shell, or launch subagents.

Use another authorized provider/model if desired. Roles are independent of provider choice. A review is a separate execution even when you choose the same provider. Only fixtures using Codex and Kimi identities have been tested; live model quality is unqualified.

The parent model can request `delegate_task` and inspect `task_status`. To inspect a snapshot, it selects a configured read-only agent and sets `reviewOf` to the editing task's ID. Dispatch through this tool uses the same capability checks, context preview, and human confirmation as `/delegate`. Completion messages do not automatically start a parent or Google turn.

## Accept or discard changes

Run `/task BUILDER_ID integrate` after a completed independent review. Pi shows the diff and review findings, then asks for approval. Integration cherry-picks the captured commit into the parent only if the parent is clean and still at the recorded base. A changed builder worktree or parent branch, detached parent HEAD, unfinished merge/cherry-pick/rebase, or review of a different revision prevents integration. Guards run again after confirmation. The task records integration intent before Git starts and the resulting parent revision after success. Review findings are evidence for your decision; a completed review does not mean the change is correct.

If the parent moved, use your normal Git tools to inspect or integrate the task branch manually. If a cherry-pick reports a conflict, inspect it with Git or Lazygit. The extension does not reset or overwrite conflicts.

Run `/task ID cancel` to stop active work. Timeout defaults to 15 minutes. Native provider cancellation and sandbox process termination propagate from the task signal. Worktrees remain available on success, failure, timeout, and cancellation. `/task ID cleanup` removes a clean inactive worktree without forcing deletion or removing its branch. Dirty worktrees require manual inspection and preservation of changes first.

Task records live under `.poly/agent/tasks/PROJECT_WING/ID/task.json`. Child Pi session files live next to that task's worktree in `sessions/`. On restart, running records become `interrupted`. Results and worktrees survive; provider work is not replayed. A host lease prevents a second managed host for the same project/profile from taking ownership. On Linux, restart checks the owning PID and process start identity before reclaiming a dead lease. It never kills an unknown PID. Damaged records, orphaned temporary records, and missing worktrees produce notices and retain files.

Use `/task ID recover` on interrupted, failed, timed-out, or canceled work. Inspect the original task first, choose an authorized provider/model, and review the reconstructed brief. Confirming creates a new task/transcript from a captured source snapshot while preserving the original record and parent/replacement links. It is not a resumed provider session. All recovered changes are included in the replacement's single reviewable commit. Completed tasks are inspected or reviewed, not replayed. A moved parent or missing original worktree requires manual Git recovery.

If lease acquisition itself was interrupted, Pi fails closed with the `host-acquisition` path. Close other hosts, inspect `host.json` and running processes locally, then remove only the abandoned acquisition directory after confirming no host is acquiring it. A foreign-machine or malformed lease requires manual inspection. Never delete a live host's lease.

Interrupted integration is reported separately. Inspect the parent using `git status`, `git log`, and your normal Git tools before completing or aborting an unfinished cherry-pick yourself. Pi neither auto-replays integration nor claims to know whether an interrupted Git operation completed.

## Continue an interrupted workflow

Inspect `/workflow-runs` and its task IDs. Use `/workflow-runs RUN_ID continue`, confirm reuse, and approve each pending task separately. A new run retains `continuedFrom` and completed task references. It does not resume a provider session.

Continuation checks current provider policy and agent model constraints, retained artifacts, task worktree branch/revision/cleanliness, and the parent revision. It reconciles completed task records even if a workflow completion notification was interrupted. New dispatches retain their workflow step ID, so a crash before workflow persistence can also be reconciled. Ambiguous legacy dispatches fail closed.

An unfinished worker blocks continuation. Use explicit task recovery, inspect its completed replacement, then continue. Stale source, missing worktrees/artifacts, canceled workflows, changed eligibility, and unlinked legacy execution require manual inspection. Completed work is never automatically repeated.

## Preserve legacy configuration

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

Concurrency is 1–4, timeout is 1–3600 seconds, and delegation depth is fixed at one. `model` and `instructions` are configurable. These are the optional legacy example permissions. For arbitrary agents, selected resources, and intersected permissions, use [platform configuration](platform.md). No provider is selected as an implicit fallback.

## Preserve useful context

Run `/handoff` after implementation and review. The draft includes the current session objective, completed task summaries, changed files, sourced findings, outstanding questions, and selected historical memory. Agent-authored summaries and review findings remain unverified until you verify them. Edit the Markdown sections and use `text | source` for facts. Confirm the preview before saving.

`/memory-save` persists the reviewed packet through the existing MemPalace MCP interface. Durable facts, decisions, questions, and hypotheses are separate items in `knowledge`; the session packet remains in `handoffs`. Stable knowledge IDs exclude session IDs and timestamps. Backend exact deduplication and retrieval deduplication complement these IDs. Near-duplicate wording and source changes can still create multiple backend records.

Configure `memory.contextBudget` in `.poly/agent/poly.json` to set the retrieval budget in characters, from 256 to 24000; the default is 12000. Retrieval parses records, ranks relevance and certainty, applies a modest recency preference, and retains older relevant decisions. Conflicting claims remain separate. Explicit `memory.sharedWings` enable additional project retrieval. There is no automatic personal-vault access.

When memory is unavailable, delegation and Pi history still work. Nothing automatically promotes agent output to verified knowledge or sends memory to a provider.

## Switch providers and recover sessions

Use `/model`, then `/handoff-use`. Review the packet in the editor and submit it yourself. Google ACP always requires this direct submission.

After explicit Google activation, `/poly-google-discover` can attempt documented `session/load` when the runtime advertises support and Pi has a saved binding for the same project directory. Failed or unsupported restoration preserves the binding and Pi history. Prepare `/handoff`, then use `/poly-google-discover new` and confirm if you want a new official session. A local handoff never claims to restore provider-private execution state.

Automatic compaction and turn retries remain disabled. Manual `/compact` requires a reviewed `/handoff`, enabled MemPalace, confirmation, and a successful checkpoint first. Compaction that would replay a turn is denied. Google ACP compaction is denied because its consumer session cannot receive an automated summary request.

## Qualify providers and use terminal tools

Use the [manual provider checklist](qualification.md) for explicitly authorized account tests. See [terminal integration examples](terminal.md) for optional tmux, Neovim, AstroNvim, and Lazygit workflows.

## Discover and recover workflow runs

Use `/workflow` without a matching name to list configured recipes. `/workflow-runs` shows durable run IDs, each step's task ID, and lifecycle state. `/workflow-runs ID cancel` stops that run's owned tasks. Sequential and parallel recipes share the same task admission, sandbox, context, and workspace controls as `/delegate`.

On restart, running or waiting-for-approval runs become interrupted. No step or approval is replayed. Inspect retained task results with `/tasks` and `/task ID`; recover an interrupted task explicitly or start a separately approved new workflow. A new run is not a resumed provider session. Integration still requires an independent read-only snapshot inspection and final user approval, regardless of agent names.
