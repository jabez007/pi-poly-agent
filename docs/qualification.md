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

## Approve a bounded live probe

Nothing in this milestone automatically authenticates or executes a real provider request. In an interactive Pi session, personally invoke `/poly-qualify PROVIDER/MODEL` after selecting an eligible provider and reviewing its supported login/billing mode. With no argument, choose an exact eligible model through Pi's picker.

Review the focused packet and launch confirmation. The probe uses the existing task engine, an isolated worktree, no tools, a 30-second task timeout, one generation and a requested output limit of 512 tokens. It cannot edit source, start tests or silently retry. It leaves a private task result and independent session reference. Provider enforcement of token limits is not a guarantee of monetary cost. Output and errors pass the existing secret screening.

A completed probe establishes only that observed request. Tool behavior, cancellation, parallel sessions, quotas and implementation/review still require their own scenarios. Denial or failure does not select another provider, credential or billing path. Claude and Google cannot become probe workers. A replacement preserves the previous request budget rather than widening it.

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

## v0.5 ecosystem observations

These results use the pinned Pi SDK/CLI 1.5.2 and Node 22.21.1. Package installation and execution occurred only in temporary profiles. The published template tarball's npm integrity was verified before source review; its unmodified files and MIT license are retained as offline fixtures. No package lifecycle script, personal Pi profile or live model was used.

| Resource and tested version            | Actual exercise                                                                                                            | Observed limitation or configuration                                                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi official `session-name`, 1.5.2      | SDK command dispatch, persisted session name and reopening                                                                 | Trusted parent extension                                                                                                                              |
| Pi official `todo`, 1.5.2              | Actual Pi tool pipeline with deterministic provider, explicit fixture approval, reload reconstruction                      | Native application code; no automatic worker import                                                                                                   |
| Pi official `status-line`, 1.5.2       | Session/turn handlers and native themed status output                                                                      | Full terminal visual acceptance remains a human activity                                                                                              |
| Pi official `dynamic-resources`, 1.5.2 | Native resources_discover loads skill, prompt and theme                                                                    | Workers cannot execute discovery hooks; a reviewed direct skill reference enables its instructional text                                              |
| `pi-package-template`, 1.2.0           | Native local install, command/tool invocation, actual selection-widget render and keyboard selection, prompt/theme loading | Legacy namespace imports work through Pi aliases. Its skill lacks required description metadata and is rejected by Pi; this is a package-format issue |
| Project-local skill and extension      | Saved native trust, reload, command execution and selected worker text                                                     | Untrusted code remains unloaded; only data enters workers                                                                                             |
| Existing synthetic package fixtures    | Resource filters, runtime dependency execution, configuration persistence and contribution schemas                         | These do not qualify every npm/Git installer or dependency script                                                                                     |

