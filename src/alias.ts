import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type SupportedShell = "bash" | "zsh" | "fish";

export interface AliasOptions {
  shell?: string;
  profile?: string;
  dryRun: boolean;
  print: boolean;
  force: boolean;
}

export interface AliasResult {
  shell: SupportedShell;
  snippet: string;
  profilePath?: string;
  activationCommand?: string;
  status: "printed" | "dry-run" | "created" | "updated" | "already-configured";
}

const supportedShells = new Set<SupportedShell>(["bash", "zsh", "fish"]);
const managedBlockPattern = /# >>> npxray alias >>>[\s\S]*?# <<< npxray alias <<</m;

export function parseAliasOptions(args: string[]): AliasOptions {
  const options: AliasOptions = {
    dryRun: false,
    print: false,
    force: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--print") {
      options.print = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--shell") {
      options.shell = requireValue(args, ++index, "--shell");
    } else if (arg.startsWith("--shell=")) {
      options.shell = arg.slice("--shell=".length);
    } else if (arg === "--profile") {
      options.profile = requireValue(args, ++index, "--profile");
    } else if (arg.startsWith("--profile=")) {
      options.profile = arg.slice("--profile=".length);
    } else {
      throw new Error(`Unknown alias option: ${arg}`);
    }
  }

  return options;
}

export function configureNpxAlias(options: AliasOptions, env: NodeJS.ProcessEnv = process.env): AliasResult {
  const shell = resolveShell(options.shell ?? env.SHELL);
  const snippet = aliasSnippet(shell);

  if (options.print) {
    return { shell, snippet, status: "printed" };
  }

  const profilePath = resolveProfilePath(shell, options.profile, env);
  const activationCommand = `source ${quoteShellPath(profilePath)}`;

  if (options.dryRun) {
    return { shell, snippet, profilePath, activationCommand, status: "dry-run" };
  }

  const existing = existsSync(profilePath) ? readFileSync(profilePath, "utf8") : "";
  const existingManagedBlock = existing.match(managedBlockPattern)?.[0];
  if (existingManagedBlock) {
    if (existingManagedBlock === snippet) {
      return { shell, snippet, profilePath, activationCommand, status: "already-configured" };
    }

    writeProfile(profilePath, existing.replace(managedBlockPattern, snippet));
    return { shell, snippet, profilePath, activationCommand, status: "updated" };
  }

  if (hasEquivalentNpxAlias(existing, shell)) {
    return { shell, snippet, profilePath, activationCommand, status: "already-configured" };
  }

  const conflictingAlias = findConflictingNpxAlias(existing, shell);
  if (conflictingAlias && !options.force) {
    throw new Error(
      `Found an existing npx alias in ${profilePath}: ${conflictingAlias.trim()}. ` +
        "Re-run with --force to append the npxray alias after it."
    );
  }

  writeProfile(profilePath, appendBlock(existing, snippet));
  return { shell, snippet, profilePath, activationCommand, status: "created" };
}

export function formatAliasResult(result: AliasResult): string {
  if (result.status === "printed") return result.snippet;

  if (result.status === "dry-run") {
    return [
      `Shell: ${result.shell}`,
      `Profile: ${result.profilePath}`,
      "",
      result.snippet,
      "",
      `Current terminal: run ${result.activationCommand}`
    ].join("\n");
  }

  if (result.status === "already-configured") {
    return [
      `npxray alias is already configured in ${result.profilePath}.`,
      `Restart your shell or run: ${result.activationCommand}`
    ].join("\n");
  }

  const verb = result.status === "updated" ? "Updated" : "Added";
  return [
    `${verb} npxray alias in ${result.profilePath}.`,
    `Restart your shell or run: ${result.activationCommand}`,
    "Then use npx as usual, for example: npx create-vite@latest my-app"
  ].join("\n");
}

function resolveShell(rawShell?: string): SupportedShell {
  const shellName = basename(rawShell ?? "")
    .replace(/\.exe$/i, "")
    .toLowerCase();
  if (supportedShells.has(shellName as SupportedShell)) return shellName as SupportedShell;
  throw new Error("Unsupported shell. Supported shells: bash, zsh, fish. Use --shell to choose one.");
}

function resolveProfilePath(shell: SupportedShell, profile: string | undefined, env: NodeJS.ProcessEnv): string {
  if (profile) return resolveHome(profile, env);

  const home = env.HOME || homedir();
  if (shell === "zsh") return join(env.ZDOTDIR || home, ".zshrc");
  if (shell === "fish") return join(env.XDG_CONFIG_HOME || join(home, ".config"), "fish", "config.fish");

  const bashrc = join(home, ".bashrc");
  const bashProfile = join(home, ".bash_profile");
  if (process.platform === "darwin") {
    if (existsSync(bashProfile)) return bashProfile;
    if (!existsSync(bashrc)) return bashProfile;
  }
  return bashrc;
}

function aliasSnippet(shell: SupportedShell): string {
  const body =
    shell === "fish" ? ["function npx", "    npxray run -- $argv", "end"].join("\n") : "alias npx='npxray run --'";
  return [
    "# >>> npxray alias >>>",
    "# Routes npx through npxray before npm exec runs package code.",
    body,
    "# <<< npxray alias <<<"
  ].join("\n");
}

function hasEquivalentNpxAlias(contents: string, shell: SupportedShell): boolean {
  if (/^[ \t]*alias[ \t]+npx=(['"])npxray run --\1[ \t]*(?:#.*)?$/m.test(contents)) return true;
  if (shell !== "fish") return false;
  return /^[ \t]*npxray run -- \$argv[ \t]*(?:#.*)?$/m.test(contents);
}

function findConflictingNpxAlias(contents: string, shell: SupportedShell): string | undefined {
  const aliasLine = contents.match(/^[ \t]*alias[ \t]+npx=.*$/m)?.[0];
  if (aliasLine && !hasEquivalentNpxAlias(aliasLine, shell)) return aliasLine;

  if (shell === "fish") {
    const fishFunction = contents.match(/^[ \t]*function[ \t]+npx(?:[ \t].*)?$/m)?.[0];
    if (fishFunction && !hasEquivalentNpxAlias(contents, shell)) return fishFunction;
  }

  return undefined;
}

function appendBlock(contents: string, block: string): string {
  if (!contents) return `${block}\n`;
  return `${contents}${contents.endsWith("\n") ? "" : "\n"}\n${block}\n`;
}

function writeProfile(profilePath: string, contents: string): void {
  mkdirSync(dirname(profilePath), { recursive: true });
  writeFileSync(profilePath, contents);
}

function resolveHome(path: string, env: NodeJS.ProcessEnv): string {
  if (path === "~") return env.HOME || homedir();
  if (path.startsWith("~/")) return join(env.HOME || homedir(), path.slice(2));
  return resolve(path);
}

function quoteShellPath(path: string): string {
  return `"${path.replace(/(["\\$`])/g, "\\$1")}"`;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}
