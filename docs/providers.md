# Provider setup

All live capabilities remain unverified. Installation and CI do not authenticate accounts. The default policy is defined by `defaultPolicy()` in `src/policy.ts`.

| Pi provider       | Execution path                                              | Authentication                  | Initial state                                              |
| ----------------- | ----------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------- |
| `openai-codex`    | Pi native provider                                          | Pi's supported ChatGPT OAuth    | Available after native login                               |
| `kimi-coding`     | Pi native coding endpoint                                   | Pi's supported Kimi Code OAuth  | Available after native login                               |
| `zai`             | Pi native coding endpoint                                   | Coding-plan key                 | Locked until coding-plan acknowledgement                   |
| `claude-acp`      | Pinned Claude ACP adapter, Agent SDK, installed Claude Code | Native Claude Code subscription | Default Claude mode; locked pending review and activation  |
| `claude-bridge`   | Upstream bridge, Agent SDK, installed Claude Code           | Native Claude Code only         | Explicit alternative; locked pending review and activation |
| `antigravity-acp` | Official ACP SDK, installed `agy acp`                       | Runtime-owned `oauth-personal`  | Locked pending review and explicit activation              |

## Use native coding-plan providers

Launch Pi with `npm start`. Use `/login` and select OpenAI Codex or Kimi Code. Pi stores the resulting credentials in `.poly/agent/auth.json`. No existing auth store is copied.

Use `/model` to select the provider and a model from Pi's pinned catalog. Native model names come from Pi's provider factories. Catalog freshness depends on the pinned Pi version.

For Z.AI, verify that the key belongs to your Coding Plan. Set `zaiCodingPlan` to `true` in `.poly/agent/poly.json`, restart, and use the native `/login` key prompt. Pi's pinned `zai` provider targets `https://api.z.ai/api/coding/paas/v4`, as defined by `@earendil-works/pi-ai/dist/providers/zai.js`.

Kimi defaults to OAuth only. A coding-plan key requires setting `kimiApiKey` to `true` and restarting. Pi's pinned provider targets `https://api.kimi.com/coding/v1`, as defined by its `providers/kimi-coding.js`. The profile cannot determine your account's billing agreement from a key. Those acknowledgements are your explicit choice of an authorized coding-plan connection.

