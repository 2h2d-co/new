import assert from "node:assert/strict";
import test from "node:test";
import {
  coerceVariableValue,
  flagToVariableName,
  formatTemplateHelp,
  formatTemplateList,
  interpolateMustache,
  parseCliArgs,
  variableNameToFlag,
} from "../src/core.ts";

test("parseCliArgs separates known options and template variable flags", () => {
  const parsed = parseCliArgs([
    "ts-cli",
    "demo",
    "--template-source",
    "2h2d-co/templates",
    "--description",
    "Demo CLI",
    "--author-name=Kaan",
    "--github-private",
    "--yes",
  ]);

  assert.deepEqual(parsed.positional, ["ts-cli", "demo"]);
  assert.equal(parsed.templateSource, "2h2d-co/templates");
  assert.equal(parsed.githubVisibility, "private");
  assert.equal(parsed.yes, true);
  assert.deepEqual(parsed.variableFlags, {
    description: "Demo CLI",
    authorName: "Kaan",
  });
});

test("parseCliArgs recognizes list as a known boolean option", () => {
  const parsed = parseCliArgs(["--list", "--description", "Demo"]);

  assert.equal(parsed.list, true);
  assert.deepEqual(parsed.variableFlags, { description: "Demo" });

  const disabled = parseCliArgs(["--list=false"]);
  assert.equal(disabled.list, false);
  assert.deepEqual(disabled.variableFlags, {});
});

test("flagToVariableName converts kebab-case to camelCase", () => {
  assert.equal(flagToVariableName("author-name"), "authorName");
  assert.equal(flagToVariableName("github-owner"), "githubOwner");
});

test("variableNameToFlag converts camelCase to kebab-case", () => {
  for (const variableName of ["authorName", "githubOwner", "description"]) {
    assert.equal(flagToVariableName(variableNameToFlag(variableName)), variableName);
  }
});

test("interpolateMustache supports dotted paths", () => {
  assert.equal(
    interpolateMustache("github.com/{{ system.github.login }}/{{ repoName }}", {
      repoName: "demo",
      system: { github: { login: "kaanozdokmeci" } },
    }),
    "github.com/kaanozdokmeci/demo",
  );
});

test("coerceVariableValue validates select values", () => {
  assert.equal(
    coerceVariableValue(
      {
        name: "visibility",
        type: "select",
        choices: ["public", "private"],
      },
      "public",
    ),
    "public",
  );
  assert.throws(() =>
    coerceVariableValue(
      {
        name: "visibility",
        type: "select",
        choices: ["public", "private"],
      },
      "internal",
    ),
  );
});

test("formatTemplateHelp renders variable flags, defaults, and commands", () => {
  const output = formatTemplateHelp("demo", {
    name: "Demo",
    description: "Demo template",
    variables: [
      { name: "projectName", prompt: "Project name" },
      {
        name: "authorName",
        prompt: "Author name",
        default: "{{ system.git.name }}",
        required: true,
      },
      { name: "includeDogs", type: "boolean", prompt: "Include dogs", default: false },
      {
        name: "visibility",
        type: "select",
        prompt: "Visibility",
        choices: ["public", { name: "Private", value: "private" }],
        default: "public",
      },
      { name: "count", type: "number", prompt: "Count", default: 2 },
      { name: "outputPath", type: "path", prompt: "Output path", default: "src" },
      { name: "repoName", prompt: "Repository name", default: "demo" },
      { name: "emptyValue", prompt: "Empty value", default: "" },
      { name: "settings", prompt: "Settings", default: { enabled: true } },
      { name: "items", prompt: "Items", default: ["a", "b"] },
    ],
    commands: [{ name: "Install", run: "npm install" }, { run: "npm test" }],
  });

  assert.match(output, /^Usage: new demo \[project-name\] \[options\]/);
  assert.match(output, /Demo\nDemo template/);
  assert.doesNotMatch(output, /--project-name/);
  assert.match(
    output,
    /--author-name <string>\s+Author name \[default: {{ system\.git\.name }}\] \(required\)/,
  );
  assert.match(output, /--include-dogs \/ --no-include-dogs\s+Include dogs \[default: false\]/);
  assert.match(output, /--visibility <public\|private>\s+Visibility \[default: public\]/);
  assert.match(output, /--count <number>\s+Count \[default: 2\]/);
  assert.match(output, /--output-path <path>\s+Output path \[default: src\]/);
  assert.match(output, /--repo-name <string>\s+Repository name \[default: demo\]/);
  assert.match(output, /--empty-value <string>\s+Empty value \[default: \]/);
  assert.match(output, /--settings <string>\s+Settings \[default: {"enabled":true}\]/);
  assert.match(output, /--items <string>\s+Items \[default: \["a","b"\]\]/);
  assert.match(output, /Commands:\n  Install: npm install\n  npm test/);
  assert.match(output, /Variables without a declared default may be filled from git, npm, gh/);
});

test("formatTemplateHelp omits commands section when commands are absent", () => {
  const output = formatTemplateHelp("demo", { variables: [] });

  assert.match(output, /Variables:\n  \(none\)/);
  assert.doesNotMatch(output, /\nCommands:/);
});

test("formatTemplateList aligns ids and displays names and descriptions", () => {
  assert.equal(
    formatTemplateList([
      { id: "demo", name: "Demo", description: "Demo template" },
      { id: "minimal", name: "minimal", description: "Minimal project" },
      { id: "named", name: "Named" },
      { id: "bare", name: "bare" },
    ]),
    ["demo     Demo - Demo template", "minimal  Minimal project", "named    Named", "bare"].join(
      "\n",
    ),
  );
});
