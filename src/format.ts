import {
  type Finding,
  type FindingSeverity,
  formatBytes,
  type Report,
  type RiskLevel,
  type ScoreBreakdown
} from "./report.js";

const C = {
  reset: 0,
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 90,
  brightRed: 91
} as const;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function visibleLen(value: string): number {
  return [...value.replace(ANSI, "")].length;
}

function padEndVisible(value: string, width: number): string {
  const gap = width - visibleLen(value);
  return gap > 0 ? value + " ".repeat(gap) : value;
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

interface Paint {
  (text: string, ...codes: number[]): string;
  enabled: boolean;
}

function makePaint(enabled: boolean): Paint {
  const paint = ((text: string, ...codes: number[]) =>
    enabled && codes.length ? `\x1b[${codes.join(";")}m${text}\x1b[0m` : text) as Paint;
  paint.enabled = enabled;
  return paint;
}

function supportsColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

const LEVELS: Record<RiskLevel, { label: string; code: number }> = {
  low: { label: "LOW RISK", code: C.green },
  watch: { label: "WATCH", code: C.yellow },
  high: { label: "HIGH RISK", code: C.red },
  severe: { label: "SEVERE", code: C.brightRed }
};

const SEVERITIES: Record<FindingSeverity, { glyph: string; code: number; rank: number }> = {
  critical: { glyph: "●", code: C.brightRed, rank: 0 },
  high: { glyph: "●", code: C.red, rank: 1 },
  medium: { glyph: "●", code: C.yellow, rank: 2 },
  low: { glyph: "○", code: C.gray, rank: 3 },
  info: { glyph: "·", code: C.cyan, rank: 4 }
};

const SIGNAL_LIMIT = 8;

export interface FormatOptions {
  color?: boolean;
  columns?: number;
  elapsedMs?: number;
}

export function formatReport(analysis: Report, options: FormatOptions = {}): string {
  const paint = makePaint(options.color ?? supportsColor());
  const cols = Math.max(48, Math.min(options.columns ?? process.stdout.columns ?? 80, 100));
  const width = Math.min(cols - 4, 74);

  const out: string[] = [];
  out.push(...header(analysis, paint, options.elapsedMs));
  out.push("");
  out.push(...verdict(analysis, paint, width));
  out.push("");
  out.push(...breakdown(analysis.scoreBreakdown, paint, width));
  out.push(...signals(analysis.findings, paint, width));
  out.push(...metrics(analysis, paint, width));
  out.push(...footer(analysis, paint, width));

  return out.map((line) => (line ? `  ${line}` : "")).join("\n");
}

function header(analysis: Report, paint: Paint, elapsedMs?: number): string[] {
  const elapsed = elapsedMs !== undefined ? paint(`scanned in ${(elapsedMs / 1000).toFixed(1)}s`, C.dim) : "";
  const brand = `${paint("▌", LEVELS[analysis.riskLevel].code)} ${paint("npxray", C.bold)}`;
  return [
    elapsed ? `${brand}   ${elapsed}` : brand,
    `${paint(analysis.request.name, C.bold)}${paint(`@${analysis.manifest.version}`, C.dim)}`
  ];
}

function verdict(analysis: Report, paint: Paint, width: number): string[] {
  const level = LEVELS[analysis.riskLevel];
  const inner = width - 4;
  const score = Math.max(0, Math.min(100, Math.round(analysis.riskScore)));

  const headline = padBetween(
    paint(level.label, level.code, C.bold),
    `${paint(String(score), C.bold)}${paint(" / 100", C.dim)}`,
    inner
  );

  const filled = Math.round((score / 100) * inner);
  const bar = paint("█".repeat(filled), level.code) + paint("░".repeat(inner - filled), C.gray);

  const body = [headline, bar, "", ...wrap(analysis.recommendation, inner).map((line) => paint(line, C.dim))];
  return boxed("VERDICT", body, inner, paint, level.code);
}

function breakdown(scoreBreakdown: ScoreBreakdown | undefined, paint: Paint, width: number): string[] {
  if (!scoreBreakdown) return [];
  const all: Array<[string, number]> = [
    ["capability", scoreBreakdown.capability],
    ["metadata", scoreBreakdown.metadata],
    ["dependency", scoreBreakdown.dependency],
    ["provenance", scoreBreakdown.provenance],
    ["anomaly", scoreBreakdown.anomaly],
    ["intelligence", scoreBreakdown.intelligence]
  ];
  const components = all.filter(([, value]) => value > 0);
  if (components.length === 0) return [];

  const max = Math.max(...components.map(([, value]) => value));
  const labelWidth = Math.max(...components.map(([label]) => label.length));
  const valueWidth = Math.max(...components.map(([, value]) => String(value).length));
  const barWidth = Math.min(width - labelWidth - 8, 28);

  const lines = [paint("BREAKDOWN", C.bold, C.dim)];
  for (const [label, value] of components) {
    const fill = Math.max(1, Math.round((value / max) * barWidth));
    const bar = paint("▇".repeat(fill), C.blue) + paint("·".repeat(barWidth - fill), C.gray);
    lines.push(`${padEndVisible(label, labelWidth)}  ${bar}  ${paint(String(value).padStart(valueWidth), C.bold)}`);
  }
  lines.push("");
  return lines;
}

function signals(findings: Finding[], paint: Paint, width: number): string[] {
  if (findings.length === 0) {
    return [`${paint("SIGNALS", C.bold, C.dim)}   ${paint("● no notable signals found", C.green)}`, ""];
  }

  const counts = countBySeverity(findings);
  const summary = (["critical", "high", "medium", "low", "info"] as FindingSeverity[])
    .filter((severity) => counts[severity] > 0)
    .map((severity) => paint(`${counts[severity]} ${severity}`, SEVERITIES[severity].code))
    .join(paint(" · ", C.gray));

  const indent = 11;
  const wrapWidth = width - indent;
  const lines = [`${paint("SIGNALS", C.bold, C.dim)}   ${summary}`];

  const ordered = [...findings].sort(
    (a, b) => SEVERITIES[a.severity].rank - SEVERITIES[b.severity].rank || b.weight - a.weight
  );

  for (const finding of ordered.slice(0, SIGNAL_LIMIT)) {
    const meta = SEVERITIES[finding.severity];
    const label = padEndVisible(finding.severity, 8);
    lines.push(`${paint(meta.glyph, meta.code)} ${paint(label, meta.code)} ${paint(finding.title, C.bold)}`);
    for (const detailLine of wrap(finding.detail, wrapWidth)) {
      lines.push(`${" ".repeat(indent)}${paint(detailLine, C.dim)}`);
    }
    if (finding.files?.length) {
      lines.push(`${" ".repeat(indent)}${paint(finding.files.slice(0, 3).join(", "), C.gray)}`);
    }
    if (finding.evidence) {
      const evidence = finding.evidence.split("\n")[0].trim();
      const clipped = evidence.length > wrapWidth - 2 ? `${evidence.slice(0, wrapWidth - 3)}…` : evidence;
      lines.push(`${" ".repeat(indent)}${paint(`› ${clipped}`, C.gray)}`);
    }
  }

  if (ordered.length > SIGNAL_LIMIT) {
    lines.push(`${" ".repeat(indent)}${paint(`+ ${ordered.length - SIGNAL_LIMIT} more — see --json`, C.gray)}`);
  }
  lines.push("");
  return lines;
}

function metrics(analysis: Report, paint: Paint, width: number): string[] {
  const m = analysis.metrics;
  const pairs: Array<[string, string]> = [
    ["package age", valueOrUnknown(m.packageAgeDays, (value) => plural(Math.round(value), "day"))],
    ["maintainers", String(m.maintainers)],
    ["version age", valueOrUnknown(m.versionAgeHours, (value) => plural(Math.round(value), "hour"))],
    ["dependencies", `${m.directDependencies} direct · ${m.optionalDependencies} opt · ${m.peerDependencies} peer`],
    ["entrypoints", `${plural(m.binCount, "bin")} · ${plural(m.lifecycleScriptCount, "lifecycle")}`],
    ["tarball", `${formatBytes(m.tarballBytes)} → ${formatBytes(m.unpackedBytes)}`],
    ["scanned", plural(m.scannedFiles, "file")]
  ];

  const labelWidth = Math.max(...pairs.map(([label]) => label.length));
  const cellWidth = Math.floor(width / 2);
  const lines = [paint("METRICS", C.bold, C.dim)];
  for (let i = 0; i < pairs.length; i += 2) {
    const left = renderPair(pairs[i], labelWidth, paint);
    const right = pairs[i + 1] ? renderPair(pairs[i + 1], labelWidth, paint) : "";
    lines.push(right ? `${padEndVisible(left, cellWidth)}${right}` : left);
  }
  lines.push("");
  return lines;
}

function footer(analysis: Report, paint: Paint, width: number): string[] {
  const lines: string[] = [];
  const flags: string[] = [];
  if (analysis.metrics.lifecycleScriptCount > 0) {
    flags.push(`runs ${plural(analysis.metrics.lifecycleScriptCount, "lifecycle script")} on install`);
  }
  if (analysis.metrics.binCount > 0) {
    flags.push(`${plural(analysis.metrics.binCount, "bin")} exposed to npx`);
  }
  if (flags.length) {
    const code = analysis.metrics.lifecycleScriptCount > 0 ? C.yellow : C.cyan;
    lines.push(...wrap(`⚑ ${flags.join(" · ")}`, width).map((line) => paint(line, code)));
    lines.push("");
  }
  lines.push(paint(`registry  ${analysis.packageUrl}`, C.dim));
  lines.push(paint(`tarball   ${analysis.manifest.dist?.tarball ?? "not available"}`, C.dim));
  return lines;
}

function boxed(title: string, body: string[], inner: number, paint: Paint, code: number): string[] {
  const span = inner + 2; // horizontal run between the corner glyphs (1-space pad each side)
  const leadVisible = 3 + title.length; // "─ " + title + " "
  const top = `${paint(`╭─ `, code)}${paint(title, code, C.bold)} ${paint("─".repeat(Math.max(0, span - leadVisible)), code)}${paint("╮", code)}`;
  const bottom = paint(`╰${"─".repeat(span)}╯`, code);
  const rows = body.map((line) => `${paint("│", code)} ${padEndVisible(line, inner)} ${paint("│", code)}`);
  return [top, ...rows, bottom];
}

function renderPair([label, value]: [string, string], labelWidth: number, paint: Paint): string {
  return `${paint(padEndVisible(label, labelWidth), C.dim)}  ${value}`;
}

function padBetween(left: string, right: string, width: number): string {
  const gap = width - visibleLen(left) - visibleLen(right);
  return `${left}${" ".repeat(Math.max(1, gap))}${right}`;
}

function countBySeverity(findings: Finding[]): Record<FindingSeverity, number> {
  const counts: Record<FindingSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

function valueOrUnknown(value: number | undefined, format: (value: number) => string): string {
  return value === undefined ? "unknown" : format(value);
}

export function formatMarkdown(analysis: Report): string {
  const findings = analysis.findings.length
    ? analysis.findings
        .map(
          (finding: Finding) =>
            `- **${finding.severity}** (${finding.category}/${finding.confidence}): ${finding.title} - ${finding.detail}`
        )
        .join("\n")
    : "- No notable signals found.";

  return [
    `# npxray: ${analysis.request.name}@${analysis.manifest.version}`,
    "",
    `**Risk:** ${analysis.riskLevel.toUpperCase()} (${analysis.riskScore}/100)`,
    "",
    analysis.recommendation,
    "",
    "## Findings",
    findings,
    "",
    "## Metrics",
    `- Breakdown: ${formatBreakdownMd(analysis.scoreBreakdown)}`,
    `- Package age: ${valueOrUnknown(analysis.metrics.packageAgeDays, (value) => `${Math.round(value)} days`)}`,
    `- Version age: ${valueOrUnknown(analysis.metrics.versionAgeHours, (value) => `${Math.round(value)} hours`)}`,
    `- Maintainers: ${analysis.metrics.maintainers}`,
    `- Dependencies: ${analysis.metrics.directDependencies} direct, ${analysis.metrics.optionalDependencies} optional, ${analysis.metrics.peerDependencies} peer`,
    `- Entrypoints: ${analysis.metrics.binCount} bin, ${analysis.metrics.lifecycleScriptCount} lifecycle scripts`,
    `- Tarball: ${formatBytes(analysis.metrics.tarballBytes)} download, ${formatBytes(analysis.metrics.unpackedBytes)} unpacked`,
    "",
    `Generated at ${analysis.generatedAt}.`
  ].join("\n");
}

function formatBreakdownMd(breakdown: ScoreBreakdown | undefined): string {
  if (!breakdown) return "unavailable";
  const items: [string, number][] = [
    ["capability", breakdown.capability],
    ["metadata", breakdown.metadata],
    ["dependency", breakdown.dependency],
    ["provenance", breakdown.provenance],
    ["anomaly", breakdown.anomaly],
    ["intelligence", breakdown.intelligence],
    ["bonus", breakdown.bonus]
  ];
  const parts = items.filter(([, value]) => value > 0);
  return parts.length ? parts.map(([label, value]) => `${label} ${value}`).join(", ") : "none";
}
