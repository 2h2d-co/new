import assert from "node:assert/strict";
import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { isConfigObject, isString } from "../src/core.ts";

// Publishes a real, public throwaway package named @2h2d/new-live-test-<YYYYMMDDHHMM> through the
// packaged CLI. npm's spam detection rejects such unscoped names. Run it with `npm run test:live` from a macOS terminal session. npm opens its
// browser approval prompts; deprecate the package afterward.

const execFile = promisify(execFileCallback);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const enabled = process.env["NEW_LIVE_TEST"] === "1";
const version = "0.0.1-alpha.0";

test(
  "the packaged CLI publishes an initial package without printing authentication links",
  {
    skip: enabled ? false : "set NEW_LIVE_TEST=1 to publish a throwaway npm package",
    timeout: 900_000,
  },
  async () => {
    assert.equal(process.platform, "darwin", "The live test requires macOS.");
    const root = await mkdtemp(join(tmpdir(), "new-live-test-"));
    const projectName = `new-live-test-${timestamp(new Date())}`;
    const packageName = `@2h2d/${projectName}`;
    console.log(`Live test package: ${packageName}@${version}`);

    try {
      const cli = await installCandidate(root);
      const templateSource = join(root, "templates");
      await createLiveTemplate(templateSource);
      const workDir = join(root, "work");
      await mkdir(workDir);
      const gitConfig = join(root, "gitconfig");
      await writeFile(
        gitConfig,
        "[user]\n\tname = new live test\n\temail = live-test@example.com\n[commit]\n\tgpgsign = false\n",
      );

      // The outer script gives new the terminal that initial publication requires.
      const result = spawnSync(
        "script",
        [
          "-q",
          "/dev/null",
          process.execPath,
          cli,
          "live-package",
          projectName,
          "--template-source",
          templateSource,
          "--yes",
          "--no-github",
        ],
        {
          cwd: workDir,
          encoding: "utf8",
          env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" },
          maxBuffer: 16 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 840_000,
        },
      );
      const output = `${result.stdout}${result.stderr}`;
      console.log(output.replaceAll(/https?:\/\/\S+/g, "<redacted URL>"));

      assert.doesNotMatch(output, /npmjs\.com\/(?:auth|login)/, "new printed an npm link.");
      assert.equal(result.status, 0, "new did not complete.");
      assert.ok(
        output.includes(
          `Published ${packageName}@${version}: registry bytes and the alpha tag match.`,
        ),
      );

      // Check the registry independently against a fresh pack of the generated project.
      const packed = await jsonOutput(
        ["pack", "--dry-run", "--json", "--allow-directory=all", "--ignore-scripts"],
        join(workDir, projectName),
      );
      const local: unknown = Array.isArray(packed) ? packed[0] : undefined;
      const published = await jsonOutput(
        ["view", `${packageName}@${version}`, "dist", "dist-tags", "--json"],
        workDir,
      );
      assert.ok(isConfigObject(local) && isConfigObject(published));
      const dist = published["dist"];
      const tags = published["dist-tags"];
      assert.ok(isConfigObject(dist) && isConfigObject(tags));
      assert.equal(dist["integrity"], local["integrity"]);
      assert.equal(dist["shasum"], local["shasum"]);
      assert.equal(tags["alpha"], version);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

// Installs NEW_PACKAGE_ARCHIVE, or a pack of this checkout, the way npm installs a published
// package, and returns its executable.
async function installCandidate(root: string): Promise<string> {
  let archive = process.env["NEW_PACKAGE_ARCHIVE"];
  if (archive === undefined) {
    await execFile("npm", ["run", "build"], { cwd: projectRoot });
    const packDir = join(root, "pack");
    await mkdir(packDir);
    await execFile(
      "npm",
      ["pack", "--pack-destination", packDir, "--allow-directory=all", "--ignore-scripts"],
      { cwd: projectRoot },
    );
    const [filename] = await readdir(packDir);
    assert.ok(isString(filename));
    archive = join(packDir, filename);
  }
  assert.ok(isAbsolute(archive), "NEW_PACKAGE_ARCHIVE must be an absolute path.");

  await execFile("tar", ["-xzf", archive, "-C", root]);
  const packageDir = join(root, "package");
  await execFile(
    "npm",
    ["install", "--omit=dev", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund"],
    { cwd: packageDir },
  );
  return join(packageDir, "bin", "new.js");
}

async function createLiveTemplate(templateSource: string): Promise<void> {
  const templateDir = join(templateSource, "live-package");
  await mkdir(join(templateDir, "files"), { recursive: true });
  await writeFile(join(templateSource, "new.toml"), 'name = "new live test templates"\n');
  await writeFile(
    join(templateDir, "template.toml"),
    [
      'name = "Live test package"',
      "",
      "[npm]",
      'package_name = "@2h2d/{{ projectName }}"',
      `version = "${version}"`,
      'tag = "alpha"',
      'access = "public"',
      "",
    ].join("\n"),
  );
  await writeFile(
    join(templateDir, "files", "package.json.eta"),
    [
      "{",
      '  "name": <%= it.json(`@2h2d/${it.projectName}`) %>,',
      `  "version": "${version}",`,
      '  "description": "Throwaway live test package for @2h2d/new. Do not use.",',
      '  "license": "MIT",',
      '  "files": ["README.md"]',
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(templateDir, "files", "README.md.eta"),
    "# @2h2d/<%= it.projectName %>\n\nThrowaway live test package for @2h2d/new. Do not use.\n",
  );
}

async function jsonOutput(args: string[], cwd: string): Promise<unknown> {
  const { stdout } = await execFile("npm", args, { cwd, encoding: "utf8" });
  const parsed: unknown = JSON.parse(stdout);
  return parsed;
}

function timestamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}`;
}
