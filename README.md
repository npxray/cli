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
npxray compare create-vite@5.0.0 create-vite@5.1.0
npxray run -- create-vite@latest my-app --template react
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
