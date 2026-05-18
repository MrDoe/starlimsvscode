# STARLIMS VS Code

STARLIMS VS Code is an unofficial Visual Studio Code extension for working with STARLIMS Enterprise Designer assets from within VS Code. It supports browsing remote items, synchronizing them to a local workspace, reviewing changes, running supported assets, debugging forms, and combining STARLIMS workflows with Git and GitHub Copilot-aware tooling.

## Key Capabilities

- Browse, search and edit all STARLIMS code items, forms, resources, database tables, and dictionary tables directly from VS Code
- Work with multiple STARLIMS environments through named server definitions and the built-in server selector
- Check out items to a local workspace, compare local files with the server version, and see checked out items of other users
- Check in, undo checkout, rename, move, add, and delete supported items
- Export your checked out items to an SDP package
- Run server scripts and data sources, capture script output, stream STARLIMS server logs, and clear logs from VS Code
- Open HTML forms, debug them in Chrome or Edge, launch XFD forms through STARLIMS Bridge
- HTML Form designer for creating or editing forms in a WYSIWYG environment with live preview, drag-and-drop controls, and property editing
- Search by item name, perform global code search across all STARLIMS code items, and quickly navigate from source code to server scripts, client scripts, data sources via hotkeys
- Explore database and dictionary tables, inspect table definitions, and generate SELECT, INSERT, UPDATE, and DELETE statements into the active editor
- Initialize a Git repository for the local SLVSCODE mirror, configure a remote, and optionally auto-commit and auto-push local STARLIMS changes during check-in
- Optionally detect new Git commits in the SLVSCODE repository and check matching checked-out STARLIMS script and data source files in with the Git commit message
- Manage STARLIMS tickets (BMBH only) from VS Code by filtering queues, selecting an active ticket, undertaking, releasing, solving, and renaming tickets, and creating ticket measures during check-in
- Use SSL and SLSQL language support, snippets, syntax highlighting, and the bundled SSL theme
- Use a local MCP endpoint and Copilot-facing workspace files to enable agents to use the STARLIMS MCP for browse, search, code retrieval, and checkout operations when working with STARLIMS assets

## Requirements

- Visual Studio Code 1.110 or later
- Access to a STARLIMS environment
- The `SCM_API.sdp` package imported into STARLIMS from the latest project release
- The following entry in the STARLIMS `web.config` file:

```xml
<add key="HTTPServices" value="SCM_API.*"/>
```

For product development environments with system layer ID 200, enable `Overwrite System Layer` during package import.

If your STARLIMS platform version does not support the `HTTPServices` setting, configure `STARLIMS.urlSuffix` to `lims2`.

Importing the latest `SCM_API.sdp` release is strongly recommended because newer features such as ticket workflows, form callback publishing, MCP access, and backend auto-upgrade depend on current backend endpoints.

## Installation and Setup

1. Install the extension in VS Code.
2. Import `SCM_API.sdp` into your STARLIMS environment.
3. Configure the STARLIMS connection settings in VS Code.
4. Set `STARLIMS.rootPath` to the parent folder where the extension should create the local `SLVSCODE` workspace mirror.
5. Open the STARLIMS view from the activity bar and connect to a configured server.

The extension creates or opens the `SLVSCODE` folder under `STARLIMS.rootPath` and uses it as the local working copy for checked out items.

On activation, the extension also:

- Checks the backend API version and offers to upgrade `SCM_API.sdp` automatically when the deployed backend is older than the extension
- Publishes the local form callback port back to STARLIMS SCM so FormDesigner can open local code-behind files in VS Code
- Creates `.vscode/mcp.json`, `.github/agents/starlims.agent.md`, and `.github/copilot-instructions.md` inside `SLVSCODE` when they are missing
- Bootstraps ESLint support for STARLIMS client-side JavaScript by copying the workspace config and installing the VS Code ESLint extension when needed

## Configuration

Core settings:

