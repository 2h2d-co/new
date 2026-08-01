import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

void test("template commands run inside the initialized Git repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "new-cli-test-"));
  const templateSource = join(root, "templates");
  const templateDir = join(templateSource, "git-aware");
  const targetDir = join(root, "generated-project");

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
          ...process.env,
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_AUTHOR_NAME: "Test Author",
          GIT_COMMITTER_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test Author",
          XDG_CONFIG_HOME: join(root, "config"),
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
