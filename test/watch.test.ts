import { describe, expect, it } from "bun:test";
import { addWatch, listWatch, removeWatch, runWatchCommand, type WatchlistPayload } from "../src/watch";

describe("watchlist API client", () => {
  it("lists watched packages with the workspace session cookie", async () => {
    const requests: Array<{ method: string; url: string; cookie?: string }> = [];
    const payload = watchlistPayload();

    const result = await listWatch({
      baseUrl: "https://api.test/",
      workspaceId: "workspace-team",
      sessionToken: "session-token",
      fetchImpl: async (url, init) => {
        requests.push({
          method: init?.method ?? "GET",
          url: String(url),
          cookie: headerValue(init?.headers, "cookie")
        });
        return jsonResponse(payload);
      }
    });

    expect(result).toEqual(payload);
    expect(requests).toEqual([
      {
        method: "GET",
        url: "https://api.test/v1/workspaces/workspace-team/watchlist",
        cookie: "npxray_session=session-token"
      }
    ]);
  });

  it("adds a package with the expected POST body", async () => {
    const requests: Array<{ method: string; url: string; cookie?: string; body: unknown }> = [];

    await addWatch(
      {
        baseUrl: "https://api.test",
        workspaceId: "workspace-team",
        sessionToken: "session-token",
        fetchImpl: async (url, init) => {
          requests.push({
            method: init?.method ?? "GET",
            url: String(url),
            cookie: headerValue(init?.headers, "cookie"),
            body: JSON.parse(String(init?.body))
          });
          return jsonResponse(watchlistPayload());
        }
      },
      "create-vite"
    );

    expect(requests).toEqual([
      {
        method: "POST",
        url: "https://api.test/v1/workspaces/workspace-team/watchlist",
        cookie: "npxray_session=session-token",
        body: { packageName: "create-vite" }
      }
    ]);
  });

  it("removes a package by resolving its watch id before deleting", async () => {
    const requests: Array<{ method: string; url: string }> = [];

    await removeWatch(
      {
        baseUrl: "https://api.test",
        workspaceId: "workspace-team",
        sessionToken: "session-token",
        fetchImpl: async (url, init) => {
          const method = init?.method ?? "GET";
          requests.push({ method, url: String(url) });
          return method === "DELETE" ? jsonResponse(watchlistPayload({ items: [] })) : jsonResponse(watchlistPayload());
        }
      },
      "Create-Vite"
    );

    expect(requests).toEqual([
      {
        method: "GET",
        url: "https://api.test/v1/workspaces/workspace-team/watchlist"
      },
      {
        method: "DELETE",
        url: "https://api.test/v1/workspaces/workspace-team/watchlist/watch-create-vite"
      }
    ]);
  });

  it("surfaces the Team workspace paid gate clearly", async () => {
    await expect(
      listWatch({
        baseUrl: "https://api.test",
        workspaceId: "workspace-free",
        sessionToken: "session-token",
        fetchImpl: async () =>
          jsonResponse(
            { error: "plan_required", message: "Watchlists require a Team workspace.", requiredPlan: "team" },
            403,
            "Forbidden"
          )
      })
    ).rejects.toThrow("Watchlists require a Team workspace.");
  });

  it("points unauthenticated users at workspace session flags", async () => {
    await expect(
      listWatch({
        baseUrl: "https://api.test",
        workspaceId: "workspace-team",
        sessionToken: "expired-session",
        fetchImpl: async () => jsonResponse({ error: "unauthenticated" }, 401, "Unauthorized")
      })
    ).rejects.toThrow("Pass --workspace and --session");
  });
});

describe("watch command output", () => {
  it("renders a human table for list", async () => {
    let stdout = "";

    await runWatchCommand(
      {
        action: "list",
        json: false,
        apiUrl: "https://api.test",
        workspaceId: "workspace-team",
        sessionToken: "session-token"
      },
      {
        stdout: writer((chunk) => {
          stdout += chunk;
        }),
        fetchImpl: async () => jsonResponse(watchlistPayload())
      }
    );

    expect(stdout).toContain("PACKAGE");
    expect(stdout).toContain("create-vite");
    expect(stdout).toContain("needs_attention");
    expect(stdout).toContain("47");
    expect(stdout).toContain("on");
  });

  it("emits the raw API payload for --json", async () => {
    let stdout = "";
    const payload = watchlistPayload();

    await runWatchCommand(
      {
        action: "list",
        json: true,
        apiUrl: "https://api.test",
        workspaceId: "workspace-team",
        sessionToken: "session-token"
      },
      {
        stdout: writer((chunk) => {
          stdout += chunk;
        }),
        fetchImpl: async () => jsonResponse(payload)
      }
    );

    expect(JSON.parse(stdout)).toEqual(payload);
  });

  it("fails helpfully when the session token is missing", async () => {
    await expect(
      runWatchCommand(
        {
          action: "list",
          json: false,
          apiUrl: "https://api.test",
          workspaceId: "workspace-team"
        },
        {
          env: {}
        }
      )
    ).rejects.toThrow("watch requires --session <token> or NPXRAY_SESSION_TOKEN.");
  });
});

function watchlistPayload(overrides: Partial<WatchlistPayload> = {}): WatchlistPayload {
  return {
    items: [
      {
        id: "watch-create-vite",
        packageName: "create-vite",
        alertsEnabled: true,
        currentVersion: "5.1.0",
        previousVersion: "5.0.0",
        score: 47,
        level: "watch",
        delta: 12,
        summary: "Score increased.",
        createdAt: "2026-07-02T10:15:00.000Z",
        crossedBudget: true,
        lastAlertAt: "2026-07-02T11:15:00.000Z",
        lastAlertDelta: 12,
        sparkline: [35, 47],
        status: "needs_attention"
      },
      {
        id: "watch-left-pad",
        packageName: "left-pad",
        alertsEnabled: false,
        score: 8,
        level: "low",
        delta: 0,
        summary: "Below budget.",
        createdAt: "2026-07-01T09:00:00.000Z",
        crossedBudget: false,
        sparkline: [8],
        status: "safe"
      }
    ],
    alerts: [],
    stats: { watched: 2, needsAttention: 1, safe: 1 },
    trending: [],
    ...overrides
  };
}

function jsonResponse(body: unknown, status = 200, statusText = "OK"): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" }
  });
}

function headerValue(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  }
  return headers[name];
}

function writer(write: (chunk: string) => void): Pick<NodeJS.WriteStream, "write"> {
  return {
    write(chunk: string | Uint8Array): boolean {
      write(String(chunk));
      return true;
    }
  };
}
