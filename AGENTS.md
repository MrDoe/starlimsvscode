# STARLIMS VS Code — Agent Notes

VS Code extension. TypeScript. SSL (`.ssl`, `.srvscr`) and SLSQL (`.slsql`) languages.
**Node 20.19+ or 22.13+. Node 18 dead.**

## Commands

| What | Command |
|------|---------|
| Compile | `npm run compile` |
| Package | `npm run package` |
| Lint | `npm run lint` |
| All checks | `npm run pretest` |
| Windows VSIX | `npm run build-windows` |

**Windows:** use `npm run build-windows`, NOT `npm run build` (uses rm/cp).

## Lint

Zero errors. Warnings okay. Baseline: 7 `curly` warnings in `serverSelectorWebviewProvider.ts`.

## Tests

`npm test` needs VS Code extension host. Fails headless. Don't block on it.

## MCP Server

Endpoint: `http://127.0.0.1:3002/mcp`. JSON-RPC 2.0 over HTTP POST.

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

| Tool | Args | What |
|------|------|------|
| `search_by_name` | `query` | Search items by name |
| `global_code_search` | `query` | Search code text |
| `get_item_code` | `uri` | Get SSL source code |
| `browse_tree` | `uri` | Browse folder tree |
| `create_item` | `itemName`, `itemType`, `language`, `categoryName`, `appName` | Create item |
| `checkout_item` | `uri`, `itemType` | Check out item |
| `checkin_item` | `uri` | Check in item |
| `save_item` | (local path) | Save local edits to server |
| `refresh_checkout_tree` | — | Refresh VS Code tree |
| `execute_server_script` | `uri`, `input` | Run script |
| `execute_data_source` | `uri`, `input` | Run data source |

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
| `src/services/starlimsMcpServer.ts` | MCP tools |
| `src/services/expressServer.ts` | Local server (MCP lives here) |
| `src/lsp/server/` | SSL language server (lexer, parser, diagnostics) |
| `src/backend/SCM_API/` | Backend package → `SCM_API.sdp` |

## Repo Layout

`syntaxes/` = TextMate grammars. `snippets/` = code snippets. `themes/` = color themes. `api/` = API types.

## Gotchas

- After code change: reload extension host (`Ctrl+Shift+P` → Reload Window).
- `tsconfig.json` excludes `src/webview` — webpack builds it separately.
- Benign webpack warning: `Critical dependency` from `express/lib/view.js`.
