export interface InspectOptions {
  json: boolean;
  markdown: boolean;
  svg: boolean;
  local: boolean;
  registryUrl?: string;
  apiUrl?: string;
  fixtureDir?: string;
  now?: string;
  input: string[];
}

export interface RunOptions {
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  local: boolean;
  registryUrl?: string;
  fixtureDir?: string;
  now?: string;
  policyFile?: string;
  apiUrl?: string;
  workspaceId?: string;
  sessionToken?: string;
  commandArgs: string[];
}

export interface WatchOptions {
  action?: string;
  json: boolean;
  apiUrl?: string;
  workspaceId?: string;
  sessionToken?: string;
  packageName?: string;
}

export interface CompareOptions {
  json: boolean;
  local: boolean;
  registryUrl?: string;
  apiUrl?: string;
  fixtureDir?: string;
  now?: string;
  input: string[];
}

export function parseInspectOptions(args: string[]): InspectOptions {
  const options: InspectOptions = {
    json: false,
    markdown: false,
    svg: false,
    local: false,
    input: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--markdown" || arg === "--md") options.markdown = true;
    else if (arg === "--svg") options.svg = true;
    else if (arg === "--local") options.local = true;
    else if (arg === "--registry") options.registryUrl = requireValue(args, ++index, "--registry");
    else if (arg === "--api-url") options.apiUrl = requireValue(args, ++index, "--api-url");
    else if (arg === "--fixture-dir") options.fixtureDir = requireValue(args, ++index, "--fixture-dir");
    else if (arg === "--now") options.now = requireValue(args, ++index, "--now");
    else options.input.push(arg);
  }

  return options;
}

export function parseRunOptions(args: string[]): RunOptions {
  const options: RunOptions = {
    yes: false,
    dryRun: false,
    json: false,
    local: false,
    commandArgs: []
  };

  let passthrough = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (passthrough) {
      options.commandArgs.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--local") {
      options.local = true;
    } else if (arg === "--registry") {
      options.registryUrl = requireValue(args, ++index, "--registry");
    } else if (arg === "--fixture-dir") {
      options.fixtureDir = requireValue(args, ++index, "--fixture-dir");
    } else if (arg === "--now") {
      options.now = requireValue(args, ++index, "--now");
    } else if (arg === "--policy-file") {
      options.policyFile = requireValue(args, ++index, "--policy-file");
    } else if (arg === "--api-url") {
      options.apiUrl = requireValue(args, ++index, "--api-url");
    } else if (arg === "--workspace") {
      options.workspaceId = requireValue(args, ++index, "--workspace");
    } else if (arg === "--session") {
      options.sessionToken = requireValue(args, ++index, "--session");
    } else {
      options.commandArgs.push(arg);
    }
  }

  return options;
}

export function parseWatchOptions(args: string[]): WatchOptions {
  const options: WatchOptions = {
    json: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--api-url") {
      options.apiUrl = requireValue(args, ++index, "--api-url");
    } else if (arg === "--workspace") {
      options.workspaceId = requireValue(args, ++index, "--workspace");
    } else if (arg === "--session") {
      options.sessionToken = requireValue(args, ++index, "--session");
    } else if (!options.action) {
      options.action = arg;
    } else if (!options.packageName) {
      options.packageName = arg;
    } else {
      throw new Error(`Unexpected watch argument: ${arg}`);
    }
  }

  return options;
}

export function parseCompareOptions(args: string[]): CompareOptions {
  const options: CompareOptions = {
    json: false,
    local: false,
    input: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--local") options.local = true;
    else if (arg === "--registry") options.registryUrl = requireValue(args, ++index, "--registry");
    else if (arg === "--api-url") options.apiUrl = requireValue(args, ++index, "--api-url");
    else if (arg === "--fixture-dir") options.fixtureDir = requireValue(args, ++index, "--fixture-dir");
    else if (arg === "--now") options.now = requireValue(args, ++index, "--now");
    else options.input.push(arg);
  }

  return options;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}
