import { readFile } from "node:fs/promises";
import {
  evaluateWorkspacePolicy,
  parseWorkspacePolicy,
  WorkspacePolicyValidationError,
  type PolicyDecision,
  type PolicyRule,
  type SignalRule,
  type WorkspacePolicy
} from "@npxray/contracts";
import type { Report } from "./report.js";

/** Loaded workspace policy; alias kept for existing CLI call sites and tests. */
export type LocalPolicy = WorkspacePolicy;

export type { PolicyDecision, PolicyRule, SignalRule, WorkspacePolicy };

export async function loadPolicy(path?: string): Promise<WorkspacePolicy | undefined> {
  if (!path) return undefined;

  let data: string;
  try {
    data = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Failed to read policy file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new Error(`Invalid policy file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    return parseWorkspacePolicy(parsed);
  } catch (error) {
    if (error instanceof WorkspacePolicyValidationError) {
      throw new Error(`Invalid policy file ${path}: ${error.message}`);
    }
    throw error;
  }
}

export async function loadPolicyFromApi(input: {
  baseUrl?: string;
  workspaceId?: string;
  sessionToken?: string;
}): Promise<WorkspacePolicy | undefined> {
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

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(
      `Workspace policy sync failed: invalid JSON (${error instanceof Error ? error.message : String(error)})`
    );
  }

  try {
    return parseWorkspacePolicy(payload);
  } catch (error) {
    if (error instanceof WorkspacePolicyValidationError) {
      throw new Error(`Workspace policy sync failed: invalid policy: ${error.message}`);
    }
    throw error;
  }
}

/** Prefer a local policy file; otherwise sync from the workspace API when credentials are present. */
export async function resolvePolicy(input: {
  policyFile?: string;
  baseUrl?: string;
  workspaceId?: string;
  sessionToken?: string;
}): Promise<WorkspacePolicy | undefined> {
  const localPolicy = await loadPolicy(input.policyFile);
  if (localPolicy) return localPolicy;
  return loadPolicyFromApi(input);
}

export function evaluatePolicy(report: Report, policy?: WorkspacePolicy): PolicyDecision {
  if (!policy) {
    return { action: "allow", reason: "No workspace policy configured." };
  }
  return evaluateWorkspacePolicy(
    {
      packageName: report.request.name,
      version: report.manifest.version,
      score: report.score,
      findings: report.findings
    },
    policy
  );
}
