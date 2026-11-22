# Use native Pi resources

Pi owns interactive extensions, skills, prompt templates, themes, package installation, resource filtering, project trust, and reloads. Pi Poly Agent owns orchestration policy and independent task execution. Native resources do not need a Poly adapter to work in the interactive session.

## Install or reference reviewed resources

Bootstrap still creates only `.poly/agent`. It does not read or copy your personal authentication store. Manage this profile with the pinned Pi CLI:

```bash
npm run pi -- install npm:YOUR_PACKAGE@EXACT_VERSION
npm run pi -- install /absolute/path/to/reviewed/local-package
npm run pi -- list
npm run pi -- config
npm run pi -- remove npm:YOUR_PACKAGE@EXACT_VERSION
npm start
```

These commands forward to Pi, rather than implementing another installer. Pi supports npm, Git, and local package sources. Pin npm versions and Git revisions yourself. Installation is an explicit trusted-code action and may run dependency scripts according to the native package manager's configuration. Review the package and its dependencies first. Startup stays offline, so merely referencing a missing package does not download it or run an installer.

`install` and `config` acknowledge trusted user-resource execution in this profile. Existing profiles with previously suppressed packages, extensions, or MCP configuration require one explicit acknowledgment:

```bash
npm start -- --trust-native-resources
```

This grants application-process authority to enabled user resources, including later edits at those locations. It is not file attestation. Remove `.poly/agent/interactive-trust.json` to require acknowledgment again. Pi's separate per-project trust decision still applies. Automatic `defaultProjectTrust: "always"` is refused in the managed profile.

To reuse a personal package, install its local path in this profile. To reuse individual personal resources, reference their reviewed paths through native settings:

```json
{
	"extensions": ["/absolute/path/to/reviewed/extension.ts"],
	"skills": ["/absolute/path/to/reviewed/skills"],
	"prompts": ["/absolute/path/to/reviewed/prompts"],
	"themes": ["/absolute/path/to/reviewed/themes"],
	"theme": "your-theme"
}
```

Add those fields to `.poly/agent/settings.json`, preserving its compaction, retry, and cache-warming safeguards. Native Pi also discovers its normal profile directories and Agent Skills locations. No executable personal configuration is silently merged. Relative references resolve according to Pi's settings rules. Do not reference credential directories.

One-launch references use `npm start -- -e /path/extension.ts --skill /path/skill --prompt-template /path/prompt.md --theme /path/theme.json`. Use `--use-theme NAME` to select an installed theme. Native `--no-extensions`, `--no-skills`, `--no-prompt-templates`, and `--no-themes` flags remain available. The platform extension still loads explicitly. Automation, RPC, inline prompts, and API-key command-line arguments remain disabled in this launcher.

Use Pi's `/reload` after resource edits. Project `.pi` resources use Pi 1.5.2's trust prompt and trust store. Refusing trust prevents project extensions and project instructional resources from loading. A trust change followed by reload changes discovery. User extensions have full host authority and can alter trust behavior, so install only code you trust.

## Select worker instructions

Workers use independent Pi SDK sessions with native executable discovery disabled. A selected skill or prompt contributes bounded, secret-screened text with its source path:

```json
{
	"version": 1,
	"agents": {
		"schema-specialist": {
			"instructions": "Inspect the assigned schema question.",
			"policy": {
				"permissions": ["read"],
				"tools": ["read"],
				"skills": ["pi:skill:database-evidence", "pi:prompt:inspection-format"]
			}
		}
	}
}
```

Names resolve through the pinned native loader, including enabled resources in already installed packages. Missing packages cannot download during this worker path. Project resources require a saved native trust decision for the project root. Disabled, missing, conflicting, symlinked, or secret-bearing selected instructions fail before the model prompt. Effective resource restrictions still intersect.

These are instructional snapshots. Workers do not gain interactive slash commands, template argument expansion, access to external supporting files, or permission to execute bundled scripts. References inside a skill grant no filesystem privilege. Copy needed non-sensitive references into approved project context when necessary. Existing `policy.skills` text registrations remain supported. Existing `policy.extensions` selects reviewed instruction functions, not arbitrary Pi extensions.

Native extension tools need a reviewed `ToolRegistration` adapter before worker use. Its permission metadata limits selection but cannot sandbox its JavaScript implementation. Such implementations have host authority and must use the scoped filesystem tools or the approved Bubblewrap execution path. General in-process Pi extensions cannot be constrained by resource filtering. They remain unsupported inside restricted workers. A separate extension runtime is not added.

## Distribute orchestration with a Pi package

A normal Pi package can optionally include this manifest field:

```json
{
	"name": "example-pi-team",
	"version": "1.0.0",
	"pi": {
		"extensions": ["extensions"],
		"skills": ["skills"],
		"prompts": ["prompts"],
		"themes": ["themes"]
	},
	"pi-poly-agent": { "configuration": "poly.json" }
}
```

Install it through Pi. Explicitly opt into its orchestration JSON in your trusted `platform.json`:

```json
{
	"version": 1,
	"packages": ["pi:npm:example-pi-team@1.0.0"]
}
```

