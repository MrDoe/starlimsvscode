# STARLIMS VS Code — Agent Notes

Compact guidance for OpenCode sessions. Omit if obvious; include if an agent would likely guess wrong.

## Project Type & Runtime

- VS Code extension (TypeScript, Node.js extension host + webview bundle).
- Custom languages: SSL (`.ssl`, `.srvscr`) and SLSQL (`.slsql`).
- Extension engine: `^1.110.0`.
- **Node floor: 20.19+ or 22.13+. Node 18 is incompatible** (locked `copy-webpack-plugin@14` and `jsdom@29` require newer runtime).

## Build System

- **Webpack dual target:** `extensionConfig` (Node, `src/extension.ts` → `dist/extension.js`) and `webviewConfig` (web/es2020, `src/webview/main.ts` → `dist/webview.js`).
- Webview config also copies `src/webview/style.css` and `src/backend/SCM_API.sdp` into `dist/`.
- `tsconfig.json` compiles `src/**/*` but **excludes `src/webview`** and `hello-webview-repro` from the tsc pipeline; webview is built by webpack only.
- Expected benign webpack warning: `Critical dependency: the request of a dependency is an expression` from `express/lib/view.js`.

## Exact Commands

| Goal | Command |
|------|---------|
| Install (reproducible) | `npm ci` |
| Dev compile | `npm run compile` |
| Production bundle | `npm run package` |
| Compile tests (tsc → `out/`) | `npm run compile-tests` |
| Lint | `npm run lint` |
| Pretest chain | `npm run pretest` (runs `compile-tests && compile && lint`) |
| Extension host tests | `npm test` |
| Watch extension | `npm run watch` |
| Watch tests | `npm run watch-tests` |
| Build VSIX on **Windows** | `npm run build-windows` |
| Build VSIX on Unix | `npm run build` |

**Platform trap:** `npm run build` uses `rm`, `cp`, `true` and fails on Windows. On Windows always use `npm run build-windows`.

**Clean build recipe (PowerShell):**
```powershell
if (Test-Path dist) { Remove-Item dist -Recurse -Force }
if (Test-Path out) { Remove-Item out -Recurse -Force }
npm run compile
```

## Pre-PR Parity Check

```powershell
npm ci
npm run lint
npm run compile
npm run package
npm run compile-tests
npm run pretest
```

Treat `npm test` as environment-dependent; it requires launching the VS Code extension host and often fails in headless/restricted environments.

## CI Truth

- `.github/workflows/webpack.yml`: runs on push/PR to `master`, matrix Node `20.x` and `22.x`; steps are `npm ci && npm run compile`.
- `.github/workflows/publish.yml`: runs on push to `master`; bumps version with `npm version patch`, builds VSIX, publishes to marketplace, creates GitHub release with artifacts (`vscode-starlims.v{version}.vsix`, `src/backend/SCM_API.sdp`).

## Architecture & Entry Points

| File / Directory | Role |
|------------------|------|
| `src/extension.ts` | Activation, command registration, orchestration. |
| `src/services/enterpriseService.ts` | STARLIMS HTTP/API client. |
| `src/services/expressServer.ts` | Local loopback server for form debug callbacks. |
| `src/services/starlimsMcpServer.ts` | Local MCP endpoint (loopback only). |
| `src/providers/` | Tree data, content, decoration, and server-selector webview providers. |
| `src/panels/` | Data/resource webview panels (resources, table designer, generic data view). |
| `src/webview/main.ts` | Webview frontend entrypoint (webpack target). |
| `src/backend/SCM_API/` | STARLIMS backend package source; built into `SCM_API.sdp` and copied to `dist/`. |
| `src/test/runTest.ts` | Test harness launcher (`@vscode/test-electron`). |
| `src/test/suite/index.ts` | Mocha test suite runner (looks for `**/*.test.js` under `out/test/`). |

## Conventions


## Lint Baseline

As of the last validated run, `npm run lint` passes with warnings only. Known baseline: **7 `curly` warnings in `src/providers/serverSelectorWebviewProvider.ts`**. Do not introduce new errors; fixing warnings is welcome but not required to pass.

## Testing Quirks

- Tests are compiled by `tsc -p . --outDir out` into `out/test/`, then discovered as `**/*.test.js`.
- `npm test` launches the full VS Code extension host via `@vscode/test-electron`. It can fail in restricted/CI/headless environments even when the build is clean.
- VS Code launch configs:
  - **Run Extension** (`F5`): uses `preLaunchTask: ${defaultBuildTask}` (the `npm: watch` task).
  - **Extension Tests**: uses `preLaunchTask: tasks: watch-tests` (runs both `npm: watch` and `npm: watch-tests`).

## MCP Refresh Flow

- The MCP server now exposes `refresh_checkout_tree` for refreshing the checked-out items tree in the GUI after server-side create/check-out operations.
- The extension-side refresh path is `refreshCheckedOutItems(includeAllUsers)`, which calls `enterpriseService.getCheckedOutItems(...)` and updates `CheckedOutTreeDataProvider`.

## Release Artifacts

- `dist/extension.js` — extension bundle.
- `dist/webview.js` — webview bundle.
- `dist/style.css` — webview styles.
- `dist/SCM_API.sdp` — STARLIMS backend package.
- `.vsix` — produced by `build` / `build-windows`.

## References

- `.github/copilot-instructions.md` — additional validated build sequences and Windows-specific guidance.
- `README.md` — user-facing setup, configuration, and feature documentation.
