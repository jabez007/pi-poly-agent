# Security limits

## Native runtime guards

Claude and Gemini are off by default.
`claude.enabled`, `claude.mode` and `google.enabled` control their activation and selection.
Poly resolves the executable from `PATH` or the optional absolute path setting.
It does not attest the executable or require a review revision.

Login stays inside Claude Code or Antigravity.
Poly does not read, copy or store their credential files.
The ACP client advertises no terminal-auth capability.
It does not call `authenticate` or `providers/*`.
Claude authentication status comes from the adapter's native status operation.
Gemini uses cached native login and reports the native login command when authentication is required.

The [billing environment guards](providers.md#billing-environment-guards) apply only to the corresponding runtime.
Native settings, helpers and account choices remain under your control.
Poly does not verify account kind or subscription entitlement.
It does not change providers or enable API billing after an error.

Claude ACP keeps native tools, prompt and settings.
It selects `default` before prompting.
You may explicitly choose any mode the runtime offers, including modes that reduce native permission prompts.
Permission requests that reach Poly show contextual details and offer only single-use decisions.
Opaque requests are denied.
The bridge uses Pi's tools; managed Pi tool calls require interactive approval.

## Human input

One shared input check covers both Claude modes and Gemini.
It requires Pi's interactive input source and a terminal UI.
ACP consumes that input for one prompt and does not forward the parent transcript.
The bridge may continue Pi tool results within that human-initiated turn.
Turn completion, model changes and session changes clear the authorization.
Generated handoffs only populate the editor.
Automatic compaction, retries and cache warming remain disabled in the managed profile.
Manual compaction requires a confirmed MemPalace checkpoint and is unavailable for both Claude modes and Gemini.

Trusted native Pi extensions execute with the host process's privileges.
Poly does not sandbox that code.
Native Pi owns project trust and resource loading.
The isolated profile requires an explicit trust acknowledgment before loading installed executable resources through the managed launcher.
Terminal automation outside Pi can look like interactive input; [Herdr helper selection](herdr.md) remains an operator responsibility.

## Removed execution guarantees

There are no Poly workers, worker tools, worktrees, task records or review gates in v0.6.
There is no Bubblewrap execution path.
Native runtimes and Pi tools act in the selected project with your user permissions.
Herdr does not replace the removed sandbox or reviewed-integration gate.
Old task files and Git worktrees are left on disk for manual inspection.

## Context

Pi owns conversation history.
MemPalace is optional project knowledge storage.
Reviewed handoffs preserve provenance and uncertainty.
Known secret patterns are screened before checkpointing; this does not detect every confidential value.
You review a handoff before saving it or submitting it to another model.
Provider-private execution state is not a shared-memory artifact.