The reference must match an already configured user package source. Absolute local package paths also work. The configuration path stays inside that package and rejects symlink escapes. JSON uses the existing version 1 agents, workflows, policy, and providers contract. It is validated and layered before its containing configuration. No JavaScript is imported to read it. Removing the reference disables that orchestration contribution; Pi's resource filters independently control native resources.

Legacy `.poly/agent/packages/NAME.json` includes remain supported as standalone JSON configuration. They have no installer, registry, or updater. Project configuration cannot install packages or enable executable integrations. A package that does not declare `pi-poly-agent` behaves as an ordinary Pi package.

Parent extensions use `pi.registerTool`, `pi.registerCommand`, `pi.on`, `pi.registerProvider`, and native MCP/context mechanisms directly. They need not implement a Poly interface. For worker providers, a reviewed integration can reuse the same Pi provider factory with `ProviderRegistry.registerAdapter`; it must also declare an eligible, explicitly activated instance. Parent registration alone never authorizes delegation. Unrestricted extension initialization cannot be replayed automatically inside a restricted worker just to discover its provider.

## Compatibility and trust

The following evidence comes from offline fixtures against Pi 1.5.2. A functioning command or renderer is distinguished from resource discovery. No real provider or third-party network package was used.

| Resource              | Interactive evidence                                                                                                                 | Restricted worker behavior                                              | Trust or remaining limitation                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Extension command     | SDK `session.prompt` dispatch executes an installed package's command; duplicate names use native disambiguation                     | Not imported                                                            | Trusted application code; no claim of host sandboxing                                           |
| Extension tool        | Native loading, SDK registration and actual definition invocation return the fixture result                                          | Reviewed adapter only                                                   | No live model-driven extension-tool qualification; arbitrary Node.js is trusted code            |
| Agent Skill           | Two packaged skills and explicit personal references discovered; filtering and trust reload tested                                   | Selected, attributed text; real independent SDK worker consumes a skill | No supporting-file or script execution grant                                                    |
| Prompt template       | Native parsing, positional argument expansion and edited-resource reload tested                                                      | Selected text with individual and combined budgets                      | No worker slash-command or argument expansion                                                   |
| Theme                 | Native loading and color rendering tested                                                                                            | No worker TUI                                                           | Full-screen selector and terminal appearance are not independently qualified                    |
| Local package         | Pinned CLI install/list/remove, resource filtering, ordinary preprovisioned runtime dependency execution, configuration preservation | Already installed instructional resources only                          | No network installer or lifecycle-script qualification                                          |
| npm or Git package    | Native mechanisms retained and reviewed in pinned source                                                                             | Already installed instructions only                                     | Network installation of real packages not independently verified                                |
| Poly-aware package    | Native installed-package reference loads validated agents/workflows                                                                  | Same task engine                                                        | Explicit trusted configuration opt-in; malformed/traversing/symlink contributions rejected      |
| Custom provider       | Native extension registration tested; compatible transport uses loopback fixtures                                                    | Explicit eligible registry adapter/instance only                        | No real model server or API billing qualification                                               |
| Project resources     | Untrusted code stays unloaded; grant/revoke and reload tested                                                                        | Saved trust plus explicit instructional selection                       | Executable project extensions never enter workers                                               |
| Profile `models.json` | Refused                                                                                                                              | Refused                                                                 | Could change authentication or endpoints outside reviewed instances                             |
| MCP/context extension | Native parent path retained                                                                                                          | Existing reviewed context/tool contracts                                | Arbitrary third-party MCP packages not independently verified; no server/credential inheritance |

Instruction snapshots containing malicious requests do not broaden effective tools, scoped paths or provider eligibility. Fixtures check rejected credential-path reads, unknown/oversized resources, and executable extensions attempting filesystem, process, credential or provider access. These tests establish the restricted loading path; they do not prove a model can never follow malicious instructions within its allowed permissions.

## Pinned baseline and remaining decisions

The verified baseline was `main` at `4f9ac10`, Pi SDK and CLI `@earendil-works/pi-coding-agent` 1.5.2, and Pi AI 1.5.2. All 79 baseline tests passed, including the opt-in Bubblewrap test. Type checking, formatting, and ESLint complexity limit 12 passed. The installed `dist/main.js`, `resource-loader`, `package-manager`, `settings-manager`, `trust-manager`, and exported declarations were inspected. No Pi upgrade was made.

Current [extensions](https://docs.pi.dev/latest/extensions), [skills](https://docs.pi.dev/latest/skills), [packages](https://docs.pi.dev/latest/packages), and [settings](https://docs.pi.dev/latest/settings) documentation informed the review. Implementation uses APIs verified in the installed 1.5.2 source and fixtures. Latest documentation is not a compatibility promise for this pin.

Pi's resource system replaces the old blanket resource exclusion and exact settings allowlist. The remaining Poly contracts express task policy, workflow dependencies, worker resource selection, provider delegation eligibility, and bounded attributed context. These have different responsibilities from native resource installation or parent extension registration.

For v0.5, prioritize qualification of representative real Pi packages and authorized providers, then distribution integrity and configuration diagnostics. Automatic worker-extension execution, another package manager, a second skill format, and a generic plugin runtime would add risk without resolving those requirements. A future worker-extension design needs enforceable process isolation, not more capability declarations.
