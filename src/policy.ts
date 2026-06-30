import { readFile } from "node:fs/promises";
import type { Report } from "./report.js";

export interface PolicyRule {
  pattern: string;
  versionRange?: string;
}

export interface LocalPolicy {
  riskBudget: number;
  enforcement: "warn" | "block";
  allow?: Array<string | PolicyRule>;
  deny?: Array<string | PolicyRule>;
}

export interface PolicyDecision {
  action: "allow" | "warn" | "block";
  reason: string;
}

export async function loadPolicy(path?: string): Promise<LocalPolicy | undefined> {
  if (!path) return undefined;
  const data = await readFile(path, "utf8");
  const policy = JSON.parse(data) as LocalPolicy;
  return {
    riskBudget: policy.riskBudget ?? 50,
    enforcement: policy.enforcement ?? "warn",
    allow: normalizeRules(policy.allow),
    deny: normalizeRules(policy.deny)
  };
}

export async function loadPolicyFromApi(input: {
  baseUrl?: string;
  workspaceId?: string;
  sessionToken?: string;
}): Promise<LocalPolicy | undefined> {
  if (!input.baseUrl || !input.workspaceId || !input.sessionToken) return undefined;
  const url = `${input.baseUrl.replace(/\/+$/, "")}/v1/workspaces/${input.workspaceId}/policy`;
  const response = await fetch(url, {
    headers: { cookie: `npxray_session=${input.sessionToken}` }
  }).catch((error: unknown) => {
    throw new Error(`Workspace policy sync failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!response.ok) {
    throw new Error(`Workspace policy sync failed: ${response.status} ${response.statusText || "response"}`);
  }
  const policy = (await response.json()) as LocalPolicy;
  return {
    riskBudget: policy.riskBudget ?? 50,
    enforcement: policy.enforcement ?? "warn",
    allow: normalizeRules(policy.allow),
    deny: normalizeRules(policy.deny)
  };
}

export function evaluatePolicy(report: Report, policy?: LocalPolicy): PolicyDecision {
  if (!policy) {
    return { action: "allow", reason: "No workspace policy configured." };
  }
  const spec = `${report.request.name}@${report.manifest.version}`;
  if (matchesAny(spec, report.request.name, report.manifest.version, policy.deny ?? [])) {
    return { action: "block", reason: `${spec} is denied by workspace policy.` };
  }
  if (matchesAny(spec, report.request.name, report.manifest.version, policy.allow ?? [])) {
    return { action: "allow", reason: `${spec} is allowed by workspace policy.` };
  }
  if (report.score >= policy.riskBudget) {
    const reason = `${spec} scored ${report.score}/100, meeting the workspace budget ${policy.riskBudget}.`;
    return { action: policy.enforcement === "block" ? "block" : "warn", reason };
  }
  return { action: "allow", reason: `${spec} is below the workspace budget.` };
}

function normalizeRules(rules: Array<string | PolicyRule> = []): PolicyRule[] {
  return rules.map((rule) => (typeof rule === "string" ? parseStringRule(rule) : rule));
}

function parseStringRule(rule: string): PolicyRule {
  const trimmed = rule.trim();
  const marker = trimmed.startsWith("@") ? trimmed.indexOf("@", 1) : trimmed.lastIndexOf("@");
  if (marker > 0) {
    const pattern = trimmed.slice(0, marker).trim();
    const versionRange = trimmed.slice(marker + 1).trim();
    if (pattern && versionRange) return { pattern, versionRange };
  }
  return { pattern: trimmed };
}

function matchesAny(spec: string, name: string, version: string, rules: Array<string | PolicyRule>): boolean {
  return normalizeRules(rules).some((rule) => {
    if (rule.pattern.endsWith("/*")) {
      if (!name.startsWith(rule.pattern.slice(0, -1))) return false;
    } else if (rule.pattern !== name && rule.pattern !== spec) {
      return false;
    }
    return versionRangeMatches(version, rule.versionRange);
  });
}

function versionRangeMatches(version: string, range?: string): boolean {
  if (!range) return true;
  const comparators = parseVersionComparators(range.trim());
  if (!comparators) return range.trim() === version;
  return comparators.every(({ operator, target }) => versionComparatorMatches(version, operator, target));
}

function parseVersionComparators(range: string): Array<{ operator: string; target: string }> | undefined {
  const comparators: Array<{ operator: string; target: string }> = [];
  let remaining = range;
  while (remaining.length > 0) {
    const match = remaining.match(/^(<=|<|>=|>|=)?\s*(\d+(?:\.\d+){0,2})(?:\s+|$)/);
    if (!match) return undefined;
    comparators.push({ operator: match[1] ?? "=", target: match[2] ?? "0" });
    remaining = remaining.slice(match[0].length).trim();
  }
  return comparators.length > 0 ? comparators : undefined;
}

function versionComparatorMatches(version: string, operator: string, target: string): boolean {
  const comparison = compareVersionsLoose(version, target);
  if (operator === "<") return comparison < 0;
  if (operator === "<=") return comparison <= 0;
  if (operator === ">") return comparison > 0;
  if (operator === ">=") return comparison >= 0;
  return comparison === 0;
}

function compareVersionsLoose(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}
