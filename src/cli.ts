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
  formatTemplateHelp,
  formatTemplateList,
  interpolateMustache,
  isBoolean,
  isConfigObject,
  isString,
  parseConfigObject,
  parseCliArgs,
  parseGithubVisibility,
  type ConfigObject,
  type ConfigValue,
  type GithubVisibility,
  type RenderData,
  type RenderValue,
  type StringValues,
  type TemplateCommand,
  type TemplateConfig,
  type TemplateGithubConfig,
  type TemplateNpmConfig,
  type TemplateVariable,
  type TemplateVariableChoice,
  type TemplateVariableChoiceDetails,
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
  git: StringValues;
  github: StringValues;
  npm: StringValues;
  config: UserConfig;
  defaults: ConfigObject;
};

type GithubCreateOptions = {
  owner: string;
  repo: string;
  visibility: GithubVisibility;
  description?: string;
};

type NpmPackagePlan = TemplateNpmConfig & {
  publish: boolean;
};

type TemplateVariableType = NonNullable<TemplateVariable["type"]>;

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.version) {
    printVersion();
    return;
  }
  if (cli.help && cli.positional[0] === undefined) {
    printHelp();
    return;
  }

  const userConfig = await loadUserConfig();
  if (cli.help) {
    const templateSource = await resolveTemplateSource(cli.templateSource, userConfig);
    const templates = await listTemplates(templateSource.path);
    if (templates.length === 0) {
      throw new Error(`No templates found in ${templateSource.path}`);
    }
    const templateId = await resolveTemplateId(cli.positional[0], templates, cli.yes);
    const template = await loadTemplateConfig(join(templateSource.path, templateId));
    console.log(formatTemplateHelp(templateId, template));
    return;
  }

  if (cli.list) {
    if (cli.positional.length > 0) {
      throw new Error("--list cannot be combined with a template or project name");
    }
    const templateSource = await resolveTemplateSource(cli.templateSource, userConfig);
    const templates = await listTemplates(templateSource.path);
    if (templates.length === 0) {
      throw new Error(`No templates found in ${templateSource.path}`);
    }
    console.log(`Templates in ${templateSource.source}:`);
    console.log(formatTemplateList(templates));
    return;
  }

  if (cli.positional.length > 2) {
    throw new Error(`Expected at most template and project name, got: ${cli.positional.join(" ")}`);
  }

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
    variableFlags["githubOwner"] = cli.githubOwner;
  }
  if (cli.githubRepo !== undefined && variableNames.has("repoName")) {
    variableFlags["repoName"] = cli.githubRepo;
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

  const npmPackage = resolveNpmPackagePlan(template.npm, renderData, cli.npmPublish);
  if (npmPackage !== undefined) {
    await ensureNpmPackageAvailable(npmPackage.packageName);
    if (npmPackage.publish) {
      await ensureNpmAuthenticated(process.cwd());
    }
  }

  if (templateSource.remote && (template.commands?.length ?? 0) > 0) {
    await confirmRemoteCommands(templateSource.source, template.commands ?? [], cli.yes);
  }

  await renderTemplate(join(templateDir, "files"), targetDir, renderData);
  await initializeGitRepository(targetDir);
  await runTemplateCommands(template.commands ?? [], targetDir, renderData);
  if (npmPackage?.publish === true) {
    await verifyRenderedPackageIdentity(targetDir, npmPackage);
  }
  await createInitialGitCommit(targetDir);

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
    if (template.github !== undefined) {
      await configureGithubReleaseControls(targetDir, githubOptions, template.github, renderData);
    }
  }
  if (npmPackage?.publish === true) {
    await publishInitialNpmPackage(targetDir, npmPackage);
  }

  console.log(`\nCreated ${projectName}`);
}

