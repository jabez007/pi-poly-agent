# Native Pi resources

The pinned Pi runtime is 1.5.2.
Pi owns packages, extensions, skills, prompt templates, themes and custom providers.
Poly does not load a separate orchestration package format.

Bootstrap creates the isolated `.poly/agent` profile.
The managed launcher sets `PI_CODING_AGENT_DIR` and `PI_POLY_PROFILE` to that profile.
It does not copy another profile's authentication store.

## Install resources

Use Pi's native package commands through the launcher:

```bash
npm run pi -- install /absolute/path/to/reviewed-package
npm run pi -- list
npm run pi -- config
npm run pi -- remove /absolute/path/to/reviewed-package
```

Installation and configuration are explicit trusted-code actions.
Packages may run dependency installation scripts.
Poly forwards these operations to Pi rather than installing packages itself.
Native Pi supports local, npm and Git package sources.

You can reference existing reviewed resources through this profile's native settings or launcher flags:

```bash
npm start -- --skill /absolute/path/to/skill --prompt-template /absolute/path/to/prompt.md
```

Native extensions and their tools run as application code with your user privileges.
Before the managed launcher loads executable resources, review them and acknowledge trust once:

```bash
npm start -- --trust-native-resources
```

Project resources still use native Pi's project-trust decision.
Use Pi's `/reload` after changing resources.
`npm run doctor` inspects installed resource metadata without importing extensions or starting providers.

Native custom providers can be supplied through Pi's own extensions and model configuration.
Poly has no custom provider-instance registry in v0.6.
Existing `platform.json`, `integrations.json` and orchestration-specific package contributions are no longer loaded.
See [migration](migration-v060.md) for preserved files and removed interfaces.
