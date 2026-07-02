import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectWithEngine, resolveEngineCommand } from "../src/engine";
import { evaluatePolicy, loadPolicyFromApi } from "../src/policy";
import type { Finding, FindingSeverity, Report } from "../src/report";

const originalEnginePath = process.env.NPXRAY_ENGINE_PATH;
const packageRoot = resolve(import.meta.dir, "..");

describe("local engine resolution", () => {
  afterEach(() => {
    if (originalEnginePath === undefined) delete process.env.NPXRAY_ENGINE_PATH;
    else process.env.NPXRAY_ENGINE_PATH = originalEnginePath;
    rmSync(join(packageRoot, ".npxray-engine"), { force: true, recursive: true });
  });

  it("uses NPXRAY_ENGINE_PATH first", () => {
    const enginePath = makeFakeEngine(fakeReport("fixture-entrypoint", "1.0.0"));
    process.env.NPXRAY_ENGINE_PATH = enginePath;

    expect(resolveEngineCommand()).toEqual({ command: enginePath, args: [] });
  });

  it("uses the local development engine path when present", async () => {
    delete process.env.NPXRAY_ENGINE_PATH;
    const target = engineTarget();
    const binary = process.platform === "win32" ? "npxray-engine.exe" : "npxray-engine";
    if (optionalEngineInstalled(target, binary)) return;

    const enginePath = join(packageRoot, ".npxray-engine", target, binary);
    mkdirSync(join(packageRoot, ".npxray-engine", target), { recursive: true });
    writeFileSync(enginePath, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(fakeReport("dev-fixture", "1.0.0"))}'\n`);
    chmodSync(enginePath, 0o755);

    expect(resolveEngineCommand()).toEqual({ command: enginePath, args: [] });
    await expect(inspectWithEngine(["dev-fixture@latest"], {})).resolves.toMatchObject({
      request: { name: "dev-fixture" }
    });
  });

  it("fails clearly when no local engine is available", () => {
    delete process.env.NPXRAY_ENGINE_PATH;
    if (optionalEngineInstalled(engineTarget(), process.platform === "win32" ? "npxray-engine.exe" : "npxray-engine")) {
      return;
    }

    expect(() => resolveEngineCommand()).toThrow(
      /Install @npxray\/engine-bin-.* as an optional dependency or set NPXRAY_ENGINE_PATH/
    );
  });
});

describe("local policy evaluation", () => {
  it("blocks packages that meet a blocking workspace budget", () => {
    const report = fakeReport("fixture-entrypoint", "1.0.0", 43);

    expect(evaluatePolicy(report, { riskBudget: 40, enforcement: "block" })).toEqual({
      action: "block",
      reason: "fixture-entrypoint@1.0.0 scored 43/100, meeting the workspace budget 40."
    });
  });

  it("blocks version-scoped deny rules", () => {
    const report = fakeReport("fixture-entrypoint", "1.0.0", 43);

    expect(
      evaluatePolicy(report, {
        riskBudget: 100,
        enforcement: "block",
        deny: [{ pattern: "fixture-entrypoint", versionRange: "< 2.0" }]
      })
    ).toEqual({
      action: "block",
      reason: "fixture-entrypoint@1.0.0 is denied by workspace policy."
    });
  });

  it("blocks composite version-scoped deny rules", () => {
    const report = fakeReport("fixture-entrypoint", "1.0.0", 43);

    expect(
      evaluatePolicy(report, {
        riskBudget: 100,
        enforcement: "block",
        deny: [{ pattern: "fixture-entrypoint", versionRange: ">=1 <2" }]
      })
    ).toEqual({
      action: "block",
      reason: "fixture-entrypoint@1.0.0 is denied by workspace policy."
    });
  });

  it("parses string deny rules with package version ranges", () => {
    const report = fakeReport("fixture-entrypoint", "1.0.0", 43);

    expect(
      evaluatePolicy(report, {
        riskBudget: 100,
        enforcement: "block",
        deny: ["fixture-entrypoint@>=1 <2", "@scope/pkg@>=5"]
      })
    ).toEqual({
      action: "block",
      reason: "fixture-entrypoint@1.0.0 is denied by workspace policy."
    });
  });

  it("blocks reports with a matching signal rule below the score budget", () => {
    const report = fakeReport("fixture-entrypoint", "1.0.0", 12, [fakeFinding("code-shell-exec", "high")]);

    expect(
      evaluatePolicy(report, {
        riskBudget: 100,
        enforcement: "warn",
        signalRules: [{ signal: "code-shell-exec", action: "block" }]
      })
    ).toEqual({
      action: "block",
      reason: "fixture-entrypoint@1.0.0 blocked: finding code-shell-exec (high) present."
    });
  });

  it("blocks reports with a matching severity rule", () => {
    const report = fakeReport("fixture-entrypoint", "1.0.0", 12, [
      fakeFinding("entrypoint-sensitive-code", "critical")
    ]);

    expect(
      evaluatePolicy(report, {
        riskBudget: 100,
        enforcement: "warn",
        signalRules: [{ severity: "critical", action: "block" }]
      })
    ).toEqual({
      action: "block",
      reason: "fixture-entrypoint@1.0.0 blocked: finding entrypoint-sensitive-code (critical) present."
    });
  });

  it("ignores findings when no signal rules are configured", () => {
    const report = fakeReport("fixture-entrypoint", "1.0.0", 12, [
      fakeFinding("entrypoint-sensitive-code", "critical")
    ]);

    expect(evaluatePolicy(report, { riskBudget: 100, enforcement: "block" })).toEqual({
      action: "allow",
      reason: "fixture-entrypoint@1.0.0 is below the workspace budget."
    });
  });

  it("keeps explicit deny precedence over signal rules", () => {
    const report = fakeReport("fixture-entrypoint", "1.0.0", 12, [fakeFinding("code-shell-exec", "high")]);

    expect(
      evaluatePolicy(report, {
        riskBudget: 100,
        enforcement: "warn",
        deny: [{ pattern: "fixture-entrypoint" }],
        signalRules: [{ signal: "code-shell-exec", action: "block" }]
      })
    ).toEqual({
      action: "block",
      reason: "fixture-entrypoint@1.0.0 is denied by workspace policy."
    });
  });
});

