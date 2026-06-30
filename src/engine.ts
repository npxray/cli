import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Report } from "./report.js";

const require = createRequire(import.meta.url);

export interface EngineRunOptions {
  includeTarball?: boolean;
  registryUrl?: string;
  workdir?: string;
  fixtureDir?: string;
  now?: string;
}

export async function inspectWithEngine(input: string[], options: EngineRunOptions): Promise<Report> {
  const engine = resolveEngineCommand();
  const args = [
    ...engine.args,
    "inspect",
    "--json",
    ...(options.includeTarball === false ? ["--no-tarball"] : []),
    ...(options.registryUrl ? ["--registry", options.registryUrl] : []),
    "--workdir",
    options.workdir ?? process.cwd(),
    ...(options.fixtureDir ? ["--fixture-dir", options.fixtureDir] : []),
    ...(options.now ? ["--now", options.now] : []),
    "--",
    ...input
  ];
  const { stdout } = await run(engine.command, args, engine.cwd);
  return JSON.parse(stdout) as Report;
}

export function resolveEngineCommand(): { command: string; args: string[]; cwd?: string } {
  if (process.env.NPXRAY_ENGINE_PATH) {
    return { command: process.env.NPXRAY_ENGINE_PATH, args: [] };
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const binary = process.platform === "win32" ? "npxray-engine.exe" : "npxray-engine";
  const target = engineTarget();
  const packageEngine = resolveOptionalPackageEngine(target, binary);
  if (packageEngine) return { command: packageEngine, args: [] };

  const packageRoot = findPackageRoot(here);
  const devEngine = join(packageRoot, ".npxray-engine", target, binary);
  if (existsSync(devEngine)) return { command: devEngine, args: [] };

  throw new Error(
    [
      `npxray local engine for ${target} was not found.`,
      `Install @npxray/engine-bin-${target} as an optional dependency or set NPXRAY_ENGINE_PATH to an npxray-engine binary.`,
      `For local development, you can also place the binary at ./.npxray-engine/${target}/${binary}.`
    ].join(" ")
  );
}

function engineTarget(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  return `${os}-${arch}`;
}

function resolveOptionalPackageEngine(target: string, binary: string): string | undefined {
  const packageName = `@npxray/engine-bin-${target}`;
  const entrypoints = [`${packageName}/package.json`, packageName];
  for (const entrypoint of entrypoints) {
    try {
      const resolved = require.resolve(entrypoint);
      const packageRoot = entrypoint.endsWith("/package.json") ? dirname(resolved) : dirname(resolved);
      const candidates = [
        entrypoint.endsWith("/package.json") ? join(packageRoot, binary) : resolved,
        join(packageRoot, "bin", binary),
        join(packageRoot, "dist", binary),
        join(packageRoot, target, binary)
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // Optional package is not installed or does not expose this entrypoint.
    }
  }
  return undefined;
}

function findPackageRoot(start: string): string {
  let current = start;
  for (let index = 0; index < 8; index += 1) {
    if (existsSync(join(current, "package.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

function run(command: string, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code && code !== 0) {
        reject(new Error(err.trim() || `npxray engine exited with ${code}`));
      } else {
        resolve({ stdout: out, stderr: err });
      }
    });
  });
}
