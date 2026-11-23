# Exercise Pi Poly Agent on its own repository

The first task creates only `docs/dogfooding-observation.md` with this exact content:

```markdown
# Dogfooding observation

Qualification status: live testing pending.
```

The acceptance command compares exact contents using Node's built-in `assert` and `fs`. It requires no dependency installation, network or credential access. The workflow definition is [examples/dogfood/platform.json](../examples/dogfood/platform.json). Its two arbitrary agents run through the existing workflow/task engine. No authentication or provider-policy file is part of the task.

## Run the offline product exercise

```bash
npm run dogfood:offline
```

This clones the committed repository into a new temporary directory, creates a fresh profile, and injects deterministic Codex/Kimi transport fixtures. Pi owns the independent sessions and actual tool execution. The documentation change, single-use test approval, Bubblewrap test, snapshot, independent diff/file inspection and structured results are exercised. MemPalace is disabled. The command leaves the parent unchanged and preserves a `report.json`, session files, task/workflow records and worktrees. Its output gives the artifact path.

The opt-in automated test also exercises integration in that disposable clone and reopens completed records without replay. It does not integrate into the active checkout. Linux namespaces and `/usr/bin/bwrap` are required. The script fails closed when sandbox startup fails; no host shell substitutes for it.

The fixtures are not real providers or proof of model judgment. Step and tool approvals are simulated in this offline exercise. The fixture-specific Kimi key flag enables an injected no-network auth seam, not a real API credential. Live dogfooding remains pending.

## Personally initiate a live exercise

Start from a clean checkout on a named branch. Run these commands from the Pi Poly Agent checkout. Existing directories and branch names cause normal Git/bootstrap refusal rather than replacement.

```bash
git worktree add -b dogfood/v05 ../pi-poly-agent-dogfood HEAD
npm run bootstrap -- --profile ../pi-poly-agent-dogfood/.poly/agent
cp -n examples/dogfood/platform.json ../pi-poly-agent-dogfood/.poly/agent/platform.json
npm run doctor -- --profile ../pi-poly-agent-dogfood/.poly/agent --project ../pi-poly-agent-dogfood
npm start -- --profile ../pi-poly-agent-dogfood/.poly/agent --project ../pi-poly-agent-dogfood
```

`cp -n` preserves an existing destination. If it already exists, inspect and edit the recipe choice explicitly. This new profile has no copied credentials. Review the native project trust prompt. In Pi, use supported `/login` yourself and verify the provider's billing classification. Choose Codex and independently Kimi or activated Z.AI, or separately authorized compatible instances. Claude subscription workers and consumer Google ACP are ineligible.

Before launching work, optionally use `/poly-qualify PROVIDER/MODEL`. It previews the exact identity and billing mode and asks for approval of one tool-free generation. It does not qualify tools, cancellation or orchestration. Complete the remaining [qualification scenarios](qualification.md) separately.

Use `/workflow`, select `documentation-check`, and enter this objective:

```text
Create only docs/dogfooding-observation.md containing exactly "# Dogfooding observation\n\nQualification status: live testing pending.\n". Run an approved Node assertion that compares the exact file content. Do not change authentication, provider policy or source implementation. Return actual evidence and outstanding questions.
```

Choose an authorized implementation model and a different inspection model. Review each packet, then approve each worker explicitly. Approve only the bounded Node acceptance command. Dependency copying is unnecessary for this task; decline it. An inspector must read the exact file and diff and report a source reference at line 3.

## Inspect before integration

Use `/tasks` or `/task` to select the implementation. Verify:

- Only the requested file changed.
- The controller recorded the acceptance command with exit 0.
- Independent review refers to the exact implementation revision.
- The diff, source paths, provider/model attribution and findings are present.
- Neither model claims that fixture results establish live qualification.

Decline integration once and confirm that the parent branch is unchanged. Integrate only after reviewing the findings and the final confirmation. This affects the `dogfood/v05` parent worktree, not `main` or the active implementation branch. No push runs automatically. Preserve artifacts and record the observed provider versions, approvals, failures and task IDs before normal Git cleanup.

A failed or interrupted run remains inspectable. Use explicit task recovery or validated workflow continuation; never replay an uncertain request manually without examining retained changes. Do not mark this exercise live-verified until you have actually completed it.
