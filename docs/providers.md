# Provider setup

All live capabilities remain unverified. Installation and CI do not authenticate accounts. The default policy is defined by `defaultPolicy()` in `src/policy.ts`.

| Pi provider       | Execution path                                    | Authentication                 | Initial state                                 |
| ----------------- | ------------------------------------------------- | ------------------------------ | --------------------------------------------- |
| `openai-codex`    | Pi native provider                                | Pi's supported ChatGPT OAuth   | Available after native login                  |
| `kimi-coding`     | Pi native coding endpoint                         | Pi's supported Kimi Code OAuth | Available after native login                  |
| `zai`             | Pi native coding endpoint                         | Coding-plan key                | Locked until coding-plan acknowledgement      |
| `claude-bridge`   | Upstream bridge, Agent SDK, installed Claude Code | Native Claude Code only        | Locked pending authorization review           |
| `antigravity-acp` | Official ACP SDK, installed `agy acp`             | Runtime-owned `oauth-personal` | Locked pending review and explicit activation |

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

Claude Code is installed externally and authenticates through Anthropic's own flow. This repository never starts it during installation, reads its credentials, or installs a custom OAuth provider.

Anthropic's current [legal and compliance documentation](https://code.claude.com/docs/en/legal-and-compliance) distinguishes native Claude Code subscription sign-in from authentication offered by third-party applications. How that distinction applies to this personal Pi Agent SDK frontend remains unresolved. Technical compatibility and T3 Code's implementation are not proof of permission. Keep Claude disabled until that question is resolved for your intended use and you explicitly authorize activation.

The pinned bridge uses the official Agent SDK `0.3.321`. Its main SDK path disables native execution tools and routes Pi tools through a strict MCP interface. It requests `bypassPermissions` internally. Pi's own interactive single-call approval gate therefore remains mandatory. The installed bridge's `src/index.ts` and `src/cc-child.ts` document these behaviors.

After authorization is settled, configure a reviewed native executable using `claude.enabled`, `claude.review`, `claude.runtime`, and `claude.sha256` in the policy. The review revision is `2026-11-21.1`. Add `.poly/agent/claude-bridge.json` with this provider configuration:

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

Run validation and restart Pi. The executable must match the policy checksum. Review native Claude user settings for `apiKeyHelper`, billing overrides, environment variables, gateways, or cloud-provider settings. The managed validator rejects those authentication overrides in the native settings file. It does not inspect credential files. No setting disables provider-side Extra Usage on your account; review that separately before activation.

## Environment conflicts

`src/policy.ts` rejects Anthropic authentication and gateway variables, Google or Gemini billing overrides, ACP overrides, bridge debugging flags, OpenAI API keys and endpoint overrides, proxy variables, custom CA injection, unsafe Node configuration, and coding-provider endpoint overrides. It does not silently unset them.

Run `npm run validate` for variable names only. Correct the intended launch environment yourself. Missing or malformed configuration, a changed runtime checksum, or a project `.pi` safety override prevents managed launch. Native project resources otherwise use Pi's trust decision. Your existing files remain intact.

## Delegation capabilities

| Provider                              | Direct parent interaction          | Native Pi worker     | Restriction                                                              |
| ------------------------------------- | ---------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| Codex                                 | After supported login              | Allowed              | ChatGPT OAuth only, guarded request, fresh child session                 |
| Kimi                                  | After supported login              | Allowed              | OAuth by default; coding-plan key needs explicit opt-in                  |
| Z.AI                                  | After coding-plan opt-in           | Allowed after opt-in | Coding endpoint only; key billing agreement must be verified by you      |
| Claude SDK                            | Locked until authorized activation | Blocked              | Direct activation does not authorize subscription-backed delegation      |
| Google consumer ACP                   | Locked until authorized activation | Forbidden            | Direct human input only; no model-generated or automated handoff prompts |
| Custom APIs and open-weight endpoints | Unconfigured                       | Blocked              | Needs a separate explicitly authorized provider instance                 |

Codex, Kimi, and opted-in Z.AI parents can request the `delegate_task` tool, subject to interactive approval. A user can invoke delegation commands while another direct provider is selected, but only an eligible registered worker is dispatched. Agent configuration cannot widen provider policy. Effective permissions determine whether an agent can edit.

No provider/model fallback is selected when child initialization, authentication, or execution fails. Native provider transports receive `maxRetries: 0`. Child sessions share Pi's supported isolated credential store through its SDK; tokens are not copied into task records, tool environments, or memory.

## Qualification and recovery

`/poly-qualify PROVIDER/MODEL` offers a separately approved, tool-free worker probe for an eligible instance. It shows the exact identity, authentication and billing mode. The probe has one generation, a requested 512-token output cap and a 30-second timeout. No tools, edits, automatic retry or provider substitution are allowed. Provider enforcement of output limits is not a monetary guarantee. This verifies only the observed request, not all provider capabilities. It is never run by installation, doctor or CI.

`npm run qualify -- PROVIDER` prints a manual plan for `openai-codex`, `kimi-coding`, or `zai`. It performs no credential resolution, login, model request, or live test. Follow [qualification procedures](qualification.md) only after reviewing and choosing the operations yourself.

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
