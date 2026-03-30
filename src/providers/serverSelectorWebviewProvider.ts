"use strict";
import * as vscode from "vscode";
import * as crypto from 'crypto';

export interface ServerConfig {
  name: string;
  url: string;
  user?: string;
  urlSuffix?: string;
}

export class ServerSelectorWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'STARLIMSServerSelector';

  private _view?: vscode.WebviewView;
  private _servers: ServerConfig[] = [];
  private _selectedServer: string = '';

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
    private readonly _onServerChanged: (server: ServerConfig | undefined) => void
  ) {
    this.loadServers();
  }

  private normalizeServers(value: unknown): ServerConfig[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .filter((entry): entry is Partial<ServerConfig> => !!entry && typeof entry === 'object')
      .map((entry) => ({
        name: typeof entry.name === 'string' ? entry.name : '',
        url: typeof entry.url === 'string' ? entry.url : '',
        user: typeof entry.user === 'string' ? entry.user : undefined,
        urlSuffix: typeof entry.urlSuffix === 'string' ? entry.urlSuffix : 'lims'
      }))
      .filter((entry) => !!entry.name && !!entry.url);
  }

  private readServerConfigFromWorkspaceFolders(): { servers: ServerConfig[]; selectedServer: string } {
    const workspaceFolders = vscode.workspace.workspaceFolders || [];

    for (const folder of workspaceFolders) {
      const folderConfig = vscode.workspace.getConfiguration('STARLIMS', folder.uri);
      const folderServers = this.normalizeServers(folderConfig.get('servers', []));
      if (folderServers.length > 0) {
        return {
          servers: folderServers,
          selectedServer: folderConfig.get('selectedServer', '')
        };
      }
    }

    return { servers: [], selectedServer: '' };
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this.logState('resolveWebviewView start');
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this._extensionUri
      ]
    };

    this.logState('resolveWebviewView after options');

    webviewView.webview.onDidReceiveMessage(data => {
      switch (data.type) {
        case 'serverSelected':
          this.selectServer(data.serverName);
          break;
        case 'configureServer':
          this.configureCurrentServer();
          break;
        case 'addServer':
          this.createNewServer();
          break;
        case 'deleteServer':
          this.deleteCurrentServer();
          break;
        case 'ready':
          // Ensure server list is read again once the webview is ready
          this.loadServers();
          this.updateWebview();
          break;
      }
    });

    webviewView.onDidChangeVisibility(() => {
      this.logState('onDidChangeVisibility:' + webviewView.visible);
      if (webviewView.visible) {
        this.updateWebview();
      }
    });

    webviewView.onDidDispose(() => {
      this.logState('onDidDispose');
      this._view = undefined;
    });

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    this.updateWebview();
    this.logState('resolveWebviewView end');
  }

  private logState(context: string) {
    console.log(`[ServerSelector] ${context}`, {
      servers: this._servers,
      selectedServer: this._selectedServer,
      view: !!this._view,
      workspaceFolders: vscode.workspace.workspaceFolders?.map(f => f.name)
    });
  }

  private loadServers() {
    const config = vscode.workspace.getConfiguration("STARLIMS");
    this._servers = this.normalizeServers(config.get("servers", []));
    this._selectedServer = config.get("selectedServer", "");

    // Fallback for multi-root/folder-scoped settings where workspace-level lookup is empty.
    if (this._servers.length === 0) {
      const folderScopedConfig = this.readServerConfigFromWorkspaceFolders();
      this._servers = folderScopedConfig.servers;
      this._selectedServer = folderScopedConfig.selectedServer;
    }

    if (this._servers.length > 0 && !this._servers.some(s => s.name === this._selectedServer)) {
      this._selectedServer = this._servers[0].name;
    }

    // Migrate legacy configuration if needed
    const legacyUrl = config.get("url") as string;
    const legacyUser = config.get("user") as string;
    
    if (legacyUrl && this._servers.length === 0) {
      const legacyServer: ServerConfig = {
        name: "Default Server",
        url: legacyUrl,
        user: legacyUser,
        urlSuffix: config.get("urlSuffix", "lims")
      };
      this._servers = [legacyServer];
      this._selectedServer = legacyServer.name;
      
      // Save migrated configuration
      config.update("servers", this._servers, false);
      config.update("selectedServer", this._selectedServer, false);
    }

    this.logState('loadServers');
  }

  private selectServer(serverName: string) {
    this._selectedServer = serverName;
    const config = vscode.workspace.getConfiguration("STARLIMS");
    config.update("selectedServer", serverName, false);
    
    const selectedServerConfig = this._servers.find(s => s.name === serverName);
    this._onServerChanged(selectedServerConfig);
    this.logState('selectServer');
    this.updateWebview();
  }

  private async configureCurrentServer() {
    const selectedServerConfig = this._servers.find(s => s.name === this._selectedServer);
    
    if (!selectedServerConfig) {
      vscode.window.showErrorMessage("No server selected to configure.");
      return;
    }

    // Edit existing server
    await this.editServer(selectedServerConfig);
  }

  private async createNewServer() {
    const name = await vscode.window.showInputBox({
      prompt: "Enter server name",
      placeHolder: "My STARLIMS Server"
    });
    
    if (!name) return;

    const url = await vscode.window.showInputBox({
      prompt: "Enter STARLIMS URL",
      placeHolder: "https://my.starlims.server.com/STARLIMS/"
    });
    
    if (!url) return;

    const user = await vscode.window.showInputBox({
      prompt: "Enter username",
      placeHolder: "username"
    });

    if (!user) return;

    const password = await vscode.window.showInputBox({
      prompt: `Enter password for user '${user}'`,
      password: true
    });

    if (!password) return;

    const urlSuffix = await vscode.window.showInputBox({
      prompt: "Enter URL suffix (optional)",
      placeHolder: "lims",
      value: "lims"
    });

    const newServer: ServerConfig = {
      name,
      url,
      user: user? user : undefined,
      urlSuffix: urlSuffix || "lims"
    };

    // Store password in secret storage with server-specific key
    const workspaceKey = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "default";
    const workspaceId = crypto.createHash('sha1').update(workspaceKey).digest('hex');
    const serverSecretKey = `${workspaceId}:${name}:userPassword`;
    await this._context.secrets.store(serverSecretKey, password);

    this._servers.push(newServer);
    const config = vscode.workspace.getConfiguration("STARLIMS");
    await config.update("servers", this._servers, false);
    
    // Select the new server and trigger refresh
    this._selectedServer = newServer.name;
    await config.update("selectedServer", this._selectedServer, false);
    this._onServerChanged(newServer);
    
    this.updateWebview();
  }

  private async editServer(server: ServerConfig) {
    const url = await vscode.window.showInputBox({
      prompt: "Enter STARLIMS URL",
      value: server.url
    });
    
    if (url === undefined) return;

    const user = await vscode.window.showInputBox({
      prompt: "Enter username",
      value: server.user || ""
    });

    if (user === undefined) return;

    // Ask for password
    const setPassword = await vscode.window.showQuickPick(
      [
        { label: "Keep current password" },
        { label: "Set new password" }
      ],
      { 
        placeHolder: "Password setting",
        ignoreFocusOut: true
      }
    );

    if (setPassword?.label === "Set new password") {
      const password = await vscode.window.showInputBox({
        prompt: `Enter password for user '${user}'`,
        password: true
      });

      if (password !== undefined) {
        // Store password in secret storage with server-specific key
        const workspaceKey = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "default";
        const workspaceId = crypto.createHash('sha1').update(workspaceKey).digest('hex');
        const serverSecretKey = `${workspaceId}:${server.name}:userPassword`;
        await this._context.secrets.store(serverSecretKey, password);
      }
    }

    const urlSuffix = await vscode.window.showInputBox({
      prompt: "Enter URL suffix",
      value: server.urlSuffix || "lims"
    });

    if (urlSuffix === undefined) return;

    // Update server config
    server.url = url;
    server.user = user? user : undefined;
    server.urlSuffix = urlSuffix || "lims";

    const config = vscode.workspace.getConfiguration("STARLIMS");
    await config.update("servers", this._servers, false);
    
    if (this._selectedServer === server.name) {
      this._onServerChanged(server);
    }
    
    this.updateWebview();
    this.refresh();
  }

  private async deleteCurrentServer() {
    const selectedServerConfig = this._servers.find(s => s.name === this._selectedServer);
    
    if (!selectedServerConfig) {
      vscode.window.showErrorMessage("No server selected to delete.");
      return;
    }

    // Ask for confirmation
    const confirm = await vscode.window.showWarningMessage(
      `Are you sure you want to delete the server "${selectedServerConfig.name}"?`,
      { modal: true },
      "Yes"
    );

    if (confirm !== "Yes") {
      return;
    }

    // Remove the server from the list
    this._servers = this._servers.filter(s => s.name !== this._selectedServer);

    // Remove password from secret storage
    const workspaceKey = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "default";
    const workspaceId = crypto.createHash('sha1').update(workspaceKey).digest('hex');
    const serverSecretKey = `${workspaceId}:${selectedServerConfig.name}:userPassword`;
    await this._context.secrets.delete(serverSecretKey);

    // Update configuration
    const config = vscode.workspace.getConfiguration("STARLIMS");
    await config.update("servers", this._servers, false);

    // If the deleted server was selected, select another one or none
    if (this._servers.length > 0) {
      this._selectedServer = this._servers[0].name;
      await config.update("selectedServer", this._selectedServer, false);
      this._onServerChanged(this._servers[0]);
    } else {
      this._selectedServer = "";
      await config.update("selectedServer", "", false);
      this._onServerChanged(undefined);
    }

    this.updateWebview();
    this.refresh();
  }

  public refresh() {
    this.loadServers();
    this.updateWebview();
  }

  public getSelectedServer(): ServerConfig | undefined {
    return this._servers.find(s => s.name === this._selectedServer);
  }

  private updateWebview() {
    this.logState('updateWebview');
    const payload = {
      type: 'updateServers',
      servers: this._servers,
      selectedServer: this._selectedServer
    };

    if (this._view) {
      this._view.webview.postMessage(payload);
    } else {
      // Wenn View noch nicht da ist, jetzt nicht endlos loopen, sondern warten auf die eigentliche Resolve-/Visibility-Event.
      console.log('[ServerSelector] updateWebview: view not ready, skipping. will retry on resolve/visibility.');
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const initialState = JSON.stringify({
      servers: this._servers,
      selectedServer: this._selectedServer
    }).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Server Selector</title>
        <style>
            body {
                padding: 6px;
                font-family: var(--vscode-font-family);
                font-size: var(--vscode-font-size);
                color: var(--vscode-foreground);
            }
            .server-selector {
                display: flex;
                align-items: center;
                gap: 4px;
                margin-bottom: 0px;
            }
            select {
                flex: 1;
                padding: 2px 4px;
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border);
                border-radius: 2px;
                font-size: var(--vscode-font-size);
                min-width: 0;
            }
            button {
                padding: 2px 6px;
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                border-radius: 2px;
                cursor: pointer;
                font-size: 12px;
                white-space: nowrap;
                min-width: 24px;
                height: 24px;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            button:hover {
                background: var(--vscode-button-hoverBackground);
            }
            button:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            .no-servers {
                color: var(--vscode-descriptionForeground);
                font-style: italic;
                margin-bottom: 6px;
                font-size: 11px;
            }
        </style>
    </head>
    <body>
        <div class="server-selector">
            <select id="serverSelect">
                <option value="">No servers configured</option>
            </select>
            <button id="configureBtn" title="Configure Server" disabled>⚙️</button>
            <button id="addBtn" title="Add New Server">+</button>
            <button id="deleteBtn" title="Delete Server" disabled>🗑️</button>
        </div>
        <div id="noServers" class="no-servers" style="display: none;">
            No servers configured. Click + to add.
        </div>

        <script>
            const vscode = acquireVsCodeApi();
          const initialState = ${initialState};
            const serverSelect = document.getElementById('serverSelect');
            const configureBtn = document.getElementById('configureBtn');
            const addBtn = document.getElementById('addBtn');
            const deleteBtn = document.getElementById('deleteBtn');
            const noServers = document.getElementById('noServers');

            serverSelect.addEventListener('change', () => {
                vscode.postMessage({
                    type: 'serverSelected',
                    serverName: serverSelect.value
                });
                updateButtonStates();
            });

            configureBtn.addEventListener('click', () => {
                vscode.postMessage({
                    type: 'configureServer'
                });
            });

            addBtn.addEventListener('click', () => {
                vscode.postMessage({
                    type: 'addServer'
                });
            });

            deleteBtn.addEventListener('click', () => {
                vscode.postMessage({
                    type: 'deleteServer'
                });
            });

            window.addEventListener('message', event => {
                const message = event.data;
                switch (message.type) {
                    case 'updateServers':
                        updateServerList(message.servers, message.selectedServer);
                        break;
                }
            });

            function updateServerList(servers, selectedServer) {
                serverSelect.innerHTML = '';
                
                if (servers.length === 0) {
                    serverSelect.innerHTML = '<option value="">No servers configured</option>';
                    noServers.style.display = 'block';
                    serverSelect.disabled = true;
                } else {
                    noServers.style.display = 'none';
                    serverSelect.disabled = false;
                    
                    servers.forEach(server => {
                        const option = document.createElement('option');
                        option.value = server.name;
                        option.textContent = server.name;
                        if (server.name === selectedServer) {
                            option.selected = true;
                        }
                        serverSelect.appendChild(option);
                    });
                }
                updateButtonStates();
            }

            function updateButtonStates() {
                const hasSelection = serverSelect.value !== '' && serverSelect.value !== 'No servers configured';
                configureBtn.disabled = !hasSelection;
                deleteBtn.disabled = !hasSelection;
            }

            // Initialize
            console.log('STARLIMS Server Selector Webview initialize', initialState);
            updateServerList(initialState.servers || [], initialState.selectedServer || '');
            vscode.postMessage({ type: 'ready' });
        </script>
    </body>
    </html>`;
  }
}