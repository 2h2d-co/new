# @2h2d/new

Template-based project initializer.

```bash
new --list
new ts-cli --help
new ts-cli my-tool
new pi-extension my-pi-package
new --template-source 2h2d-co/templates go-cli my-go-tool
```

The package exposes the `new` binary.

## Template source resolution

`new` resolves a template collection in this order:

1. `--template-source <source>`
2. `NEW_CLI_TEMPLATE_SOURCE`
3. `./templates`
4. `template_source` from `$XDG_CONFIG_HOME/new/config.toml` or `~/.config/new/config.toml`

A local template source must contain `new.toml` or `new-cli.toml` at the root. If a non-local source looks like `owner/repo`, `new` clones it with `gh` into the XDG cache and runs `git pull --ff-only` on later uses.

## Usage

```bash
new [template] [project-name] [options]
new --list
new <template> --help
```

With no arguments, `new` prompts for the template and project name. Use `new --list`
to list templates in the resolved template source, and `new <template> --help` to inspect
a template's variable flags, defaults, required markers, select choices, and commands before
rendering it.

Common options:

```bash
--template-source <source>   Local template collection or GitHub owner/repo
--list                       List templates in the resolved template source
--yes                        Use defaults and do not prompt
--no-github                  Skip GitHub repository creation
--github-owner <owner>       GitHub owner for repository creation
--github-repo <name>         GitHub repository name
--github-visibility <v>      public or private
--github-public              Shorthand for --github-visibility public
--github-private             Shorthand for --github-visibility private
--help                       Show static help or template help with a template
--version                    Show version
```

Template variables are passed as kebab-case flags:

```bash
new ts-cli demo --description "Demo CLI" --author-name "Kaan"
```

Variable defaults can use `{{ variable }}` interpolation and system defaults gathered from git, GitHub CLI, npm, and the global config.

## Global config

```toml
template_source = "2h2d-co/templates"

[defaults]
authorName = "Kaan Ozdokmeci"
authorEmail = "kaan@2h2d.co"
authorUrl = "https://www.2h2d.co"
licensor = "Kaan Ozdokmeci"

[github]
owner = "2h2d-co"
visibility = "public"
```

## Template collection layout

```txt
templates/
  new.toml
  ts-cli/
    template.toml
    files/
      package.json.eta
      src/
        cli.ts.eta
```

`.eta` files are rendered with Eta and the `.eta` suffix is stripped. Other files are copied as-is. File and directory names, defaults, and command strings support `{{ variable }}` interpolation.

## Local development

```bash
npm install
npm run check
npm run build
npm run pack:dry
npm run lint
npm run fmt
```

## Packaging

This package publishes the executable shim, generated JavaScript, and project files explicitly:

- `bin/`
- `dist/`
- `README.md`
- `CHANGELOG.md`
- `LICENSE`

Release flow:

1. Create a release commit named `release: vX.Y.Z`.
2. Tag that commit as `vX.Y.Z`.
3. Push `main` and the tag to GitHub.
4. The tag push triggers GitHub Actions to build and stage the package on npm via trusted publishing with npm provenance.
5. Approve the staged package on npmjs.com, or with `npm stage approve <stage-id>`.

The CI release workflow intentionally ignores prerelease tags such as `vX.Y.Z-alpha.N`; use the prerelease publish helper for those builds.

Prerelease publish helper for non-latest builds:

```bash
npm run publish:prerelease
npm run publish:prerelease -- --execute
```

`npm run publish:prerelease` runs `npm run check` and `npm run build` first, then defaults to an npm dry-run. Pass `--execute` to perform the real publish. The helper only supports prerelease versions, derives the npm dist-tag from the first prerelease identifier (`alpha` for `X.Y.Z-alpha.N`, `xyz` for `X.Y.Z-xyz.W`), refuses `latest`, and requires a clean worktree plus a pushed `v<version>` tag pointing at the current commit before a real publish.
