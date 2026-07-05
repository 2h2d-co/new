import { confirm, input, select } from "@inquirer/prompts";
import { Eta } from "eta";
import { copyFile, mkdir, readdir, readFile, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import {
  choiceName,
  choiceValue,
  coerceVariableValue,
  interpolateMustache,
  isRecord,
  parseCliArgs,
  parseGithubVisibility,
  type GithubVisibility,
  type TemplateCommand,
  type TemplateConfig,
  type TemplateVariable,
  type TemplateVariableChoice,
  type UserConfig,
} from "./core.ts";

const execFile = promisify(execFileCallback);
const TEMPLATE_SOURCE_ENV = "NEW_CLI_TEMPLATE_SOURCE";

type TemplateSource = {
  path: string;
  source: string;
  remote: boolean;
};

type TemplateSummary = {
  id: string;
  name: string;
  description?: string;
};

type SystemInfo = {
  git: Record<string, string>;
  github: Record<string, string>;
  npm: Record<string, string>;
  config: UserConfig;
  defaults: Record<string, unknown>;
};

type GithubCreateOptions = {
  owner: string;
  repo: string;
  visibility: GithubVisibility;
  description?: string;
};

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.help) {
    printHelp();
    return;
  }
  if (cli.version) {
    printVersion();
    return;
  }
  if (cli.positional.length > 2) {
    throw new Error(`Expected at most template and project name, got: ${cli.positional.join(" ")}`);
  }

  const userConfig = await loadUserConfig();
  const system = await collectSystemInfo(userConfig);
  const templateSource = await resolveTemplateSource(cli.templateSource, userConfig);
  const templates = await listTemplates(templateSource.path);
  if (templates.length === 0) {
    throw new Error(`No templates found in ${templateSource.path}`);
  }

  const templateId = await resolveTemplateId(cli.positional[0], templates, cli.yes);
  const templateDir = join(templateSource.path, templateId);
  const template = await loadTemplateConfig(templateDir);
  const projectName = await resolveProjectName(cli.positional[1], cli.yes);
  validateProjectName(projectName);

  const variableFlags = { ...cli.variableFlags };
  const variableNames = new Set((template.variables ?? []).map((variable) => variable.name));
  if (cli.githubOwner !== undefined && variableNames.has("githubOwner")) {
    variableFlags.githubOwner = cli.githubOwner;
  }
  if (cli.githubRepo !== undefined && variableNames.has("repoName")) {
    variableFlags.repoName = cli.githubRepo;
  }
  rejectUnknownVariableFlags(variableFlags, variableNames);

  const variables = await collectTemplateVariables(
    template,
    projectName,
    system,
    variableFlags,
    cli.yes,
  );
  const renderData = createRenderData(variables, system);
  const targetDir = resolve(process.cwd(), projectName);
  if (await pathExists(targetDir)) {
    throw new Error(`Target directory already exists: ${targetDir}`);
  }

  if (templateSource.remote && (template.commands?.length ?? 0) > 0) {
    await confirmRemoteCommands(templateSource.source, template.commands ?? [], cli.yes);
  }

  await renderTemplate(join(templateDir, "files"), targetDir, renderData);
  await runTemplateCommands(template.commands ?? [], targetDir, renderData);
  await initializeGitRepository(targetDir);

  const githubOptions = await resolveGithubOptions(
    cli.github,
    cli.yes,
    cli.githubOwner,
    cli.githubRepo,
    cli.githubVisibility,
    variables,
    system,
  );
  if (githubOptions) {
    await createGithubRepository(targetDir, githubOptions);
  }

  console.log(`\nCreated ${projectName}`);
}