describe("workspace policy sync", () => {
  it("loads a policy from the API with the session cookie", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; cookie?: string }> = [];
    globalThis.fetch = (async (url, init) => {
      requests.push({
        url: String(url),
        cookie:
          init?.headers instanceof Headers
            ? (init.headers.get("cookie") ?? undefined)
            : ((init?.headers as Record<string, string> | undefined)?.cookie ?? undefined)
      });
      return new Response(
        JSON.stringify({
          riskBudget: 42,
          enforcement: "block",
          allow: ["@acme/*"],
          deny: [{ pattern: "fixture-entrypoint", versionRange: "< 2.0" }]
        }),
        { headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    try {
      await expect(
        loadPolicyFromApi({
          baseUrl: "https://api.test/",
          workspaceId: "workspace-team",
          sessionToken: "session-token"
        })
      ).resolves.toEqual({
        riskBudget: 42,
        enforcement: "block",
        allow: [{ pattern: "@acme/*" }],
        deny: [{ pattern: "fixture-entrypoint", versionRange: "< 2.0" }],
        signalRules: []
      });
      expect(requests).toEqual([
        {
          url: "https://api.test/v1/workspaces/workspace-team/policy",
          cookie: "npxray_session=session-token"
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails closed when the API policy request is rejected", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "unauthenticated" }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "content-type": "application/json" }
      })) as typeof fetch;

    try {
      await expect(
        loadPolicyFromApi({
          baseUrl: "https://api.test/",
          workspaceId: "workspace-team",
          sessionToken: "expired-session"
        })
      ).rejects.toThrow("Workspace policy sync failed: 401");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function makeFakeEngine(report: Report): string {
  const dir = mkdtempSync(join(tmpdir(), "npxray-fake-engine-"));
  const path = join(dir, "npxray-engine");
  writeFileSync(path, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(report)}\nJSON\n`);
  chmodSync(path, 0o755);
  return path;
}

function engineTarget(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  return `${os}-${arch}`;
}

function optionalEngineInstalled(target: string, binary: string): boolean {
  try {
    const command = resolveEngineCommand().command;
    return command.includes(`engine-bin-${target}`) && command.endsWith(join("bin", binary));
  } catch {
    return false;
  }
}

function fakeReport(name: string, version: string, score = 0, findings: Finding[] = []): Report {
  return {
    request: {
      raw: `${name}@${version}`,
      name,
      requested: version,
      normalizedSpec: `${name}@${version}`,
      commandArgs: [],
      source: "package"
    },
    packageUrl: `https://registry.npmjs.org/${name}`,
    registryUrl: "https://registry.npmjs.org",
    manifest: { name, version, dist: {} },
    packumentSummary: { tags: {} },
    metrics: {
      maintainers: 1,
      directDependencies: 0,
      optionalDependencies: 0,
      peerDependencies: 0,
      binCount: 0,
      lifecycleScriptCount: 0,
      scannedFiles: 0,
      transitiveDependencies: 0,
      dependencyTreeTruncated: false
    },
    findings,
    score,
    level: score >= 40 ? "watch" : "low",
    riskScore: score,
    riskLevel: score >= 40 ? "watch" : "low",
    scoreBreakdown: {
      total: score,
      capability: 0,
      metadata: 0,
      dependency: 0,
      anomaly: score,
      intelligence: 0,
      provenance: 0
    },
    recommendation: "Review before running.",
    scannedFiles: [],
    dependencyTree: { nodes: [], edges: [], truncated: false },
    generatedAt: "2026-06-26T12:00:00Z",
    engineVersion: "0.4.0",
    cacheKey: `fake-${name}`,
    shareCard: {
      title: "Would you run this?",
      subtitle: `${name}@${version} scored ${score}/100`,
      score,
      level: score >= 40 ? "watch" : "low",
      packageName: name,
      packageVersion: version,
      topFindings: [],
      stats: []
    }
  } as Report;
}

function fakeFinding(id: string, severity: FindingSeverity): Finding {
  return {
    id,
    severity,
    category: "capability",
    confidence: "high",
    title: id,
    detail: `${id} detail`,
    weight: 16
  };
}
