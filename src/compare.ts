import { inspectWithEngine, type EngineRunOptions } from "./engine.js";
import { type Finding, formatBytes, type Report, type RiskLevel } from "./report.js";
import { resolveApiUrl } from "./scan.js";

const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";
const REMOTE_COMPARE_TIMEOUT_MS = 10_000;

export interface CompareRunOptions extends EngineRunOptions {
  local?: boolean;
  apiUrl?: string;
  env?: NodeJS.ProcessEnv;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface VersionCompareResult {
  packageName: string;
  fromVersion: string;
  toVersion: string;
  scoreDelta: number;
  riskDirection: "increased" | "decreased" | "unchanged";
  cached?: { from: boolean; to: boolean };
  from: VersionVerdict;
  to: VersionVerdict;
  signals: {
    added: SignalDiffItem[];
    removed: SignalDiffItem[];
    unchanged: SignalDiffItem[];
  };
  metrics: MetricDiff[];
  versionRisk?: unknown;
}

interface VersionVerdict {
  scan: unknown;
  version: string;
  score: number;
  level: RiskLevel;
  publishedAt?: string;
  recommendation: string;
  summary: string;
}

interface SignalDiffItem {
  id: string;
  change: "added" | "removed" | "unchanged";
  severity: Finding["severity"];
  category: Finding["category"];
  confidence: Finding["confidence"];
  title: string;
  detail: string;
  evidence?: string;
  files: string[];
  weight: number;
}

interface MetricDiff {
  id: string;
  label: string;
  from: number;
  to: number;
  delta: number;
  unit: "count" | "bytes";
  direction: "up" | "down" | "flat";
  riskImpact: "better" | "worse" | "neutral";
  suffix?: string;
}

export interface CompareScanResult {
  comparison: VersionCompareResult;
  source: "api" | "local";
}

export async function comparePackages(input: string[], options: CompareRunOptions = {}): Promise<CompareScanResult> {
  const request = parseCompareInput(input);
  const env = options.env ?? process.env;
  if (shouldUseLocalOnly(options, env)) {
    return { comparison: await compareWithLocalEngine(request, options), source: "local" };
  }

  try {
    return {
      comparison: await compareWithApi(request, options, env),
      source: "api"
    };
  } catch (error) {
    if (error instanceof RemoteCompareHttpError && error.status >= 400 && error.status < 500) {
      throw error;
    }
    writeFallbackNotice(options.stderr ?? process.stderr, error);
    return { comparison: await compareWithLocalEngine(request, options), source: "local" };
  }
}

export function formatCompareResult(comparison: VersionCompareResult): string {
  const sign = comparison.scoreDelta > 0 ? "+" : "";
  const lines = [
    `npxray compare ${comparison.packageName}`,
    `${comparison.fromVersion} (${comparison.from.level}, ${comparison.from.score}/100) -> ${comparison.toVersion} (${comparison.to.level}, ${comparison.to.score}/100)`,
    `risk ${comparison.riskDirection}; score delta ${sign}${comparison.scoreDelta}`,
    ""
  ];

  lines.push("Signals");
  lines.push(...formatSignalGroup("added", comparison.signals.added));
  lines.push(...formatSignalGroup("removed", comparison.signals.removed));
  if (comparison.signals.added.length === 0 && comparison.signals.removed.length === 0) {
    lines.push("  No signal changes.");
  }
  lines.push("");

  lines.push("Metrics");
  for (const metric of comparison.metrics) {
    const delta =
      metric.delta > 0
        ? `+${formatMetricValue(metric.delta, metric.unit)}`
        : formatMetricValue(metric.delta, metric.unit);
    lines.push(
      `  ${metric.label}: ${formatMetricValue(metric.from, metric.unit)} -> ${formatMetricValue(metric.to, metric.unit)} (${delta}, ${metric.riskImpact})`
    );
  }

  return lines.join("\n");
}

function formatSignalGroup(label: "added" | "removed", items: SignalDiffItem[]): string[] {
  if (items.length === 0) return [];
  return items.slice(0, 8).map((item) => `  ${label}: [${item.severity}] ${item.title}`);
}

function formatMetricValue(value: number, unit: "count" | "bytes"): string {
  if (unit === "bytes") return formatBytes(Math.abs(value));
  return String(value);
}

async function compareWithApi(
  request: ParsedCompareRequest,
  options: CompareRunOptions,
  env: NodeJS.ProcessEnv
): Promise<VersionCompareResult> {
  const baseUrl = resolveApiUrl(options.apiUrl, env);
  const params = new URLSearchParams({
    pkg: request.packageName,
    a: request.fromVersion,
    b: request.toVersion
  });
  const url = `${baseUrl}/v1/compare?${params}`;
  const timeoutMs = options.timeoutMs ?? REMOTE_COMPARE_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) {
      const detail = await responseDetail(response);
      if (response.status >= 400 && response.status < 500) {
        throw new RemoteCompareHttpError(response.status, detail);
      }
      throw new RemoteCompareUnavailableError(`${response.status} ${detail}`);
    }
    const payload = (await response.json()) as VersionCompareResult | { comparison?: VersionCompareResult };
    const comparison: VersionCompareResult | undefined =
      "comparison" in payload ? payload.comparison : (payload as VersionCompareResult);
    if (!comparison?.packageName || !comparison.from || !comparison.to) {
      throw new RemoteCompareUnavailableError("response did not include a comparison");
    }
    return comparison;
  } catch (error) {
    if (error instanceof RemoteCompareHttpError || error instanceof RemoteCompareUnavailableError) {
      throw error;
    }
    throw new RemoteCompareUnavailableError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

async function compareWithLocalEngine(
  request: ParsedCompareRequest,
  options: CompareRunOptions
): Promise<VersionCompareResult> {
  const engineOptions: EngineRunOptions = {
    registryUrl: options.registryUrl,
    fixtureDir: options.fixtureDir,
    now: options.now,
    workdir: options.workdir
  };
  const [fromReport, toReport] = await Promise.all([
    inspectWithEngine([`${request.packageName}@${request.fromVersion}`], engineOptions),
    inspectWithEngine([`${request.packageName}@${request.toVersion}`], engineOptions)
  ]);
  return compareReports(request.packageName, fromReport, toReport);
}

function compareReports(packageName: string, fromReport: Report, toReport: Report): VersionCompareResult {
  const scoreDelta = toReport.score - fromReport.score;
  return {
    packageName,
    fromVersion: fromReport.manifest.version,
    toVersion: toReport.manifest.version,
    scoreDelta,
    riskDirection: riskDirection(scoreDelta),
    cached: { from: false, to: false },
    from: versionVerdict(fromReport),
    to: versionVerdict(toReport),
    signals: signalDiff(fromReport.findings, toReport.findings),
    metrics: metricDiffs(fromReport, toReport)
  };
}

function versionVerdict(report: Report): VersionVerdict {
  return {
    scan: {
      id: `local-${report.request.name}-${report.manifest.version}`,
      packageName: report.request.name,
      requestedSpec: report.request.normalizedSpec,
      createdAt: report.generatedAt
    },
    version: report.manifest.version,
    score: report.score,
    level: report.level,
    publishedAt: report.metrics.versionPublishedAt,
    recommendation: report.recommendation,
    summary: report.findings.length
      ? report.findings
          .slice(0, 2)
          .map((finding) => finding.title)
          .join("; ")
      : "No notable signals found."
  };
}

function signalDiff(fromFindings: Finding[], toFindings: Finding[]): VersionCompareResult["signals"] {
  const fromById = new Map(fromFindings.map((finding) => [finding.id, finding]));
  const toById = new Map(toFindings.map((finding) => [finding.id, finding]));
  return {
    added: toFindings.filter((finding) => !fromById.has(finding.id)).map((finding) => signalItem(finding, "added")),
    removed: fromFindings.filter((finding) => !toById.has(finding.id)).map((finding) => signalItem(finding, "removed")),
    unchanged: toFindings
      .filter((finding) => fromById.has(finding.id))
      .map((finding) => signalItem(finding, "unchanged"))
  };
}

function signalItem(finding: Finding, change: SignalDiffItem["change"]): SignalDiffItem {
  return {
    id: finding.id,
    change,
    severity: finding.severity,
    category: finding.category,
    confidence: finding.confidence,
    title: finding.title,
    detail: finding.detail,
    evidence: finding.evidence,
    files: finding.files ?? [],
    weight: finding.weight
  };
}

function metricDiffs(fromReport: Report, toReport: Report): MetricDiff[] {
  return [
    metricDiff(
      "directDependencies",
      "Direct deps",
      fromReport.metrics.directDependencies,
      toReport.metrics.directDependencies,
      {
        worseWhen: "up"
      }
    ),
    metricDiff(
      "lifecycleScriptCount",
      "Lifecycle scripts",
      fromReport.metrics.lifecycleScriptCount,
      toReport.metrics.lifecycleScriptCount,
      { worseWhen: "up", suffix: "new" }
    ),
    metricDiff("maintainers", "Maintainers", fromReport.metrics.maintainers, toReport.metrics.maintainers, {
      worseWhen: "down"
    }),
    metricDiff("tarballBytes", "Tarball", fromReport.metrics.tarballBytes ?? 0, toReport.metrics.tarballBytes ?? 0, {
      unit: "bytes",
      worseWhen: "up"
    })
  ];
}

function metricDiff(
  id: string,
  label: string,
  from: number,
  to: number,
  options: { unit?: "count" | "bytes"; worseWhen: "up" | "down"; suffix?: string }
): MetricDiff {
  const delta = to - from;
  const direction = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const riskImpact = direction === "flat" ? "neutral" : direction === options.worseWhen ? "worse" : "better";
  return {
    id,
    label,
    from,
    to,
    delta,
    unit: options.unit ?? "count",
    direction,
    riskImpact,
    suffix: options.suffix
  };
}

interface ParsedCompareRequest {
  packageName: string;
  fromVersion: string;
  toVersion: string;
}

function parseCompareInput(input: string[]): ParsedCompareRequest {
  if (input.length !== 2) {
    throw new Error("compare requires <pkg@from> <pkg@to>.");
  }
  const from = parsePackageVersion(input[0] ?? "");
  const to = parsePackageVersion(input[1] ?? "");
  if (from.packageName !== to.packageName) {
    throw new Error(`compare requires the same package name, got ${from.packageName} and ${to.packageName}.`);
  }
  return {
    packageName: from.packageName,
    fromVersion: from.version,
    toVersion: to.version
  };
}

function parsePackageVersion(spec: string): { packageName: string; version: string } {
  const trimmed = spec.trim();
  const versionMarker = trimmed.lastIndexOf("@");
  if (versionMarker <= 0 || versionMarker === trimmed.length - 1) {
    throw new Error(`compare spec ${spec} must include an explicit version.`);
  }
  const packageName = trimmed.slice(0, versionMarker);
  const version = trimmed.slice(versionMarker + 1);
  if (!packageName || !version) {
    throw new Error(`compare spec ${spec} must include an explicit version.`);
  }
  return { packageName, version };
}

function riskDirection(scoreDelta: number): VersionCompareResult["riskDirection"] {
  if (scoreDelta > 0) return "increased";
  if (scoreDelta < 0) return "decreased";
  return "unchanged";
}

function shouldUseLocalOnly(options: CompareRunOptions, env: NodeJS.ProcessEnv): boolean {
  if (options.local || truthyEnv(env.NPXRAY_LOCAL)) return true;
  if (options.fixtureDir || options.now) return true;
  if (options.registryUrl && trimTrailingSlash(options.registryUrl) !== DEFAULT_REGISTRY_URL) return true;
  return false;
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
  stderr.write(`npxray: compare API unavailable (${reason}); falling back to local engine.\n`);
}

function truthyEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

class RemoteCompareHttpError extends Error {
  constructor(
    readonly status: number,
    detail: string
  ) {
    super(`API compare failed: ${status} ${detail}`);
  }
}

class RemoteCompareUnavailableError extends Error {
  constructor(detail: string) {
    super(detail || "unavailable");
  }
}
