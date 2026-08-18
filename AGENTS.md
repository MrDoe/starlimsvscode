# STARLIMS VS Code — Agent Notes

VS Code extension. TypeScript. SSL (`.ssl`, `.srvscr`) and SLSQL (`.slsql`) languages.
**Node 20.19+ or 22.13+. Node 18 dead.**

**Encoding:** always use UTF-8 for all files (no BOM). Non-ASCII characters are fine as long as the file stays UTF-8; never let tools rewrite files with another encoding.

## Commands

| What | Command |
|------|---------|
| Compile (webpack) | `npm run compile` |
| Watch | `npm run watch` |
| Package VSIX | `npm run package` |
| Lint | `npm run lint` |
| Typecheck main ext | `npm run compile-tests` |
| All checks (typecheck + compile + lint) | `npm run pretest` |
| Validate backend SSL syntax + style rules (LSP parser over all `.srvscr`) | `npm run check:ssl` |
| SSL LSP unit tests (mocha, no VS Code) | `npm run test:lsp` |
| Windows VSIX | `npm run build-windows` |
| Generate STARLIMS typings | `npm run generate-typings` (needs `STARLIMS_ROOT` env) |
| Publish to share | `npm run publish` (copies to `\\BMBH02\SL_Connector\VSCode\`) |

**Windows:** use `npm run build-windows`, NOT `npm run build` (uses rm/cp).

## Lint

`npm run lint` = `eslint src --ext ts` (includes `src/lsp/**` and `src/webview`).
**Zero errors.** Warnings okay, baseline ~341 (mostly `curly` in `src/lsp/server/`). Do not introduce new ones without intent.

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
# Step 1: init (once per session) — response header Mcp-Session-Id must be sent on all follow-up requests
$init = Invoke-WebRequest -Uri "http://127.0.0.1:3002/mcp" -Method Post -Headers $h -Body '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'
$sessionId = $init.Headers["Mcp-Session-Id"]
# Step 2: call tool (sessionful server — missing Mcp-Session-Id header => 400)
$h2 = @{ "Accept" = "application/json, text/event-stream"; "Content-Type" = "application/json"; "Mcp-Session-Id" = $sessionId; "Mcp-Protocol-Version" = "2024-11-05" }
$resp = Invoke-WebRequest -Uri "http://127.0.0.1:3002/mcp" -Method Post -Headers $h2 -Body '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_by_name","arguments":{"query":"scGetCases"}}}'
$result = $resp.Content | ConvertFrom-Json
```

The server is **sessionful**: `initialize` creates a session and returns `Mcp-Session-Id`; keep sending it on every request (`DELETE /mcp` ends the session). `content[0].text` now carries the full result as JSON (when `STARLIMS.mcp.includeStructuredDataInText` is on, default) plus a `TRUNCATED:` note when data was cut off. `$result.result.structuredContent` is still available for the raw structure.

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
| `execute_data_source` | `uri`, `parameters?`, `outputType?`, `maxCharacters?`, `maxRows?` | Run data source (ARRAY output capped at `STARLIMS.mcp.maxDataSourceRows`, default 500) |
| `create_item` | `itemName`, `itemType`, `language`, `categoryName`, `appName` | Create item |
| `get_table_definition` | `uri`, `maxCharacters?` | Read table XML |
| `checkout_table` | `uri` | Check out table |
| `checkin_table` | `uri`, `reason` | Check in table |
| `create_table` | `tableName`, `dsn` | Create table |
| `edit_table` | `uri`, `tableXml` | Save table XML |
| `run_integration_tests` | `reason?`, `maxCharacters?` | Run `npm test` (prompts user) |
| `transfer_item_to_server` | `targetServer`, `saveLocalEdits?` | Transfer all checked out items to another configured server (new versions on target) |

## Workflow for OpenCode agents

When working with STARLIMS items from the SLVSCODE workspace, always use MCP tools in this order:

1. **Find** — `search_by_name` with `query` to locate the item. Use the `.uri` from the result.
2. **Read** — `get_item_code` with the URI to get the authoritative server version.
3. **Checkout** — `checkout_item` with `uri`. For form items (HTMLFORMXML, HTMLFORMCODE, etc.) pass `language: "GER"`.
4. **Refresh tree** — `refresh_checkout_tree` after checkout/undo to update VS Code.
5. **Edit** — modify the synced local file (path from `checkout_item.localPath`).
6. **Save** — `save_item` with the absolute `localPath` from step 3.
7. **Never check in** unless the user explicitly asks.

**Important:** Every MCP tool response has two parts:
- `content`: summary string plus the full payload as JSON under `--- Structured result ---` (when `STARLIMS.mcp.includeStructuredDataInText` is on, default) and a `TRUNCATED:` note when the result was cut off
- `structuredContent`: the full structured result with all fields (`uri`, `localPath`, `items`, `code`, etc.)

### URI format

`/Applications/BMBH_Modules/CaseManagement/ServerScripts/scGetCases`

Sandbox items use the `/Applications/_Sandbox` prefix:
`/Applications/_Sandbox/TestApp/HTMLForms/XML/frmTest`

The URI is always returned in the `.uri` field of `search_by_name` results.

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
| `src/services/expressServer.ts` | Local loopback server (MCP + form callbacks) |
| `src/services/gitService.ts` | Git integration for check-in |
| `src/services/opencodeServerService.ts` | OpenCode server API client (spawns/reuses `opencode web`, sessions, plan→build flow) |
| `src/services/starlimsJsBridge.ts` | Bridge to the JS language server |
| `src/services/ticketManagementTypes.ts` | Tickets data model |
| `src/lsp/server/` | SSL language server (lexer, parser, diagnostics, style rules, quick fixes, formatter, hover, refs, navigation). Design: `starlims-lsp.md` |
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
`STARLIMS.opencode.*` — "Solve with OpenCode" (`integration: server|terminal`, `planModel: glm-5.1`, `buildModel: kimi-2.6`, `serverPort: 4096`; password in secret storage via `STARLIMS.SetOpenCodeServerPassword`).
`STARLIMS.git.*` — git on check-in (autoPush, remoteUrl, commit message generator).
`starlimsJsLsp.enabled` — JS LSP (default true).
`starlimsSslLsp.*` — SSL LSP: `enabled`, `format.*` (indent, casing, spacing, wrap, inline SQL), `diagnostics.rules` (style-rule slug → off|info|warn|error), `diagnostics.strictStyleGuideMode`, `diagnostics.globals`, `naming.hungarianNotation.*`, `styleGuide.*`, `editor.autoInsertBlockClosers`, `documentNamespaces`. Style rules run in `check:ssl` always on; exit code only fails on parse errors or error-severity rule hits.

## Gotchas

- After code change: reload extension host (`Ctrl+Shift+P` → Reload Window).
- `tsconfig.json` excludes `src/webview`, `src/lsp/server`, `src/lsp/js` — see Build table; `pretest` won't typecheck them.
- `.vscode/*` and `.env` are gitignored — no shared launch configs/tasks.
- `enterpriseService.ts` backend error messages dropped: ~13 `get*Result` methods call `getOperationErrorMessage(data, fallback)` but the backend puts errors in `result.error`, not `result.data`. Pass the full `result` object instead of `data` to surface real error messages (e.g., `getEnterpriseItemsResult` L1336 had this bug).
- Backend `ParseURI` (Utils.srvscr) assigns Type purely from URI component count, not from DB lookup. `/ServerScripts/ssCat/realScript` (leaf) and `/ServerScripts/ssCat/nonexistent` (bogus) both return `success:true, items:[]`. No way for the client to distinguish leaf from empty from nonexistent folder without an extra `search_for_items_result` call.
- SSL comments are terminated by the first `;` — `; */` is NOT valid. A comment written as `/* ... ; */` closes at the `;` and the leftover `*/` becomes a parse error ("Unexpected token in expression"). Always end comments with just `;` (the file header keeps its original `***/;` form). Run `npm run check:ssl` after editing any `.srvscr`.

## Wiki

`.opencode/wiki/` — structured knowledge base (gitignored, not in git). Read `index.md` (page catalog) first, then the page, before reading source files directly.

- `index.md` — catalog of all pages with one-line summaries; `log.md` — append-only timeline of wiki updates
- `entities/` — one page per module/service/component (e.g. `ssl-parser.md`, `enterprise-service.md`)
- `concepts/` — patterns, workflows, gotchas (e.g. `ssl-keyword-registration.md`, `unicode-roundtrip.md`)
- Consult before source reading; file new knowledge back as new/updated pages with `[[wiki/...]]` cross-links

**LSP note:** when changing SSL keywords/tokens, touch lexer.ts + parser.ts + `syntaxes/ssl.tmLanguage.json` + hover.ts + server.ts completion + `starlims-lsp.md` design doc (see wiki `ssl-keyword-registration.md`). The SSL LSP also has a formatter (`formatter.ts`/`sqlFormatter.ts`), style rules (`styleRules.ts`), quick fixes (`codeActions.ts`), signature help (`signatureHelp.ts`) and navigation (`navigation.ts`) — keyword changes can affect all of them. `tsconfig.lsp-test.json` now compiles the whole `src/lsp/server` directory (not just `parser.test.ts`); `test:lsp` runs all `*.test.js` in `out-lsp-test/lsp/server/`. After editing any `.srvscr` under `src/backend/`, run `npm run check:ssl` (parses all backend scripts with the SSL LSP parser, style rules always on) and rebuild `SCM_API.sdp` via `src/backend/create-packages.ps1` (bumps the version; use `create-packages.sh` on non-Windows).

<!-- BEGIN opencode-rag -->
## Code Navigation

ALWAYS use OpenCodeRAG tools before reading or editing:
- **Search first** — `search_semantic(query)` instead of grep/glob
- **Skeleton before read** — `get_file_skeleton(filePath)` then read specific lines
- **Usages before edit** — `find_usages(symbolName)` before modifying any symbol
- **Images via describe** — `describe_image(filePath)` — never read raw bytes
- **Recall quirks** — `recall_quirks(query)` when you hit a known pitfall
- **Add quirks** — `add_quirk(content)` when you discover a non-obvious fact

If no results, run `opencode-rag index`.

### Decision tree — ALWAYS follow this order
1. User mentions code behavior/architecture → `search_semantic(query)`
2. User mentions a file path → `get_file_skeleton(filePath)` THEN `read` on specific lines
3. User mentions a function/class/variable to edit → `find_usages(symbolName)` THEN `search_semantic` THEN `edit`
4. User asks a code question → `search_semantic` to gather context before answering
5. User asks about an image or visual asset → `describe_image(filePath)` to retrieve its generated description, then optionally `search_semantic` for related code
6. You encounter an error or need to recall a known pitfall → `recall_quirks(query)`
7. You discover a non-obvious fact or workaround → `add_quirk(content)` to persist it for future sessions

### Proactive triggers — you MUST call these tools when
- User asks about code behavior, architecture, or implementation details
- User asks to edit, refactor, or fix code — call `find_usages` first
- User references files or functions you haven't read yet
- User says "find", "search", "look up", "where is", "how does"
- User refers to an image, screenshot, diagram, or visual asset
- Before answering ANY code-related question, retrieve context first
- Before reading ANY file, call `get_file_skeleton` to orient first

### Anti-patterns — NEVER do these
- Reading full files without calling `get_file_skeleton` first (wastes tokens)
- Editing a function without calling `find_usages` first (breaks call sites)
- Answering code questions without calling `search_semantic` first (you guess at behavior)
- Using `grep`/`glob` when `search_semantic` would find the answer faster
- Treating image files as text — use `describe_image` instead of reading raw bytes
- Using `npx opencode-rag quirk` shell commands instead of the built-in `add_quirk` / `recall_quirks` tools (the tools are faster, already loaded in-process, and go through the trust monitor)

### MANDATORY quirk capture rules — you MUST call `add_quirk` when
- A build, test, or type-check command fails and you resolve it
- You discover an undocumented library constraint, peer dep, or workaround
- You learn an environment-specific requirement (OS, tool version, etc.)
- You make a design decision that future sessions should remember
- You resolve a gotcha that cost more than one attempt
- NEVER finish a coding session without adding quirks for resolved errors.
<!-- END opencode-rag -->