async function loadUserConfig(): Promise<UserConfig> {
  const configPath = join(configHome(), "new", "config.toml");
  if (!(await pathExists(configPath))) {
    return {};
  }

  const raw = parseToml(await readFile(configPath, "utf8"));
  if (!isRecord(raw)) {
    throw new Error(`Invalid config file: ${configPath}`);
  }

  const config: UserConfig = {};
  if (typeof raw.template_source === "string") {
    config.template_source = raw.template_source;
  }
  if (isRecord(raw.defaults)) {
    config.defaults = { ...raw.defaults };
  }
  if (isRecord(raw.github)) {
    const github: NonNullable<UserConfig["github"]> = {};
    if (typeof raw.github.owner === "string") {
      github.owner = raw.github.owner;
    }
    if (typeof raw.github.visibility === "string") {
      github.visibility = parseGithubVisibility(raw.github.visibility);
    }
    config.github = github;
  }

  return config;
}

async function collectSystemInfo(config: UserConfig): Promise<SystemInfo> {
  const git: Record<string, string> = {};
  const github: Record<string, string> = {};
  const npm: Record<string, string> = {};

  assignIfPresent(git, "name", await commandOutput("git", ["config", "user.name"]));
  assignIfPresent(git, "email", await commandOutput("git", ["config", "user.email"]));
  assignIfPresent(
    npm,
    "authorName",
    await commandOutput("npm", ["config", "get", "init-author-name"]),
  );
  assignIfPresent(
    npm,
    "authorEmail",
    await commandOutput("npm", ["config", "get", "init-author-email"]),
  );
  assignIfPresent(
    npm,
    "authorUrl",
    await commandOutput("npm", ["config", "get", "init-author-url"]),
  );
  assignIfPresent(github, "login", await commandOutput("gh", ["api", "user", "--jq", ".login"]));
  assignIfPresent(
    github,
    "name",
    await commandOutput("gh", ["api", "user", "--jq", ".name // empty"]),
  );
  assignIfPresent(
    github,
    "email",
    await commandOutput("gh", ["api", "user", "--jq", ".email // empty"]),
  );

  const defaults: Record<string, unknown> = { ...config.defaults };
  const authorName = firstString(
    defaults.authorName,
    npm.authorName,
    git.name,
    github.name,
    github.login,
  );
  const authorEmail = firstString(defaults.authorEmail, npm.authorEmail, git.email, github.email);
  const authorUrl = firstString(defaults.authorUrl, npm.authorUrl);
  const githubOwner = firstString(config.github?.owner, defaults.githubOwner, github.login);
  const licensor = firstString(defaults.licensor, authorName, githubOwner);

  assignDefault(defaults, "authorName", authorName);
  assignDefault(defaults, "authorEmail", authorEmail);
  assignDefault(defaults, "authorUrl", authorUrl);
  assignDefault(defaults, "githubOwner", githubOwner);
  assignDefault(defaults, "licensor", licensor);

  return { git, github, npm, config, defaults };
}

async function resolveTemplateSource(
  sourceOption: string | undefined,
  config: UserConfig,
): Promise<TemplateSource> {
  const explicit = sourceOption ?? process.env[TEMPLATE_SOURCE_ENV];
  if (explicit !== undefined && explicit.length > 0) {
    return resolveTemplateSourceValue(explicit);
  }

  const localTemplates = resolve(process.cwd(), "templates");
  if (await directoryExists(localTemplates)) {
    await ensureTemplateSourceMarker(localTemplates);
    return { path: localTemplates, source: localTemplates, remote: false };
  }

  if (config.template_source !== undefined && config.template_source.length > 0) {
    return resolveTemplateSourceValue(config.template_source);
  }

  throw new Error(
    `No template source found. Create ./templates, set ${TEMPLATE_SOURCE_ENV}, pass --template-source, or configure template_source in ${join(configHome(), "new", "config.toml")}.`,
  );
}

