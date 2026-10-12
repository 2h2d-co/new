import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { isConfigObject, isString, parseConfigObject, type ConfigObject } from "../src/core.ts";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Eta rendering preserves newlines after interpolation tags", async () => {
  const root = await mkdtemp(join(tmpdir(), "new-cli-test-"));
  const templateSource = join(root, "templates");
  const templateDir = join(templateSource, "eta-whitespace");
  const targetDir = join(root, "generated-project");

  try {
    await mkdir(join(templateDir, "files"), { recursive: true });
    await writeFile(join(templateSource, "new.toml"), 'name = "Test templates"\n');
    await writeFile(
      join(templateDir, "template.toml"),
      [
        'name = "Eta whitespace"',
        "",
        "[[variables]]",
        'name = "description"',
        'default = "Generated description"',
        "",
      ].join("\n"),
    );
    await writeFile(
      join(templateDir, "files", "README.md.eta"),
      "# <%= it.projectName %>\n\n<%= it.description %>\n\nGenerated content.\n",
    );

    await execFile(
      process.execPath,
      [
        join(projectRoot, "src", "cli.ts"),
        "eta-whitespace",
        "generated-project",
        "--template-source",
        templateSource,
        "--yes",
        "--no-github",
      ],
      {
        cwd: root,
        env: gitIdentityEnv(root),
      },
    );

    assert.equal(
      await readFile(join(targetDir, "README.md"), "utf8"),
      "# generated-project\n\nGenerated description\n\nGenerated content.\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("npm templates validate, authenticate, and publish the initial package", async () => {
  const root = await mkdtemp(join(tmpdir(), "new-cli-test-"));
  const targetDir = join(root, "generated-package");
  const fakeNpm = await createFakeNpm(root);

  try {
    const output = await runNpmTemplate(root, fakeNpm, "generated-package");

    const lifecycle = (await readFakeNpmLog(fakeNpm.logPath)).filter((entry) =>
      ["view", "whoami", "login", "pack", "publish"].includes(entry.args[0] ?? ""),
    );
    assert.deepEqual(
      lifecycle.map((entry) => entry.args[0]),
      ["view", "whoami", "login", "whoami", "pack", "publish", "view"],
    );
    assert.deepEqual(lifecycle[2]?.args, [
      "login",
      "--auth-type=web",
      "--color=false",
      "--logs-max=0",
    ]);
    assert.deepEqual(lifecycle[5]?.args, [
      "publish",
      "--tag",
      "alpha",
      "--access",
      "public",
      "--allow-directory=all",
      "--color=false",
      "--logs-max=0",
    ]);
    assert.equal(lifecycle[5]?.cwd, await realpath(targetDir));
    assert.deepEqual(lifecycle[6]?.args, [
      "view",
      "generated-package@0.0.1-alpha.0",
      "dist",
      "dist-tags",
      "--json",
      "--logs-max=0",
    ]);
    assert.deepEqual(await readOpenedUrls(fakeNpm), [FAKE_LOGIN_URL, FAKE_PUBLISH_URL]);
    assertNoAuthenticationLinks(output);
    assert.match(
      output,
      /Published generated-package@0\.0\.1-alpha\.0: registry bytes and the alpha tag match\./,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("npm publication requires a terminal before scaffolding", async () => {
  const root = await mkdtemp(join(tmpdir(), "new-cli-test-"));
  const fakeNpm = await createFakeNpm(root);

  try {
    await assert.rejects(
      runNpmTemplate(root, fakeNpm, "terminal-package", {}, { terminal: false }),
      /Initial npm publication requires a macOS terminal\. Pass --no-npm-publish to skip it\./,
    );
    await assert.rejects(stat(join(root, "terminal-package")));
    const lifecycle = (await readFakeNpmLog(fakeNpm.logPath)).filter(
      (entry) => entry.args[0] !== "config",
    );
    assert.deepEqual(lifecycle, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed npm login stops before scaffolding without printing links", async () => {
  const root = await mkdtemp(join(tmpdir(), "new-cli-test-"));
  const fakeNpm = await createFakeNpm(root);

  try {
    const failure = await runNpmTemplate(root, fakeNpm, "login-package", {
      FAKE_NPM_LOGIN: "fail",
    }).then(
      () => assert.fail("Expected npm login to fail"),
      (error: unknown) => error,
    );
    const output = commandOutputText(failure);
    assert.match(output, /npm login did not complete \(exit code 1, npm error codes E401\)/);
    assertNoAuthenticationLinks(output);
    assert.deepEqual(await readOpenedUrls(fakeNpm), [FAKE_LOGIN_URL]);
    await assert.rejects(stat(join(root, "login-package")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("npm publication fails when the registry bytes differ from the packed archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "new-cli-test-"));
  const fakeNpm = await createFakeNpm(root);

  try {
    await assert.rejects(
      runNpmTemplate(root, fakeNpm, "mismatched-package", { FAKE_NPM_PUBLISH: "other-bytes" }),
      /The published mismatched-package@0\.0\.1-alpha\.0 differs from the packed archive\./,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("npm publication fails when the dist-tag does not point to the version", async () => {
  const root = await mkdtemp(join(tmpdir(), "new-cli-test-"));
  const fakeNpm = await createFakeNpm(root);

  try {
    await assert.rejects(
      runNpmTemplate(root, fakeNpm, "untagged-package", { FAKE_NPM_PUBLISH: "other-tag" }),
      /matches the packed archive, but the alpha tag does not point to it\./,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the registry confirms a publication whose npm client failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "new-cli-test-"));
  const fakeNpm = await createFakeNpm(root);

  try {
    const output = await runNpmTemplate(root, fakeNpm, "interrupted-package", {
      FAKE_NPM_PUBLISH: "fail-after-publish",
    });
    assertNoAuthenticationLinks(output);
    assert.match(output, /Published interrupted-package@0\.0\.1-alpha\.0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed npm publication reports npm error codes and reasons without links", async () => {
  const root = await mkdtemp(join(tmpdir(), "new-cli-test-"));
  const fakeNpm = await createFakeNpm(root);

  try {
    const failure = await runNpmTemplate(root, fakeNpm, "rejected-package", {
      FAKE_NPM_PUBLISH: "fail",
    }).then(
      () => assert.fail("Expected npm publish to fail"),
      (error: unknown) => error,
    );
    const output = commandOutputText(failure);
    assert.ok(
      output.includes(
        [
          "npm publish did not complete (exit code 1, npm error codes E403), and the registry does not show rejected-package@0.0.1-alpha.0.",
          "npm reported:",
          "  403 403 Forbidden - PUT <URL> - Package name triggered spam detection",
          "  Retry at <URL>",
          "",
        ].join("\n"),
      ),
      output,
    );
    assertNoAuthenticationLinks(output);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("npm templates reject an occupied package name before scaffolding", async () => {
  const root = await mkdtemp(join(tmpdir(), "new-cli-test-"));
  const fakeNpm = await createFakeNpm(root);

  try {
    await assert.rejects(
      runNpmTemplate(root, fakeNpm, "occupied-package", { FAKE_NPM_TAKEN: "true" }),
      /npm package name is already taken: occupied-package/,
    );

    await assert.rejects(stat(join(root, "occupied-package")));
    const lifecycle = (await readFakeNpmLog(fakeNpm.logPath)).filter((entry) =>
      ["view", "whoami", "login", "pack", "publish"].includes(entry.args[0] ?? ""),
    );
    assert.deepEqual(
      lifecycle.map((entry) => entry.args),
      [["view", "occupied-package", "name", "--json"]],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--no-npm-publish keeps availability validation but skips authentication and publish", async () => {
  const root = await mkdtemp(join(tmpdir(), "new-cli-test-"));
  const fakeNpm = await createFakeNpm(root);

  try {
    await runNpmTemplate(
      root,
      fakeNpm,
      "unpublished-package",
      {},
      { args: ["--no-npm-publish"], terminal: false },
    );

    const lifecycle = (await readFakeNpmLog(fakeNpm.logPath)).filter((entry) =>
      ["view", "whoami", "login", "pack", "publish"].includes(entry.args[0] ?? ""),
    );
    assert.deepEqual(
      lifecycle.map((entry) => entry.args),
      [["view", "unpublished-package", "name", "--json"]],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("template commands run inside the initialized Git repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "new-cli-test-"));
  const templateSource = join(root, "templates");
  const templateDir = join(templateSource, "git-aware");
  const targetDir = join(root, "generated-project");
  const fakeMise = await createFakeMise(root);

  try {
    await mkdir(join(templateDir, "files"), { recursive: true });
    await writeFile(join(templateSource, "new.toml"), 'name = "Test templates"\n');
    await writeFile(
      join(templateDir, "template.toml"),
      [
        'name = "Git-aware"',
        "",
        "[[commands]]",
        'name = "Inspect Git repository"',
        'run = "git rev-parse --is-inside-work-tree > git-state.txt"',
        "",
      ].join("\n"),
    );
    await writeFile(join(templateDir, "files", "README.md"), "# Generated project\n");
    await writeFile(join(templateDir, "files", "mise.toml"), '[tools]\nnode = "22"\n');

    await execFile(
      process.execPath,
      [
        join(projectRoot, "src", "cli.ts"),
        "git-aware",
        "generated-project",
        "--template-source",
        templateSource,
        "--yes",
        "--no-github",
      ],
      {
        cwd: root,
        env: {
          ...gitIdentityEnv(root),
          FAKE_MISE_LOG: fakeMise.logPath,
          PATH: `${fakeMise.binDir}:${process.env["PATH"] ?? ""}`,
        },
      },
    );

    assert.equal(await readFile(join(targetDir, "git-state.txt"), "utf8"), "true\n");
    const { stdout: status } = await execFile("git", ["status", "--porcelain"], {
      cwd: targetDir,
    });
    assert.equal(status, "");
    const { stdout: subject } = await execFile("git", ["log", "-1", "--pretty=%s"], {
      cwd: targetDir,
    });
    assert.equal(subject.trim(), "chore: initial commit");
    assert.deepEqual(JSON.parse(await readFile(fakeMise.logPath, "utf8")), [
      "exec",
      "--",
      "git",
      "commit",
      "-m",
      "chore: initial commit",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("template GitHub configuration applies release controls after repository creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "new-cli-test-"));
  const templateSource = join(root, "templates");
  const templateDir = join(templateSource, "github-controls");
  const targetDir = join(root, "generated-project");
  const fakeGh = await createFakeGh(root);

  try {
    await mkdir(join(templateDir, "files"), { recursive: true });
    await writeFile(join(templateSource, "new.toml"), 'name = "Test templates"\n');
    await writeFile(
      join(templateDir, "template.toml"),
      [
        'name = "GitHub controls"',
        "",
        "[[variables]]",
        'name = "githubOwner"',
        'default = "2h2d-co"',
        "",
        "[[variables]]",
        'name = "repoName"',
        'default = "generated-project"',
        "",
        "[github]",
        'release_environment = "npm-publish"',
        "",
      ].join("\n"),
    );
    await writeFile(join(templateDir, "files", "README.md"), "# Generated project\n");

    await execFile(
      process.execPath,
      [
        join(projectRoot, "src", "cli.ts"),
        "github-controls",
        "generated-project",
        "--template-source",
        templateSource,
        "--yes",
      ],
      {
        cwd: root,
        env: {
          ...gitIdentityEnv(root),
          FAKE_GH_LOG: fakeGh.logPath,
          PATH: `${fakeGh.binDir}:${process.env["PATH"] ?? ""}`,
        },
      },
    );

    const operations = (await readFakeGhLog(fakeGh.logPath)).filter(
      (entry) =>
        entry.args[0] === "repo" ||
        (entry.args[0] === "api" && entry.args[3]?.startsWith("repos/2h2d-co/")),
    );
    assert.deepEqual(
      operations.map((entry) => entry.args.slice(0, 4)),
      [
        ["repo", "create", "2h2d-co/generated-project", "--public"],
        ["api", "--method", "PUT", "repos/2h2d-co/generated-project/branches/main/protection"],
        ["api", "--method", "POST", "repos/2h2d-co/generated-project/rulesets"],
        ["api", "--method", "PUT", "repos/2h2d-co/generated-project/environments/npm-publish"],
        [
          "api",
          "--method",
          "POST",
          "repos/2h2d-co/generated-project/environments/npm-publish/deployment-branch-policies",
        ],
      ],
    );

    const branchProtection = parseFakeGhInput(operations[1]);
    assert.deepEqual(branchProtection["required_pull_request_reviews"], {
      dismissal_restrictions: {},
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
      require_last_push_approval: false,
      required_approving_review_count: 1,
    });
    assert.equal(branchProtection["enforce_admins"], false);
    assert.equal(branchProtection["required_linear_history"], true);
    assert.equal(branchProtection["allow_force_pushes"], false);
    assert.equal(branchProtection["allow_deletions"], false);
    assert.equal(branchProtection["required_conversation_resolution"], true);

    const tagRuleset = parseFakeGhInput(operations[2]);
    assert.equal(tagRuleset["target"], "tag");
    assert.deepEqual(tagRuleset["rules"], [
      { type: "creation" },
      { type: "update" },
      { type: "deletion" },
    ]);

    const environment = parseFakeGhInput(operations[3]);
    assert.equal(environment["can_admins_bypass"], false);
    assert.deepEqual(environment["reviewers"], []);

    const environmentPolicy = parseFakeGhInput(operations[4]);
    assert.deepEqual(environmentPolicy, { name: "v*", type: "tag" });

    const { stdout: status } = await execFile("git", ["status", "--porcelain"], {
      cwd: targetDir,
    });
    assert.equal(status, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function gitIdentityEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_AUTHOR_NAME: "Test Author",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test Author",
    XDG_CONFIG_HOME: join(root, "config"),
  };
}

type FakeNpm = {
  authPath: string;
  binDir: string;
  logPath: string;
  openLogPath: string;
  registryPath: string;
  terminalPreloadPath: string;
};

type FakeNpmLogEntry = {
  args: string[];
  cwd: string;
};

type FakeGh = {
  binDir: string;
  logPath: string;
};

type FakeGhLogEntry = {
  args: string[];
  cwd: string;
  input: string;
};

async function createNpmTemplate(templateSource: string): Promise<void> {
  const templateDir = join(templateSource, "npm-package");
  await mkdir(join(templateDir, "files"), { recursive: true });
  await writeFile(join(templateSource, "new.toml"), 'name = "Test templates"\n');
  await writeFile(
    join(templateDir, "template.toml"),
    [
      'name = "npm package"',
      "",
      "[[variables]]",
      'name = "packageName"',
      'default = "{{ projectName }}"',
      "",
      "[npm]",
      'package_name = "{{ packageName }}"',
      'version = "0.0.1-alpha.0"',
      'tag = "alpha"',
      'access = "public"',
      "",
    ].join("\n"),
  );
  await writeFile(
    join(templateDir, "files", "package.json.eta"),
    [
      "{",
      '  "name": <%= it.json(it.packageName) %>,',
      '  "version": "0.0.1-alpha.0"',
      "}",
      "",
    ].join("\n"),
  );
}

const FAKE_LOGIN_URL = "https://www.npmjs.com/login?next=/login/cli/fake-login-secret";
const FAKE_PUBLISH_URL = "https://www.npmjs.com/auth/cli/fake-publish-secret";

async function runNpmTemplate(
  root: string,
  fakeNpm: FakeNpm,
  projectName: string,
  overrides: NodeJS.ProcessEnv = {},
  options: { args?: string[]; terminal?: boolean } = {},
): Promise<string> {
  const templateSource = join(root, "templates");
  await createNpmTemplate(templateSource);
  // Linux CI has no macOS terminal. The preload presents one, and the fake script and open
  // commands stand in for the macOS tools.
  const preload =
    options.terminal === false ? [] : ["--import", pathToFileURL(fakeNpm.terminalPreloadPath).href];
  const result = await execFile(
    process.execPath,
    [
      ...preload,
      join(projectRoot, "src", "cli.ts"),
      "npm-package",
      projectName,
      "--template-source",
      templateSource,
      "--yes",
      "--no-github",
      ...(options.args ?? []),
    ],
    { cwd: root, env: npmTestEnv(root, fakeNpm, overrides) },
  );
  return `${result.stdout}${result.stderr}`;
}

function commandOutputText(error: unknown): string {
  if (
    !(error instanceof Error) ||
    !("stdout" in error) ||
    !("stderr" in error) ||
    !isString(error.stdout) ||
    !isString(error.stderr)
  ) {
    throw new Error("Expected a failed command with captured output");
  }
  return `${error.stdout}${error.stderr}`;
}

function assertNoAuthenticationLinks(output: string): void {
  assert.doesNotMatch(output, /fake-(?:login|publish)-secret|npmjs\.com\/(?:auth|login)/);
}

async function readOpenedUrls(fakeNpm: FakeNpm): Promise<string[]> {
  const content = await readFile(fakeNpm.openLogPath, "utf8");
  return content.split("\n").filter((line) => line.length > 0);
}

async function createFakeNpm(root: string): Promise<FakeNpm> {
  const binDir = join(root, "fake-bin");
  const authPath = join(root, "npm-authenticated");
  const logPath = join(root, "npm.log");
  const openLogPath = join(root, "open.log");
  const registryPath = join(root, "npm-registry.json");
  const terminalPreloadPath = join(root, "terminal.mjs");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(binDir, "npm"),
    [
      "#!/usr/bin/env node",
      'const { createHash } = require("node:crypto");',
      'const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");',
      'const { join } = require("node:path");',
      "const args = process.argv.slice(2);",
      "appendFileSync(process.env.FAKE_NPM_LOG, `${JSON.stringify({ args, cwd: process.cwd() })}\\n`);",
      "const authenticated = () => existsSync(process.env.FAKE_NPM_AUTH_FILE);",
      'const archive = () => readFileSync("package.json");',
      'const manifest = () => JSON.parse(readFileSync("package.json", "utf8"));',
      "const option = (name) => args[args.indexOf(name) + 1];",
      "const digest = (contents) => ({",
      '  integrity: `sha512-${createHash("sha512").update(contents).digest("base64")}`,',
      '  shasum: createHash("sha1").update(contents).digest("hex"),',
      "});",
      'if (args[0] === "config") { console.log("undefined"); process.exit(0); }',
      'if (args[0] === "view" && args[2] === "dist") {',
      "  if (!existsSync(process.env.FAKE_NPM_REGISTRY)) {",
      '    console.error("npm error code E404");',
      "    process.exit(1);",
      "  }",
      '  console.log(readFileSync(process.env.FAKE_NPM_REGISTRY, "utf8"));',
      "  process.exit(0);",
      "}",
      'if (args[0] === "view") {',
      '  if (process.env.FAKE_NPM_TAKEN === "true") {',
      "    console.log(JSON.stringify(args[1]));",
      "    process.exit(0);",
      "  }",
      '  console.error("npm error code E404");',
      "  process.exit(1);",
      "}",
      'if (args[0] === "whoami") {',
      "  if (authenticated()) {",
      '    console.log("test-user");',
      "    process.exit(0);",
      "  }",
      '  console.error("npm error code E401");',
      "  process.exit(1);",
      "}",
      'if (args[0] === "login") {',
      `  console.log(${JSON.stringify(`Login at:\r\n${FAKE_LOGIN_URL}\r\nPress ENTER to open in the browser...\r\n`)});`,
      '  if (process.env.FAKE_NPM_LOGIN === "fail") {',
      '    console.error("npm error code E401");',
      "    process.exit(1);",
      "  }",
      '  writeFileSync(process.env.FAKE_NPM_AUTH_FILE, "authenticated");',
      "  process.exit(0);",
      "}",
      'if (args[0] === "pack") {',
      "  const { name, version } = manifest();",
      "  const filename = `${name}-${version}.tgz`;",
      '  writeFileSync(join(option("--pack-destination"), filename), archive());',
      "  console.log(JSON.stringify([{ name, version, filename }]));",
      "  process.exit(0);",
      "}",
      'if (args[0] === "publish") {',
      "  if (!authenticated()) {",
      '    console.error("npm error code E401");',
      "    process.exit(1);",
      "  }",
      `  console.log(${JSON.stringify(`Authenticate your account at:\r\n${FAKE_PUBLISH_URL}\r\n`)});`,
      '  const mode = process.env.FAKE_NPM_PUBLISH ?? "success";',
      '  if (mode === "fail") {',
      '    console.error("npm error code E403");',
      `    console.error(${JSON.stringify(`\u001b[1G\u001b[0Knpm error 403 403 Forbidden - PUT https://registry.npmjs.org/rejected-package - Package name triggered spam detection\r\nnpm error Retry at ${FAKE_PUBLISH_URL}\r\nnpm error Log files were not written due to the config logs-max=0`)});`,
      "    process.exit(1);",
      "  }",
      '  const contents = mode === "other-bytes" ? Buffer.from("other bytes") : archive();',
      '  const tag = mode === "other-tag" ? "next" : option("--tag");',
      "  writeFileSync(",
      "    process.env.FAKE_NPM_REGISTRY,",
      '    JSON.stringify({ dist: digest(contents), "dist-tags": { [tag]: manifest().version } }),',
      "  );",
      '  process.exit(mode === "fail-after-publish" ? 1 : 0);',
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(binDir, "script"),
    [
      "#!/usr/bin/env node",
      'const { spawnSync } = require("node:child_process");',
      "const args = process.argv.slice(2);",
      'if (args[0] !== "-q" || args[1] !== "/dev/null") process.exit(2);',
      'const result = spawnSync(args[2], args.slice(3), { stdio: "inherit" });',
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(binDir, "open"),
    [
      "#!/usr/bin/env node",
      'const { appendFileSync } = require("node:fs");',
      "appendFileSync(process.env.FAKE_OPEN_LOG, `${process.argv[2]}\\n`);",
      "",
    ].join("\n"),
  );
  await Promise.all(["npm", "script", "open"].map((name) => chmod(join(binDir, name), 0o755)));
  await writeFile(
    terminalPreloadPath,
    [
      'Object.defineProperty(process, "platform", { value: "darwin" });',
      'Object.defineProperty(process.stdin, "isTTY", { value: true });',
      "",
    ].join("\n"),
  );
  return { authPath, binDir, logPath, openLogPath, registryPath, terminalPreloadPath };
}

async function createFakeGh(root: string): Promise<FakeGh> {
  const binDir = join(root, "fake-gh-bin");
  const logPath = join(root, "gh.log");
  const ghPath = join(binDir, "gh");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    ghPath,
    [
      "#!/usr/bin/env node",
      'const { appendFileSync, readFileSync } = require("node:fs");',
      "const args = process.argv.slice(2);",
      'const input = args.includes("--input") ? readFileSync(0, "utf8") : "";',
      "appendFileSync(",
      "  process.env.FAKE_GH_LOG,",
      "  `${JSON.stringify({ args, cwd: process.cwd(), input })}\\n`,",
      ");",
      'if (args[0] === "api" && args[1] === "user") console.log("test-user");',
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  await chmod(ghPath, 0o755);
  return { binDir, logPath };
}

async function createFakeMise(root: string): Promise<{ binDir: string; logPath: string }> {
  const binDir = join(root, "fake-mise-bin");
  const logPath = join(root, "mise.log");
  const misePath = join(binDir, "mise");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    misePath,
    [
      "#!/usr/bin/env node",
      'const { writeFileSync } = require("node:fs");',
      'const { spawnSync } = require("node:child_process");',
      "const args = process.argv.slice(2);",
      "writeFileSync(process.env.FAKE_MISE_LOG, JSON.stringify(args));",
      'if (args[0] !== "exec" || args[1] !== "--") process.exit(1);',
      'const result = spawnSync(args[2], args.slice(3), { env: process.env, stdio: "inherit" });',
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
  );
  await chmod(misePath, 0o755);
  return { binDir, logPath };
}

function npmTestEnv(
  root: string,
  fakeNpm: FakeNpm,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...gitIdentityEnv(root),
    PATH: `${fakeNpm.binDir}:${process.env["PATH"] ?? ""}`,
    FAKE_NPM_AUTH_FILE: fakeNpm.authPath,
    FAKE_NPM_LOG: fakeNpm.logPath,
    FAKE_NPM_REGISTRY: fakeNpm.registryPath,
    FAKE_OPEN_LOG: fakeNpm.openLogPath,
    ...overrides,
  };
}

async function readFakeNpmLog(logPath: string): Promise<FakeNpmLogEntry[]> {
  const content = await readFile(logPath, "utf8");
  return content
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (!isFakeNpmLogEntry(parsed)) {
        throw new Error("Invalid fake npm log entry");
      }
      return parsed;
    });
}

async function readFakeGhLog(logPath: string): Promise<FakeGhLogEntry[]> {
  const content = await readFile(logPath, "utf8");
  return content
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (!isFakeGhLogEntry(parsed)) {
        throw new Error("Invalid fake GitHub log entry");
      }
      return parsed;
    });
}

function parseFakeGhInput(entry: FakeGhLogEntry | undefined): ConfigObject {
  if (entry === undefined) {
    throw new Error("Missing fake GitHub operation");
  }
  return parseConfigObject(entry.input, "fake GitHub input");
}

function isFakeNpmLogEntry(value: unknown): value is FakeNpmLogEntry {
  return (
    isConfigObject(value) &&
    Array.isArray(value["args"]) &&
    value["args"].every(isString) &&
    isString(value["cwd"])
  );
}

function isFakeGhLogEntry(value: unknown): value is FakeGhLogEntry {
  return (
    isConfigObject(value) &&
    Array.isArray(value["args"]) &&
    value["args"].every(isString) &&
    isString(value["cwd"]) &&
    isString(value["input"])
  );
}
