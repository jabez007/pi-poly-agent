# Qualify a native coding-plan provider

These procedures make real requests only when you submit prompts or approve worker launches yourself. No provider has been live-qualified by this repository's automated tests.

## Review the operations

Generate a plan without authentication or network requests:

```bash
npm run qualify -- openai-codex
npm run qualify -- kimi-coding
npm run qualify -- zai
```

Each plan lists 13 scenarios with `not-run` outcomes and empty evidence fields. It is a checklist, not an execution command or a qualification certificate. Claude and Google are excluded. Their activation reviews remain separate.

Use a disposable, clean repository with a committed test fixture. Use the isolated profile, supported `/login`, and enumerated `/model` IDs. Confirm the account's coding subscription or coding-plan billing before starting. Z.AI and Kimi key authentication require the opt-ins described in [providers](providers.md). Never inspect or copy credential stores to establish authentication availability.

Pi's [provider documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md) describes supported interactive login. This project uses its pinned provider implementation and adds stricter policy checks.

## Run the scenarios in Pi

1. Authenticate through `/login` if needed. Record whether the chosen provider appears in `/model`, without recording credentials.
2. Select an exact model. Ask a short read-only question about the fixture. Observe response activity and completed output. Worker partial bodies are withheld until secret screening completes.
3. Use `/implement Add a small tested function to the fixture`. Choose a Builder and a different authorized Reviewer. Review both focused packets. Approve each launch separately.
4. Approve one `run_test` command. Verify its recorded command and exit status against the output. Decline another command to verify denial.
5. Inspect `/tasks`, the two session references, source diffs, branches, provider identities, and independent review findings. Decline integration once. Confirm that the parent remains unchanged. Approve only after inspecting the exact reviewed revision.
6. Launch two small independent tasks with `/delegate`. Verify separate worktrees. Cancel one with `/task ID cancel`. Confirm the other can finish.
7. In the disposable project, terminate the Pi host during a bounded task. Restart Pi. Inspect the interrupted task and retained changes. Use `/task ID recover`, review the proposed replacement, and explicitly authorize it. Check that the new task has a different ID and transcript.
8. Record naturally occurring authentication, model, quota, transport, or context failures. Leave unobserved scenarios `not-run`. Do not exhaust quota, invalidate credentials, rotate accounts, or replay uncertain requests to manufacture evidence.

A completed provider request does not establish all scenarios. Cancellation, quota behavior, refresh, and interruption require separate observations. Native worker activity indicators are not a claim of raw token streaming support.

## Record evidence

For each scenario record the repository revision, Node and Pi versions, provider/model, authentication mode by name, task IDs, base and reviewed commits, approval outcome, command exit status, and observed result. Keep local session files private. Do not publish raw provider errors, authentication values, or transcripts containing confidential code.

Classify each outcome as passed, failed, or not-run. Distinguish offline unit tests, mocked Pi SDK integration, local unauthenticated TUI/sandbox execution, and authorized live requests. A generated plan always starts unqualified.

## Recover from errors

Task records classify authentication, model, availability, quota, transport, context, tool/worktree, policy, output, or unknown failures. Messages provide a next action and discard raw provider bodies. Classification is conservative and cannot diagnose every upstream error format.

Inspect retained work before replacing a failed task. A generation may have changed files before its transport failed. Automatic provider retries and turn replay remain disabled because the pinned transport does not prove that an uncertain generation accepted no work. No error selects another model, account, endpoint, or billing method.

## Current qualification matrix

| Path             | Offline/mock evidence                                                       | Local unauthenticated evidence            | Live subscription evidence                             |
| ---------------- | --------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| Codex            | Independent Pi SDK builder, parallel workers, cancellation, policy guards   | Managed Pi startup and Bubblewrap sandbox | Not run                                                |
| Kimi             | Independent Pi SDK reviewer and concurrent worker                           | Shared Pi/sandbox infrastructure only     | Not run                                                |
| Z.AI coding plan | Pi SDK worker and sanitized authentication/quota/transport/context failures | Shared Pi/sandbox infrastructure only     | Not run                                                |
| Claude SDK       | Mock SDK query and invocation guards                                        | No native Claude runtime execution        | Blocked pending authorization; workers disabled        |
| Google ACP       | Official ACP SDK subprocess fixture, permissions and restoration fixtures   | Fixture runtime only                      | Not run; activation review required; workers forbidden |

The local startup observation is unauthenticated. Shared sandbox tests do not establish any provider's live behavior. Plans and fixtures never change these classifications automatically.