async function resolveTemplateSourceValue(source: string): Promise<TemplateSource> {
  const localPath = resolve(process.cwd(), source);
  if (await directoryExists(localPath)) {
    await ensureTemplateSourceMarker(localPath);
    return { path: localPath, source: localPath, remote: false };
  }

  if (!isGithubSlug(source)) {
    throw new Error(
      `Template source does not exist and is not a GitHub owner/repo source: ${source}`,
    );
  }

  const cachePath = await ensureRemoteTemplateCache(source);
  await ensureTemplateSourceMarker(cachePath);
  return { path: cachePath, source, remote: true };
}

async function ensureRemoteTemplateCache(source: string): Promise<string> {
  const [owner, repo] = source.split("/");
  if (owner === undefined || repo === undefined) {
    throw new Error(`Invalid GitHub template source: ${source}`);
  }

  const cachePath = join(cacheHome(), "new", "templates", `${owner}__${repo}`);
  if (await directoryExists(join(cachePath, ".git"))) {
    console.log(`Updating cached templates from ${source}`);
    await runProcess("git", ["pull", "--ff-only"], cachePath);
    return cachePath;
  }

  await mkdir(dirname(cachePath), { recursive: true });
  console.log(`Cloning templates from ${source}`);
  await runProcess("gh", ["repo", "clone", source, cachePath, "--", "--depth=1"], process.cwd());
  return cachePath;
}

async function ensureTemplateSourceMarker(sourcePath: string): Promise<void> {
  if (
    (await pathExists(join(sourcePath, "new.toml"))) ||
    (await pathExists(join(sourcePath, "new-cli.toml")))
  ) {
    return;
  }
  throw new Error(`Template source is missing new.toml or new-cli.toml: ${sourcePath}`);
}

async function listTemplates(sourcePath: string): Promise<TemplateSummary[]> {
  const entries = await readdir(sourcePath, { withFileTypes: true });
  const templates: TemplateSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const templateDir = join(sourcePath, entry.name);
    if (!(await templateConfigPath(templateDir))) {
      continue;
    }
    const config = await loadTemplateConfig(templateDir);
    const summary: TemplateSummary = {
      id: entry.name,
      name: config.name ?? entry.name,
    };
    if (config.description !== undefined) {
      summary.description = config.description;
    }
    templates.push(summary);
  }
  return templates.sort((left, right) => left.id.localeCompare(right.id));
}

async function loadTemplateConfig(templateDir: string): Promise<TemplateConfig> {
  const configPath = await templateConfigPath(templateDir);
  if (configPath === undefined) {
    throw new Error(`Template is missing template.toml or template.json: ${templateDir}`);
  }

  const raw = configPath.endsWith(".json")
    ? JSON.parse(await readFile(configPath, "utf8"))
    : parseToml(await readFile(configPath, "utf8"));
  if (!isRecord(raw)) {
    throw new Error(`Invalid template config: ${configPath}`);
  }
  const filesPath = join(templateDir, "files");
  if (!(await directoryExists(filesPath))) {
    throw new Error(`Template is missing files directory: ${templateDir}`);
  }
  return normalizeTemplateConfig(raw, configPath);
}

async function templateConfigPath(templateDir: string): Promise<string | undefined> {
  const tomlPath = join(templateDir, "template.toml");
  if (await pathExists(tomlPath)) {
    return tomlPath;
  }
  const jsonPath = join(templateDir, "template.json");
  if (await pathExists(jsonPath)) {
    return jsonPath;
  }
  return undefined;
}

function normalizeTemplateConfig(raw: Record<string, unknown>, configPath: string): TemplateConfig {
  const config: TemplateConfig = {};
  if (typeof raw.name === "string") {
    config.name = raw.name;
  }
  if (typeof raw.description === "string") {
    config.description = raw.description;
  }
  if (raw.variables !== undefined) {
    if (!Array.isArray(raw.variables)) {
      throw new Error(`Template variables must be an array in ${configPath}`);
    }
    config.variables = raw.variables.map((entry, index) =>
      normalizeTemplateVariable(entry, index, configPath),
    );
  }
  if (raw.commands !== undefined) {
    if (!Array.isArray(raw.commands)) {
      throw new Error(`Template commands must be an array in ${configPath}`);
    }
    config.commands = raw.commands.map((entry, index) =>
      normalizeTemplateCommand(entry, index, configPath),
    );
  }
  return config;
}

