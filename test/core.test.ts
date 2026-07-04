import assert from "node:assert/strict";
import test from "node:test";
import {
  coerceVariableValue,
  flagToVariableName,
  interpolateMustache,
  parseCliArgs,
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

test("flagToVariableName converts kebab-case to camelCase", () => {
  assert.equal(flagToVariableName("author-name"), "authorName");
  assert.equal(flagToVariableName("github-owner"), "githubOwner");
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