Built-in separately metered Anthropic, Google, OpenAI API, gateway, and proxy providers remain disabled. v0.4 supports separately named, explicitly activated local or API-billed compatible instances through [provider registration](platform.md#register-provider-instances). They cannot borrow subscription credentials. There is no metered fallback or Gemini API delegation path.

## Review and activate Google ACP

Do not activate this integration merely to run the automated tests. They use mocks.

1. Install Google's official `agy` CLI through Google's documented distribution. Do not patch it or reuse tokens from another application.
2. Review [Google's ACP documentation](https://antigravity.google/docs/ide/extensions/acp/) and the [November 16 delegation clarification](https://discuss.ai.google.dev/t/tos-clarification-is-human-supervised-codex-to-antigravity-acp-delegation-permitted/200697). This profile supports direct personal interaction only.
3. Verify the executable's provenance, version, native authentication mode, and update settings. This repository never downloads or updates it. Keep updates manual, and review a changed executable before updating its checksum.
4. Authenticate through the official runtime's own `agy acp --login` flow. Pi never reads, imports, refreshes, or stores Google tokens.
5. After completing the review and explicitly choosing activation, edit `.poly/agent/poly.json`. Set `google.enabled` to `true`, `google.review` to `2026-11-21.1`, `google.runtime` to the absolute official `agy` path, and `google.sha256` to that file's reviewed SHA-256 digest.
6. Run validation and restart Pi. Invoke `/poly-google-discover` and confirm the live operation. The adapter initializes ACP, selects the advertised native `oauth-personal` authentication method, and creates a session in `default` prompting mode.
7. Choose a discovered Gemini model with `/model`. Submit prompts in Pi yourself.

No executable is started during bootstrap, provider registration, startup, or ordinary model selection. Discovery requires a direct UI command and confirmation. It may require the runtime's native login if the prior login expired. A runtime without personal OAuth, a prompting mode, or model configuration options fails closed.

Models come from the runtime's `model` configuration options. This slice exposes Gemini models only. The discovery command replaces the locked placeholder in Pi's picker. Pi stores the ACP session identifier and project directory in its own session history for recovery. After restarting, explicit discovery attempts documented `session/load` only when the runtime advertises it. Unsupported or failed restoration preserves local state and requires `/poly-google-discover new` plus confirmation to create a replacement. `/handoff` remains available. No private Google session identifier is copied into another provider.

The adapter currently supports text prompts, streamed reasoning, tool activity, approval prompts, and cancellation. Wait for or cancel the active Google turn before submitting another prompt. Queued and steering prompts are refused in this slice. It does not implement image prompts, quota display, unadvertised or draft resume protocols, or Pi-owned tools inside the Google agent. Displayed token and cost values are unavailable and remain zero; they are not a statement about subscription cost or remaining quota. The conservative Pi context limit is 128,000 tokens, not a claim about the model's actual context window.

## Review Claude subscription use

Both Claude modes share one activation lock in `.poly/agent/poly.json`. Omitted `claude.mode` selects `acp`; `bridge` explicitly selects the existing bridge. Their provider IDs are `claude-acp` and `claude-bridge`, so Pi history identifies the execution path. Neither mode is eligible for delegated workers.

Anthropic's [legal and compliance documentation](https://code.claude.com/docs/en/legal-and-compliance) permits end users to sign in to an unmodified Claude Code binary on a hosting platform under stated conditions, while restricting third-party credential handling and subscription routing. The support article [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says plan-authenticated SDK usage draws from subscription limits, whereas linked Console API keys use API credits. These statements do not establish Anthropic approval of either Pi integration. Review their applicability and account-level Extra Usage before explicitly activating your chosen mode.

Configure the externally installed, unmodified Claude Code executable with `claude.enabled`, `claude.review`, `claude.runtime` and `claude.sha256`. Claude now requires review revision `2026-11-25.1`; previous Claude activations require reapproval. Google's revision remains `2026-11-21.1`. An outdated Claude review locks only Claude. Google and native providers still load. `/poly-status` and `npm run validate` report that Claude needs reapproval. Re-review the integration and update `claude.review` to activate it again. Bootstrap preserves existing settings; add `claude-acp/*` to Pi's `enabledModels` if your older profile filters it out.

### Default Claude ACP mode

`@agentclientprotocol/claude-agent-acp` is pinned to `0.112.0` and its Agent SDK to `0.3.331`. The adapter uses Claude Code's native tools, system prompt and user, project and local settings. Pi sends no tool or system-prompt override. Native settings, hooks, plugins and tools execute with Claude Code's authority, outside the restricted worker sandbox.

1. Run `claude auth login` yourself using the reviewed native executable. Pi does not open Claude credential stores or copy credentials.
2. Set native Claude settings to `"permissions": { "defaultMode": "default" }`. This adapter otherwise defaults to Auto when available; discovery refuses an absent or different native default.
3. Set `"DISABLE_AUTOUPDATER": "1"` in the `env` object of your native user settings. This disables background updates. See [Claude Code update controls](https://code.claude.com/docs/en/setup#disable-auto-updates). Manual updates still require a new executable review and checksum.
4. Review native settings for authentication helpers and environment overrides. Linux preflight uses the adapter's pinned SDK settings resolver for user, project, local and managed settings, including cached organization policy; conflicting settings, policy helpers and unreadable managed policy are refused rather than rewritten.
5. After authorization review, activate Claude with the new revision and checksum. Leave `claude.mode` absent or set it to `acp`.
6. Restart Pi, run `/poly-claude-discover` and confirm the live operation. Choose a discovered Claude Code model with `/model` and submit your prompt yourself.

The adapter receives the checksum-checked native path through its supported `CLAUDE_CODE_EXECUTABLE` override in its child environment. The transport rechecks that path before session creation, restoration, prompts and native login-status probes. A changed executable closes the port and requires a new review. External overrides remain refused. Claude ACP preflight currently supports Linux only. It refuses inherited `CLAUDE_AGENT_*` overrides, including adapter logs and protocol selection.

`npm run validate` names the selected Claude mode. An outdated Claude review appears as `needs reapproval`.

The client advertises no terminal-auth or gateway capabilities, calls no `authenticate` or `providers/*` method, and requires runtime-reported native subscription authentication. Missing login produces a fixed message asking you to run `claude auth login`; API-key, gateway, external or unknown authentication is refused without fallback. Discarded runtime stderr and fixed errors keep native diagnostics out of Pi logs.

Session creation and restoration send `_meta.claudeCode.options.allowDangerouslySkipPermissions: false`. Other session metadata is refused. Forbidden-mode notifications close the port. Pending turns retain the forbidden-mode refusal.

Sessions start in `default` mode. `/poly-claude-mode` offers the runtime's advertised `default`, `plan` and `acceptEdits` choices; `bypassPermissions`, `dontAsk` and `auto` are refused. Native permission requests use the shared contextual, single-use ACP approval UI. `acceptEdits` applies Claude Code's native editing permissions after your explicit selection.

Discovery and restoration follow Google's confirmation rules with separate Claude bindings. A restored `default`, `plan` or `acceptEdits` session resets to `default`. Other resumed modes are refused with `/poly-claude-discover new` guidance. New sessions must still start in `default`. Explicit discovery attempts `session/load` only when advertised; unsupported or failed restoration preserves Pi history and requires `/poly-claude-discover new` plus confirmation for a new session. No runtime starts during registration, startup or model selection. Only a fresh interactive TUI input can submit one Claude ACP prompt; automatically submitted handoffs, RPC input, steering and automatic continuation are refused. `/handoff-use` prepares editor text for your inspection and manual submission.

### Optional Claude bridge mode

Set `claude.mode` to `bridge` and retain `.poly/agent/claude-bridge.json`:

```json
{
	"provider": {
		"pathToClaudeCodeExecutable": "/absolute/reviewed/path/to/claude",
		"strictMcpConfig": true,
		"autoMemoryEnabled": false,
		"longContextExtraUsage": false
	}
}
```

The pinned bridge remains `0.13.0` with Agent SDK `0.3.321`. Pi owns its agent loop, tools and system prompt; the bridge routes Pi tools through strict MCP, disables native tools and requests `bypassPermissions` internally. Pi's interactive single-call tool approval remains mandatory. The bridge's existing native-settings and environment guards remain active, and its lifecycle hooks are loaded only when bridge mode is activated. Its registration may invoke the native SDK after activation; the ACP discovery confirmation applies to ACP mode only. The bridge's long-context setting does not disable account-level Extra Usage.

## Environment conflicts

`src/policy.ts` rejects Anthropic authentication and gateway variables, Google or Gemini billing overrides, ACP overrides, bridge debugging flags, OpenAI API keys and endpoint overrides, proxy variables, custom CA injection, unsafe Node configuration, and coding-provider endpoint overrides. It does not silently unset them.

Run `npm run validate` for variable names only. Correct the intended launch environment yourself. Missing or malformed configuration, a changed runtime checksum, or a project `.pi` safety override prevents managed launch. Native project resources otherwise use Pi's trust decision. Your existing files remain intact.

## Delegation capabilities

| Provider                              | Direct parent interaction                                    | Native Pi worker     | Restriction                                                              |
| ------------------------------------- | ------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------ |
| Codex                                 | After supported login                                        | Allowed              | ChatGPT OAuth only, guarded request, fresh child session                 |
| Kimi                                  | After supported login                                        | Allowed              | OAuth by default; coding-plan key needs explicit opt-in                  |
| Z.AI                                  | After coding-plan opt-in                                     | Allowed after opt-in | Coding endpoint only; key billing agreement must be verified by you      |
| Claude ACP (`claude-acp`)             | Locked until reviewed activation and explicit discovery      | Forbidden            | Native Claude Code; direct human input only, no automatic handoffs       |
| Claude bridge (`claude-bridge`)       | Locked until reviewed activation and explicit mode selection | Blocked              | Pi agent loop; activation does not authorize worker delegation           |
| Google consumer ACP                   | Locked until authorized activation                           | Forbidden            | Direct human input only; no model-generated or automated handoff prompts |
| Custom APIs and open-weight endpoints | Unconfigured                                                 | Blocked              | Needs a separate explicitly authorized provider instance                 |

Codex, Kimi, and opted-in Z.AI parents can request the `delegate_task` tool, subject to interactive approval. A user can invoke delegation commands while another direct provider is selected, but only an eligible registered worker is dispatched. Agent configuration cannot widen provider policy. Effective permissions determine whether an agent can edit.

No provider/model fallback is selected when child initialization, authentication, or execution fails. Native provider transports receive `maxRetries: 0`. Child sessions share Pi's supported isolated credential store through its SDK; tokens are not copied into task records, tool environments, or memory.

## Qualification and recovery

`/poly-qualify PROVIDER/MODEL` offers a separately approved, tool-free worker probe for an eligible instance. It shows the exact identity, authentication and billing mode. The probe has one generation, a requested 512-token output cap and a 30-second timeout. No tools, edits, automatic retry or provider substitution are allowed. Provider enforcement of output limits is not a monetary guarantee. This verifies only the observed request, not all provider capabilities. It is never run by installation, doctor or CI.

`npm run qualify -- PROVIDER` prints a manual plan for `openai-codex`, `kimi-coding`, `zai`, or an explicitly configured custom instance. It performs no credential resolution, login, model request, or live test. See [the planner](../src/orchestration/qualification.ts) and follow [qualification procedures](qualification.md) only after reviewing and choosing the operations yourself.

Native worker failures have fixed, secret-screened categories and explicit recovery guidance. Provider/model identity never changes automatically. Quota, authentication, context, or uncertain transport failures do not trigger retries. `/task ID recover` is an approved new worker with a fresh transcript and preserved source changes. Existing provider-private execution state is not restored. Claude worker delegation remains blocked; Google consumer ACP remains direct-interaction-only.

## v0.4 provider-instance qualification

Provider instances advertise direct interaction, delegation, concurrency, streaming, cancellation, tools, editing/read-only execution, persistence, handoffs, and billing classification. Native subscription restrictions cannot be overridden by instance declarations. Custom adapters cannot register OAuth or replace reserved providers. Exact endpoint and environment checks run again at the request boundary.

The native Codex/Kimi/Z.AI scenarios remain mock-tested only. A fake loopback OpenAI-compatible server also exercises Pi's real transport, local instance registration, and independent worker execution without credentials. This does not qualify a hosted model, inference gateway, subscription, or billing agreement. Continue using the [opt-in qualification procedure](qualification.md) before relying on live accounts.

## Local open-weight example

[examples/local-open-weight/platform.json](../examples/local-open-weight/platform.json) is a disabled, host-independent starting point. Use a separate profile. Replace `REPLACE_MODEL_ID`, the loopback endpoint and declared limits with values from your server. Enable the instance only after review. No subscription credential or particular model host is required.

Start conservatively with no tools or editing, as in the example. Use `/model` for direct interaction or delegate `local-reader` with explicitly supplied context. There is no automatic `/models` discovery. If the server actually supports streaming, cancellation and schema-compatible tool calls, qualify those operations before enabling tools and adding scoped `read` to the agent. A declaration does not prove model reliability. Remote API instances require HTTPS, separate billing activation and their own supported Pi credential path; they cannot reuse consumer subscription tokens.

## Native custom providers and qualification

Trusted parent Pi extensions can register providers through normal `pi.registerProvider`, without a Poly adapter. Such registration does not authorize workers. Worker eligibility requires a reviewed registry adapter that can reuse the same Pi provider factory, explicit instance activation, and central policy validation. Built-in separately billed providers remain disabled by the managed extension; arbitrary trusted host code is not sandboxed.

Compatible endpoint tests use loopback HTTP fixtures for explicit models and limits, streaming, fragmented tool arguments, errors, malformed events, cancellation, and separate instances. They do not qualify a real server. Configure a local or API instance, then run `npm run qualify -- INSTANCE` for a manual checklist without authentication or inference. No automatic discovery request, provider substitution, or subscription credential reuse occurs. See [qualification](qualification.md).
