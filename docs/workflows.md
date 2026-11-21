# Development workflows

## Work directly with a native provider

Run `npm start`, authenticate through `/login`, and select a coding model with `/model`. Pi streams the response and presents tools in its normal conversation view. Every Pi tool call requires your approval. Escape or Pi's normal cancellation shortcut stops the current request.

Use `/resume` or launch with `npm start -- --resume` to pick a stored conversation. Launch with `npm start -- --continue` to resume the most recent session for the project. `/tree` provides Pi's native branching history.

The profile directory belongs to this checkout. To work in another repository, launch the script by absolute path from that repository:

```bash
cd /path/to/your/project
node --import /path/to/pi-poly-agent/node_modules/tsx/dist/loader.mjs /path/to/pi-poly-agent/scripts/cli.ts launch
```

Use a supported Node version. The launcher preserves the current project directory. If that project or its parents have executable `.pi` settings, review their compatibility before using the managed profile. No project settings are rewritten.

## Switch providers with a handoff

Run `/handoff` to open the checkpoint editor. Supply the current objective, completed work, decisions, questions, and relevant files. A fact needs `text`, `source`, and `verified`. Put uncertain ideas in `hypotheses` or mark the fact unverified. The extension supplies session, project, provider, Git revision, and timestamp provenance.

Confirm the preview, then select the destination provider with `/model`. Run `/handoff-use` to put the checkpoint into the editor. Review it and press Enter yourself. The command does not submit a prompt.

Claude and Google's runtime conversations are provider-specific. Pi retains the visible local history, but a switch does not transfer private execution state. Google receives only your current direct prompt. Use the explicit handoff when that prompt needs earlier context.

## Save and retrieve project memory

Set `memory.enabled` to `true` in `.poly/agent/poly.json` and restart. Keep `sharedWings` empty for project isolation. Session opening, resumption, and provider selection retrieve bounded project memories when the backend is available. Retrieval produces a notification, not a provider request.

After preparing `/handoff`, run `/memory-save` and confirm the save. Run `/memory-recall search words` for a focused lookup and `/memory-show` to inspect the results. If no local handoff exists, `/handoff-use` places the retrieved results in the editor. If a local handoff exists, it takes precedence.

Pi custom entries retain the reviewed checkpoint and its deduplication digest across resumption. MemPalace retains persistent project knowledge. Backend failures leave Pi history usable. No full conversation is repeatedly exported and no diary or coordination logstream is created.

## Work from tmux or Neovim

Open the managed Pi command in a normal tmux window for the current project. Return to Neovim with your existing tmux bindings. A Neovim terminal can run the same command. No shell, editor, keymap, or tmux configuration is changed by bootstrap.

Lazygit can run in another existing window or through your normal editor binding. Pi's active repository remains the directory from which you launched it.

## Use worktrees

Create worktrees with your normal Git commands and launch Pi from each worktree. Pi retains its native per-directory sessions. MemPalace uses the Git common directory for project identity, so those worktrees retrieve the same project wing. Checkpoint provenance records the revision associated with each handoff.

This milestone does not create, merge, or delete worktrees. It also does not dispatch parallel tasks or delegated reviews. Those workflows need a provider-capability check before any future subagent extension is enabled. Subscription-backed Google ACP must remain unavailable to that dispatcher.