The template is a small public starter package, not a recommended complete environment. Its source is linked from the [Pi package page](https://pi.dev/packages/pi-package-template). Fixture pins are recorded in [the review metadata](../tests/fixtures/vendor/pi-package-template.review.json). Changing its executable code requires source review, not merely refreshing a checksum. Application dependency pins do not attest separately installed packages.

Real-loader testing found that Pi 1.5.2's jiti prefix alias misresolved some `pi-ai` API/provider subpaths. The platform now uses the supported builtin-provider catalog entry point, plus an explicit path to the launcher's validated Pi API dependency for the compatible transport. This is a narrow pin-specific workaround, not a new inference client. Remove it only after an upstream compatibility fix is verified. Unmodified Pi and third-party resource source code was not patched.

Metadata-only resource inspection also exposed a scope bug: flattening native settings could lose or promote project package resources. The installed-resource snapshot now retains separate user/project settings and lets Pi apply precedence. A regression test failed before the fix. Inspection, package contribution references and selected instructions remain non-executing paths.

## v0.5 provider and orchestration evidence

| Provider path                        | Offline/local method                                                                                                                                                                                          | Live status                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Codex                                | Independent SDK implementation/probe workers, tools, parallel/canceled/interrupted tasks                                                                                                                      | Not run; explicit authorization required        |
| Kimi Coding                          | Independent SDK inspection fixtures and exact revision checks                                                                                                                                                 | Not run; supported login required               |
| Z.AI coding plan                     | Existing SDK worker/error fixtures and policy/plan checks                                                                                                                                                     | Not run; coding-plan opt-in required            |
| OpenAI-compatible local/API instance | Real Pi client against loopback HTTP fixtures: streaming, fragmented/incomplete tool arguments, unsupported tools, empty/malformed output, cancellation, limits, unavailable endpoints and separate instances | No real model server or API agreement qualified |
| Claude SDK                           | Existing mocked SDK and request/environment guards                                                                                                                                                            | Authorization unresolved; workers blocked       |
| Google consumer ACP                  | Existing official-protocol fixtures and direct-input enforcement                                                                                                                                              | Activation review pending; workers forbidden    |

The full suite covers single delegation, parallel independent work, implementation and exact-revision inspection, killed-host recovery, workflow checkpoint continuation, arbitrary agent/workflow definitions and native-only context. The new [self-development exercise](dogfooding.md) uses actual Pi worker sessions against a disposable clone of this repository, a real Bubblewrap acceptance command and independent Codex/Kimi transport fixtures. Results, tests, diffs, session references and restart records survive. It does not establish model judgment or live account compatibility.

A real managed TUI startup and `/poly-doctor` invocation were also exercised in an empty temporary profile, with project execution trust declined and no model prompt/login. Before native authentication, only locked placeholders were available in that test. Do not confuse the configured capability registry with authenticated model availability.

The platform is ready for supervised qualification. It is **not yet ready to replace the primary development harness**: live provider behavior and human dogfooding acceptance remain unverified. The next gates are an explicitly authorized Codex → Kimi/Z.AI exercise, repeated cancellation/recovery and package-update acceptance in normal terminal sessions, then release/upgrade verification. Extra orchestration features do not remove these gates.

## v0.5 verification record

The baseline `main` commit was `515bc05`, with Pi SDK/CLI 1.5.2 and 123 passing tests including Linux sandbox fixtures. Node 22.21.1 was used throughout. The final `PI_OFFLINE=1 PI_POLY_SANDBOX_TEST=1 npm run check` passed all 139 tests with zero failures or skips, plus type checking, ESLint with complexity limit 12 and formatting. No changed function exceeds that limit. The native-loader startup, scope-preservation and bounded-request regressions failed before their fixes.

`npm ci --ignore-scripts --offline` installed 323 packages. Every non-root dependency lock entry matches v0.4.2. Two bootstrap runs preserved the actual managed profile. Validation rejected an inherited `ANTHROPIC_API_KEY` by name and then passed in a child omitting that variable. The original shell and credential stores were unchanged. Doctor exited zero for a clean isolated dogfooding checkout, while correctly warning about missing worker dependencies and unprobed namespaces. The disabled local-model example validated without contacting an endpoint.

`npm run docs:check` passed. The CI workflow was parsed and adds a clean-profile doctor step; hosted v0.5 CI has not run because this feature branch has not been pushed. The existing hosted namespace limitation remains explicit. Actual Bubblewrap isolation, parent-termination cleanup and the offline self-development test passed locally.

`npm audit --json` reported zero advisories at verification time. Gitleaks 8.30.1 found no candidates or warnings in a 104-file source snapshot including the reviewed vendor fixture, excluding ignored profiles, dependencies, Git metadata and history. No credential validation or revocation ran. Existing ESLint 9 and node-domexception deprecation warnings remain; no dependency upgrade was bundled into v0.5.

No Anthropic, Google, Codex, Kimi or Z.AI account request ran. The public package tarball was downloaded for source review without npm user configuration or package scripts, then used as a fixed offline fixture. No real model server, API billing agreement, MemPalace server or personal Pi resource installation was used. Live provider qualification and user dogfooding are separate pending acceptance activities.
