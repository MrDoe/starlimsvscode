# STARLIMS VS Code

STARLIMS VS Code is an unofficial Visual Studio Code extension for working with STARLIMS Enterprise Designer assets from within VS Code. It supports browsing remote items, synchronizing them to a local workspace, reviewing changes, running supported assets, and performing common source-control style operations.

## Key Capabilities

- Browse STARLIMS Enterprise Designer items and checked out items
- Check out items to a local workspace and compare local changes with the server version
- Check in, undo checkout, rename, move, add, and delete supported items
- Run server scripts and data sources
- Open, debug, and design HTML forms, and launch XFD forms through STARLIMS Bridge
- Search by item name and perform global code search
- Explore database and dictionary tables and generate SQL statements
- Use SSL and SLSQL language support, including syntax highlighting and theme assets
- Optionally expose a local MCP endpoint for GitHub Copilot agents

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

## Installation and Setup

1. Install the extension in VS Code.
2. Import `SCM_API.sdp` into your STARLIMS environment.
3. Configure the STARLIMS connection settings in VS Code.
4. Set `STARLIMS.rootPath` to the parent folder where the extension should create the local `SLVSCODE` workspace mirror.
5. Open the STARLIMS view from the activity bar and connect to a configured server.

The extension creates or opens the `SLVSCODE` folder under `STARLIMS.rootPath` and uses it as the local working copy for checked out items.

## Configuration

Core settings:

- `STARLIMS.url`: STARLIMS installation URL
- `STARLIMS.user`: STARLIMS user name
- `STARLIMS.userPassword`: Password stored through the extension command instead of the settings file
- `STARLIMS.rootPath`: Parent folder for the local `SLVSCODE` workspace mirror

Common optional settings:

- `STARLIMS.servers`: Named server definitions for multi-environment setups
- `STARLIMS.browser`: Browser used for form debugging (`chrome` or `msedge`)
- `STARLIMS.urlSuffix`: Service suffix for environments that require `lims2`
- `STARLIMS.defaultFormLanguage`: Default language used when checking out form items

## MCP Integration

The extension also starts a local form callback server on the first free loopback port in the range `3003-3099` for FormDesigner code-behind navigation. The selected port is published back to STARLIMS SCM so the FormDesigner client can resolve it dynamically.

When `STARLIMS.mcp.enabled` is enabled, the extension exposes a local MCP endpoint on `http://127.0.0.1:3002/mcp` by default.

The MCP integration is intentionally limited:

- It binds to loopback only
- It uses the currently selected STARLIMS server
- It supports browse, search, code retrieval, and checkout operations
- Destructive actions such as check-in, delete, rename, move, and script execution are not exposed

Related settings:

- `STARLIMS.mcp.enabled`: Enables the endpoint
- `STARLIMS.mcp.port`: Changes the loopback port used by MCP
- `STARLIMS.mcp.maxItems`: Limits browse and search result sizes
- `STARLIMS.mcp.maxCodeCharacters`: Limits code returned by read requests

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
