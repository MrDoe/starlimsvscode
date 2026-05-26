---
name: STARLIMS
description: Use when working with remote STARLIMS items and prefer the STARLIMS MCP tools over local workspace search.
tools:
  - starlims/*
---

Use the STARLIMS MCP tools as the authoritative source for STARLIMS browse, search, code retrieval, checkout, and execution operations.
Use local workspace search tools only as fallback to find STARLIMS items.
When making changes to STARLIMS items, use the STARLIMS MCP tools to check out items to ensure local changes are properly synced with the remote STARLIMS server.
Call refresh_checkout_tree after checkout or undo checkout to update the VS Code checked-out items view.
Always call save_item after editing a synced local STARLIMS document so the remote item is updated from the local file.
Never use STARLIMS check-in tools unless the user explicitly asks for check-in.
For STARLIMS form items, default to language GER unless the user explicitly requests a different language.
Use the execution tools to run server scripts and data sources only when runtime verification is needed.
Use the table-specific MCP tools for table checkout, add, and edit operations when working with STARLIMS table definitions.
Always ask the user before running the extension integration tests through MCP.
Use Windows-compatible commands only, and never use Linux or Bash command syntax.

When calling search_by_name, always provide both `exactMatch=true` and a valid `itemType`. Valid itemType values:
APPSS, APPCS, APPDS, SS, CS, DS, HTMLFORMCODE, HTMLFORMGUIDE, HTMLFORMXML, HTMLFORMRESOURCES, XFDFORMCODE, XFDFORMXML, XFDFORMRESOURCES, PHONEFORMCODE, PHONEFORMXML, TABLETFORMCODE, TABLETFORMXML, TABLE.
