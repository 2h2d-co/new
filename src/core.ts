export type GithubVisibility = "public" | "private";
export type NpmAccess = "public" | "restricted";

export type ConfigPrimitive = bigint | boolean | null | number | string;

export type ConfigValue = ConfigObject | ConfigPrimitive | ConfigValue[] | Date;

export type ConfigObject = {
  [key: string]: ConfigValue;
};

export type StringValues = {
  [key: string]: string;
};

export type RenderJson = (value: RenderValue) => string | undefined;

export type RenderValue = ConfigValue | RenderJson | RenderObject;

export type RenderObject = {
  [key: string]: RenderValue;
};

export type RenderData = RenderObject & {
  system: ConfigObject;
  json: RenderJson;
};

export type ParsedCliArgs = {
  help: boolean;
  version: boolean;
  list: boolean;
  yes: boolean;
  github: boolean;
  npmPublish: boolean;
  positional: string[];
  variableFlags: Record<string, string | boolean>;
  templateSource?: string;
  githubOwner?: string;
  githubRepo?: string;
  githubVisibility?: GithubVisibility;
};

export type TemplateVariableChoice = string | TemplateVariableChoiceDetails;

export type TemplateVariableChoiceDetails = {
  name?: string;
  value: string;
};

export type TemplateVariable = {
  name: string;
  type?: "string" | "boolean" | "select" | "number" | "path";
  prompt?: string;
  default?: ConfigValue;
  required?: boolean;
  choices?: TemplateVariableChoice[];
};

export type TemplateCommand = {
  name?: string;
  run: string;
};

export type TemplateNpmConfig = {
  packageName: string;
  version: string;
  tag: string;
  access: NpmAccess;
};

export type TemplateGithubConfig = {
  releaseEnvironment: string;
};

export type TemplateConfig = {
  name?: string;
  description?: string;
  variables?: TemplateVariable[];
  commands?: TemplateCommand[];
  github?: TemplateGithubConfig;
  npm?: TemplateNpmConfig;
};

export type UserConfig = {
  template_source?: string;
  defaults?: ConfigObject;
  github?: {
    owner?: string;
    visibility?: GithubVisibility;
  };
};

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const parsed: ParsedCliArgs = {
    help: false,
    version: false,
    list: false,
    yes: false,
    github: true,
    npmPublish: true,
    positional: [],
    variableFlags: {},
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (token === "--") {
      parsed.positional.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("--")) {
      if (token.startsWith("-") && token !== "-") {
        throw new Error(`Unsupported short option ${token}`);
      }
      parsed.positional.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const equalIndex = withoutPrefix.indexOf("=");
    const rawName = equalIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, equalIndex);
    const inlineValue = equalIndex === -1 ? undefined : withoutPrefix.slice(equalIndex + 1);

    if (rawName === "help") {
      parsed.help = true;
      continue;
    }
    if (rawName === "version") {
      parsed.version = true;
      continue;
    }
    if (rawName === "list") {
      parsed.list = parseBooleanOption(rawName, inlineValue);
      continue;
    }
    if (rawName === "yes") {
      parsed.yes = parseBooleanOption(rawName, inlineValue);
      continue;
    }
    if (rawName === "github") {
      parsed.github = parseBooleanOption(rawName, inlineValue);
      continue;
    }
    if (rawName === "no-github") {
      parsed.github = false;
      continue;
    }
    if (rawName === "npm-publish") {
      parsed.npmPublish = parseBooleanOption(rawName, inlineValue);
      continue;
    }
    if (rawName === "no-npm-publish") {
      parsed.npmPublish = false;
      continue;
    }
    if (rawName === "github-public") {
      parsed.githubVisibility = "public";
      continue;
    }
    if (rawName === "github-private") {
      parsed.githubVisibility = "private";
      continue;
    }

    if (rawName === "template-source") {
      parsed.templateSource = takeOptionValue(rawName, inlineValue, argv, () => {
        index += 1;
        return argv[index];
      });
      continue;
    }
    if (rawName === "github-owner") {
      parsed.githubOwner = takeOptionValue(rawName, inlineValue, argv, () => {
        index += 1;
        return argv[index];
      });
      continue;
    }
    if (rawName === "github-repo") {
      parsed.githubRepo = takeOptionValue(rawName, inlineValue, argv, () => {
        index += 1;
        return argv[index];
      });
      continue;
    }
    if (rawName === "github-visibility") {
      const value = takeOptionValue(rawName, inlineValue, argv, () => {
        index += 1;
        return argv[index];
      });
      parsed.githubVisibility = parseGithubVisibility(value);
      continue;
    }

    if (rawName.startsWith("no-")) {
      parsed.variableFlags[flagToVariableName(rawName.slice(3))] = false;
      continue;
    }

    if (inlineValue !== undefined) {
      parsed.variableFlags[flagToVariableName(rawName)] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      parsed.variableFlags[flagToVariableName(rawName)] = next;
      index += 1;
    } else {
      parsed.variableFlags[flagToVariableName(rawName)] = true;
    }
  }

  return parsed;
}

