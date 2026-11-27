# Providers

| Provider ID       | Execution                                  | Authentication                                                |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------- |
| `openai-codex`    | Native Pi provider                         | Pi-managed ChatGPT OAuth                                      |
| `kimi-coding`     | Native Pi provider                         | Pi-managed OAuth; coding-plan keys require `kimiApiKey: true` |
| `zai`             | Native Pi provider                         | Coding-plan key; requires `zaiCodingPlan: true`               |
| `claude-acp`      | Claude Code through the pinned ACP adapter | Native Claude Code login                                      |
| `claude-bridge`   | Opt-in `pi-claude-bridge`                  | Native Claude Code/SDK authentication                         |
| `antigravity-acp` | Official `agy acp`                         | Cached native Google login                                    |

Use Pi's `/login` for native providers.
Use `/model` to select a model.
Poly does not substitute another provider after a failure.

## Configure the native runtimes

Edit the existing `.poly/agent/poly.json`:

```json
{
	"version": 1,
	"claude": { "enabled": false, "mode": "acp" },
	"google": { "enabled": false },
	"kimiApiKey": false,
	"zaiCodingPlan": false,
	"memory": { "enabled": false, "sharedWings": [], "contextBudget": 12000 }
}
```

Set the runtime's `enabled` flag to `true` to use it.
Use Pi's `/reload` after editing configuration.
Executables come from `PATH` unless you set an absolute `claude.path` or `google.path`.
Poly does not check executable checksums or review revisions.

Run `claude auth login` yourself before Claude discovery.
Run `agy` yourself and sign in before Gemini discovery.
The [Antigravity ACP documentation](https://antigravity.google/docs/ide/extensions/acp/) describes reuse of cached native credentials.
Poly does not start client-side login, Console login or provider-routing methods for these adapters.
Missing native login produces guidance naming the native login command.

Inside Pi, run `/poly-claude-discover` or `/poly-google-discover` and confirm runtime startup.
These commands open or restore a native ACP session and register its models for `/model`.
Model listing itself does not start an ACP runtime.
If `session/load` fails or is unavailable, the command reports how to use its `new` argument explicitly.
Pi history and saved handoffs remain available.

## Claude modes

`claude.mode` defaults to `acp`.
ACP leaves Claude Code's tools, system prompt and user/project/local settings with the native runtime.
Poly sends no tool, system-prompt or `_meta` override.
It selects `default` before prompting on a newly opened or restored session.
`/poly-claude-mode` lets you select any mode that session offers while it is idle.
Poly does not disable native bypass or Auto modes.

The bridge loads only when `claude.enabled` is true and `claude.mode` is `bridge`.
It uses Pi's agent loop and tools through the upstream bridge.
The pinned bridge appends Pi's system prompt to its Claude Code preset.
Its `.poly/agent/claude-bridge.json` retains `provider.plan` and `provider.longContextExtraUsage` as billing choices.
They default to `pro` and `false`.
Poly writes the resolved executable into `provider.pathToClaudeCodeExecutable` as launcher plumbing.
Bridge startup replaces the file with those three fields; other historical options no longer apply.
Account-level Extra Usage and native account settings remain your responsibility.

Anthropic's [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) describes conditions for hosting unmodified Claude Code and restrictions on credential handling.
[Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) distinguishes plan-authenticated usage from API-key usage.
These statements do not establish Anthropic approval of either Pi integration.

## Billing environment guards

Poly checks the following nonempty variables when preparing or requesting the corresponding runtime.
A bridge startup refusal locks only the bridge and leaves Poly's other providers and commands available.
The locked bridge reports conflicting variable names or a missing executable without importing the bridge package.
It checks both inherited and per-request environments.
Diagnostics show names rather than values.

| Runtime             | Refused variables                                                                                                                                                                   | Source                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Claude, either mode | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`                                  | [Claude environment reference](https://code.claude.com/docs/en/env-vars) |
| Claude, either mode | `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_MANTLE`, `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD` | [Claude environment reference](https://code.claude.com/docs/en/env-vars) |
| Gemini              | `GEMINI_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, `AGY_ADC_AUTH`                                                                                                                          | [Antigravity authentication](https://antigravity.google/docs/install/)   |
| Gemini              | `GOOGLE_API_KEY` is refused defensively; the current CLI documents that it ignores this variable                                                                                    | [Antigravity authentication](https://antigravity.google/docs/install/)   |

During the v0.6.1 review, the [Claude environment reference](https://code.claude.com/docs/en/env-vars) did not document `CLAUDE_CODE_USE_GATEWAY` or `ANTHROPIC_UNIX_SOCKET`.
Neither variable is included in this guard.

Proxy variables, `NODE_OPTIONS`, `LD_*` and unrelated-provider variables are not refused by this guard.
Native settings can also affect authentication and billing; Poly no longer preflights them.
The login check does not attest an account's subscription plan.

Claude and Gemini prompts require direct interactive Pi input.
`/handoff-use` only prepares editor text; you submit it yourself.
See [security limits](security.md) and [Herdr helper restrictions](herdr.md).
