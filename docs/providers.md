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

Separately metered Anthropic, Google, OpenAI API, gateway, and proxy providers are disabled. This milestone has no metered fallback or Gemini API delegation path. A future API connection needs a separately named provider and explicit authorization.

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

Run `npm run validate` for variable names only. Correct the intended launch environment yourself. Missing or malformed configuration, a changed runtime checksum, or an unknown project `.pi` settings file prevents managed launch. Your existing files remain intact.

## Delegation capabilities

| Provider                              | Direct parent interaction          | Native Pi worker     | Restriction                                                              |
| ------------------------------------- | ---------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| Codex                                 | After supported login              | Allowed              | ChatGPT OAuth only, guarded request, fresh child session                 |
| Kimi                                  | After supported login              | Allowed              | OAuth by default; coding-plan key needs explicit opt-in                  |
| Z.AI                                  | After coding-plan opt-in           | Allowed after opt-in | Coding endpoint only; key billing agreement must be verified by you      |
| Claude SDK                            | Locked until authorized activation | Blocked              | Direct activation does not authorize subscription-backed delegation      |
| Google consumer ACP                   | Locked until authorized activation | Forbidden            | Direct human input only; no model-generated or automated handoff prompts |
| Custom APIs and open-weight endpoints | Unconfigured                       | Blocked              | Needs a separate explicitly authorized provider instance                 |

Codex, Kimi, and opted-in Z.AI parents can request the `delegate_task` tool, subject to interactive approval. A user can invoke delegation commands while another direct provider is selected, but only an authorized native worker is dispatched. Worker role configuration never changes these capabilities. Read-only roles cannot become builders by editing configuration.

No provider/model fallback is selected when child initialization, authentication, or execution fails. Native provider transports receive `maxRetries: 0`. Child sessions share Pi's supported isolated credential store through its SDK; tokens are not copied into task records, tool environments, or memory.
