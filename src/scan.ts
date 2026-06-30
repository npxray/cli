import { inspectWithEngine, type EngineRunOptions } from "./engine.js";
import type { Report } from "./report.js";

const DEFAULT_API_URL = "https://api.npxray.dev";
const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";
const REMOTE_SCAN_TIMEOUT_MS = 10_000;

const flagsWithValues = new Set(["--package", "-p", "--registry", "--cache", "--userconfig", "--workspace", "-w"]);

export interface ScanOptions extends EngineRunOptions {
  local?: boolean;
  apiUrl?: string;
  env?: NodeJS.ProcessEnv;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ScanResult {
  report: Report;
  source: "api" | "local";
}

export async function inspectWithScanner(input: string[], options: ScanOptions = {}): Promise<ScanResult> {
  const env = options.env ?? process.env;
  if (shouldUseLocalOnly(input, options, env)) {
    return { report: await inspectWithEngine(input, options), source: "local" };
  }

  const spec = extractPackageSpecForRemote(input);
  if (!spec) {
    return { report: await inspectWithEngine(input, options), source: "local" };
  }
  if (isLocalPackageSpec(spec)) {
    return { report: await inspectWithEngine(input, options), source: "local" };
  }

  try {
    return {
      report: await scanWithApi(spec, options, env),
      source: "api"
    };
  } catch (error) {
    if (error instanceof RemoteScanHttpError && error.status >= 400 && error.status < 500) {
      throw error;
    }
    writeFallbackNotice(options.stderr ?? process.stderr, error);
    return { report: await inspectWithEngine(input, options), source: "local" };
  }
}

export function resolveApiUrl(apiUrl?: string, env: NodeJS.ProcessEnv = process.env): string {
  return trimTrailingSlash(apiUrl ?? env.NPXRAY_API_URL ?? DEFAULT_API_URL);
}

export function extractPackageSpecForRemote(input: string[]): string | undefined {
  const normalized = input.filter((value) => value.length > 0);
  if (normalized.length === 0) return undefined;
  if (normalized.length === 1) {
    const trimmed = normalized[0]?.trim();
    if (!trimmed) return undefined;
    if (!trimmed.startsWith("npx ") && !trimmed.startsWith("npm ")) return trimmed;
    return extractPackageSpecFromTokens(tokenizeCommand(trimmed));
  }
  return extractPackageSpecFromTokens(normalized);
}

export function isLocalPackageSpec(spec: string): boolean {
  const trimmed = spec.trim();
  if (!trimmed || trimmed.startsWith("@")) return false;
  if (trimmed.startsWith("file:")) return true;
  if (trimmed === "." || trimmed === "..") return true;
  if (
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith(".\\") ||
    trimmed.startsWith("..\\") ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  ) {
    return true;
  }
  return /\.(?:tgz|tar\.gz)$/i.test(trimmed);
}

async function scanWithApi(spec: string, options: ScanOptions, env: NodeJS.ProcessEnv): Promise<Report> {
  const apiToken = env.NPXRAY_API_TOKEN?.trim();
  const baseUrl = resolveApiUrl(options.apiUrl, env);
  const endpoint = apiToken ? "/v1/api/scan" : "/v1/scan";
  const url = `${baseUrl}${endpoint}`;
  const timeoutMs = options.timeoutMs ?? REMOTE_SCAN_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {})
      },
      body: JSON.stringify({
        spec,
        includeTarball: true,
        ...(options.registryUrl ? { registryUrl: options.registryUrl } : {})
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = await responseDetail(response);
      if (response.status >= 400 && response.status < 500) {
        throw new RemoteScanHttpError(response.status, detail);
      }
      throw new RemoteScanUnavailableError(`${response.status} ${detail}`);
    }
    const payload = (await response.json()) as { report?: Report };
    if (!payload.report) {
      throw new RemoteScanUnavailableError("response did not include a report");
    }
    return payload.report;
  } catch (error) {
    if (error instanceof RemoteScanHttpError || error instanceof RemoteScanUnavailableError) {
      throw error;
    }
    throw new RemoteScanUnavailableError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

function shouldUseLocalOnly(input: string[], options: ScanOptions, env: NodeJS.ProcessEnv): boolean {
  if (options.local || truthyEnv(env.NPXRAY_LOCAL)) return true;
  if (options.fixtureDir || options.now) return true;
  if (options.registryUrl && trimTrailingSlash(options.registryUrl) !== DEFAULT_REGISTRY_URL && !env.NPXRAY_API_TOKEN) {
    return true;
  }
  return input.length === 0;
}

function extractPackageSpecFromTokens(tokens: string[]): string | undefined {
  if (tokens.length === 0) return undefined;
  let sourceTokens = tokens;
  if (sourceTokens[0] === "npx") {
    sourceTokens = sourceTokens.slice(1);
  } else if (sourceTokens[0] === "npm" && (sourceTokens[1] === "exec" || sourceTokens[1] === "x")) {
    sourceTokens = sourceTokens.slice(2);
  } else if (
    sourceTokens[0] === "npm" &&
    (sourceTokens[1] === "create" || sourceTokens[1] === "init") &&
    sourceTokens[2]
  ) {
    return normalizeCreatePackage(sourceTokens[2]);
  }

  let packageToken: string | undefined;
  for (let index = 0; index < sourceTokens.length; index += 1) {
    const token = sourceTokens[index];
    if (!token || token === "--") continue;
    if (token.startsWith("--package=")) {
      packageToken = token.slice("--package=".length);
      continue;
    }
    if (flagsWithValues.has(token)) {
      if ((token === "--package" || token === "-p") && sourceTokens[index + 1]) {
        packageToken = sourceTokens[index + 1];
      }
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    if (!packageToken) packageToken = token;
    break;
  }
  return packageToken;
}

function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function normalizeCreatePackage(spec: string): string {
  return spec.startsWith("@") ? spec : `create-${spec}`;
}

async function responseDetail(response: Response): Promise<string> {
  const fallback = response.statusText || "response";
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    const message = typeof body.message === "string" ? body.message : undefined;
    const error = typeof body.error === "string" ? body.error : undefined;
    return message ?? error ?? fallback;
  } catch {
    return fallback;
  }
}

function writeFallbackNotice(stderr: Pick<NodeJS.WriteStream, "write">, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  stderr.write(`npxray: API scan unavailable (${reason}); falling back to local engine.\n`);
}

function truthyEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

class RemoteScanHttpError extends Error {
  constructor(
    readonly status: number,
    detail: string
  ) {
    super(`API scan failed: ${status} ${detail}`);
  }
}

class RemoteScanUnavailableError extends Error {
  constructor(detail: string) {
    super(detail || "unavailable");
  }
}
