import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Report } from "../src/report";
import { extractPackageSpecForRemote, inspectWithScanner, isLocalPackageSpec, resolveApiUrl } from "../src/scan";

const originalEnginePath = process.env.NPXRAY_ENGINE_PATH;

describe("API-first scan routing", () => {
  beforeEach(() => {
    delete process.env.NPXRAY_ENGINE_PATH;
  });

  afterEach(() => {
    if (originalEnginePath === undefined) delete process.env.NPXRAY_ENGINE_PATH;
    else process.env.NPXRAY_ENGINE_PATH = originalEnginePath;
  });

  it("extracts package specs without command args for remote scans", () => {
    expect(extractPackageSpecForRemote(["create-vite@latest", "my-app", "--template", "react"])).toBe(
      "create-vite@latest"
    );
    expect(extractPackageSpecForRemote(["npx", "--package", "fixture-entrypoint@latest", "--", "fixture"])).toBe(
      "fixture-entrypoint@latest"
    );
    expect(extractPackageSpecForRemote(["npm", "x", "fixture-entrypoint@latest", "--", "fixture"])).toBe(
      "fixture-entrypoint@latest"
    );
    expect(extractPackageSpecForRemote(["npm", "create", "vite", "my-app"])).toBe("create-vite");
    expect(extractPackageSpecForRemote(["npm", "init", "vite", "my-app"])).toBe("create-vite");
    expect(extractPackageSpecForRemote(["npx shadcn@latest init"])).toBe("shadcn@latest");
  });

  it("detects local package specs without catching scoped package names", () => {
    expect(isLocalPackageSpec("./package.tgz")).toBe(true);
    expect(isLocalPackageSpec("file:../package.tgz")).toBe(true);
    expect(isLocalPackageSpec(".")).toBe(true);
    expect(isLocalPackageSpec("/tmp/package")).toBe(true);
    expect(isLocalPackageSpec("package.tgz")).toBe(true);
    expect(isLocalPackageSpec("@scope/package")).toBe(false);
    expect(isLocalPackageSpec("create-vite@latest")).toBe(false);
  });

  it("defaults to the hosted API origin unless overridden", () => {
    expect(resolveApiUrl(undefined, {})).toBe("https://api.npxray.dev");
    expect(resolveApiUrl("https://api.test/", {})).toBe("https://api.test");
    expect(resolveApiUrl(undefined, { NPXRAY_API_URL: "https://env.test/" })).toBe("https://env.test");
  });

  it("uses an anonymous API scan response as the report", async () => {
    const requests: Array<{ url: string; authorization?: string; body: unknown }> = [];
    const result = await inspectWithScanner(["fixture-entrypoint@latest"], {
      env: { NPXRAY_API_URL: "https://api.test" },
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          authorization:
            init?.headers instanceof Headers
              ? (init.headers.get("authorization") ?? undefined)
              : ((init?.headers as Record<string, string> | undefined)?.authorization ?? undefined),
          body: JSON.parse(String(init?.body))
        });
        return jsonResponse({ report: fakeReport("api-fixture", "1.0.0") });
      }
    });

    expect(result.source).toBe("api");
    expect(result.report.request.name).toBe("api-fixture");
    expect(requests).toEqual([
      {
        url: "https://api.test/v1/scan",
        authorization: undefined,
        body: { spec: "fixture-entrypoint@latest", includeTarball: true }
      }
    ]);
  });

  it("uses the token-authenticated scan route when an API token is configured", async () => {
    const requests: Array<{ url: string; authorization?: string }> = [];
    await inspectWithScanner(["fixture-entrypoint@latest"], {
      env: { NPXRAY_API_URL: "https://api.test", NPXRAY_API_TOKEN: "npxr_secret" },
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          authorization: (init?.headers as Record<string, string> | undefined)?.authorization
        });
        return jsonResponse({ report: fakeReport("api-fixture", "1.0.0") });
      }
    });

    expect(requests).toEqual([{ url: "https://api.test/v1/api/scan", authorization: "Bearer npxr_secret" }]);
  });

  it("falls back to the local engine when the API is unavailable", async () => {
    process.env.NPXRAY_ENGINE_PATH = makeFakeEngine(fakeReport("local-fixture", "1.0.0"));
    let stderr = "";
    const result = await inspectWithScanner(["fixture-entrypoint@latest"], {
      env: { NPXRAY_API_URL: "https://api.test" },
      stderr: {
        write: (chunk: string | Uint8Array) => {
          stderr += String(chunk);
          return true;
        }
      },
      fetchImpl: async () => jsonResponse({ error: "temporarily_unavailable" }, 503, "Service Unavailable")
    });

    expect(result.source).toBe("local");
    expect(result.report.request.name).toBe("local-fixture");
    expect(stderr).toContain("falling back to local engine");
  });

  it("fails closed on 4xx API responses", async () => {
    process.env.NPXRAY_ENGINE_PATH = makeFakeEngine(fakeReport("local-fixture", "1.0.0"));
    await expect(
      inspectWithScanner(["fixture-entrypoint@latest"], {
        env: { NPXRAY_API_URL: "https://api.test" },
        fetchImpl: async () => jsonResponse({ error: "invalid_api_key" }, 401, "Unauthorized")
      })
    ).rejects.toThrow("API scan failed: 401 invalid_api_key");
  });

  it("keeps diagnostic fixture scans local", async () => {
    process.env.NPXRAY_ENGINE_PATH = makeFakeEngine(fakeReport("local-fixture", "1.0.0"));
    let calls = 0;
    const result = await inspectWithScanner(["fixture-entrypoint@latest"], {
      fixtureDir: "conformance/fixtures",
      now: "2026-06-26T12:00:00Z",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ report: fakeReport("api-fixture", "1.0.0") });
      }
    });

    expect(result.source).toBe("local");
    expect(result.report.request.name).toBe("local-fixture");
    expect(calls).toBe(0);
  });

  it("keeps local tarball and package directory scans local", async () => {
    process.env.NPXRAY_ENGINE_PATH = makeFakeEngine(fakeReport("local-fixture", "1.0.0"));
    const dir = mkdtempSync(join(tmpdir(), "npxray-local-input-"));
    const tarballPath = join(dir, "fixture.tgz");
    writeFileSync(tarballPath, "not a real tarball; fake engine handles it");
    let calls = 0;

    const tarball = await inspectWithScanner([tarballPath], {
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ report: fakeReport("api-fixture", "1.0.0") });
      }
    });
    const directory = await inspectWithScanner(["."], {
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({ report: fakeReport("api-fixture", "1.0.0") });
      }
    });

    expect(tarball.source).toBe("local");
    expect(directory.source).toBe("local");
    expect(tarball.report.request.name).toBe("local-fixture");
    expect(directory.report.request.name).toBe("local-fixture");
    expect(calls).toBe(0);
  });
});

function makeFakeEngine(report: Report): string {
  const dir = mkdtempSync(join(tmpdir(), "npxray-fake-engine-"));
  const path = join(dir, "npxray-engine");
  writeFileSync(path, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(report)}\nJSON\n`);
  chmodSync(path, 0o755);
  return path;
}

function jsonResponse(body: unknown, status = 200, statusText = "OK"): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" }
  });
}

function fakeReport(name: string, version: string): Report {
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
    findings: [],
    score: 0,
    level: "low",
    riskScore: 0,
    riskLevel: "low",
    scoreBreakdown: { total: 0, capability: 0, metadata: 0, dependency: 0, anomaly: 0, intelligence: 0, provenance: 0 },
    recommendation: "No notable signals found.",
    scannedFiles: [],
    dependencyTree: { nodes: [], edges: [], truncated: false },
    generatedAt: "2026-06-26T12:00:00Z",
    engineVersion: "0.3.0",
    cacheKey: `fake-${name}`,
    shareCard: {
      title: "Would you run this?",
      subtitle: `${name}@${version} scored 0/100`,
      score: 0,
      level: "low",
      packageName: name,
      packageVersion: version,
      topFindings: [],
      stats: []
    }
  } as Report;
}
