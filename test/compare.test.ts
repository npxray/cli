import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comparePackages, formatCompareResult, type VersionCompareResult } from "../src/compare";

const originalEnginePath = process.env.NPXRAY_ENGINE_PATH;

describe("compare command scanner", () => {
  afterEach(() => {
    if (originalEnginePath === undefined) delete process.env.NPXRAY_ENGINE_PATH;
    else process.env.NPXRAY_ENGINE_PATH = originalEnginePath;
  });

  it("calls the compare API by default", async () => {
    const requests: string[] = [];
    const comparison = fakeComparison("fixture-entrypoint", "1.0.0", "2.0.0");
    const result = await comparePackages(["fixture-entrypoint@1.0.0", "fixture-entrypoint@2.0.0"], {
      env: { NPXRAY_API_URL: "https://api.test" },
      fetchImpl: async (url) => {
        requests.push(String(url));
        return new Response(JSON.stringify(comparison), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });

    expect(result.source).toBe("api");
    expect(result.comparison.scoreDelta).toBe(30);
    expect(requests).toEqual(["https://api.test/v1/compare?pkg=fixture-entrypoint&a=1.0.0&b=2.0.0"]);
  });

  it("falls back to two local engine scans when the compare API is unavailable", async () => {
    process.env.NPXRAY_ENGINE_PATH = makeVersionedFakeEngine();
    let stderr = "";
    const result = await comparePackages(["fixture-entrypoint@1.0.0", "fixture-entrypoint@2.0.0"], {
      env: { NPXRAY_API_URL: "https://api.test" },
      stderr: {
        write: (chunk: string | Uint8Array) => {
          stderr += String(chunk);
          return true;
        }
      },
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "content-type": "application/json" }
        })
    });

    expect(result.source).toBe("local");
    expect(result.comparison.fromVersion).toBe("1.0.0");
    expect(result.comparison.toVersion).toBe("2.0.0");
    expect(result.comparison.scoreDelta).toBe(25);
    expect(stderr).toContain("falling back to local engine");
    expect(formatCompareResult(result.comparison)).toContain("risk increased");
  });

  it("requires matching package names with explicit versions", async () => {
    await expect(comparePackages(["left@1.0.0", "right@2.0.0"], { local: true })).rejects.toThrow("same package name");
    await expect(comparePackages(["fixture-entrypoint", "fixture-entrypoint@2.0.0"], { local: true })).rejects.toThrow(
      "explicit version"
    );
  });
});

function makeVersionedFakeEngine(): string {
  const dir = mkdtempSync(join(tmpdir(), "npxray-compare-engine-"));
  const path = join(dir, "npxray-engine");
  writeFileSync(
    path,
    `#!/bin/sh
spec="$#"
for arg in "$@"; do
  spec="$arg"
done
case "$spec" in
  *@1.0.0) version="1.0.0"; score=5 ;;
  *@2.0.0) version="2.0.0"; score=30 ;;
  *) version="0.0.0"; score=0 ;;
esac
VERSION="$version" SCORE="$score" node -e 'const version=process.env.VERSION,score=Number(process.env.SCORE); console.log(JSON.stringify({
  request:{raw:"fixture-entrypoint@"+version,name:"fixture-entrypoint",requested:version,normalizedSpec:"fixture-entrypoint@"+version,commandArgs:[],source:"package"},
  packageUrl:"https://registry.npmjs.org/fixture-entrypoint",
  registryUrl:"https://registry.npmjs.org",
  manifest:{name:"fixture-entrypoint",version,dist:{}},
  packumentSummary:{tags:{}},
  metrics:{maintainers:1,directDependencies:score>10?2:0,optionalDependencies:0,peerDependencies:0,binCount:0,lifecycleScriptCount:score>10?1:0,tarballBytes:score*100,scannedFiles:0,transitiveDependencies:0,dependencyTreeTruncated:false},
  findings:score>10?[{id:"new-lifecycle-script",severity:"medium",category:"anomaly",confidence:"high",title:"New lifecycle script",detail:"A lifecycle script appeared.",files:[],weight:20}]:[],
  score,level:score>10?"watch":"low",riskScore:score,riskLevel:score>10?"watch":"low",
  scoreBreakdown:{total:score,capability:0,metadata:0,dependency:0,anomaly:score,intelligence:0,provenance:0,bonus:0},
  recommendation:"Review before running.",scannedFiles:[],dependencyTree:{nodes:[],edges:[],truncated:false},
  generatedAt:"2026-06-26T12:00:00Z",engineVersion:"0.4.0",cacheKey:"fake-"+version,
  shareCard:{title:"Would you run this?",subtitle:"fixture-entrypoint@"+version+" scored "+score+"/100",score,level:score>10?"watch":"low",packageName:"fixture-entrypoint",packageVersion:version,topFindings:[],stats:[]}
}))'
`
  );
  chmodSync(path, 0o755);
  return path;
}

function fakeComparison(name: string, fromVersion: string, toVersion: string): VersionCompareResult {
  return {
    packageName: name,
    fromVersion,
    toVersion,
    scoreDelta: 30,
    riskDirection: "increased",
    cached: { from: false, to: true },
    from: {
      scan: {},
      version: fromVersion,
      score: 10,
      level: "low",
      recommendation: "Looks ok.",
      summary: "No notable signals found."
    },
    to: {
      scan: {},
      version: toVersion,
      score: 40,
      level: "watch",
      recommendation: "Review before running.",
      summary: "New lifecycle script"
    },
    signals: {
      added: [],
      removed: [],
      unchanged: []
    },
    metrics: []
  };
}
