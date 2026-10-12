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
--no-npm-publish             Skip template-declared initial npm publication
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

Templates can request the shared release protections after GitHub repository creation:

```toml
[github]
release_environment = "npm-publish"
```

When GitHub creation is enabled, `new` then:

- protects `main` with one code-owner approval, stale-review dismissal, conversation resolution,
  linear history, and force-push/deletion blocking while retaining the administrator release path;
- protects `v*` tags against creation, update, and deletion except by repository administrators;
- creates the named release environment without required reviewers or administrator bypass;
- restricts that environment to `v*` tags.

`--no-github` skips both repository creation and these server-side controls. npm trusted publishing
must still be connected to the repository, workflow, and environment after the initial package
exists.

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

`.eta` files are rendered with Eta without automatic whitespace trimming, and the `.eta` suffix is
stripped. Other files are copied as-is. File and directory names, defaults, and command strings
support `{{ variable }}` interpolation.

Generated projects with `mise.toml` or `.mise.toml` create their initial Git commit through
`mise exec` so project-local hook tools are available.

## npm package reservation

Templates for npm packages can declare an initial publication:

```toml
[npm]
package_name = "{{ packageName }}"
version = "0.0.1-alpha.0"
tag = "alpha"
access = "public"
```

Initial publication requires a macOS terminal. Before creating the target directory, `new` checks
the exact package name with `npm view`. An existing package stops creation. If `npm whoami` fails,
`new` runs `npm login --auth-type=web`.

After rendering, template commands, the initial Git commit, optional GitHub repository creation,
and declared GitHub release controls, `new` verifies the rendered `package.json` name and version.
It packs the package and records the archive checksums, then runs:

```bash
npm publish --tag alpha --access public --allow-directory=all
```

npm login and publish run under macOS `script`, which gives npm a terminal. Their output stays in
memory because it contains one-time authentication links. `new` opens each npm authentication link
in the browser with `open` and prints only fixed status lines, exit codes, npm error codes, and npm's
error explanations with every URL removed. Each command stops after five minutes.

The registry decides the result, because an interrupted npm client can still have published. `new`
checks the registry with `npm view` for up to five minutes. The published SHA-512 integrity and
SHA-1 must match the packed archive, and the configured tag must point to the version.

Initial publication is public and irreversible. Use `--no-npm-publish` to skip publication; package
name availability is still validated.

## Local development

```bash
mise run init
mise run check
npm run build
npm run pack:dry
npm run lint
npm run fmt
```

`npm run test:live` packs this checkout, installs the archive, and publishes a real, public throwaway
package named `@2h2d/new-live-test-<YYYYMMDDHHMM>` through it. Run it from a macOS terminal session
and approve npm's browser prompt. Set `NEW_PACKAGE_ARCHIVE` to an absolute archive path to test that
archive instead. Deprecate the throwaway package afterward.

## Packaging

This package publishes the executable shim, generated JavaScript, and project files explicitly:

- `bin/`
- `dist/`
- `README.md`
- `CHANGELOG.md`
- `LICENSE`

`.github/npm-package-files` is the authoritative package-content allowlist used by the local release command and both CI jobs. Update it whenever the intended published file set changes.

Release flow:

1. Run `npm run release -- X.Y.Z` from a clean, synchronized `main`.
2. The release command builds the package from the staged Git index, records its SHA-256 in the SSH-signed release commit, rebuilds the commit to prove reproducibility, and creates a lightweight `vX.Y.Z` tag.
3. Inspect the commit and tag, then push them atomically with `git push --atomic origin main vX.Y.Z`.
4. The tag push triggers a read-only GitHub Actions job that builds, tests, packs, and inspects the package.
5. After approval in the tag-restricted `npm-publish` environment, a separate credentialed job verifies the release commit signature and requires its package to match the locally signed SHA-256 before attesting and staging that exact archive through npm trusted publishing with npm provenance.
6. Approve the staged package on npmjs.com, or with `npm stage approve <stage-id>`.

Stable and prerelease tags use the same CI flow. Stable versions use the `latest` npm dist-tag; prereleases derive the tag from their first prerelease identifier, such as `alpha`, `beta`, or `rc`.