- `STARLIMS.url`: STARLIMS installation URL
- `STARLIMS.user`: STARLIMS user name
- `STARLIMS.userPassword`: Password stored through the extension command instead of the settings file
- `STARLIMS.rootPath`: Parent folder for the local `SLVSCODE` workspace mirror

Common optional settings:

- `STARLIMS.servers`: Named server definitions for multi-environment setups
- `STARLIMS.selectedServer`: The currently active named server
- `STARLIMS.browser`: Browser used for form debugging (`chrome` or `msedge`)
- `STARLIMS.urlSuffix`: Service suffix for environments that require `lims2`
- `STARLIMS.defaultFormLanguage`: Default language used when checking out form items

Git automation settings:

- `STARLIMS.git.enabled`: Enables Git integration for STARLIMS check-in flows
- `STARLIMS.git.autoPush`: Automatically pushes Git commits after STARLIMS check-in
- `STARLIMS.git.remoteUrl`: Optional remote URL used by the configure-remote command
- `STARLIMS.git.remoteName`: Git remote name, defaulting to `origin`
- `STARLIMS.git.commitMessageGenerator`: Uses either a fast local message or Copilot-assisted message generation
- `STARLIMS.git.copilotCommitMessageModel`: Optional exact Copilot model name for message generation

Additional Git message settings are available to control detail level, prefixes, maximum length, whether item type or language is included, custom system prompts, and Copilot timeout behavior.

## Ticket Workflows

The Tickets view groups STARLIMS tickets by status and supports title filtering, active ticket selection, ticket undertaking and release, marking tickets as solved, and renaming tickets.

When an active ticket is selected, STARLIMS check-in commands can reuse ticket-aware reasons and automatically create ticket measures. Ticket measure text can use the same fast local generator or Copilot-assisted generation that is used for Git and check-in messages.

## MCP Integration

The extension also starts a local form callback server on the first free loopback port in the range `3003-3099` for FormDesigner code-behind navigation. The selected port is published back to STARLIMS SCM so the FormDesigner client can resolve it dynamically.

When `STARLIMS.mcp.enabled` is enabled, the extension exposes a local MCP endpoint on `http://127.0.0.1:3002/mcp` by default.

The MCP integration is intentionally limited:

- Binds to loopback only
- Uses the currently selected STARLIMS server
- Supports browse, search, code retrieval, table definition retrieval, checkout, check-in, item creation, table creation, and edit operations
- Destructive actions such as delete, rename, move, and script execution are currently not exposed

Related settings:

- `STARLIMS.mcp.enabled`: Enables the endpoint
- `STARLIMS.mcp.port`: Changes the loopback port used by MCP
- `STARLIMS.mcp.maxItems`: Limits browse and search result sizes
- `STARLIMS.mcp.maxCodeCharacters`: Limits code returned by read requests

When the local `SLVSCODE` workspace is created, the extension also seeds Copilot-facing helper files so agents can discover the STARLIMS MCP endpoint and prefer STARLIMS-native browse, search, code retrieval, checkout, item creation, and table management operations.

## Default Shortcuts

- `F5`: Run a server script or data source, or debug an HTML form, depending on the active file type
- `Ctrl+F5`: Open HTML forms or XFD forms
- `Ctrl+F6`: Open the HTML form designer
- `F11`: Navigate to the STARLIMS item referenced at the cursor
- `Ctrl+Alt+F`: Run STARLIMS global code search

## Development

Current development dependency floor:

- Node.js 20.19 or later, or Node.js 22.13 or later

Node 18 is no longer supported by the current toolchain. The locked versions of `copy-webpack-plugin` and `jsdom` require newer runtime features and will fail during CI or local builds on Node 18.

Recommended local workflow:

```powershell
npm ci
npm run lint
npm run compile
npm run package
npm run compile-tests
npm run pretest
```

`npm test` runs the VS Code extension host tests and may fail in restricted or headless environments.

To build a VSIX package on Windows, use:

```powershell
npm run build-windows
```

## License

See [LICENSE.md](LICENSE.md).
