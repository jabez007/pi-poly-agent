# Security and subscription safeguards

Assessment date: November 21, 2026. No Anthropic or Google account was authenticated, queried, or activated during implementation. Mock success does not establish live compatibility or permission.

## Account protection

The default policy locks Claude and Google. Their real runtime paths require explicit activation, the current review revision, an absolute executable path, and a matching SHA-256 digest. The Google discovery command also asks the user before starting the runtime. Pi startup runs offline. No installer or CI job starts either runtime.

Anthropic's application-authentication distinction remains unresolved for this personal SDK frontend. The official documentation permits native sign-in under stated conditions and separately restricts third-party subscription authentication. Resolve that applicability before activating the bridge. See [Anthropic's legal and compliance documentation](https://code.claude.com/docs/en/legal-and-compliance).

Google's published clarification supports direct interaction through compatible ACP editors and prohibits external coding-agent delegation through consumer credentials, even with human approval. This implementation follows that distinction. See the [November 16 clarification](https://discuss.ai.google.dev/t/tos-clarification-is-human-supervised-codex-to-antigravity-acp-delegation-permitted/200697) and [official ACP documentation](https://antigravity.google/docs/ide/extensions/acp/).

## Enforcement

| Control                        | Implementation                                                                                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No credential migration        | Bootstrap creates an isolated Pi profile without reading other auth stores.                                                                                                                                                                     |
| Native provider authentication | Pi handles Codex and Kimi login. Claude Code and Google retain their own subscription credentials.                                                                                                                                              |
| No implicit API billing        | Alternate providers are replaced with empty, non-authenticating definitions. Z.AI and Kimi coding keys require explicit policy choices.                                                                                                         |
| Conflicting configuration      | Launch and stream checks reject provider overrides, API-key conflicts, proxy injection, and debug settings. Diagnostics report names only.                                                                                                      |
| Google direct interaction      | Only a TUI input event with source `interactive` grants one Google stream request. RPC, extension input, and automatic continuations have no capability.                                                                                        |
| Google permission mode         | Session initialization must offer `default`; the adapter selects it explicitly. No `yolo` fallback exists.                                                                                                                                      |
| Tool approvals                 | Parent Pi tools require interactive confirmation. Scoped worker file tools require an approved task; sandbox test commands require separate confirmation. ACP shows contextual details, offers single-use options, and rejects opaque requests. |
| Runtime provenance             | The adapter verifies the selected executable digest immediately before spawn. No updater or downloader exists in this repository.                                                                                                               |
| Secrets in diagnostics         | ACP runtime stderr is discarded. Adapter failures and child-provider errors use fixed messages. Child results and memory reject known secret forms.                                                                                             |
| Memory routing                 | Retrieval and handoff preparation do not call a provider. The user manually submits context from the editor.                                                                                                                                    |

`--offline` disables startup network operations, not user-directed coding. Built-in provider definitions outside the managed profile have empty model lists and no OAuth flow. Only the managed delegation extension is registered; arbitrary subagent extensions are not loaded. Third-party project executable configuration causes managed launch to stop for review, preserving the original files.

## Memory privacy

MemPalace is optional and disabled initially. Discovery reads configuration paths and checks existing storage; it does not initialize a palace. Saves require a structured handoff, source references, verification flags, secret screening, and a user preview. Repeated unchanged checkpoints are skipped using a digest persisted in Pi's session. MemPalace's own checkpoint handles content deduplication.

Each Git common directory maps to one project wing. Worktrees share that identity. Cross-project retrieval requires explicit `memory.sharedWings`. No personal knowledge-vault connector is configured, and the extension never writes to or indexes the Obsidian vault. Retrieved memories are labeled as untrusted historical evidence.

Pattern screening cannot identify every confidential value or arbitrary secret. Do not put personal data, client secrets, or provider session data in a checkpoint. The preview remains necessary. MemPalace itself may have existing remote write routing or synchronization configured. Reusing that installation preserves those choices; review them before enabling memory. This project neither changes those settings nor claims that the palace is local-only.

## Dependency and implementation assessment

Pi, the Claude bridge, and their dependencies are installed with lifecycle scripts disabled by `.npmrc` and the documented `npm ci --ignore-scripts` command. The lockfile pins transitive versions and npm integrity hashes. The bridge pins its Agent SDK dependency. The repository does not vendor dependency packages or native runtimes. Bootstrap does not install or update Claude Code or Antigravity.

GPL-3.0-or-later applies to this project's original source code. It does not relicense the Claude Agent SDK or other dependencies. The SDK remains subject to [Anthropic's license](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/LICENSE.md) and applicable terms. Review the licenses and distribution terms of included dependencies before publishing a bundled package, container image, or executable. Source publication and subscription activation are separate decisions.

