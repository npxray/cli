#!/usr/bin/env node
import { spawn } from "node:child_process";
import { env, stderr, stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { configureNpxAlias, formatAliasResult, parseAliasOptions } from "./alias.js";
import { comparePackages, formatCompareResult } from "./compare.js";
import { formatMarkdown, formatReport } from "./format.js";
import { parseCompareOptions, parseInspectOptions, parseRunOptions, parseWatchOptions } from "./options.js";
import { evaluatePolicy, resolvePolicy } from "./policy.js";
import type { Report } from "./report.js";
import { inspectWithScanner, resolveApiUrl } from "./scan.js";
import { buildShareSvg } from "./share.js";
import { runWatchCommand } from "./watch.js";

const HELP = `npxray

Usage:
  npxray inspect [options] <package|npx command>
  npxray compare [options] <pkg@from> <pkg@to>
  npxray run [options] -- <npx args...>
  npxray alias [options]
  npxray watch <list|add|remove> [options]

Examples:
  npxray inspect create-vite@latest
  npxray inspect ./package.tgz
  npxray inspect .
  npxray inspect "npx shadcn@latest init"
  npxray compare create-vite@5.0.0 create-vite@5.1.0
  npxray run -- create-vite@latest my-app --template react
  npxray run -- ./package.tgz
  npxray alias
  npxray watch add create-vite
  npxray watch list
  npx create-vite@latest my-app --template react

Run "npxray inspect --help", "npxray compare --help", "npxray run --help", "npxray alias --help", or "npxray watch --help" for command options.
`;

const INSPECT_HELP = `npxray inspect

Usage:
  npxray inspect [options] <package|npx command|local .tgz|local package dir>

Options:
  --json                 Print the canonical report JSON
  --markdown, --md       Print a Markdown report
  --svg                  Print a share-card SVG
  --api-url <url>        Use a specific npxray API origin (default: https://api.npxray.dev)
  --local                Force the local engine instead of the API
  --registry <url>       Scan against a custom registry
  --policy-file <path>   Load a local JSON policy
  --workspace <id>       Workspace id for session-based policy sync
  --session <token>      Session token for session-based policy sync
  --fixture-dir <path>   Load registry/tarball data from fixtures for diagnostics
  --now <timestamp>      Use an injected RFC3339 timestamp for diagnostics
  -h, --help             Show this help

Environment:
  NPXRAY_API_URL         Default API origin override
  NPXRAY_API_TOKEN       Use the token-authenticated API scan route
  NPXRAY_LOCAL=1         Force local scanning
  NPXRAY_WORKSPACE_ID    Workspace id for policy sync
  NPXRAY_SESSION_TOKEN   Session token for policy sync

Local .tgz files and package directories always use the local engine.
`;

const RUN_HELP = `npxray run

Usage:
  npxray run [options] -- <npx args...>

Options:
  --yes, -y              Run approved commands without prompting
  --dry-run              Scan only; do not start npm exec
  --json                 Print the canonical report JSON before policy/run handling
  --api-url <url>        Use a specific npxray API origin (default: https://api.npxray.dev)
  --local                Force the local engine instead of the API
  --registry <url>       Scan against a custom registry
  --policy-file <path>   Load a local JSON policy
  --workspace <id>       Workspace id for session-based policy sync
  --session <token>      Session token for session-based policy sync
  --fixture-dir <path>   Load registry/tarball data from fixtures for diagnostics
  --now <timestamp>      Use an injected RFC3339 timestamp for diagnostics
  -h, --help             Show this help

Environment:
  NPXRAY_API_URL         Default API origin override
  NPXRAY_API_TOKEN       Use the token-authenticated API scan route
  NPXRAY_LOCAL=1         Force local scanning
  NPXRAY_WORKSPACE_ID    Workspace id for policy sync
  NPXRAY_SESSION_TOKEN   Session token for policy sync

Local .tgz files and package directories always use the local engine.
`;

const COMPARE_HELP = `npxray compare

Usage:
  npxray compare [options] <pkg@from> <pkg@to>

Options:
  --json                 Print the canonical compare JSON
  --api-url <url>        Use a specific npxray API origin (default: https://api.npxray.dev)
  --local                Force two local engine scans instead of the API
  --registry <url>       Scan against a custom registry for local fallback/scans
  --fixture-dir <path>   Load registry/tarball data from fixtures for diagnostics
  --now <timestamp>      Use an injected RFC3339 timestamp for diagnostics
  -h, --help             Show this help

Environment:
  NPXRAY_API_URL         Default API origin override
  NPXRAY_LOCAL=1         Force local scanning
`;

const ALIAS_HELP = `npxray alias

Usage:
  npxray alias [options]

Options:
  --shell <shell>        Shell to configure: bash, zsh, fish (default: detect from SHELL)
  --profile <path>      Write to a specific shell startup file
  --print               Print the shell snippet without writing a profile
  --dry-run             Show the target profile and snippet without writing
  --force               Append after an existing non-npxray npx alias
  -h, --help            Show this help

Environment:
  SHELL                 Used to detect the shell when --shell is omitted
  HOME                  Used to find the default shell startup file
  ZDOTDIR               zsh startup directory override
  XDG_CONFIG_HOME       fish config root override
`;

const WATCH_HELP = `npxray watch

Usage:
  npxray watch list [options]
  npxray watch add [options] <package>
  npxray watch remove [options] <package>

Options:
  --json                 Print the API watchlist JSON
  --api-url <url>        Use a specific npxray API origin (default: https://api.npxray.dev)
  --workspace <id>       Workspace id for session-based watchlist access
  --session <token>      Session token for session-based watchlist access
  -h, --help             Show this help

Environment:
  NPXRAY_API_URL         Default API origin override
  NPXRAY_WORKSPACE_ID    Workspace id for watchlist access
  NPXRAY_SESSION_TOKEN   Session token for watchlist access
`;

const npmExecFlagsWithValues = new Set([
  "--package",
  "-p",
  "--registry",
  "--cache",
  "--userconfig",
  "--workspace",
  "-w"
]);

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h") {
    output.write(HELP);
    return 0;
  }

  if (command === "alias") {
    if (isLeadingHelpFlag(args)) {
      output.write(ALIAS_HELP);
      return 0;
    }
    const result = configureNpxAlias(parseAliasOptions(args));
    output.write(`${formatAliasResult(result)}\n`);
    return 0;
  }

  if (command === "watch") {
    if (isLeadingHelpFlag(args)) {
      output.write(WATCH_HELP);
      return 0;
    }
    return runWatchCommand(parseWatchOptions(args));
  }

  if (command === "inspect") {
    if (isLeadingHelpFlag(args)) {
      output.write(INSPECT_HELP);
      return 0;
    }
    const options = parseInspectOptions(args);
    if (options.input.length === 0) throw new Error("inspect requires a package or command.");
    const started = Date.now();
    const stopSpinner = startSpinner(`scanning ${options.input.join(" ")}`);
    let analysis: Report;
    try {
      analysis = (
        await inspectWithScanner(options.input, {
          local: options.local,
          apiUrl: options.apiUrl,
          registryUrl: options.registryUrl,
          fixtureDir: options.fixtureDir,
          now: options.now
        })
      ).report;
    } finally {
      stopSpinner();
    }
    if (options.json) {
      output.write(`${JSON.stringify(analysis, null, 2)}\n`);
    } else if (options.markdown) {
      output.write(`${formatMarkdown(analysis)}\n`);
    } else if (options.svg) {
      output.write(`${buildShareSvg(analysis.shareCard)}\n`);
    } else {
      output.write(`${formatReport(analysis, { elapsedMs: Date.now() - started })}\n`);
    }

    const policy = await resolvePolicy({
      policyFile: options.policyFile,
      baseUrl: resolveApiUrl(options.apiUrl),
      workspaceId: options.workspaceId ?? env.NPXRAY_WORKSPACE_ID,
      sessionToken: options.sessionToken ?? env.NPXRAY_SESSION_TOKEN
    });
    const decision = evaluatePolicy(analysis, policy);
    if (decision.action === "block") {
      output.write(`\nBlocked by policy: ${decision.reason}\n`);
      return 3;
    }
    if (decision.action === "warn") {
      output.write(`\nPolicy warning: ${decision.reason}\n`);
    }
    return 0;
  }

  if (command === "compare") {
    if (isLeadingHelpFlag(args)) {
      output.write(COMPARE_HELP);
      return 0;
    }
    const options = parseCompareOptions(args);
    const started = Date.now();
    const stopSpinner = startSpinner(`comparing ${options.input.join(" ")}`);
    let result!: Awaited<ReturnType<typeof comparePackages>>;
    try {
      result = await comparePackages(options.input, {
        local: options.local,
        apiUrl: options.apiUrl,
        registryUrl: options.registryUrl,
        fixtureDir: options.fixtureDir,
        now: options.now
      });
    } finally {
      stopSpinner();
    }
    if (options.json) {
      output.write(`${JSON.stringify(result.comparison, null, 2)}\n`);
    } else {
      output.write(`${formatCompareResult(result.comparison)}\n`);
      output.write(`\nCompared via ${result.source} in ${((Date.now() - started) / 1000).toFixed(1)}s.\n`);
    }
    return 0;
  }

  if (command === "run") {
    if (hasHelpFlagBeforePassthrough(args)) {
      output.write(RUN_HELP);
      return 0;
    }
    const options = parseRunOptions(args);
    if (options.commandArgs.length === 0) throw new Error("run requires npx arguments after --.");
    const inspectArgs = normalizeRunArgsForInspection(options.commandArgs);
    const started = Date.now();
    const stopSpinner = startSpinner(`scanning ${inspectArgs.join(" ")}`);
    let analysis: Report;
    try {
      analysis = (
        await inspectWithScanner(inspectArgs, {
          local: options.local,
          apiUrl: options.apiUrl,
          registryUrl: options.registryUrl,
          fixtureDir: options.fixtureDir,
          now: options.now
        })
      ).report;
    } finally {
      stopSpinner();
    }

    if (options.json) {
      output.write(`${JSON.stringify(analysis, null, 2)}\n`);
    } else {
      output.write(`${formatReport(analysis, { elapsedMs: Date.now() - started })}\n`);
    }

    const policy = await resolvePolicy({
      policyFile: options.policyFile,
      baseUrl: resolveApiUrl(options.apiUrl),
      workspaceId: options.workspaceId ?? env.NPXRAY_WORKSPACE_ID,
      sessionToken: options.sessionToken ?? env.NPXRAY_SESSION_TOKEN
    });
    const decision = evaluatePolicy(analysis, policy);
    if (decision.action === "block") {
      output.write(`\nBlocked by policy: ${decision.reason}\n`);
      return 3;
    }
    if (decision.action === "warn") {
      output.write(`\nPolicy warning: ${decision.reason}\n`);
    }

    if (options.dryRun) {
      output.write("\nDry run: npm exec was not started.\n");
      return 0;
    }

    if (!options.yes) {
      const approved = await confirmRun(
        analysis.riskScore >= 50 ? "This looks risky. Run anyway?" : "Run with npm exec?"
      );
      if (!approved) {
        output.write("Aborted.\n");
        return 2;
      }
    }

    return runNpmExec(normalizeRunArgsForExecution(options.commandArgs));
  }

  throw new Error(`Unknown command: ${command}`);
}

