export type GithubVisibility = "public" | "private";

export type ParsedCliArgs = {
  help: boolean;
  version: boolean;
  list: boolean;
  yes: boolean;
  github: boolean;
  positional: string[];
  variableFlags: Record<string, string | boolean>;
  templateSource?: string;
  githubOwner?: string;
  githubRepo?: string;
  githubVisibility?: GithubVisibility;
};

export type TemplateVariableChoice =
  | string
  | {
      name?: string;
      value: string;
    };

export type TemplateVariable = {
  name: string;
  type?: "string" | "boolean" | "select" | "number" | "path";
  prompt?: string;
  default?: unknown;
  required?: boolean;
  choices?: TemplateVariableChoice[];
};

export type TemplateCommand = {
  name?: string;
  run: string;
};

export type TemplateConfig = {
  name?: string;
  description?: string;
  variables?: TemplateVariable[];
  commands?: TemplateCommand[];
};

export type UserConfig = {
  template_source?: string;
  defaults?: Record<string, unknown>;
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

export function interpolateMustache(input: string, context: Record<string, unknown>): string {
  return input.replace(
    /{{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*}}/g,
    (_match, expression: string) => {
      const value = getContextValue(context, expression);
      if (value === undefined || value === null) {
        return "";
      }
      return String(value);
    },
  );
}

export function getContextValue(context: Record<string, unknown>, path: string): unknown {
  let current: unknown = context;
  for (const part of path.split(".")) {
    if (!isRecord(current) || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

export function coerceVariableValue(
  variable: TemplateVariable,
  raw: unknown,
): string | boolean | number {
  const type = variable.type ?? "string";
  if (type === "boolean") {
    if (typeof raw === "boolean") {
      return raw;
    }
    if (typeof raw === "string") {
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
    const numberValue = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(numberValue)) {
      throw new Error(`Variable ${variable.name} expects a number value`);
    }
    return numberValue;
  }

  const stringValue = String(raw);
  if (type === "select") {
    const choices = variable.choices ?? [];
    if (choices.length === 0) {
      throw new Error(`Variable ${variable.name} is a select variable without choices`);
    }
    const values = choices.map((choice) => (typeof choice === "string" ? choice : choice.value));
    if (!values.includes(stringValue)) {
      throw new Error(`Variable ${variable.name} must be one of: ${values.join(", ")}`);
    }
  }
  return stringValue;
}

export function choiceValue(choice: TemplateVariableChoice): string {
  return typeof choice === "string" ? choice : choice.value;
}

export function choiceName(choice: TemplateVariableChoice): string {
  return typeof choice === "string" ? choice : (choice.name ?? choice.value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function formatTemplateVariableHelp(variable: TemplateVariable): {
  option: string;
  details: string;
} {
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

function formatDefaultValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value) ?? String(value);
  }
  return String(value);
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
