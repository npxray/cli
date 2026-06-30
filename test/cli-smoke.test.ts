import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = join(repoRoot, "src/index.ts");

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
}

async function runCliAsync(args: string[], env: NodeJS.ProcessEnv = {}) {
  const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  return { status, stdout, stderr };
}

describe("CLI command smoke", () => {
  it("prints command-specific help for inspect, compare, run, and alias", () => {
    const inspect = runCli(["inspect", "--help"]);
    expect(inspect.status).toBe(0);
    expect(inspect.stdout).toContain("npxray inspect");
    expect(inspect.stdout).toContain("--api-url <url>");
    expect(inspect.stdout).toContain("--local");
    expect(inspect.stdout).toContain("NPXRAY_API_TOKEN");

    const compare = runCli(["compare", "--help"]);
    expect(compare.status).toBe(0);
    expect(compare.stdout).toContain("npxray compare");
    expect(compare.stdout).toContain("<pkg@from> <pkg@to>");
    expect(compare.stdout).toContain("--local");

    const run = runCli(["run", "--help"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("npxray run");
    expect(run.stdout).toContain("--api-url <url>");
    expect(run.stdout).toContain("--local");
    expect(run.stdout).toContain("NPXRAY_LOCAL=1");

    const alias = runCli(["alias", "--help"]);
    expect(alias.status).toBe(0);
    expect(alias.stdout).toContain("npxray alias");
    expect(alias.stdout).toContain("--shell <shell>");
    expect(alias.stdout).toContain("--dry-run");
  });

  it("adds an idempotent zsh alias block to a selected profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "npxray-alias-zsh-"));
    const profile = join(dir, ".zshrc");

    const first = runCli(["alias", "--shell", "zsh", "--profile", profile], {
      HOME: dir,
      SHELL: "/bin/zsh"
    });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(`Added npxray alias in ${profile}`);
    expect(first.stdout).toContain("npx create-vite@latest my-app");

    const configured = readFileSync(profile, "utf8");
    expect(configured).toContain("# >>> npxray alias >>>");
    expect(configured).toContain("alias npx='npxray run --'");

    const second = runCli(["alias", "--shell", "zsh", "--profile", profile], {
      HOME: dir,
      SHELL: "/bin/zsh"
    });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already configured");
    expect(readFileSync(profile, "utf8")).toBe(configured);
  });

  it("shows fish alias dry-runs and printed snippets without writing", () => {
    const dir = mkdtempSync(join(tmpdir(), "npxray-alias-fish-"));
    const profile = join(dir, "config.fish");

    const dryRun = runCli(["alias", "--shell", "fish", "--profile", profile, "--dry-run"], {
      HOME: dir,
      SHELL: "/opt/homebrew/bin/fish"
    });
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain(`Profile: ${profile}`);
    expect(dryRun.stdout).toContain("function npx");
    expect(dryRun.stdout).toContain("npxray run -- $argv");
    expect(existsSync(profile)).toBe(false);

    const printed = runCli(["alias", "--shell", "fish", "--print"], {
      HOME: dir,
      SHELL: "/opt/homebrew/bin/fish"
    });
    expect(printed.status).toBe(0);
    expect(printed.stdout).not.toContain("Profile:");
    expect(printed.stdout).toContain("function npx");
    expect(existsSync(profile)).toBe(false);
  });

  it("refuses to override an existing npx alias without --force", () => {
    const dir = mkdtempSync(join(tmpdir(), "npxray-alias-conflict-"));
    const profile = join(dir, ".zshrc");
    writeFileSync(profile, "alias npx='something else'\n");

    const blocked = runCli(["alias", "--shell", "zsh", "--profile", profile], {
      HOME: dir,
      SHELL: "/bin/zsh"
    });
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("Found an existing npx alias");
    expect(readFileSync(profile, "utf8")).toBe("alias npx='something else'\n");

    const forced = runCli(["alias", "--shell", "zsh", "--profile", profile, "--force"], {
      HOME: dir,
      SHELL: "/bin/zsh"
    });
    expect(forced.status).toBe(0);
    expect(readFileSync(profile, "utf8")).toContain("alias npx='npxray run --'");
  });

  it("does not treat passthrough --help as npxray run help", async () => {
    const server = await startScanServer();
    try {
      const result = await runCliAsync(["run", "--dry-run", "--json", "--api-url", server.url, "--", "--help"]);

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("npxray run");
      expect(server.requests[0]?.body).toEqual({ spec: "--help", includeTarball: true });
    } finally {
      await closeServer(server.server);
    }
  });

  it("uses the anonymous scan API for inspect by default", async () => {
    const server = await startScanServer();
    try {
      const result = await runCliAsync(["inspect", "--json", "--api-url", server.url, "fixture-entrypoint@latest"]);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ request: { name: "remote-fixture" } });
      expect(server.requests).toEqual([
        {
          method: "POST",
          url: "/v1/scan",
          authorization: undefined,
          body: { spec: "fixture-entrypoint@latest", includeTarball: true }
        }
      ]);
    } finally {
      await closeServer(server.server);
    }
  });

  it("uses the token-authenticated scan API when NPXRAY_API_TOKEN is set", async () => {
    const server = await startScanServer();
    try {
      const result = await runCliAsync(["inspect", "--json", "--api-url", server.url, "fixture-entrypoint@latest"], {
        NPXRAY_API_TOKEN: "npxr_secret"
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ request: { name: "remote-fixture" } });
      expect(server.requests).toEqual([
        {
          method: "POST",
          url: "/v1/api/scan",
          authorization: "Bearer npxr_secret",
          body: { spec: "fixture-entrypoint@latest", includeTarball: true }
        }
      ]);
    } finally {
      await closeServer(server.server);
    }
  });

  it("sends only the package spec to the scan API for guarded runs", async () => {
    const server = await startScanServer();
    try {
      const result = await runCliAsync([
        "run",
        "--dry-run",
        "--json",
        "--api-url",
        server.url,
        "--",
        "create-vite@latest",
        "my-app",
        "--template",
        "react"
      ]);

      expect(result.status).toBe(0);
      const reportJson = result.stdout.slice(0, result.stdout.indexOf("\n\nDry run"));
      expect(JSON.parse(reportJson)).toMatchObject({ request: { name: "remote-fixture" } });
      expect(server.requests[0]?.body).toEqual({ spec: "create-vite@latest", includeTarball: true });
    } finally {
      await closeServer(server.server);
    }
  });

  it("falls back to the local engine when the scan API is unavailable", async () => {
    const server = await startScanServer({ status: 503 });
    const enginePath = makeFakeEngine(fakeReport("local-fixture", "1.0.0"));
    try {
      const result = await runCliAsync(["inspect", "--json", "--api-url", server.url, "fixture-entrypoint@latest"], {
        NPXRAY_ENGINE_PATH: enginePath
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ request: { name: "local-fixture" } });
      expect(result.stderr).toContain("falling back to local engine");
    } finally {
      await closeServer(server.server);
    }
  });

  it("fails closed on 4xx API scans before npm exec starts", async () => {
    const server = await startScanServer({ status: 401, body: { error: "invalid_api_key" } });
    const dir = mkdtempSync(join(tmpdir(), "npxray-api-fail-npm-"));
    const logPath = join(dir, "npm-args.txt");
    const npmPath = join(dir, "npm");
    writeFileSync(npmPath, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$NPXRAY_FAKE_NPM_LOG"\nexit 7\n');
    chmodSync(npmPath, 0o755);
    try {
      const result = await runCliAsync(["run", "--yes", "--api-url", server.url, "--", "fixture-entrypoint@latest"], {
        NPXRAY_FAKE_NPM_LOG: logPath,
        PATH: `${dir}:${process.env.PATH ?? ""}`
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("API scan failed: 401 invalid_api_key");
      expect(existsSync(logPath)).toBe(false);
    } finally {
      await closeServer(server.server);
    }
  });

  it("keeps --local scans off the API", async () => {
    const server = await startScanServer();
    const enginePath = makeFakeEngine(fakeReport("local-fixture", "1.0.0"));
    try {
      const result = await runCliAsync(
        ["inspect", "--local", "--json", "--api-url", server.url, "fixture-entrypoint@latest"],
        { NPXRAY_ENGINE_PATH: enginePath }
      );

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ request: { name: "local-fixture" } });
      expect(server.requests).toEqual([]);
    } finally {
      await closeServer(server.server);
    }
  });

  it("keeps local tarball and package directory scans off the API", async () => {
    const server = await startScanServer();
    const enginePath = makeFakeEngine(fakeReport("local-fixture", "1.0.0"));
    const dir = mkdtempSync(join(tmpdir(), "npxray-local-cli-"));
    const tarballPath = join(dir, "fixture.tgz");
    writeFileSync(tarballPath, "fake engine handles this");
    try {
      const tarball = await runCliAsync(["inspect", "--json", "--api-url", server.url, tarballPath], {
        NPXRAY_ENGINE_PATH: enginePath
      });
      const directory = await runCliAsync(["inspect", "--json", "--api-url", server.url, "."], {
        NPXRAY_ENGINE_PATH: enginePath
      });

      expect(tarball.status).toBe(0);
      expect(directory.status).toBe(0);
      expect(JSON.parse(tarball.stdout)).toMatchObject({ request: { name: "local-fixture" } });
      expect(JSON.parse(directory.stdout)).toMatchObject({ request: { name: "local-fixture" } });
      expect(server.requests).toEqual([]);
    } finally {
      await closeServer(server.server);
    }
  });

  it("prints JSON, Markdown, and SVG inspect output", () => {
    const json = runCli(["inspect", "--local", "--json", "fixture-severe@latest"], {
      NPXRAY_ENGINE_PATH: makeFakeEngine(fakeReport("fixture-severe", "1.0.0", 58))
    });
    expect(json.status).toBe(0);
    const report = JSON.parse(json.stdout) as { score: number; level: string };
    expect(report).toMatchObject({ score: 58, level: "high" });

    const markdown = runCli(["inspect", "--local", "--markdown", "fixture-lifecycle-extensionless@latest"], {
      NPXRAY_ENGINE_PATH: makeFakeEngine(fakeReport("fixture-lifecycle-extensionless", "1.0.0", 43))
    });
    expect(markdown.status).toBe(0);
    expect(markdown.stdout).toContain("fixture-lifecycle-extensionless");
    expect(markdown.stdout).toContain("43/100");

    const svg = runCli(["inspect", "--local", "--svg", "fixture-entrypoint-extensionless@latest"], {
      NPXRAY_ENGINE_PATH: makeFakeEngine(fakeReport("fixture-entrypoint-extensionless", "1.0.0", 43))
    });
    expect(svg.status).toBe(0);
    expect(svg.stdout.trim().startsWith("<svg")).toBe(true);
    expect(svg.stdout).toContain(">43<");
  });

  it("returns distinct guarded run exit codes", () => {
    const enginePath = makeFakeEngine(fakeReport("fixture-entrypoint", "1.0.0", 43));
    const dryRun = runCli(["run", "--dry-run", "--local", "--", "fixture-entrypoint-extensionless@latest"], {
      NPXRAY_ENGINE_PATH: enginePath
    });
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain("Dry run");

    const abort = runCli(["run", "--local", "--", "fixture-entrypoint@latest"], {
      NPXRAY_ENGINE_PATH: enginePath
    });
    expect(abort.status).toBe(2);
    expect(abort.stdout).toContain("Refusing to run without --yes");

    const dir = mkdtempSync(join(tmpdir(), "npxray-policy-"));
    const policyPath = join(dir, "policy.json");
    writeFileSync(policyPath, JSON.stringify({ riskBudget: 40, enforcement: "block" }));
    const blocked = runCli(["run", "--policy-file", policyPath, "--local", "--", "fixture-entrypoint@latest"], {
      NPXRAY_ENGINE_PATH: enginePath
    });
    expect(blocked.status).toBe(3);
    expect(blocked.stdout).toContain("Blocked by policy");
  });

  it("blocks guarded runs with a synced workspace API policy", async () => {
    const server = await startPolicyServer();
    const dir = mkdtempSync(join(tmpdir(), "npxray-remote-policy-npm-"));
    const logPath = join(dir, "npm-args.txt");
    const npmPath = join(dir, "npm");
    const enginePath = makeFakeEngine(fakeReport("fixture-entrypoint", "1.0.0", 43));
    writeFileSync(npmPath, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$NPXRAY_FAKE_NPM_LOG"\nexit 7\n');
    chmodSync(npmPath, 0o755);
    try {
      const blocked = await runCliAsync(
        [
          "run",
          "--yes",
          "--api-url",
          server.url,
          "--workspace",
          "workspace-team",
          "--session",
          "session-token",
          "--local",
          "--",
          "fixture-entrypoint@latest"
        ],
        {
          NPXRAY_FAKE_NPM_LOG: logPath,
          NPXRAY_ENGINE_PATH: enginePath,
          PATH: `${dir}:${process.env.PATH ?? ""}`
        }
      );

      expect(blocked.status).toBe(3);
      expect(blocked.stdout).toContain("Blocked by policy");
      expect(server.cookies).toContain("npxray_session=session-token");
    } finally {
      await closeServer(server.server);
    }
  });

  it("stops guarded runs when synced workspace policy fails", async () => {
    const server = await startPolicyServer({ status: 401 });
    const dir = mkdtempSync(join(tmpdir(), "npxray-remote-policy-fail-"));
    const logPath = join(dir, "npm-args.txt");
    const npmPath = join(dir, "npm");
    const enginePath = makeFakeEngine(fakeReport("fixture-entrypoint", "1.0.0", 43));
    writeFileSync(npmPath, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$NPXRAY_FAKE_NPM_LOG"\nexit 7\n');
    chmodSync(npmPath, 0o755);
    try {
      const result = await runCliAsync(
        [
          "run",
          "--yes",
          "--api-url",
          server.url,
          "--workspace",
          "workspace-team",
          "--session",
          "expired-session",
          "--local",
          "--",
          "fixture-entrypoint@latest"
        ],
        {
          NPXRAY_FAKE_NPM_LOG: logPath,
          NPXRAY_ENGINE_PATH: enginePath,
          PATH: `${dir}:${process.env.PATH ?? ""}`
        }
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Workspace policy sync failed: 401");
      expect(existsSync(logPath)).toBe(false);
      expect(server.cookies).toContain("npxray_session=expired-session");
    } finally {
      await closeServer(server.server);
    }
  });

  it("delegates approved runs to npm exec with normalized arguments", () => {
    const dir = mkdtempSync(join(tmpdir(), "npxray-fake-npm-"));
    const logPath = join(dir, "npm-args.txt");
    const npmPath = join(dir, "npm");
    const enginePath = makeFakeEngine(fakeReport("fixture-entrypoint", "1.0.0", 43));
    writeFileSync(npmPath, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$NPXRAY_FAKE_NPM_LOG"\nexit 7\n');
    chmodSync(npmPath, 0o755);

    const result = runCli(
      [
        "run",
        "--yes",
        "--local",
        "--",
        "npx",
        "--package",
        "fixture-entrypoint@latest",
        "--",
        "fixture-entrypoint",
        "--hello"
      ],
      {
        NPXRAY_FAKE_NPM_LOG: logPath,
        NPXRAY_ENGINE_PATH: enginePath,
        PATH: `${dir}:${process.env.PATH ?? ""}`
      }
    );

    expect(result.status).toBe(7);
    expect(result.stdout).toContain("fixture-entrypoint@1.0.0");
    expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual([
      "exec",
      "--package",
      "fixture-entrypoint@latest",
      "--",
      "fixture-entrypoint",
      "--hello"
    ]);
  });
});

async function startPolicyServer(
  options: { status?: number } = {}
): Promise<{ server: Server; url: string; cookies: string[] }> {
  const cookies: string[] = [];
  const status = options.status ?? 200;
  const server = createServer((request, response) => {
    cookies.push(request.headers.cookie ?? "");
    response.setHeader("connection", "close");
    response.shouldKeepAlive = false;
    if (request.method === "GET" && request.url === "/v1/workspaces/workspace-team/policy") {
      if (status !== 200) {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unauthenticated" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          riskBudget: 50,
          enforcement: "block",
          allow: [],
          deny: [{ pattern: "fixture-entrypoint", versionRange: "< 2.0" }]
        })
      );
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}`, cookies };
}

async function startScanServer(options: { status?: number; body?: unknown } = {}): Promise<{
  server: Server;
  url: string;
  requests: Array<{ method?: string; url?: string; authorization?: string; body: unknown }>;
}> {
  const requests: Array<{ method?: string; url?: string; authorization?: string; body: unknown }> = [];
  const status = options.status ?? 200;
  const body = options.body ?? { report: fakeReport("remote-fixture", "1.0.0"), cached: true };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: rawBody ? JSON.parse(rawBody) : undefined
    });
    response.setHeader("connection", "close");
    response.shouldKeepAlive = false;
    if (request.method === "POST" && (request.url === "/v1/scan" || request.url === "/v1/api/scan")) {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}`, requests };
}

function makeFakeEngine(report: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "npxray-fake-engine-"));
  const path = join(dir, "npxray-engine");
  writeFileSync(path, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(report)}\nJSON\n`);
  chmodSync(path, 0o755);
  return path;
}

function fakeReport(name: string, version: string, score = 0) {
  const level = score >= 50 ? "high" : score >= 40 ? "watch" : "low";
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
    findings:
      score > 0
        ? [
            {
              id: "fake-signal",
              severity: "medium",
              category: "anomaly",
              confidence: "high",
              title: "Fake risk signal",
              detail: "A deterministic fake signal for CLI smoke tests.",
              files: [],
              weight: score
            }
          ]
        : [],
    score,
    level,
    riskScore: score,
    riskLevel: level,
    scoreBreakdown: {
      total: score,
      capability: 0,
      metadata: 0,
      dependency: 0,
      anomaly: score,
      intelligence: 0,
      provenance: 0
    },
    recommendation: score > 0 ? "Review before running." : "No notable signals found.",
    scannedFiles: [],
    dependencyTree: { nodes: [], edges: [], truncated: false },
    generatedAt: "2026-06-26T12:00:00Z",
    engineVersion: "0.4.0",
    cacheKey: `fake-${name}`,
    shareCard: {
      title: "Would you run this?",
      subtitle: `${name}@${version} scored ${score}/100`,
      score,
      level,
      packageName: name,
      packageVersion: version,
      topFindings: [],
      stats: []
    }
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