function isLeadingHelpFlag(args: string[]): boolean {
  return args[0] === "--help" || args[0] === "-h";
}

function hasHelpFlagBeforePassthrough(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "--help" || arg === "-h") return true;
  }
  return false;
}

function normalizeRunArgsForInspection(args: string[]): string[] {
  return normalizeRunInvocation(args);
}

function normalizeRunArgsForExecution(args: string[]): string[] {
  return normalizeRunInvocation(args);
}

function normalizeRunInvocation(args: string[]): string[] {
  if (args[0] === "npx") return args.slice(1);
  if (args[0] === "npm" && (args[1] === "exec" || args[1] === "x")) return args.slice(2);
  if (args[0] === "npm" && (args[1] === "create" || args[1] === "init") && args[2]) {
    return [normalizeCreatePackage(args[2]), ...args.slice(3)];
  }
  return args;
}

function normalizeCreatePackage(spec: string): string {
  if (spec.startsWith("@")) return spec;
  return `create-${spec}`;
}

// Keep spinner output off pipes, CI, and tests.
function startSpinner(label: string): () => void {
  if (!stderr.isTTY || env.NO_COLOR) {
    return () => {};
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frame = 0;
  stderr.write("\x1b[?25l");
  const timer = setInterval(() => {
    frame = (frame + 1) % frames.length;
    stderr.write(`\r\x1b[36m${frames[frame]}\x1b[0m ${label}…\x1b[K`);
  }, 80);
  return () => {
    clearInterval(timer);
    stderr.write("\r\x1b[2K\x1b[?25h");
  };
}

async function confirmRun(question: string): Promise<boolean> {
  if (!input.isTTY) {
    output.write("Refusing to run without --yes because stdin is not interactive.\n");
    return false;
  }
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

function runNpmExec(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", buildNpmExecArgs(args), {
      stdio: "inherit",
      shell: false
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        resolve(1);
      } else {
        resolve(code ?? 0);
      }
    });
  });
}

function buildNpmExecArgs(args: string[]): string[] {
  const execArgs = ["exec"];
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      index += 1;
      break;
    }
    if (!arg.startsWith("-")) {
      break;
    }
    execArgs.push(arg);
    if (npmExecFlagsWithValues.has(arg) && index + 1 < args.length) {
      execArgs.push(args[index + 1]);
      index += 1;
    }
  }
  const commandArgs = args.slice(index);
  if (commandArgs.length > 0) {
    execArgs.push("--", ...commandArgs);
  }
  return execArgs;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`npxray: ${message}\n`);
    process.exitCode = 1;
  }
);
