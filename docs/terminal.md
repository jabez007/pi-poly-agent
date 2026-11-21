# Use Pi with tmux, Neovim, and Lazygit

These examples are optional. They do not install hooks or modify editor configuration. Substitute your Pi Poly checkout path.

## Keep Pi beside the editor in tmux

From your repository, create a pane with the same working directory:

```bash
tmux split-window -h -c "$PWD" 'node --import /absolute/pi-poly-agent/node_modules/tsx/dist/loader.mjs /absolute/pi-poly-agent/scripts/cli.ts launch'
```

Use tmux's pane selection keys to return to Neovim. Pi's `/tasks` selects recent tasks and actions; `/tasks all` prints the full list. Completion and interruption notifications appear in Pi even when the parent model is idle.

An optional tmux binding opens Pi in the active pane's directory:

```tmux
bind-key P split-window -h -c '#{pane_current_path}' 'node --import /absolute/pi-poly-agent/node_modules/tsx/dist/loader.mjs /absolute/pi-poly-agent/scripts/cli.ts launch'
set-option -g visual-activity on
set-window-option -g monitor-activity on
```

Activity monitoring marks output, including completion notifications; it does not classify task events. Avoid starting a second Pi task host for the same project/profile. Focus its existing pane instead. No tmux pane or session is killed by worker cleanup.

## Open Pi from Neovim or AstroNvim

Run `:terminal` and invoke the absolute launcher from your repository, or add this optional Lua command to your own configuration:

```lua
vim.api.nvim_create_user_command("PiPoly", function()
	local root = vim.fs.root(0, { ".git" }) or vim.fn.getcwd()
	vim.cmd("botright new")
	vim.fn.jobstart({
		"node", "--import", "/absolute/pi-poly-agent/node_modules/tsx/dist/loader.mjs",
		"/absolute/pi-poly-agent/scripts/cli.ts", "launch",
	}, { term = true, cwd = root })
	vim.cmd("startinsert")
end, {})
```

Use `<C-\><C-n>` to leave terminal input mode and normal window commands to return to your buffer. The command uses an argument list and preserves paths with spaces. It does not change your shell or install an AstroNvim plugin. Check that the selected buffer belongs to the intended repository before launching.

## Inspect work with Lazygit

`/task ID` shows the worker's path, branch, base, and captured revision. Open another terminal at that path and run `lazygit`. Use normal Git worktree navigation to return to the parent. Reviewer worktrees contain the builder snapshot and read-only worker tools; your own Git tools still have normal user permissions.

Use `/task ID integrate` for the guarded, approved integration path. If you integrate manually, inspect the exact reviewed commit and findings first. The extension does not claim to enforce its approval or review rules on Git commands you run independently.

`/task ID cleanup` removes a clean inactive worktree and retains its branch. Inspect retained branches with `git branch --list 'poly/task-*'` and worktrees with `git worktree list`. Delete a branch yourself only after preserving or integrating its changes. Missing worktree directories require normal `git worktree repair` or `git worktree prune` inspection; Pi does not prune them automatically.
