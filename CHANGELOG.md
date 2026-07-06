# Changelog

## Unreleased

### Added

- Added project scaffolding from local and GitHub-hosted template collections.
- Added template source resolution from `--template-source`, `NEW_CLI_TEMPLATE_SOURCE`, local `./templates`, and global config.
- Added Eta-based template rendering with interpolation for file paths, defaults, and template commands.
- Added interactive prompts and `--yes` flows for template selection, project names, and template variables.
- Added kebab-case CLI flags for supplying template variables non-interactively.
- Added template listing with `--list` and per-template help with `new <template> --help`.
- Added generated-project git initialization, template command execution, and optional GitHub repository creation with `gh`.
- Added global defaults from config, git, npm, and GitHub CLI metadata.

### Fixed

- Improved the Ctrl+C prompt cancellation message.
- Removed duplicate available-template output before the interactive template picker.