The source review checked dependency manifests and installed runtime source. The bridge's strict MCP configuration, environment propagation, native-settings loading, SDK options, and debug controls informed the safeguards. The ACP alternatives were reviewed and left uninstalled because their authentication management and orchestration behaviors were unnecessary here. See [the source inventory](architecture.md#reviewed-source-and-reuse-decisions).

Automated tests cover request authorization, mock streaming and cancellation, initialization failures, permission denial, secret-safe diagnostics, native sessions, project-scoped checkpoints, and installation preservation. They isolate HOME and auth directories before imports. The Claude SDK test replaces the upstream bridge's query seam and never spawns Claude Code.

The initial npm advisory check identified a moderate development-tool chain through TypeScript ESLint and minimatch. The dependency was updated to `typescript-eslint@8.73.0`. Re-run `npm audit` when changing pins. The check is a snapshot, not a claim that dependencies are universally safe.

The final advisory check reported zero advisories. The reviewed lifecycle inventory contains Google's no-op preinstall, esbuild's binary setup, protobufjs's compatibility warning, and optional macOS fsevents installation. All remained disabled during the clean lockfile installation. The Linux checks succeeded using the packaged optional esbuild binary.

Initial v0.1 verification on Node 22.21.1 passed `npm ci --ignore-scripts`, `npm run check`, and two consecutive `npm run bootstrap` invocations after a real Pi TUI startup. The check ran type checking, ESLint with complexity limit 12, formatting verification, and 20 tests. The ACP subprocess fixture exercised the official SDK's JSON-RPC initialization, native-auth method selection, model discovery, prompting, and permission responses. The real Pi CLI loaded the extension offline, listed the locked models, displayed `/poly-status`, and exited without a provider prompt or login.

Gitleaks 8.30.1 reported no candidates in a filesystem scan of this checkout using built-in rules. It did not validate credentials or inspect historical revisions. Scanner defaults and suppressions limit coverage. No existing function exceeded the configured complexity limit at handoff; no unrelated cleanup was applied.

## Limits and activation blockers

1. Claude subscription authorization remains unresolved. Provider-side Extra Usage must also be reviewed. Disabling the bridge's long-context extra-usage option does not disable account-level overages.
2. Google live compatibility, official runtime provenance, authentication, default-mode behavior, and model enumeration require an authorized interactive qualification. Install and review the official `agy` runtime before activation.
3. Pi requires Node.js 22.19 or newer. `.nvmrc` pins the verified Node version. The launcher rejects older versions.
4. The launcher rejects inherited API keys and other authentication overrides. Run `npm run validate` to identify conflicting variable names, then resolve them in the intended launch shell. Diagnostics never include their values.
5. This profile is not an operating-system sandbox. Trusted extensions, arbitrary approved shell commands, or a person running an unmanaged Pi binary can bypass its application-level restrictions. It does not claim to police the user's entire workstation.
6. Native provider model catalogs are pinned and can become stale. ACP model discovery requires explicit live activation. Quota and billing information are not inferred from mock responses.

