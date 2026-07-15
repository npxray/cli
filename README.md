# npxray CLI

`npxray` gives `npx` a safety prompt with deterministic package-risk evidence.

```bash
npm i -g @npxray/cli
npxray inspect create-vite@latest
npx @npxray/cli inspect create-vite@latest
```

```bash
npxray inspect create-vite@latest
npxray inspect ./package.tgz
npxray inspect .
npxray inspect --policy-file policy.json create-vite@latest
npxray inspect --workspace workspace-team --session "$NPXRAY_SESSION_TOKEN" create-vite@latest
npxray compare create-vite@5.0.0 create-vite@5.1.0
npxray run -- create-vite@latest my-app --template react
npxray run --policy-file policy.json --dry-run -- create-vite@latest
npxray run -- ./package.tgz
npxray alias
npxray watch add create-vite --workspace workspace-team --session "$NPXRAY_SESSION_TOKEN"
npxray watch list --workspace workspace-team --session "$NPXRAY_SESSION_TOKEN"
npx create-vite@latest my-app --template react
```

Public package specs scan through the hosted cache-first API by default, then approved runs delegate to `npm exec`.

## Usage

```bash
npxray inspect [options] <package|npx command|local .tgz|local package dir>
npxray compare [options] <pkg@from> <pkg@to>
npxray run [options] -- <npx args...>
npxray alias [options]
npxray watch list [options]
npxray watch add [options] <package>
npxray watch remove [options] <package>
npxray inspect --help
npxray compare --help
npxray run --help
npxray alias --help
npxray watch --help
```

Common policy options on `inspect` and `run`:

- `--policy-file <path>` loads a local JSON policy. Local files take precedence over a synced workspace policy.
- `--workspace <id>` and `--session <token>` sync the workspace policy over the session cookie auth model used by the hosted API.
- `NPXRAY_WORKSPACE_ID` and `NPXRAY_SESSION_TOKEN` provide the same workspace/session defaults when flags are omitted.
- `--api-url <url>` / `NPXRAY_API_URL` select the API origin used for scans and policy sync.

## Policy evaluation

`inspect` and `run` evaluate the same workspace policy after the report is printed. Shared precedence is exact (seven stages):

1. matching `deny` rule → block
2. matching `allow` rule → allow (bypasses signals and budget)
3. any matching signal rule with `action: "block"`
4. score at or above `riskBudget` with `enforcement: "block"` → block
5. any matching signal rule with `action: "warn"`
6. score at or above `riskBudget` with `enforcement: "warn"` → warn
7. allow (below budget)

A matching signal block outranks matching signal warnings regardless of signal-rule order. Signal and severity selectors on one rule are conjunctive.

Observable exit contract:

| Code | Meaning |
| --- | --- |
| `0` | Allow, help, or warn. Warnings print as `Policy warning: <reason>`. |
| `1` | Error, including malformed local/synced policy and workspace policy sync failure. |
| `2` | Aborted run prompt / non-interactive refusal without `--yes`. |
| `3` | Blocked by policy. Prints `Blocked by policy: <reason>`. |

`run --dry-run` still evaluates policy before returning. A blocked dry-run exits `3` and never starts `npm exec`; a warning dry-run exits `0`, prints the warning, then reports that `npm exec` was not started. Malformed local or synced policy aborts with exit `1` before `npm exec` (and before a successful inspect/run result).

### Policy schema

```json
{
  "riskBudget": 50,
  "enforcement": "block",
  "allow": [
    "create-vite",
    "@npxray/cli@0.1.1",
    { "pattern": "@my-org/*", "versionRange": ">=1.0.0" }
  ],
  "deny": [
    "left-pad",
    { "pattern": "event-stream", "versionRange": "<4" }
  ],
  "signalRules": [
    { "signal": "code-shell-exec", "action": "block" },
    { "severity": "critical", "action": "warn" },
    { "signal": "code-shell-exec", "severity": "high", "action": "block" }
  ]
}
```