function normalizeTemplateVariable(
  entry: unknown,
  index: number,
  configPath: string,
): TemplateVariable {
  if (!isRecord(entry) || typeof entry.name !== "string") {
    throw new Error(`Template variable at index ${index} in ${configPath} must have a string name`);
  }
  const variable: TemplateVariable = { name: entry.name };
  if (entry.type !== undefined) {
    if (!["string", "boolean", "select", "number", "path"].includes(String(entry.type))) {
      throw new Error(
        `Unsupported variable type for ${entry.name} in ${configPath}: ${String(entry.type)}`,
      );
    }
    variable.type = entry.type as NonNullable<TemplateVariable["type"]>;
  }
  if (typeof entry.prompt === "string") {
    variable.prompt = entry.prompt;
  }
  if (Object.hasOwn(entry, "default")) {
    variable.default = entry.default;
  }
  if (typeof entry.required === "boolean") {
    variable.required = entry.required;
  }
  if (entry.choices !== undefined) {
    if (!Array.isArray(entry.choices)) {
      throw new Error(`Variable ${entry.name} choices must be an array in ${configPath}`);
    }
    variable.choices = entry.choices.map((choice, choiceIndex) =>
      normalizeChoice(choice, variable.name, choiceIndex, configPath),
    );
  }
  return variable;
}

function normalizeChoice(
  choice: unknown,
  variableName: string,
  index: number,
  configPath: string,
): TemplateVariableChoice {
  if (typeof choice === "string") {
    return choice;
  }
  if (isRecord(choice) && typeof choice.value === "string") {
    const normalized: { name?: string; value: string } = { value: choice.value };
    if (typeof choice.name === "string") {
      normalized.name = choice.name;
    }
    return normalized;
  }
  throw new Error(
    `Choice ${index} for variable ${variableName} in ${configPath} must be a string or { value, name }`,
  );
}

function normalizeTemplateCommand(
  entry: unknown,
  index: number,
  configPath: string,
): TemplateCommand {
  if (!isRecord(entry) || typeof entry.run !== "string") {
    throw new Error(
      `Template command at index ${index} in ${configPath} must have a string run value`,
    );
  }
  const command: TemplateCommand = { run: entry.run };
  if (typeof entry.name === "string") {
    command.name = entry.name;
  }
  return command;
}

async function resolveTemplateId(
  templateId: string | undefined,
  templates: TemplateSummary[],
  yes: boolean,
): Promise<string> {
  if (templateId !== undefined) {
    if (templates.some((template) => template.id === templateId)) {
      return templateId;
    }
    throw new Error(
      `Unknown template ${templateId}. Available templates: ${templates.map((template) => template.id).join(", ")}`,
    );
  }

  if (yes) {
    throw new Error("Template id is required when --yes is used");
  }

  return select({
    message: "Template",
    choices: templates.map((template) => ({
      name: template.description ? `${template.id} - ${template.description}` : template.id,
      value: template.id,
    })),
  });
}

async function resolveProjectName(projectName: string | undefined, yes: boolean): Promise<string> {
  if (projectName !== undefined) {
    return projectName;
  }
  if (yes) {
    throw new Error("Project name is required when --yes is used");
  }
  return input({
    message: "Project name",
    validate: (value) => (value.length > 0 ? true : "Project name is required"),
  });
}

function validateProjectName(projectName: string): void {
  if (projectName.length === 0) {
    throw new Error("Project name is required");
  }
  if (
    projectName === "." ||
    projectName === ".." ||
    projectName.includes("/") ||
    projectName.includes("\\")
  ) {
    throw new Error("Project name must be a single directory name under the current directory");
  }
}