## v0.2 provider invocation and delegation

The Claude stream wrapper now validates both `process.env` and `options.env` before upstream invocation. The same validator protects native provider streams and Google stream requests. Per-request overrides accept only locale, timezone, terminal, and color settings. Credential-supplied empty strings cannot remove a forbidden variable or change HOME, executable lookup, native storage, gateways, endpoints, or billing. Errors omit values. The bridge's `ccChildEnv` deliberately merges credential environments over the parent; validation therefore occurs before that merge, rather than trusting its propagation behavior.

Delegation checks capabilities at UI selection, dispatch, child initialization, and every native request. Depth is exactly one. Claude subscription workers remain disabled even if direct Claude use is activated. Consumer Antigravity ACP workers remain forbidden even if Google activation is complete or a human approves a task. No child loads the Claude bridge or ACP runtime. A separate Gemini API provider is not configured.

Worker tools cannot construct new authenticated sessions: there is no general shell, arbitrary extension loading, or credential-file access. Builder test execution runs under Bubblewrap with no network or host credential stores. Tests of those controls use real temporary repositories and independent Pi SDK sessions with mocked Codex and Kimi transports. An additional opt-in Linux test verifies actual sandbox execution. Worktree isolation is not a general host security sandbox for arbitrary plugins; do not load additional executable resources into managed workers.

Native stream wrappers force zero transport retries. Pi turn retries and automatic compaction stay disabled. Manual compaction requires a successful reviewed MemPalace checkpoint; Google compaction and overflow recovery that would retry a turn are rejected. Official native runtimes may have their own internal transport behavior, which this project does not intercept or rewrite. Safe pre-request transport retry classification remains deferred.

ACP permissions display the tool title, operation kind, supplied arguments, locations, proposed content, risk description, and single-invocation scope. Missing operation details, excessive preview size, known sensitive content, cancellation, and unavailable UI deny the request. Only `allow_once` and `reject_once` can be selected. The adapter does not invent missing command arguments or claim knowledge the runtime did not supply.

Documented ACP restoration is attempted only from the explicit discovery command and only with advertised `loadSession` support. A failure never silently creates a new session. Saved identifiers are local Pi recovery references, not credentials, and are never included in another provider's prompt or MemPalace handoff.

Task results and briefs are screened before persistence. Worker native sessions still contain approved source context and model output, so they are private local artifacts under the ignored profile. Pattern screening does not prove arbitrary text is free of confidential information. Review every context packet before dispatch or memory persistence. No automatic extraction promotes an agent claim to a verified fact.

## v0.2 verification evidence

On Node 22.21.1, `npm ci --ignore-scripts --offline` succeeded. `PI_POLY_SANDBOX_TEST=1 npm run check` passed type checking, ESLint with complexity limit 12, formatting, and all 41 offline tests, including actual Bubblewrap execution. Two bootstrap runs passed without overwriting the isolated profile. Validation rejected an inherited conflicting variable by name and passed in a temporary validation process without it. The original environment was preserved.

The Codex-builder/Kimi-reviewer fixture uses real independent Pi SDK sessions and Git worktrees while replacing provider transports. It checks source editing, independent diff inspection, structured findings, parent preservation, and integration. A second integration fixture runs two actual Pi SDK sessions concurrently with independent provider identities and worktree contents. Command tests verify review and final approval requirements. Claude's negative environment regression was observed failing with its invocation check temporarily removed, then passing after restoration. The ACP permission regression also failed before its fix.

A v0.2 offline TUI startup loaded the managed extension, displayed `/agents` and `/tasks`, and exited without a login or model prompt. `npm audit` reported zero advisories. Gitleaks 8.30.1 found no candidates in a temporary source candidate assembled from tracked and unignored repository files using built-in rules, without warnings or credential validation. Dependency directories, ignored local profiles, and historical Git revisions were outside that scan.
