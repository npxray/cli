import { sanitizeTerminal } from "./format.js";
import type { WatchOptions } from "./options.js";
import { resolveApiUrl } from "./scan.js";

export interface WatchlistItem {
  id: string;
  packageName: string;
  alertsEnabled: boolean;
  currentVersion?: string;
  previousVersion?: string;
  score?: number;
  level?: string;
  delta?: number;
  summary?: string;
  createdAt: string;
  crossedBudget?: boolean;
  lastAlertAt?: string;
  lastAlertDelta?: number;
  sparkline?: number[];
  status?: "needs_attention" | "safe" | "unscanned" | string;
}

export interface WatchlistPayload {
  items: WatchlistItem[];
  alerts?: unknown[];
  stats?: {
    watched: number;
    needsAttention: number;
    safe: number;
  };
  trending?: unknown[];
}

export interface WatchApiInput {
  baseUrl: string;
  workspaceId: string;
  sessionToken: string;
  fetchImpl?: typeof fetch;
}

interface WatchCommandIo {
  env?: NodeJS.ProcessEnv;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  fetchImpl?: typeof fetch;
}

export async function listWatch(input: WatchApiInput): Promise<WatchlistPayload> {
  return watchRequest(input, `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/watchlist`);
}

export async function addWatch(input: WatchApiInput, packageName: string): Promise<WatchlistPayload> {
  return watchRequest(input, `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/watchlist`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ packageName })
  });
}

export async function removeWatch(input: WatchApiInput, packageName: string): Promise<WatchlistPayload> {
  const payload = await listWatch(input);
  const item = payload.items.find((candidate) => candidate.packageName.toLowerCase() === packageName.toLowerCase());
  if (!item) throw new Error(`${packageName} is not on the watchlist.`);
  return watchRequest(
    input,
    `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/watchlist/${encodeURIComponent(item.id)}`,
    { method: "DELETE" }
  );
}

export async function runWatchCommand(options: WatchOptions, io: WatchCommandIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const apiInput = resolveWatchApiInput(options, env, io.fetchImpl);
  const action = options.action ?? "list";
  if (action === "list") {
    const payload = await listWatch(apiInput);
    writeWatchResult(payload, options, io.stdout ?? process.stdout);
    return 0;
  }
  if (action === "add") {
    const packageName = requirePackageName(options, "add");
    const payload = await addWatch(apiInput, packageName);
    writeWatchResult(payload, options, io.stdout ?? process.stdout, `Added ${sanitizeTerminal(packageName)}.`);
    return 0;
  }
  if (action === "remove") {
    const packageName = requirePackageName(options, "remove");
    const payload = await removeWatch(apiInput, packageName);
    writeWatchResult(payload, options, io.stdout ?? process.stdout, `Removed ${sanitizeTerminal(packageName)}.`);
    return 0;
  }
  throw new Error(`Unknown watch command: ${action}`);
}

export function formatWatchlist(payload: WatchlistPayload): string {
  if (payload.items.length === 0) return "No watched packages.";

  const rows = payload.items.map((item) => ({
    packageName: sanitizeTerminal(item.packageName),
    score: item.score === undefined ? "-" : String(Math.round(item.score)),
    status: sanitizeTerminal(item.status ?? "unscanned"),
    alerts: item.alertsEnabled ? "on" : "off",
    addedAt: formatTimestamp(item.createdAt),
    lastAlert: item.lastAlertAt ? formatTimestamp(item.lastAlertAt) : "-"
  }));
  const widths = {
    packageName: Math.max("PACKAGE".length, ...rows.map((row) => visibleLength(row.packageName))),
    score: Math.max("SCORE".length, ...rows.map((row) => row.score.length)),
    status: Math.max("STATUS".length, ...rows.map((row) => row.status.length)),
    alerts: Math.max("ALERTS".length, ...rows.map((row) => row.alerts.length)),
    addedAt: Math.max("ADDED AT".length, ...rows.map((row) => row.addedAt.length)),
    lastAlert: Math.max("LAST ALERT".length, ...rows.map((row) => row.lastAlert.length))
  };

  const lines = [
    [
      padEnd("PACKAGE", widths.packageName),
      padStart("SCORE", widths.score),
      padEnd("STATUS", widths.status),
      padEnd("ALERTS", widths.alerts),
      padEnd("ADDED AT", widths.addedAt),
      padEnd("LAST ALERT", widths.lastAlert)
    ].join("  "),
    [
      "-".repeat(widths.packageName),
      "-".repeat(widths.score),
      "-".repeat(widths.status),
      "-".repeat(widths.alerts),
      "-".repeat(widths.addedAt),
      "-".repeat(widths.lastAlert)
    ].join("  ")
  ];

  for (const row of rows) {
    lines.push(
      [
        padEnd(row.packageName, widths.packageName),
        padStart(row.score, widths.score),
        padEnd(row.status, widths.status),
        padEnd(row.alerts, widths.alerts),
        padEnd(row.addedAt, widths.addedAt),
        padEnd(row.lastAlert, widths.lastAlert)
      ].join("  ")
    );
  }

  return lines.join("\n");
}

function resolveWatchApiInput(options: WatchOptions, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): WatchApiInput {
  const workspaceId = options.workspaceId ?? env.NPXRAY_WORKSPACE_ID;
  const sessionToken = options.sessionToken ?? env.NPXRAY_SESSION_TOKEN;
  if (!workspaceId) throw new Error("watch requires --workspace <id> or NPXRAY_WORKSPACE_ID.");
  if (!sessionToken) throw new Error("watch requires --session <token> or NPXRAY_SESSION_TOKEN.");
  return {
    baseUrl: resolveApiUrl(options.apiUrl, env),
    workspaceId,
    sessionToken,
    fetchImpl
  };
}

async function watchRequest(
  input: WatchApiInput,
  path: string,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}
): Promise<WatchlistPayload> {
  const url = `${input.baseUrl.replace(/\/+$/, "")}${path}`;
  const response = await (input.fetchImpl ?? fetch)(url, {
    ...init,
    headers: {
      accept: "application/json",
      cookie: `npxray_session=${input.sessionToken}`,
      ...init.headers
    }
  }).catch((error: unknown) => {
    throw new Error(`Watchlist request failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!response.ok) {
    const detail = await responseDetail(response);
    if ((response.status === 402 || response.status === 403) && detail.toLowerCase().includes("team workspace")) {
      throw new Error("Watchlists require a Team workspace.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Watchlist request failed: ${response.status} ${detail}. Pass --workspace and --session for a workspace session.`
      );
    }
    throw new Error(`Watchlist request failed: ${response.status} ${detail}`);
  }
  return (await response.json()) as WatchlistPayload;
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

function requirePackageName(options: WatchOptions, action: "add" | "remove"): string {
  const packageName = options.packageName?.trim();
  if (!packageName) throw new Error(`watch ${action} requires a package name.`);
  return packageName;
}

function writeWatchResult(
  payload: WatchlistPayload,
  options: WatchOptions,
  stdout: Pick<NodeJS.WriteStream, "write">,
  message?: string
): void {
  if (options.json) {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  stdout.write(`${message ? `${message}\n\n` : ""}${formatWatchlist(payload)}\n`);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return sanitizeTerminal(value);
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function visibleLength(value: string): number {
  return [...value].length;
}

function padEnd(value: string, width: number): string {
  const gap = width - visibleLength(value);
  return gap > 0 ? value + " ".repeat(gap) : value;
}

function padStart(value: string, width: number): string {
  const gap = width - visibleLength(value);
  return gap > 0 ? " ".repeat(gap) + value : value;
}
