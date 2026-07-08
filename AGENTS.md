# STARLIMS VS Code — Agent Notes

VS Code extension. TypeScript. SSL (`.ssl`, `.srvscr`) and SLSQL (`.slsql`) languages.
**Node 20.19+ or 22.13+. Node 18 dead.**

## Commands

| What | Command |
|------|---------|
| Compile (webpack) | `npm run compile` |
| Watch | `npm run watch` |
| Package VSIX | `npm run package` |
| Lint | `npm run lint` |
| Typecheck main ext | `npm run compile-tests` |
| All checks (typecheck + compile + lint) | `npm run pretest` |
| Windows VSIX | `npm run build-windows` |
| Generate STARLIMS typings | `npm run generate-typings` (needs `STARLIMS_ROOT` env) |
| Publish to share | `npm run publish` (copies to `\\BMBH02\SL_Connector\VSCode\`) |

**Windows:** use `npm run build-windows`, NOT `npm run build` (uses rm/cp).

## Lint

`npm run lint` = `eslint src --ext ts` (includes `src/lsp/**` and `src/webview`).
**Zero errors.** Warnings okay, **~341 baseline**: mostly `curly` (heaviest in `src/lsp/server/`: parser, definition, references, symbol-table) + `@typescript-eslint/naming-convention` (`finish_reason` in the opencode proxy). Do not introduce new ones without intent.

## Tests

`npm test` needs VS Code extension host. Fails headless. Don't block on it.

## Build (webpack)

One `webpack.config.js` → **4 bundles** to `dist/` – all `transpileOnly`:

| Bundle | Entry | tsconfig |
|--------|-------|----------|
| `extension.js` | `src/extension.ts` | `tsconfig.json` |
| `webview.js` | `src/webview/main.ts` | (webpack only) |
| `ssl-language-server.js` | `src/lsp/server/server.ts` | `tsconfig.server.json` |
| `js-language-server.js` | `src/lsp/js/server.ts` | `tsconfig.js-lsp.json` |

`npm run compile-tests` (`tsc -p tsconfig.json`) typechecks **only** the main extension — `tsconfig.json` excludes `src/webview`, `src/lsp/server`, **and** `src/lsp/js`. So `pretest` does NOT cover the two LSPs or the webview. To typecheck an LSP change, run `tsc -p tsconfig.server.json` or `tsconfig.js-lsp.json` by hand.

Benign webpack warning: `Critical dependency` from `express/lib/view.js` (explicitly ignored in webpack config).

## MCP Server

Endpoint: `http://127.0.0.1:3002/mcp`. JSON-RPC 2.0 over HTTP POST. Port via `STARLIMS.mcp.port` (default 3002). Form callback server is separate (3003–3099).

### Call pattern (PowerShell)

```powershell
$h = @{ "Accept" = "application/json, text/event-stream"; "Content-Type" = "application/json" }
# Step 1: init (once per session)
Invoke-RestMethod -Uri "http://127.0.0.1:3002/mcp" -Method Post -Headers $h -Body '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'
# Step 2: call tool
$resp = Invoke-RestMethod -Uri "http://127.0.0.1:3002/mcp" -Method Post -Headers $h -Body '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_by_name","arguments":{"query":"scGetCases"}}}'
```

**Use `$resp.structuredContent`** for data. `$resp.content` is just a summary string.

### Tools

All tools are defined in `src/services/starlimsMcpServer.ts` and implemented in `src/services/starlimsAutomationService.ts`.

| Tool | Args | What |
|------|------|------|
| `browse_tree` | `uri?`, `maxItems?` | Browse folder/root tree |
| `search_by_name` | `query`, `itemType?`, `exactMatch?`, `maxItems?` | Search items by name |
| `global_code_search` | `searchString`, `itemTypes?`, `maxItems?` | Search code text |
| `list_languages` | `maxItems?` | Languages for form checkout |
| `get_item_code` | `uri`, `language?`, `maxCharacters?` | Read item source |
| `read_log` | `user?`, `maxLines?` | Read server log |
| `checkout_item` | `uri`, `language?` | Check out → SLVSCODE workspace |
| `save_item` | `localPath`, `language?` | Save local edits to server |
| `checkin_item` | `uri`, `reason`, `language?` | Check in |
| `undo_checkout` | `uri` | Discard checkout |
| `refresh_checkout_tree` | `includeAllUsers?` | Refresh VS Code checked-out tree |
| `execute_server_script` | `uri`, `parameters?`, `outputType?`, `entryPoint?`, `maxCharacters?` | Run script |
| `execute_data_source` | `uri`, `parameters?`, `outputType?`, `maxCharacters?` | Run data source |
| `create_item` | `itemName`, `itemType`, `language`, `categoryName`, `appName` | Create item |
| `get_table_definition` | `uri`, `maxCharacters?` | Read table XML |
| `checkout_table` | `uri` | Check out table |
| `checkin_table` | `uri`, `reason` | Check in table |
| `create_table` | `tableName`, `dsn` | Create table |
| `edit_table` | `uri`, `tableXml` | Save table XML |
| `run_integration_tests` | `reason?`, `maxCharacters?` | Run `npm test` (prompts user) |

### URI format

`/Applications/BMBH_Modules/CaseManagement/ServerScripts/scGetCases`

### `create_item` item types

Scripts: `APPSS`, `APPDS`, `APPCS`, `SS`, `DS`, `CS`
Forms: `HTMLFORMXML`, `XFDFORMXML`
Categories: `SSCAT`, `DSCAT`, `CSCAT`
Folders: `APP`, `APPCATEGORY`

Folder types (`SSCAT`, `DSCAT`, `CSCAT`) are server-side only. Ignore `language`/`categoryName`/`appName`.

## Architecture

| File | Does what |
|------|-----------|
| `src/extension.ts` | Entry point, commands |
| `src/services/enterpriseService.ts` | STARLIMS HTTP client |
| `src/services/starlimsAutomationService.ts` | Backing impl for all MCP tools |
| `src/services/starlimsMcpServer.ts` | MCP tool registration/handling |
| `src/services/expressServer.ts` | Local loopback server (MCP + OpenCode proxy) |
| `src/services/gitService.ts` | Git integration for check-in |
| `src/services/starlimsJsBridge.ts` | Bridge to the JS language server |
| `src/services/ticketManagementTypes.ts` | Tickets data model |
| `src/lsp/server/` | SSL language server (lexer, parser, diagnostics, refs, hover). Design: `starlims-lsp.md` |
| `src/lsp/js/` | Separate TS-powered JS IntelliSense LSP (`starlimsJsLsp.enabled`, default true) |
| `src/providers/` | Tree data providers (enterprise, checked-out, tickets), file decorations, server-selector webview |
| `src/panels/` | Webview panels (table designer, data view) |
| `src/webview/` | Webview UI built separately by webpack |
| `src/backend/SCM_API/` | Backend package → `SCM_API.sdp` |

## Repo Layout

`syntaxes/` = TextMate grammars. `snippets/` = code snippets. `themes/` = color themes. `resources/instructions/` = Copilot chat instructions (→ `dist/instructions/`). `api/api.yaml` = API spec; runtime typings generated by `tools/generate-starlims-typings.mjs` → `dist/starlims-runtime.d.ts`.

## Settings (subset agents may touch)

`STARLIMS.url`/`user`/`userPassword`/`rootPath`/`servers`/`selectedServer` — connections.
`STARLIMS.mcp.*` — MCP on/off, port, max items, max code chars.
`STARLIMS.opencode.*` — proxy, "Solve with OpenCode" command (`planModel: glm-5.1`, `buildModel: kimi-2.6`).
`STARLIMS.git.*` — git on check-in (autoPush, remoteUrl, commit message generator).
`starlimsJsLsp.enabled` — JS LSP (default true).

## Gotchas

- After code change: reload extension host (`Ctrl+Shift+P` → Reload Window).
- `tsconfig.json` excludes `src/webview`, `src/lsp/server`, `src/lsp/js` — see Build table; `pretest` won't typecheck them.
- `.vscode/*` and `.env` are gitignored — no shared launch configs/tasks.