async function loadUserConfig(): Promise<UserConfig> {
  const configPath = join(configHome(), "new", "config.toml");
  if (!(await pathExists(configPath))) {
    return {};
  }

  const raw = parseToml(await readFile(configPath, "utf8"));

  const config: UserConfig = {};
  if (isString(raw["template_source"])) {
    config.template_source = raw["template_source"];
  }
  if (isConfigObject(raw["defaults"])) {
    const defaults: ConfigObject = {};
    Object.assign(defaults, raw["defaults"]);
    config.defaults = defaults;
  }
  if (isConfigObject(raw["github"])) {
    const github: NonNullable<UserConfig["github"]> = {};
    if (isString(raw["github"]["owner"])) {
      github.owner = raw["github"]["owner"];
    }
    if (isString(raw["github"]["visibility"])) {
      github.visibility = parseGithubVisibility(raw["github"]["visibility"]);
    }
    config.github = github;
  }

  return config;
}

async function collectSystemInfo(config: UserConfig): Promise<SystemInfo> {
  const git: StringValues = {};
  const github: StringValues = {};
  const npm: StringValues = {};

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

  const defaults: ConfigObject = {};
  Object.assign(defaults, config.defaults);
  const authorName = firstString(
    defaults["authorName"],
    npm["authorName"],
    git["name"],
    github["name"],
    github["login"],
  );
  const authorEmail = firstString(
    defaults["authorEmail"],
    npm["authorEmail"],
    git["email"],
    github["email"],
  );
  const authorUrl = firstString(defaults["authorUrl"], npm["authorUrl"]);
  const githubOwner = firstString(config.github?.owner, defaults["githubOwner"], github["login"]);
  const licensor = firstString(defaults["licensor"], authorName, githubOwner);

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

  const contents = await readFile(configPath, "utf8");
  const raw: ConfigObject = configPath.endsWith(".json")
    ? parseConfigObject(contents, configPath)
    : parseToml(contents);
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

function normalizeTemplateConfig(raw: ConfigObject, configPath: string): TemplateConfig {
  const config: TemplateConfig = {};
  if (isString(raw["name"])) {
    config.name = raw["name"];
  }
  if (isString(raw["description"])) {
    config.description = raw["description"];
  }
  if (raw["variables"] !== undefined) {
    if (!Array.isArray(raw["variables"])) {
      throw new Error(`Template variables must be an array in ${configPath}`);
    }
    config.variables = raw["variables"].map((entry, index) =>
      normalizeTemplateVariable(entry, index, configPath),
    );
  }
  if (raw["commands"] !== undefined) {
    if (!Array.isArray(raw["commands"])) {
      throw new Error(`Template commands must be an array in ${configPath}`);
    }
    config.commands = raw["commands"].map((entry, index) =>
      normalizeTemplateCommand(entry, index, configPath),
    );
  }
  if (raw["github"] !== undefined) {
    config.github = normalizeTemplateGithubConfig(raw["github"], configPath);
  }
  if (raw["npm"] !== undefined) {
    config.npm = normalizeTemplateNpmConfig(raw["npm"], configPath);
  }
  return config;
}

function normalizeTemplateGithubConfig(
  entry: ConfigValue,
  configPath: string,
): TemplateGithubConfig {
  if (!isConfigObject(entry)) {
    throw new Error(`Template GitHub configuration must be an object in ${configPath}`);
  }

  return {
    releaseEnvironment: requiredConfigString(
      entry,
      "release_environment",
      "GitHub release_environment",
      configPath,
    ),
  };
}

function normalizeTemplateNpmConfig(entry: ConfigValue, configPath: string): TemplateNpmConfig {
  if (!isConfigObject(entry)) {
    throw new Error(`Template npm configuration must be an object in ${configPath}`);
  }

  const packageName = requiredConfigString(entry, "package_name", "npm package_name", configPath);
  const version = requiredConfigString(entry, "version", "npm version", configPath);
  const tag = requiredConfigString(entry, "tag", "npm tag", configPath);
  const accessValue = requiredConfigString(entry, "access", "npm access", configPath);
  if (accessValue !== "public" && accessValue !== "restricted") {
    throw new Error(
      `Template npm access in ${configPath} must be "public" or "restricted", got ${JSON.stringify(accessValue)}`,
    );
  }

  return { packageName, version, tag, access: accessValue };
}

function requiredConfigString(
  entry: ConfigObject,
  key: string,
  label: string,
  configPath: string,
): string {
  const value = entry[key];
  if (!isString(value) || value.length === 0) {
    throw new Error(`Template ${label} must be a non-empty string in ${configPath}`);
  }
  return value;
}

function normalizeTemplateVariable(
  entry: ConfigValue,
  index: number,
  configPath: string,
): TemplateVariable {
  if (!isConfigObject(entry) || !isString(entry["name"])) {
    throw new Error(`Template variable at index ${index} in ${configPath} must have a string name`);
  }
  const variable: TemplateVariable = { name: entry["name"] };
  if (entry["type"] !== undefined) {
    if (!isTemplateVariableType(entry["type"])) {
      throw new Error(
        `Unsupported variable type for ${entry["name"]} in ${configPath}: ${String(entry["type"])}`,
      );
    }
    variable.type = entry["type"];
  }
  if (isString(entry["prompt"])) {
    variable.prompt = entry["prompt"];
  }
  if (Object.hasOwn(entry, "default")) {
    const defaultValue = entry["default"];
    if (defaultValue !== undefined) {
      variable.default = defaultValue;
    }
  }
  if (isBoolean(entry["required"])) {
    variable.required = entry["required"];
  }
  if (entry["choices"] !== undefined) {
    if (!Array.isArray(entry["choices"])) {
      throw new Error(`Variable ${entry["name"]} choices must be an array in ${configPath}`);
    }
    variable.choices = entry["choices"].map((choice, choiceIndex) =>
      normalizeChoice(choice, variable.name, choiceIndex, configPath),
    );
  }
  return variable;
}

function normalizeChoice(
  choice: ConfigValue,
  variableName: string,
  index: number,
  configPath: string,
): TemplateVariableChoice {
  if (isString(choice)) {
    return choice;
  }
  if (isConfigObject(choice) && isString(choice["value"])) {
    const normalized: TemplateVariableChoiceDetails = { value: choice["value"] };
    if (isString(choice["name"])) {
      normalized.name = choice["name"];
    }
    return normalized;
  }
  throw new Error(
    `Choice ${index} for variable ${variableName} in ${configPath} must be a string or { value, name }`,
  );
}

function normalizeTemplateCommand(
  entry: ConfigValue,
  index: number,
  configPath: string,
): TemplateCommand {
  if (!isConfigObject(entry) || !isString(entry["run"])) {
    throw new Error(
      `Template command at index ${index} in ${configPath} must have a string run value`,
    );
  }
  const command: TemplateCommand = { run: entry["run"] };
  if (isString(entry["name"])) {
    command.name = entry["name"];
  }
  return command;
}

function isTemplateVariableType(value: ConfigValue): value is TemplateVariableType {
  return isString(value) && ["string", "boolean", "select", "number", "path"].includes(value);
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
): Promise<ConfigObject> {
  const values: ConfigObject = {
    projectName,
    repoName: projectName,
  };

  for (const variable of template.variables ?? []) {
    if (variable.name === "projectName") {
      values["projectName"] = projectName;
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
  context: RenderData,
  system: SystemInfo,
): ConfigValue | undefined {
  if (Object.hasOwn(variable, "default")) {
    return isString(variable.default)
      ? interpolateMustache(variable.default, context)
      : variable.default;
  }
  const configuredDefault = system.defaults[variable.name];
  if (isString(configuredDefault)) {
    return interpolateMustache(configuredDefault, context);
  }
  return configuredDefault;
}

async function promptForVariable(
  variable: TemplateVariable,
  defaultValue: ConfigValue | undefined,
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
      default: isString(defaultValue) ? defaultValue : undefined,
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

function createRenderData(values: ConfigObject, system: SystemInfo) {
  return {
    ...values,
    system: createSystemRenderData(system),
    json: (value: RenderValue) => JSON.stringify(value),
  } satisfies RenderData;
}

function createSystemRenderData(system: SystemInfo) {
  const config: ConfigObject = {};
  if (system.config.template_source !== undefined) {
    config["template_source"] = system.config.template_source;
  }
  if (system.config.defaults !== undefined) {
    config["defaults"] = system.config.defaults;
  }
  if (system.config.github !== undefined) {
    const github: ConfigObject = {};
    if (system.config.github.owner !== undefined) {
      github["owner"] = system.config.github.owner;
    }
    if (system.config.github.visibility !== undefined) {
      github["visibility"] = system.config.github.visibility;
    }
    config["github"] = github;
  }

  return {
    git: system.git,
    github: system.github,
    npm: system.npm,
    config,
    defaults: system.defaults,
  } satisfies ConfigObject;
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
  data: RenderData,
): Promise<void> {
  await mkdir(targetDir);
  const eta = new Eta({ autoEscape: false, autoTrim: false });
  await renderDirectory(templateFilesDir, templateFilesDir, targetDir, data, eta);
}

async function renderDirectory(
  rootDir: string,
  currentDir: string,
  targetDir: string,
  data: RenderData,
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

function interpolatePath(relativePath: string, data: RenderData): string {
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
  data: RenderData,
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
}

async function createInitialGitCommit(targetDir: string): Promise<void> {
  console.log("\n> Create initial commit");
  await runProcess("git", ["add", "."], targetDir);
  const commitArgs = ["commit", "-m", "chore: initial commit"];
  if (
    (await pathExists(join(targetDir, "mise.toml"))) ||
    (await pathExists(join(targetDir, ".mise.toml")))
  ) {
    await runProcess("mise", ["exec", "--", "git", ...commitArgs], targetDir);
    return;
  }
  await runProcess("git", commitArgs, targetDir);
}

async function resolveGithubOptions(
  githubEnabled: boolean,
  yes: boolean,
  ownerOption: string | undefined,
  repoOption: string | undefined,
  visibilityOption: GithubVisibility | undefined,
  variables: ConfigObject,
  system: SystemInfo,
): Promise<GithubCreateOptions | undefined> {
  if (!githubEnabled) {
    return undefined;
  }

  const defaultOwner = firstString(
    ownerOption,
    stringValue(variables["githubOwner"]),
    system.config.github?.owner,
    system.defaults["githubOwner"],
    system.github["login"],
  );
  const defaultRepo = firstString(
    repoOption,
    stringValue(variables["repoName"]),
    stringValue(variables["projectName"]),
  );
  const defaultVisibility = visibilityOption ?? system.config.github?.visibility ?? "public";
  const description = stringValue(variables["description"]);

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

async function configureGithubReleaseControls(
  targetDir: string,
  options: GithubCreateOptions,
  config: TemplateGithubConfig,
  data: RenderData,
): Promise<void> {
  const repository = `${options.owner}/${options.repo}`;
  const releaseEnvironment = interpolateMustache(config.releaseEnvironment, data).trim();
  if (releaseEnvironment.length === 0) {
    throw new Error("Rendered GitHub release environment is empty");
  }
  const encodedEnvironment = encodeURIComponent(releaseEnvironment);

  console.log("\n> Configure GitHub release controls");
  await runGithubApi(
    "PUT",
    `repos/${repository}/branches/main/protection`,
    {
      required_status_checks: null,
      enforce_admins: false,
      required_pull_request_reviews: {
        dismissal_restrictions: {},
        dismiss_stale_reviews: true,
        require_code_owner_reviews: true,
        require_last_push_approval: false,
        required_approving_review_count: 1,
      },
      restrictions: null,
      required_linear_history: true,
      allow_force_pushes: false,
      allow_deletions: false,
      block_creations: false,
      required_conversation_resolution: true,
      lock_branch: false,
      allow_fork_syncing: false,
    },
    targetDir,
  );
  await runGithubApi(
    "POST",
    `repos/${repository}/rulesets`,
    {
      name: "Protect release tags",
      target: "tag",
      enforcement: "active",
      bypass_actors: [
        {
          actor_id: 5,
          actor_type: "RepositoryRole",
          bypass_mode: "always",
        },
      ],
      conditions: {
        ref_name: {
          exclude: [],
          include: ["refs/tags/v*"],
        },
      },
      rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
    },
    targetDir,
  );
  await runGithubApi(
    "PUT",
    `repos/${repository}/environments/${encodedEnvironment}`,
    {
      wait_timer: 0,
      can_admins_bypass: false,
      prevent_self_review: false,
      reviewers: [],
      deployment_branch_policy: {
        protected_branches: false,
        custom_branch_policies: true,
      },
    },
    targetDir,
  );
  await runGithubApi(
    "POST",
    `repos/${repository}/environments/${encodedEnvironment}/deployment-branch-policies`,
    {
      name: "v*",
      type: "tag",
    },
    targetDir,
  );
}

async function runGithubApi(
  method: "POST" | "PUT",
  path: string,
  body: ConfigObject,
  cwd: string,
): Promise<void> {
  await runProcess(
    "gh",
    ["api", "--method", method, path, "--input", "-"],
    cwd,
    `${JSON.stringify(body)}\n`,
  );
}

function resolveNpmPackagePlan(
  config: TemplateNpmConfig | undefined,
  data: RenderData,
  publish: boolean,
): NpmPackagePlan | undefined {
  if (config === undefined) {
    return undefined;
  }

  return {
    packageName: interpolateRequiredNpmValue("package name", config.packageName, data),
    version: interpolateRequiredNpmValue("version", config.version, data),
    tag: interpolateRequiredNpmValue("tag", config.tag, data),
    access: config.access,
    publish,
  };
}

function interpolateRequiredNpmValue(label: string, value: string, data: RenderData): string {
  const rendered = interpolateMustache(value, data).trim();
  if (rendered.length === 0) {
    throw new Error(`Rendered npm ${label} is empty`);
  }
  return rendered;
}

async function ensureNpmPackageAvailable(packageName: string): Promise<void> {
  console.log("\n> Validate npm package availability");

  try {
    await execFile("npm", ["view", packageName, "name", "--json"], { encoding: "utf8" });
  } catch (error) {
    if (isNpmNotFoundError(error)) {
      console.log(`npm package name is available: ${packageName}`);
      return;
    }
    throw new Error(
      `Could not check npm package availability for ${packageName}: ${commandFailureMessage(error)}`,
      { cause: error },
    );
  }

  throw new Error(`npm package name is already taken: ${packageName}`);
}

async function ensureNpmAuthenticated(cwd: string): Promise<void> {
  if ((await commandOutput("npm", ["whoami"])) !== undefined) {
    return;
  }

  console.log("\n> Authenticate with npm");
  await runProcess("npm", ["login"], cwd);

  if ((await commandOutput("npm", ["whoami"])) === undefined) {
    throw new Error("npm login completed, but npm authentication could not be verified");
  }
}

async function publishInitialNpmPackage(targetDir: string, plan: NpmPackagePlan): Promise<void> {
  console.log(`\n> Publish ${plan.packageName}@${plan.version} to npm`);
  await runProcess(
    "npm",
    ["publish", "--tag", plan.tag, "--access", plan.access, "--allow-directory=all"],
    targetDir,
  );
}

async function verifyRenderedPackageIdentity(
  targetDir: string,
  plan: NpmPackagePlan,
): Promise<void> {
  const packageJsonPath = join(targetDir, "package.json");
  let parsed: ConfigObject;
  try {
    parsed = parseConfigObject(await readFile(packageJsonPath, "utf8"), packageJsonPath);
  } catch (error) {
    throw new Error(
      `Could not read rendered package manifest ${packageJsonPath}: ${String(error)}`,
      { cause: error },
    );
  }

  if (parsed["name"] !== plan.packageName) {
    throw new Error(
      `Rendered package name ${JSON.stringify(parsed["name"])} does not match configured npm package ${JSON.stringify(plan.packageName)}`,
    );
  }
  if (parsed["version"] !== plan.version) {
    throw new Error(
      `Rendered package version ${JSON.stringify(parsed["version"])} does not match configured initial npm version ${JSON.stringify(plan.version)}`,
    );
  }
}

function isNpmNotFoundError(error: unknown): boolean {
  const output = commandFailureMessage(error);
  return /\bE404\b|404 Not Found/i.test(output);
}

function commandFailureMessage(error: unknown): string {
  if (!isCommandFailure(error)) {
    return String(error);
  }

  if (isString(error.stderr) && error.stderr.trim().length > 0) {
    return error.stderr.trim();
  }
  return isString(error.message) && error.message.length > 0 ? error.message : String(error);
}

type CommandFailure = {
  message?: unknown;
  stderr?: unknown;
};

function isCommandFailure(value: unknown): value is CommandFailure {
  return typeof value === "object" && value !== null;
}

async function ensureGhAuthenticated(): Promise<void> {
  try {
    await execFile("gh", ["auth", "status"]);
  } catch (error) {
    throw new Error(
      "GitHub creation is enabled, but gh is not installed or not authenticated. Run gh auth login or pass --no-github.",
      { cause: error },
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

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  input?: string,
): Promise<void> {
  console.log(`$ ${[command, ...args].join(" ")}`);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    });
    if (input !== undefined) {
      if (child.stdin === null) {
        reject(new Error(`Could not open stdin for ${command}`));
        return;
      }
      child.stdin.end(input);
    }
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
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return undefined;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

function configHome(): string {
  return process.env["XDG_CONFIG_HOME"] ?? join(process.env["HOME"] ?? tmpdir(), ".config");
}

function cacheHome(): string {
  return process.env["XDG_CACHE_HOME"] ?? join(process.env["HOME"] ?? tmpdir(), ".cache");
}

function isGithubSlug(source: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assignIfPresent(target: StringValues, key: string, value: string | undefined): void {
  if (value !== undefined && value.length > 0) {
    target[key] = value;
  }
}

function assignDefault(target: ConfigObject, key: string, value: string | undefined): void {
  if (target[key] === undefined && value !== undefined && value.length > 0) {
    target[key] = value;
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (isNonEmptyString(value)) {
      return value;
    }
  }
  return undefined;
}

function stringValue(value: ConfigValue | undefined): string | undefined {
  return isNonEmptyString(value) ? value : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isMissing(value: ConfigValue | undefined): boolean {
  return value === undefined || value === null || (isString(value) && value.length === 0);
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
       new --list
       new <template> --help

Options:
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

Template variables can be passed as kebab-case flags, for example:
  new ts-cli demo --description "Demo CLI" --author-name "Kaan"
`);
}

function printVersion(): void {
  const require = createRequire(import.meta.url);
  const packageJson: unknown = require("../package.json");
  if (!isConfigObject(packageJson)) {
    throw new Error("Invalid package.json");
  }
  console.log(stringValue(packageJson["version"]) ?? "0.0.0");
}

// oxlint-disable-next-line 2h2d/no-silent-error-suppression -- The CLI boundary renders failures and converts them to process exit codes.
void main().catch((error: unknown) => {
  if (error instanceof Error && error.name === "ExitPromptError") {
    console.error("new: Cancelled by user (Ctrl+C).");
    process.exitCode = 130;
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(`new: ${message}`);
  process.exitCode = 1;
});
