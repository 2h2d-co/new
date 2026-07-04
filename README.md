# @2h2d/new

Template-based project initializer.

```bash
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
```

With no arguments, `new` lists available templates and prompts for the template and project name.

Common options:

```bash
--template-source <source>   Local template collection or GitHub owner/repo
--yes                        Use defaults and do not prompt
--no-github                  Skip GitHub repository creation
--github-owner <owner>       GitHub owner for repository creation
--github-repo <name>         GitHub repository name
--github-visibility <v>      public or private
--github-public              Shorthand for --github-visibility public
--github-private             Shorthand for --github-visibility private
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
