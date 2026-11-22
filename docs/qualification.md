# Qualify a provider deliberately

These procedures make real requests only when you submit prompts or approve worker launches yourself. No provider has been live-qualified by this repository's automated tests.

## Review the operations

Generate a plan without authentication or network requests:

```bash
npm run qualify -- openai-codex
npm run qualify -- kimi-coding
npm run qualify -- zai
npm run qualify -- YOUR_CONFIGURED_LOCAL_OR_API_INSTANCE
```

Each plan lists 13 scenarios with `not-run` outcomes and empty evidence fields. It is a checklist, not an execution command or a qualification certificate. The custom-instance plan supports the built-in OpenAI-compatible adapter. Other trusted adapters require manual procedures with their documented runtime. Claude and Google are excluded. Their activation reviews remain separate.

Use a disposable, clean repository with a committed test fixture. Use the isolated profile, supported `/login`, and enumerated `/model` IDs. Confirm the account's coding subscription or coding-plan billing before starting. Check declared streaming, tools and cancellation capabilities against the intended operation. A locked capability is not authorization; review and activate the intended mode separately. Z.AI and Kimi key authentication require the opt-ins described in [providers](providers.md). Never inspect or copy credential stores to establish authentication availability.

Pi's [provider documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md) describes supported interactive login. This project uses its pinned provider implementation and adds stricter policy checks.

For the worker scenarios, configure the optional `implementation-review` recipe first. Minimal profiles intentionally omit `/implement` and the example agents. Recipe selection and migration are described in [the platform guide](platform.md).

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

A local OpenAI-compatible instance has also been exercised through Pi's real transport against a loopback fake server. It uses no account and does not qualify a real hosted model or API billing agreement.

The local startup observation is unauthenticated. Shared sandbox tests do not establish any provider's live behavior. Plans and fixtures never change these classifications automatically.

## Qualify a local or API endpoint

Use explicit model IDs and declared context limits. There is no automatic `/models` discovery in the compatible adapter. Verify these values against the server before executing tests. For local instances, confirm a loopback URL and no subscription credentials. For API instances, confirm separate billing activation and use the instance's own supported Pi login.

Run the same streaming, tool, cancellation, independent-session, failure, and review scenarios in a disposable repository. In particular, verify JSON tool arguments and the actual model context limit. An OpenAI-compatible URL does not establish these capabilities. Do not deliberately exhaust quota or provoke billable failures. Record endpoint version, model ID, instance, billing mode, and observed evidence without credentials.

Offline tests use a loopback fixture with no GPU or model server. HTTP 401, 429, 503, malformed SSE, unavailable endpoints, cancellation, model metadata overrides, unsupported tool capabilities, and multiple instances are tested without authenticated accounts. Those results establish client behavior, not compatibility with an untested endpoint.

## Release verification without accounts

`npm run check` includes native local-package, SDK command/tool, skill/prompt/theme, configuration/migration, integrity, workflow-recovery and provider-transport fixtures. `npm run docs:check` verifies local documentation links, headings and named npm scripts. Neither command qualifies a live account.

CI validates the minimal profile and a four-step agent-team recipe. Its dedicated Linux job installs the system Bubblewrap package and probes user/network namespaces without changing host security settings. If AppArmor or runner policy denies namespaces, the job records a warning and summary and does not run sandbox fixtures. A green job with that warning is not sandbox evidence. Run `PI_POLY_SANDBOX_TEST=1 npm test` on a supported Linux host before claiming sandbox coverage.

The CI image is fixed to Ubuntu 24.04, while action revisions, Node and application dependencies remain pinned. GitHub [documents VM and administrative access](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), but namespace availability is verified by the probe rather than inferred from the image name. Package acquisition during CI setup is distinct from model requests; tests use empty authentication stores, offline model/resource loading, mocked providers and loopback-only fake endpoints. `PI_OFFLINE` suppresses Pi startup/package network operations; it is not a general network firewall or extension sandbox.