- `riskBudget` is the score at or above which `enforcement` applies (`0`–`100`, required, finite).
- `enforcement` is required and must be `"warn"` or `"block"`.
- `allow` / `deny` entries may be strings (`name`, `name@version`, `name/*`, or `name@range`) or objects with `pattern` and optional `versionRange`. Omitted lists load as `[]`; blank or invalid package rules are rejected.
- `signalRules` is a normalized array (omission loads as `[]`). Each rule must select by finding `signal` id, `severity`, or both (conjunctive) and set `action` to `"warn"` or `"block"`. Selectorless or otherwise malformed signal rules are rejected instead of ignored.
- Unknown top-level keys are rejected except API metadata `workspaceId` and `updatedAt` (accepted on input, stripped from the normalized policy).

Local files and synced API responses both pass through the shared strict parser. Malformed policy fails closed with exit `1` before command execution.

Session-authenticated workspace policy sync uses `GET /v1/workspaces/<id>/policy` with the `npxray_session` cookie. Sync failures fail closed with exit `1` before any command execution.

## Alias npx

Run `npxray alias` after installing the CLI to add a managed `npx` alias to your shell startup file. Supported shells are bash, zsh, and fish. Restart your shell, or source the file named in the command output, then use `npx` normally:

```bash
npx create-vite@latest my-app --template react
```

Use `npxray alias --dry-run` to preview the profile and snippet, `--print` to print the snippet only, `--shell <bash|zsh|fish>` to choose a shell explicitly, or `--profile <path>` to write a specific startup file.

## Watchlists

Team workspaces can manage package watchlists from the terminal with the same session-based workspace auth used for policy sync:

```bash
npxray watch add create-vite --workspace workspace-team --session "$NPXRAY_SESSION_TOKEN"
npxray watch list --workspace workspace-team --session "$NPXRAY_SESSION_TOKEN"
npxray watch remove create-vite --workspace workspace-team --session "$NPXRAY_SESSION_TOKEN"
```

Use `--json` to print the API watchlist payload unchanged for scripts. `NPXRAY_WORKSPACE_ID`, `NPXRAY_SESSION_TOKEN`, and `NPXRAY_API_URL` can provide the workspace, session, and API origin defaults.

## Scan Routing

Common scan routing options:

- `--api-url <url>` uses a specific npxray API origin instead of `https://api.npxray.dev`.
- `--local` forces the local engine instead of the API.
- `NPXRAY_API_URL` sets the default API origin.
- `NPXRAY_API_TOKEN` uses the token-authenticated scan route.
- `NPXRAY_LOCAL=1` forces local scanning for all commands.
- `NPXRAY_ENGINE_PATH` points to a local `npxray-engine` binary.

Local `.tgz` files and package directories are always scanned by the local engine and never sent to the API. Use `npxray inspect .` as a lint-style check for the current package, or `npxray inspect ./package.tgz` / `npxray run -- ./package.tgz` for a packed tarball.

Network failures, timeouts, and 5xx API responses fall back to local scanning when an engine is available. 4xx responses fail closed so auth, validation, rate-limit, and private-registry errors stay visible. If the API is unavailable and no local engine is installed, npxray exits with a message explaining how to install the optional engine package or set `NPXRAY_ENGINE_PATH`.

## Local Engine

The CLI does not build or ship the Go engine source. At runtime it resolves a local engine in this order:

1. `NPXRAY_ENGINE_PATH`
2. Optional platform package, such as `@npxray/engine-bin-darwin-arm64`
3. Local development path `./.npxray-engine/<platform>/npxray-engine`

Windows uses `npxray-engine.exe`; other platforms use `npxray-engine`. Supported optional package targets are:

- `@npxray/engine-bin-darwin-arm64`
- `@npxray/engine-bin-darwin-amd64`
- `@npxray/engine-bin-linux-amd64`
- `@npxray/engine-bin-linux-arm64`
- `@npxray/engine-bin-windows-amd64`

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
npm pack --dry-run
```

`bun run build` compiles TypeScript and marks `dist/index.js` executable. It does not compile native engine binaries.

## License

Apache-2.0
