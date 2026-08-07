# Changelog

## Unreleased

### Added

- Let npm package templates validate name availability, authenticate interactively, and publish an initial package release.
- Add `--no-npm-publish` to skip initial publication while retaining package-name validation.

### Fixed

- Preserve template newlines after Eta interpolation tags.
- Create initial commits for mise-managed projects inside their project tool environment.

## [0.0.3] - 2026-08-01

### Fixed

- Initialize Git before running template commands so project checks can inspect the repository.

## [0.0.2] - 2026-08-01

### Fixed

- Upgrade the TOML parser to address a denial-of-service vulnerability.
- Use a Conventional Commit message when initializing generated Git repositories.

## [0.0.1] - 2026-07-06

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
