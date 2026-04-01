# STARLIMS VS Code - Copilot Onboarding

## What This Repository Is

This is an unofficial VS Code extension that integrates STARLIMS Enterprise Designer into VS Code. It lets users browse STARLIMS items, check out/check in code, compare local vs remote versions, execute scripts/data sources, and debug forms.

High-level facts:
- Project type: VS Code extension
- Primary language/runtime: TypeScript on Node.js (extension host) + webview bundle
- Major tooling: webpack, ESLint, TypeScript, @vscode/test-electron
- Custom languages: SSL (`.ssl`, `.srvscr`) and SLSQL (`.slsql`)
- VS Code API engine: `^1.86.0`

## Always-Use Build Sequence (Validated)

Validation date: 2026-03-30 (Windows PowerShell, repo root).

1) Bootstrap dependencies (required)

```bash
npm ci
```

- Worked.
- Fresh install took ~27s in this environment.
- Use `npm ci` for reproducible CI/local runs; use `npm install` only when lockfile updates are intended.

2) Lint

```bash
npm run lint
```

- Worked with warnings only (no errors).
- Current baseline: 7 `curly` warnings in `src/providers/serverSelectorWebviewProvider.ts`.

3) Compile (dev build)

```bash
npm run compile
```

- Worked.
- Produces `dist/extension.js`, `dist/webview.js`, `dist/style.css`, and copies `dist/SCM_API.sdp`.
- Expected warning: webpack/express `Critical dependency: the request of a dependency is an expression` from `express/lib/view.js`.

4) Package (production webpack bundle)

```bash
npm run package
```

- Worked.
- Same expected express warning.

5) Test prerequisites + pretest chain

```bash
npm run compile-tests
npm run pretest
```

- Both worked.
- `pretest` runs: `compile-tests -> compile -> lint`.

6) Integration tests

```bash
npm test
```

- Failed in this environment with `Failed to run tests`.
- Test runner uses `@vscode/test-electron` (`src/test/runTest.ts`) and requires launching VS Code test host; headless/restricted environments can fail.

## Script Behavior by Platform (Important)

- `npm run build` is Unix-oriented and failed on Windows (`rm`, `true`, `cp` not found).
- `npm run build-windows` worked and produced `.vsix` successfully.
- `build-windows` still invokes `src/backend/create-packages.sh`; in this environment it succeeded, but on some Windows setups this requires shell association/Git tooling.

If you need a release package on Windows, use:

```bash
npm run build-windows
```

## Clean Build Recipe

Validated clean-compile flow:

```powershell
if (Test-Path dist) { Remove-Item dist -Recurse -Force }
if (Test-Path out) { Remove-Item out -Recurse -Force }
npm run compile
```

This worked from a clean artifact state.

## Architecture and Where To Edit

Core structure:
- `src/extension.ts`: activation, command registration, orchestration.
- `src/services/enterpriseService.ts`: STARLIMS HTTP/API operations.
- `src/services/expressServer.ts`: local server used for form debug flows.
- `src/providers/`: tree/content/decoration providers and server selector webview provider.
- `src/panels/`: data/resource webview panels.
- `src/webview/main.ts`: webview frontend logic.
- `src/backend/SCM_API/`: STARLIMS backend package content, built into `SCM_API.sdp`.

Configuration and build files:
- `package.json`: scripts, extension contributions, dependencies.
- `webpack.config.js`: dual webpack targets (extension + webview), copies CSS and `SCM_API.sdp`.
- `tsconfig.json`: strict TS config, excludes `src/webview` from `tsc` compile-tests pipeline.
- `.eslintrc.json`: warning-focused lint rules.

## CI and Pre-Checkin Parity

GitHub workflows:
- `.github/workflows/webpack.yml`: on push/PR to `master`, matrix Node `16.x`, `18.x`, `22.x`; runs `npm install` then `npx webpack`.
- `.github/workflows/publish.yml`: on push to `master`; uses Node 22, `npm ci`, version bump, VSIX publish/release.

Recommended local parity before PR:

```bash
npm ci
npm run lint
npm run compile
npm run package
npm run compile-tests
npm run pretest
```

Treat `npm test` as environment-dependent unless you can run VS Code extension host tests locally.

## Known Codebase Caveats

- `src/webview/main.ts` contains a TODO workaround for grid column width due toolkit limitation.
- `src/extension.ts` contains a documented workaround for Git API limitations when mapping committed files.

## Root-Level Map (Quick Scan)

Important root entries: `.github/`, `.copilot/`, `src/`, `api/`, `resources/`, `syntaxes/`, `themes/`, `snippets/`, `package.json`, `webpack.config.js`, `tsconfig.json`, `.eslintrc.json`, `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`.

## Agent Operating Rule

Trust this file first. Only search the repository when these instructions are incomplete or proven incorrect.

## Important Note
You are working on Windows, so only use PowerShell- and Windows-compatible commands and paths when suggesting build/test instructions. Do not try to use Unix commands like `rm`, `cp`, or `true` in your suggestions. Use PowerShell equivalents like `Remove-Item`, `Copy-Item`, and `$true` instead.
