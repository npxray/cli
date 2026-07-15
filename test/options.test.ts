import { describe, expect, it } from "bun:test";
import { parseInspectOptions, parseRunOptions } from "../src/options";

describe("CLI option parsing", () => {
  it("parses inspect flags", () => {
    expect(
      parseInspectOptions([
        "--json",
        "--local",
        "--registry",
        "https://registry.test",
        "--api-url",
        "https://api.test",
        "create-vite@latest"
      ])
    ).toEqual({
      json: true,
      markdown: false,
      svg: false,
      local: true,
      registryUrl: "https://registry.test",
      apiUrl: "https://api.test",
      fixtureDir: undefined,
      now: undefined,
      policyFile: undefined,
      workspaceId: undefined,
      sessionToken: undefined,
      input: ["create-vite@latest"]
    });
  });

  it("parses inspect local and synced policy inputs", () => {
    expect(
      parseInspectOptions([
        "--policy-file",
        "policy.json",
        "--workspace",
        "workspace-team",
        "--session",
        "session-token",
        "--api-url",
        "https://api.test",
        "--local",
        "fixture-entrypoint@latest"
      ])
    ).toEqual({
      json: false,
      markdown: false,
      svg: false,
      local: true,
      registryUrl: undefined,
      apiUrl: "https://api.test",
      fixtureDir: undefined,
      now: undefined,
      policyFile: "policy.json",
      workspaceId: "workspace-team",
      sessionToken: "session-token",
      input: ["fixture-entrypoint@latest"]
    });
  });

  it("keeps run passthrough args after --", () => {
    expect(parseRunOptions(["--dry-run", "--", "create-vite@latest", "my-app", "--template", "react"])).toEqual({
      yes: false,
      dryRun: true,
      json: false,
      local: false,
      registryUrl: undefined,
      fixtureDir: undefined,
      now: undefined,
      policyFile: undefined,
      apiUrl: undefined,
      workspaceId: undefined,
      sessionToken: undefined,
      commandArgs: ["create-vite@latest", "my-app", "--template", "react"]
    });
  });

  it("parses workspace policy sync flags before passthrough args", () => {
    expect(
      parseRunOptions([
        "--api-url",
        "https://api.test",
        "--local",
        "--workspace",
        "workspace-team",
        "--session",
        "session-token",
        "--policy-file",
        "policy.json",
        "--",
        "fixture-entrypoint@latest"
      ])
    ).toEqual({
      yes: false,
      dryRun: false,
      json: false,
      local: true,
      registryUrl: undefined,
      fixtureDir: undefined,
      now: undefined,
      policyFile: "policy.json",
      apiUrl: "https://api.test",
      workspaceId: "workspace-team",
      sessionToken: "session-token",
      commandArgs: ["fixture-entrypoint@latest"]
    });
  });

  it("treats removed inspect tarball flag as input", () => {
    expect(parseInspectOptions(["--no-tarball", "create-vite@latest"])).toMatchObject({
      input: ["--no-tarball", "create-vite@latest"]
    });
  });
});
