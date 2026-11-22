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

| Resource                       | Interactive Pi                     | Delegated worker                         | Required trust or limitation                                  |
| ------------------------------ | ---------------------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| Native extension command or UI | Native loading and reload          | Not imported                             | Trusted application code in parent                            |
| Native extension tool          | Native tool and approval UI        | Reviewed adapter only                    | Tool metadata does not constrain arbitrary Node.js            |
| Agent Skill                    | Native discovery and commands      | Selected instructional text              | Project trust, source attribution, secret/path checks         |
| Prompt template                | Native discovery and expansion     | Selected instructional text              | No worker slash commands or argument expansion                |
| Theme                          | Native selection                   | No worker TUI                            | User resource or trusted project                              |
| npm, Git, or local package     | Native install, filtering, removal | Already installed instructions only      | Installation and dependencies are trusted code                |
| Native custom provider         | Native extension registration      | Explicit registry adapter and instance   | No automatic worker eligibility or billing fallback           |
| Profile `models.json`          | Refused                            | Refused                                  | Can alter authentication/endpoints outside reviewed instances |
| Project resources              | Native trust decision              | Trusted selected instructions            | Executable project extensions never enter workers             |
| MCP/context extension          | Native parent integration          | Existing reviewed context/tool contracts | No automatic server or credential inheritance                 |

## Pinned baseline and remaining decisions

The verified baseline was `main` at `4f9ac10`, Pi SDK and CLI `@earendil-works/pi-coding-agent` 1.5.2, and Pi AI 1.5.2. All 79 baseline tests passed, including the opt-in Bubblewrap test. Type checking, formatting, and ESLint complexity limit 12 passed. The installed `dist/main.js`, `resource-loader`, `package-manager`, `settings-manager`, `trust-manager`, and exported declarations were inspected. No Pi upgrade was made.

Current [extensions](https://docs.pi.dev/latest/extensions), [skills](https://docs.pi.dev/latest/skills), [packages](https://docs.pi.dev/latest/packages), and [settings](https://docs.pi.dev/latest/settings) documentation informed the review. Implementation uses APIs verified in the installed 1.5.2 source and fixtures. Latest documentation is not a compatibility promise for this pin.

Pi's resource system replaces the old blanket resource exclusion and exact settings allowlist. The remaining Poly contracts express task policy, workflow dependencies, worker resource selection, provider delegation eligibility, and bounded attributed context. These have different responsibilities from native resource installation or parent extension registration.

For v0.5, prioritize qualification of representative real Pi packages and authorized providers, then distribution integrity and configuration diagnostics. Automatic worker-extension execution, another package manager, a second skill format, and a generic plugin runtime would add risk without resolving those requirements. A future worker-extension design needs enforceable process isolation, not more capability declarations.
