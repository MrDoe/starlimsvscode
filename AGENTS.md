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
- `build-windows` still invokes `src/backend/create-packages.sh`; on some Windows setups this requires shell association / Git tooling.

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

## MCP Server

- MCP endpoint: `http://127.0.0.1:3002/mcp` (Streamable HTTP transport).
- Initialize with `Accept: application/json, text/event-stream` header.
- Uses JSON-RPC 2.0 protocol over HTTP POST.

### MCP Tools

| Tool | Read-only | Description |
|------|-----------|-------------|
| `browse_tree` | ✅ | Browse items under a folder URI or from the root tree. |
| `search_by_name` | ✅ | Search items by name or partial name. |
| `global_code_search` | ✅ | Search for text across code items. |
| `list_languages` | ✅ | List available form languages. |
| `get_item_code` | ✅ | Read code for an item. |
| `checkout_item` | ❌ | Check out an item and sync local copy. |
| `save_item` | ❌ | Save an edited local STARLIMS working copy back to the remote item. |
| `refresh_checkout_tree` | ❌ | Refresh the checked-out tree in VS Code. |
| `checkin_item` | ❌ | Check in an item after local edits. |
| `undo_checkout` | ❌ | Undo checkout and discard server checkout. |
| `execute_server_script` | ❌ | Execute a server script and return output. |
| `execute_data_source` | ❌ | Execute a data source and return output. |
| `create_item` | ❌ | Create any item via `SCM_API.Add`. |
| `get_table_definition` | ✅ | Read full XML table definition. |
| `checkout_table` | ❌ | Check out a table and sync local XML. |
| `checkin_table` | ❌ | Check in a table. |
| `create_table` / `add_table` | ❌ | Create a new table. |
| `edit_table` | ❌ | Save a modified table XML definition. |
| `run_integration_tests` | ❌ | Run `npm test` (prompts user for permission). |

### Creating Folder Types via `create_item`

**Folder types** (`SSCAT`, `DSCAT`, `CSCAT`) skip checkout and local copy — they are created server-side only. Parameters `language`, `categoryName`, and `appName` are sent but ignored by the backend for folders.

```powershell
# Example: create a ServerScript category
$headers = @{ "Accept" = "application/json, text/event-stream"; "Content-Type" = "application/json" }
$body = '{ "jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}} }'
Invoke-RestMethod -Uri "http://127.0.0.1:3002/mcp" -Method Post -Headers $headers -Body $body

$body = @{ jsonrpc="2.0"; id=2; method="tools/call"; params=@{ name="create_item"; arguments=@{ itemName="MyCategory"; itemType="SSCAT"; language="N/A"; categoryName="N/A"; appName="N/A" } } } | ConvertTo-Json -Depth 10
Invoke-WebRequest -Uri "http://127.0.0.1:3002/mcp" -Method Post -Headers $headers -Body $body | Select-Object -ExpandProperty Content
```

### Refresh Checkout Tree

The `refresh_checkout_tree` tool refreshes the checked-out items tree in the VS Code GUI after server-side create/check-out operations. The extension-side refresh path is `refreshCheckedOutItems(includeAllUsers)`, which calls `enterpriseService.getCheckedOutItems(...)` and updates `CheckedOutTreeDataProvider`.

### Save Edited Documents

After editing a checked-out STARLIMS document in the local workspace, call `save_item` with the local file path to persist the local working copy back to the STARLIMS server before any optional check-in step.

### Key Files

| File | Role |
|------|------|
| `src/services/starlimsMcpServer.ts` | MCP tool definitions and HTTP handler. |
| `src/services/starlimsAutomationService.ts` | Validation, limits, bridges MCP to EnterpriseService. Contains `FOLDER_ITEM_TYPES` (`SSCAT`, `DSCAT`, `CSCAT`) and `buildCreatedItemUri`. |
| `src/services/enterpriseService.ts` | HTTP client for all SCM_API REST endpoints. |
| `src/services/expressServer.ts` | Express server hosting the MCP endpoint at `/mcp`. |
| `src/backend/SCM_API/Server Scripts/SCM_API/Add.srvscr` | Backend `SCM_API.Add` — handles `SSCAT`/`SSCATEGORY`, `DSCAT`/`DSCATEGORY`, `CSCAT`/`CSCATEGORY` via dedicated providers. |

### Reload Required

After code changes, the extension host must be reloaded (`Ctrl+Shift+P` → `Developer: Reload Window` or restart F5) for new compiled code to take effect.

## Release Artifacts

- `dist/extension.js` — extension bundle.
- `dist/webview.js` — webview bundle.
- `dist/style.css` — webview styles.
- `dist/SCM_API.sdp` — STARLIMS backend package.
- `.vsix` — produced by `build` / `build-windows`.

## Repository Layout

| Directory | Role |
|-----------|------|
| `api/` | STARLIMS API type definitions / wrappers. |
| `resources/` | Extension icons, images, and static assets. |
| `syntaxes/` | TextMate grammars for SSL (`.ssl`, `.srvscr`) and SLSQL (`.slsql`). |
| `themes/` | VS Code color themes. |
| `snippets/` | Code snippets for STARLIMS languages. |

## References

- `.github/copilot-instructions.md` — additional validated build sequences and Windows-specific guidance.
- `README.md` — user-facing setup, configuration, and feature documentation.
