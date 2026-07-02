import { describe, expect, it } from "bun:test";
import { formatMarkdown, formatReport, sanitizeTerminal } from "../src/format";
import type { Report } from "../src/report";

describe("terminal output sanitization", () => {
  it("removes ANSI color escape bytes while preserving visible text", () => {
    const esc = String.fromCharCode(27);
    const result = sanitizeTerminal(`${esc}[31mLOW RISK${esc}[0m`);

    expect(result.includes(esc)).toBe(false);
    expect(result).toContain("LOW RISK");
  });

  it("removes cursor-control escape bytes", () => {
    const esc = String.fromCharCode(27);
    const result = sanitizeTerminal(`a${esc}[1Ab`);

    expect(result.includes(esc)).toBe(false);
  });

  it("preserves tabs and newlines", () => {
    expect(sanitizeTerminal("a\tb\nc")).toBe("a\tb\nc");
  });

  it("strips terminal escapes from rendered report findings", () => {
    const esc = String.fromCharCode(27);
    const report = fakeReport();
    report.findings = [
      {
        id: "escape-title",
        severity: "high",
        category: "anomaly",
        confidence: "high",
        title: `Lifecycle script clears line ${esc}[2K`,
        detail: `A package script used cursor controls ${esc}[1A`,
        evidence: `postinstall: ${esc}[31mrm -rf${esc}[0m`,
        files: [`scripts/${esc}[2Kpostinstall.js`],
        weight: 20
      }
    ];

    const rendered = formatReport(report, { color: false, columns: 80 });

    expect(rendered).not.toContain(`${esc}[2K`);
    expect(rendered).not.toContain(`${esc}[1A`);
    expect(rendered).not.toContain(`${esc}[31m`);
    expect(rendered).toContain("Lifecycle script clears line");
  });

  it("strips ESC bytes from rendered report manifest versions", () => {
    const ESC = String.fromCharCode(0x1b);
    const report = fakeReport();
    report.manifest.version = `1.0.0${ESC}[2K${ESC}[1A`;

    const output = formatReport(report, { color: false, columns: 80 });

    expect(output.includes(ESC)).toBe(false);
    expect(output).toContain("escape-fixture@1.0.0[2K[1A");
  });

  it("strips ESC bytes from markdown manifest versions", () => {
    const ESC = String.fromCharCode(0x1b);
    const report = fakeReport();
    report.manifest.version = `1.0.0${ESC}[2K${ESC}[1A`;

    const output = formatMarkdown(report);

    expect(output.includes(ESC)).toBe(false);
    expect(output).toContain("# npxray: escape-fixture@1.0.0[2K[1A");
  });

  it("strips C1 bytes from rendered report manifest versions", () => {
    const c1 = String.fromCharCode(0x9b);
    const report = fakeReport();
    report.manifest.version = `1.0.0${c1}[2K`;

    const output = formatReport(report, { color: false, columns: 80 });

    expect(output.includes(c1)).toBe(false);
    expect(output).toContain("escape-fixture@1.0.0[2K");
  });
});

function fakeReport(): Report {
  return {
    request: {
      raw: "escape-fixture@1.0.0",
      name: "escape-fixture",
      requested: "1.0.0",
      normalizedSpec: "escape-fixture@1.0.0",
      commandArgs: [],
      source: "package"
    },
    packageUrl: "https://registry.npmjs.org/escape-fixture",
    registryUrl: "https://registry.npmjs.org",
    manifest: {
      name: "escape-fixture",
      version: "1.0.0",
      dist: {
        tarball: "https://registry.npmjs.org/escape-fixture/-/escape-fixture-1.0.0.tgz"
      }
    },
    packumentSummary: { tags: {} },
    metrics: {
      maintainers: 1,
      directDependencies: 0,
      optionalDependencies: 0,
      peerDependencies: 0,
      binCount: 0,
      lifecycleScriptCount: 1,
      tarballBytes: 512,
      unpackedBytes: 1024,
      scannedFiles: 1,
      transitiveDependencies: 0,
      dependencyTreeTruncated: false
    },
    findings: [],
    score: 40,
    level: "watch",
    riskScore: 40,
    riskLevel: "watch",
    scoreBreakdown: {
      total: 40,
      capability: 0,
      metadata: 0,
      dependency: 0,
      anomaly: 40,
      intelligence: 0,
      provenance: 0,
      bonus: 0
    },
    recommendation: "Review before running.",
    scannedFiles: [],
    dependencyTree: { nodes: [], edges: [], truncated: false },
    generatedAt: "2026-06-26T12:00:00Z",
    engineVersion: "0.4.0",
    cacheKey: "fake-escape-fixture",
    shareCard: {
      title: "Would you run this?",
      subtitle: "escape-fixture@1.0.0 scored 40/100",
      score: 40,
      level: "watch",
      packageName: "escape-fixture",
      packageVersion: "1.0.0",
      topFindings: [],
      stats: []
    }
  } as Report;
}
