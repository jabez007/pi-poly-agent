# Run Pi Poly Agent in Herdr

Install Herdr using its [installation guide](https://herdr.dev/tui/docs/install/):

```bash
curl -fsSL https://herdr.dev/install.sh | sh
```

From the Pi Poly Agent checkout, bootstrap its profile and install Herdr's native Pi integration:

```bash
npm run bootstrap
PI_CODING_AGENT_DIR="$PWD/.poly/agent" herdr integration install pi
```

Herdr documents the command and directory override in [Pi integration](https://herdr.dev/tui/docs/integrations/).
The extension goes into this profile, rather than your personal Pi profile.
No Poly-specific Herdr adapter is required.

Start Herdr as described in its [quick start](https://herdr.dev/tui/docs/quick-start/):

```bash
herdr
```

In a pane, run the managed launcher from the Poly checkout:

```bash
npm start -- --project /absolute/path/to/your/project --trust-native-resources
```

Review installed resources before acknowledging trust.
The [quick start](https://herdr.dev/tui/docs/quick-start/) explains panes, detach and reattachment.
Herdr's [integration guide](https://herdr.dev/tui/docs/integrations/) describes native Pi state reporting and supported restoration.
Poly leaves those responsibilities with Herdr and Pi.

Herdr [restores Pi with `pi --session <path-or-id>`](https://herdr.dev/tui/docs/session-state/#native-agent-session-restore), without Poly's `--project` flag.
Pi loads resources from `PI_CODING_AGENT_DIR`, or `~/.pi/agent` when it is unset; the session reference does not select Poly's profile.
If the restored pane lost the profile, stop Pi and restart it from the Poly checkout:

```bash
npm start -- --project /absolute/path/to/your/project --session /absolute/path/to/session.jsonl --trust-native-resources
```

## Choose helper providers yourself

Start Claude and Gemini panes yourself.
Use only Codex, Kimi or Z.AI for helpers that agents start with [`herdr agent start`](https://herdr.dev/tui/docs/cli-reference/#agents) and drive with [`herdr agent prompt`](https://herdr.dev/tui/docs/cli-reference/#agents).
`herdr agent prompt` types into a pane, so Poly cannot distinguish it from your typing in a Claude or Gemini pane.
Pi Poly Agent cannot enforce provider selection inside Herdr or distinguish agent-sent terminal input from your keystrokes.

Herdr's [terminal runtime](https://herdr.dev/core/) supports background terminals and several machines.
It does not add Poly's retired sandbox or independent-review integration gate.
