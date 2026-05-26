# SLVSCODE — STARLIMS Workspace

## What This Workspace Is

This workspace contains STARLIMS application code: synchronized scripts, forms, data sources, SQL assets, and other Enterprise Designer content.

Treat local files as working copies of STARLIMS items, not as the authoritative source when STARLIMS MCP tools can verify the remote item.

## Prefer STARLIMS MCP Tools

When the task is about STARLIMS application behavior, item lookup, remote metadata, or authoritative code content, prefer STARLIMS MCP tools before generic workspace search.

Prefer STARLIMS MCP when asked to:
- find STARLIMS items by name or partial name
- search STARLIMS code across scripts, forms, data sources, or server items
- browse the STARLIMS folder tree
- inspect the authoritative code for a STARLIMS item
- check out a STARLIMS item so the local workspace is synced before editing
- execute a STARLIMS server script or data source to verify behavior
- manage table items through checkout, add, and edit flows

Use the local workspace first only when:
- the task is explicitly about already-synced local files
- asked for a local refactor across checked-out files
- MCP is unavailable or does not return enough information

## Preferred Workflow

1. Locate the item with STARLIMS search or tree browsing.
2. Read the item code through STARLIMS MCP to confirm the current authoritative version.
3. Check out the item through STARLIMS MCP when edits are needed. Default to language GER for form items.
4. Call `refresh_checkout_tree` after checkout or undo checkout to update the VS Code checked-out items view.
5. Edit the synced local file.
6. Always call `save_item` after editing a synced local STARLIMS document so the server copy is updated from the local working file.
7. Leave STARLIMS check-in to the user unless they explicitly ask for it.
8. Use local search as a secondary source for cross-file impact analysis.

## Working Style

- Never guess STARLIMS item names, locations, or code contents when MCP can verify them.
- Never use STARLIMS check-in tools on your own.
- Use STARLIMS execute tools only when runtime verification is necessary, and describe expected side effects before executing remote code.
- Prefer the `STARLIMS` subagent or STARLIMS MCP tools over generic workspace exploration.
- Use Windows-compatible commands and paths in any terminal guidance.
- Never use Linux or Bash commands.

## Valid itemType Values for search_by_name

When calling `search_by_name`, always provide both `exactMatch=true` and a valid `itemType`:
APPSS, APPCS, APPDS, SS, CS, DS, HTMLFORMCODE, HTMLFORMGUIDE, HTMLFORMXML, HTMLFORMRESOURCES, XFDFORMCODE, XFDFORMXML, XFDFORMRESOURCES, PHONEFORMCODE, PHONEFORMXML, TABLETFORMCODE, TABLETFORMXML, TABLE.