function rejectUnknownVariableFlags(
  variableFlags: Record<string, string | boolean>,
  variableNames: Set<string>,
): void {
  const unknown = Object.keys(variableFlags).filter((name) => !variableNames.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown template variable flag(s): ${unknown.map((name) => `--${name}`).join(", ")}`,
    );
  }
}

async function collectTemplateVariables(
  template: TemplateConfig,
  projectName: string,
  system: SystemInfo,
  variableFlags: Record<string, string | boolean>,
  yes: boolean,
): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {
    projectName,
    repoName: projectName,
  };

  for (const variable of template.variables ?? []) {
    if (variable.name === "projectName") {
      values.projectName = projectName;
      continue;
    }

    const context = createRenderData(values, system);
    const flagValue = variableFlags[variable.name];
    if (flagValue !== undefined) {
      values[variable.name] = coerceVariableValue(variable, flagValue);
      continue;
    }

    const defaultValue = resolveVariableDefault(variable, context, system);
    if (yes) {
      if (variable.required === true && isMissing(defaultValue)) {
        throw new Error(`Variable ${variable.name} is required and has no default`);
      }
      if (defaultValue !== undefined) {
        values[variable.name] = coerceVariableValue(variable, defaultValue);
      }
      continue;
    }

    values[variable.name] = await promptForVariable(variable, defaultValue);
  }

  return values;
}

function resolveVariableDefault(
  variable: TemplateVariable,
  context: Record<string, unknown>,
  system: SystemInfo,
): unknown {
  if (Object.hasOwn(variable, "default")) {
    return typeof variable.default === "string"
      ? interpolateMustache(variable.default, context)
      : variable.default;
  }
  const configuredDefault = system.defaults[variable.name];
  if (typeof configuredDefault === "string") {
    return interpolateMustache(configuredDefault, context);
  }
  return configuredDefault;
}

async function promptForVariable(
  variable: TemplateVariable,
  defaultValue: unknown,
): Promise<string | boolean | number> {
  const type = variable.type ?? "string";
  const message = variable.prompt ?? variable.name;
  if (type === "boolean") {
    const answer = await confirm({ message, default: Boolean(defaultValue) });
    return coerceVariableValue(variable, answer);
  }
  if (type === "select") {
    const choices = variable.choices ?? [];
    if (choices.length === 0) {
      throw new Error(`Variable ${variable.name} is a select variable without choices`);
    }
    const choice = await select({
      message,
      choices: choices.map((item) => ({ name: choiceName(item), value: choiceValue(item) })),
      default: typeof defaultValue === "string" ? defaultValue : undefined,
    });
    return coerceVariableValue(variable, choice);
  }

  const answer = await input({
    message,
    default: defaultValue === undefined ? undefined : String(defaultValue),
    validate: (value) =>
      variable.required !== true || value.length > 0 ? true : `${variable.name} is required`,
  });
  return coerceVariableValue(variable, answer);
}

function createRenderData(
  values: Record<string, unknown>,
  system: SystemInfo,
): Record<string, unknown> {
  return {
    ...values,
    system,
    json: (value: unknown) => JSON.stringify(value),
  };
}

async function confirmRemoteCommands(
  source: string,
  commands: TemplateCommand[],
  yes: boolean,
): Promise<void> {
  console.warn(
    `Remote template source ${source} defines shell commands that will run in the generated project:`,
  );
  for (const command of commands) {
    console.warn(`  - ${command.name ?? command.run}: ${command.run}`);
  }
  if (yes) {
    return;
  }
  const ok = await confirm({ message: "Run these commands after rendering?", default: true });
  if (!ok) {
    throw new Error("Aborted before running remote template commands");
  }
}

async function renderTemplate(
  templateFilesDir: string,
  targetDir: string,
  data: Record<string, unknown>,
): Promise<void> {
  await mkdir(targetDir);
  const eta = new Eta({ autoEscape: false });
  await renderDirectory(templateFilesDir, templateFilesDir, targetDir, data, eta);
}

async function renderDirectory(
  rootDir: string,
  currentDir: string,
  targetDir: string,
  data: Record<string, unknown>,
  eta: Eta,
): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(currentDir, entry.name);
    const relativePath = relative(rootDir, sourcePath);
    const renderedRelative = interpolatePath(relativePath, data);
    const destinationPath = safeDestination(targetDir, renderedRelative);

    if (entry.isDirectory()) {
      await mkdir(destinationPath, { recursive: true });
      await renderDirectory(rootDir, sourcePath, targetDir, data, eta);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    await mkdir(dirname(destinationPath), { recursive: true });
    const mode = (await stat(sourcePath)).mode & 0o777;
    if (sourcePath.endsWith(".eta")) {
      const outputPath = destinationPath.slice(0, -4);
      const rendered = eta.renderString(await readFile(sourcePath, "utf8"), data);
      await writeFile(outputPath, rendered);
      await chmod(outputPath, mode);
    } else {
      await copyFile(sourcePath, destinationPath);
      await chmod(destinationPath, mode);
    }
  }
}

function interpolatePath(relativePath: string, data: Record<string, unknown>): string {
  return relativePath
    .split("/")
    .map((part) => interpolateMustache(part, data))
    .join("/");
}

function safeDestination(targetDir: string, renderedRelative: string): string {
  const destinationPath = resolve(targetDir, renderedRelative);
  const root = resolve(targetDir);
  if (destinationPath !== root && !destinationPath.startsWith(`${root}/`)) {
    throw new Error(`Template path escapes target directory: ${renderedRelative}`);
  }
  return destinationPath;
}

async function runTemplateCommands(
  commands: TemplateCommand[],
  targetDir: string,
  data: Record<string, unknown>,
): Promise<void> {
  for (const command of commands) {
    const run = interpolateMustache(command.run, data);
    if (run.trim().length === 0) {
      throw new Error("Template command rendered to an empty command");
    }
    console.log(`\n> ${command.name ?? run}`);
    console.log(`$ ${run}`);
    await runShell(run, targetDir);
  }
}

async function initializeGitRepository(targetDir: string): Promise<void> {
  console.log("\n> Initialize git repository");
  await runProcess("git", ["init", "-b", "main"], targetDir);
  await runProcess("git", ["add", "."], targetDir);
  await runProcess("git", ["commit", "-m", "Initial commit"], targetDir);
}

async function resolveGithubOptions(
  githubEnabled: boolean,
  yes: boolean,
  ownerOption: string | undefined,
  repoOption: string | undefined,
  visibilityOption: GithubVisibility | undefined,
  variables: Record<string, unknown>,
  system: SystemInfo,
): Promise<GithubCreateOptions | undefined> {
  if (!githubEnabled) {
    return undefined;
  }

  const defaultOwner = firstString(
    ownerOption,
    stringValue(variables.githubOwner),
    system.config.github?.owner,
    system.defaults.githubOwner,
    system.github.login,
  );
  const defaultRepo = firstString(
    repoOption,
    stringValue(variables.repoName),
    stringValue(variables.projectName),
  );
  const defaultVisibility = visibilityOption ?? system.config.github?.visibility ?? "public";
  const description = stringValue(variables.description);

  if (yes) {
    if (defaultOwner === undefined) {
      throw new Error("GitHub owner is required when GitHub creation is enabled with --yes");
    }
    if (defaultRepo === undefined) {
      throw new Error("GitHub repo name is required when GitHub creation is enabled with --yes");
    }
    return withOptionalDescription(
      { owner: defaultOwner, repo: defaultRepo, visibility: defaultVisibility },
      description,
    );
  }

  const create = await confirm({ message: "Create GitHub repository?", default: true });
  if (!create) {
    return undefined;
  }

  const owner = await input({
    message: "GitHub owner",
    default: defaultOwner,
    validate: (value) => (value.length > 0 ? true : "GitHub owner is required"),
  });
  const repo = await input({
    message: "GitHub repo",
    default: defaultRepo,
    validate: (value) => (value.length > 0 ? true : "GitHub repo is required"),
  });
  const visibility = await select<GithubVisibility>({
    message: "GitHub visibility",
    choices: [
      { name: "public", value: "public" },
      { name: "private", value: "private" },
    ],
    default: defaultVisibility,
  });

  return withOptionalDescription({ owner, repo, visibility }, description);
}

async function createGithubRepository(
  targetDir: string,
  options: GithubCreateOptions,
): Promise<void> {
  console.log("\n> Create GitHub repository");
  await ensureGhAuthenticated();
  const args = [
    "repo",
    "create",
    `${options.owner}/${options.repo}`,
    `--${options.visibility}`,
    "--source",
    ".",
    "--remote",
    "origin",
    "--push",
  ];
  if (options.description !== undefined && options.description.length > 0) {
    args.push("--description", options.description);
  }
  await runProcess("gh", args, targetDir);
}

async function ensureGhAuthenticated(): Promise<void> {
  try {
    await execFile("gh", ["auth", "status"]);
  } catch {
    throw new Error(
      "GitHub creation is enabled, but gh is not installed or not authenticated. Run gh auth login or pass --no-github.",
    );
  }
}

async function runShell(command: string, cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd,
      env: process.env,
      shell: true,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          signal
            ? `Command was terminated by ${signal}: ${command}`
            : `Command failed with exit code ${code}: ${command}`,
        ),
      );
    });
  });
}

async function runProcess(command: string, args: string[], cwd: string): Promise<void> {
  console.log(`$ ${[command, ...args].join(" ")}`);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          signal
            ? `${command} was terminated by ${signal}`
            : `${command} failed with exit code ${code}`,
        ),
      );
    });
  });
}

async function commandOutput(command: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await execFile(command, args, { encoding: "utf8" });
    const output = result.stdout.trim();
    if (output.length === 0 || output === "undefined" || output === "null") {
      return undefined;
    }
    return output;
  } catch {
    return undefined;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function configHome(): string {
  return process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? tmpdir(), ".config");
}

function cacheHome(): string {
  return process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? tmpdir(), ".cache");
}

function isGithubSlug(source: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source);
}

function assignIfPresent(
  target: Record<string, string>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined && value.length > 0) {
    target[key] = value;
  }
}

function assignDefault(
  target: Record<string, unknown>,
  key: string,
  value: string | undefined,
): void {
  if (target[key] === undefined && value !== undefined && value.length > 0) {
    target[key] = value;
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.length === 0);
}

function withOptionalDescription(
  options: Omit<GithubCreateOptions, "description">,
  description: string | undefined,
): GithubCreateOptions {
  if (description === undefined) {
    return options;
  }
  return { ...options, description };
}

function printHelp(): void {
  console.log(`Usage: new [template] [project-name] [options]

Options:
  --template-source <source>   Local template collection or GitHub owner/repo
  --yes                        Use defaults and do not prompt
  --no-github                  Skip GitHub repository creation
  --github-owner <owner>       GitHub owner for repository creation
  --github-repo <name>         GitHub repository name
  --github-visibility <v>      public or private
  --github-public              Shorthand for --github-visibility public
  --github-private             Shorthand for --github-visibility private
  --help                       Show this help
  --version                    Show version

Template variables can be passed as kebab-case flags, for example:
  new ts-cli demo --description "Demo CLI" --author-name "Kaan"
`);
}

function printVersion(): void {
  const require = createRequire(import.meta.url);
  const packageJson = require("../package.json") as { version?: string };
  console.log(packageJson.version ?? "0.0.0");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`new: ${message}`);
  process.exitCode = 1;
});
