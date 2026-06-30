# Repository Guidelines

## Project Structure

This is the standalone public CLI package for npxray. Runtime source lives in `src/`, tests live in `test/`, and small build helpers live in `scripts/`. The package consumes report types from `@npxray/contracts` and discovers a local scanning engine from environment or optional platform packages.

## Development Commands

- `bun install`: install dependencies.
- `bun run typecheck`: run the TypeScript compiler without emitting.
- `bun test`: run the Bun test suite.
- `bun run build`: compile `src/` to `dist/` and mark the CLI entrypoint executable.
- `npm pack --dry-run`: verify the publishable package contents.

## Coding Style

TypeScript is ESM and formatted by Biome with 2-space indentation, 120-column line width, double quotes, semicolons, and no trailing commas. Use PascalCase for types/classes and camelCase for functions and variables. Do not commit generated build output or engine binaries.

## Engine Runtime

Do not add scripts that build or run the private Go engine source. Local scanning must resolve an engine in this order: `NPXRAY_ENGINE_PATH`, optional `@npxray/engine-bin-<platform>` package, then `./.npxray-engine/<platform>/npxray-engine(.exe)` for local development.

## Pull Requests

Keep commits focused and describe user-visible CLI changes, verification commands, and any package metadata or release impacts. This repository is Apache-2.0 source; never commit secrets, local package-manager caches, `dist/`, or native engine binaries.
