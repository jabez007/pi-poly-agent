# Roadmap

The first milestone provides the isolated profile, provider-policy enforcement, a reused Claude SDK bridge, a small direct-interaction ACP adapter, and an optional MemPalace handoff. Live execution remains unqualified.

## Next milestone: qualify the direct provider paths

1. Resolve Claude subscription authorization for this SDK frontend. Review account Extra Usage and native settings before any activation.
2. Verify the official `agy` distribution and a compatible version. After explicit user authorization, qualify login, Gemini enumeration, tool prompts, cancellation, and reconnection inside Pi.
3. Qualify native Codex, Kimi, and Z.AI coding-plan logins without introducing an API fallback.
4. Replace conservative ACP context limits with supported runtime metadata where available. Add quota display only through documented runtime capabilities.
5. Test permissions with real tools in a disposable repository after authorization. Keep live tests outside the ordinary test suite and CI.

## Improve continuity

Add user-reviewed incremental checkpoint drafting, exact knowledge-item deduplication, and relevance tests against project fixtures. Preserve Pi as the active-conversation source of truth. Prefer MemPalace's existing checkpoint, diary, and logstream interfaces over new persistence formats.

Make fresh runtime sessions visible in the status line and offer an explicit handoff when a provider cannot resume. Consider documented ACP session restoration after direct interaction has been qualified. Do not synchronize provider-private execution state.

## Add small workflow extensions

Start with an explicit delegated review on an authorized native provider. Define delegation capability separately from model availability. Enforce the Google prohibition at dispatch and request time. Then add worktree isolation, per-task status, and user-controlled merging.

Reuse an established Pi subagent extension after reviewing its provider selection and child-session behavior. Do not introduce a daemon for these workflows without a concrete need.

## Optional terminal polish

Add tmux and Neovim command examples, Lazygit shortcuts, role definitions, and concise status details as separate opt-in modules. Preserve standalone Pi usage and the user's existing editor and Git workflows.