export function flagToVariableName(flagName: string): string {
  return flagName.replace(/-([a-zA-Z0-9])/g, (_match, char: string) => char.toUpperCase());
}

export function variableNameToFlag(variableName: string): string {
  return variableName
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

export function formatTemplateList(
  templates: { id: string; name: string; description?: string }[],
): string {
  const idWidth = templates.reduce((width, template) => Math.max(width, template.id.length), 0);
  return templates
    .map((template) => {
      const details = templateListDetails(template);
      return details.length > 0 ? `${template.id.padEnd(idWidth)}  ${details}` : template.id;
    })
    .join("\n");
}

export function formatTemplateHelp(templateId: string, config: TemplateConfig): string {
  const lines = [`Usage: new ${templateId} [project-name] [options]`];
  const metadata = [config.name, config.description].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  if (metadata.length > 0) {
    lines.push("", ...metadata);
  }

  const variables = (config.variables ?? []).filter((variable) => variable.name !== "projectName");
  lines.push("", "Variables:");
  if (variables.length === 0) {
    lines.push("  (none)");
  } else {
    const rendered = variables.map(formatTemplateVariableHelp);
    const optionWidth = rendered.reduce(
      (width, variable) => Math.max(width, variable.option.length),
      0,
    );
    for (const variable of rendered) {
      lines.push(
        variable.details.length > 0
          ? `  ${variable.option.padEnd(optionWidth)}  ${variable.details}`
          : `  ${variable.option}`,
      );
    }
  }

  if ((config.commands?.length ?? 0) > 0) {
    lines.push("", "Commands:");
    for (const command of config.commands ?? []) {
      lines.push(
        `  ${command.name === undefined ? command.run : `${command.name}: ${command.run}`}`,
      );
    }
  }

  if (config.npm !== undefined) {
    lines.push(
      "",
      "npm:",
      `  Validate package name: ${config.npm.packageName}`,
      `  Initial publish: ${config.npm.version} (tag: ${config.npm.tag}, access: ${config.npm.access})`,
    );
  }

  if (config.github !== undefined) {
    lines.push(
      "",
      "GitHub:",
      "  Protect main and v* release tags after repository creation",
      `  Restrict release environment: ${config.github.releaseEnvironment}`,
    );
  }

  lines.push(
    "",
    "Note: Variables without a declared default may be filled from git, npm, gh, or [defaults] in the global config.",
  );

  return lines.join("\n");
}

export function parseGithubVisibility(value: string): GithubVisibility {
  if (value === "public" || value === "private") {
    return value;
  }
  throw new Error(`GitHub visibility must be "public" or "private", got ${JSON.stringify(value)}`);
}

export function interpolateMustache(input: string, context: RenderObject): string {
  return input.replace(
    /{{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*}}/g,
    (_match, expression: string) => {
      const value = getContextValue(context, expression);
      if (value === undefined || value === null) {
        return "";
      }
      if (!isConfigValue(value)) {
        throw new Error(`Cannot interpolate non-data value: ${expression}`);
      }
      return formatConfigValue(value);
    },
  );
}

export function getContextValue(context: RenderObject, path: string): RenderValue | undefined {
  let current: RenderValue = context;
  for (const part of path.split(".")) {
    if (!isRenderObject(current) || !(part in current)) {
      return undefined;
    }
    const next: RenderValue | undefined = current[part];
    if (next === undefined) {
      return undefined;
    }
    current = next;
  }
  return current;
}

export function coerceVariableValue(
  variable: TemplateVariable,
  raw: ConfigValue,
): string | boolean | number {
  const type = variable.type ?? "string";
  if (type === "boolean") {
    if (isBoolean(raw)) {
      return raw;
    }
    if (isString(raw)) {
      const normalized = raw.toLowerCase();
      if (["true", "1", "yes", "y", "on"].includes(normalized)) {
        return true;
      }
      if (["false", "0", "no", "n", "off"].includes(normalized)) {
        return false;
      }
    }
    throw new Error(`Variable ${variable.name} expects a boolean value`);
  }

  if (type === "number") {
    const numberValue = isNumber(raw) ? raw : Number(raw);
    if (!Number.isFinite(numberValue)) {
      throw new Error(`Variable ${variable.name} expects a number value`);
    }
    return numberValue;
  }

  const stringValue = formatConfigValue(raw);
  if (type === "select") {
    const choices = variable.choices ?? [];
    if (choices.length === 0) {
      throw new Error(`Variable ${variable.name} is a select variable without choices`);
    }
    const values = choices.map((choice) => (isString(choice) ? choice : choice.value));
    if (!values.includes(stringValue)) {
      throw new Error(`Variable ${variable.name} must be one of: ${values.join(", ")}`);
    }
  }
  return stringValue;
}

export function choiceValue(choice: TemplateVariableChoice): string {
  return isString(choice) ? choice : choice.value;
}

export function choiceName(choice: TemplateVariableChoice): string {
  return isString(choice) ? choice : (choice.name ?? choice.value);
}

export function parseConfigObject(contents: string, label: string): ConfigObject {
  const parsed: unknown = JSON.parse(contents);
  if (!isConfigObject(parsed)) {
    throw new Error(`Expected a configuration object: ${label}`);
  }
  return parsed;
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isConfigValue(value: unknown): value is ConfigValue {
  if (
    value === null ||
    typeof value === "bigint" ||
    isBoolean(value) ||
    isNumber(value) ||
    isString(value) ||
    value instanceof Date
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isConfigValue);
  }
  return typeof value === "object" && Object.values(value).every(isConfigValue);
}

export function isConfigObject(value: unknown): value is ConfigObject {
  return (
    typeof value === "object" &&
    isConfigValue(value) &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

export function formatConfigValue(value: ConfigValue): string {
  if (isString(value)) {
    return value;
  }
  if (value === null) {
    return "null";
  }
  if (isBoolean(value)) {
    return value ? "true" : "false";
  }
  if (isNumber(value)) {
    return `${value}`;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }

  const serialized = JSON.stringify(value, (_key, nested: unknown) =>
    typeof nested === "bigint" ? nested.toString() : nested,
  );
  if (serialized === undefined) {
    throw new Error("Configuration value could not be serialized");
  }
  return serialized;
}

export function isRenderObject(value: RenderValue): value is RenderObject {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

function templateListDetails(template: { id: string; name: string; description?: string }): string {
  const hasDescription = template.description !== undefined && template.description.length > 0;
  if (template.name !== template.id && hasDescription) {
    return `${template.name} - ${template.description}`;
  }
  if (template.name !== template.id) {
    return template.name;
  }
  return template.description ?? "";
}

type TemplateVariableHelp = {
  option: string;
  details: string;
};

function formatTemplateVariableHelp(variable: TemplateVariable): TemplateVariableHelp {
  const details: string[] = [];
  if (variable.prompt !== undefined && variable.prompt.length > 0) {
    details.push(variable.prompt);
  }
  if (Object.hasOwn(variable, "default")) {
    details.push(`[default: ${formatDefaultValue(variable.default)}]`);
  }
  if (variable.required === true) {
    details.push("(required)");
  }
  return {
    option: formatVariableOption(variable),
    details: details.join(" "),
  };
}

function formatVariableOption(variable: TemplateVariable): string {
  const flag = variableNameToFlag(variable.name);
  const option = `--${flag}`;
  const type = variable.type ?? "string";
  if (type === "boolean") {
    return `${option} / --no-${flag}`;
  }
  if (type === "select") {
    const choices = (variable.choices ?? []).map(choiceValue);
    return `${option} <${choices.length > 0 ? choices.join("|") : "choice"}>`;
  }
  return `${option} <${type}>`;
}

function formatDefaultValue(value: ConfigValue | undefined): string {
  return value === undefined ? "undefined" : formatConfigValue(value);
}

function parseBooleanOption(name: string, value: string | undefined): boolean {
  if (value === undefined) {
    return true;
  }
  const normalized = value.toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Option --${name} expects a boolean value`);
}

function takeOptionValue(
  name: string,
  inlineValue: string | undefined,
  _argv: readonly string[],
  takeNext: () => string | undefined,
): string {
  if (inlineValue !== undefined) {
    return inlineValue;
  }
  const next = takeNext();
  if (next === undefined) {
    throw new Error(`Option --${name} expects a value`);
  }
  return next;
}
