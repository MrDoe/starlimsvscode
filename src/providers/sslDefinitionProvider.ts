import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Host-side definition provider for DoProc/ExecFunction string arguments.
 *
 * VS Code merges results from multiple definition providers, so this provider
 * only handles string-literal call targets while the SSL LSP keeps handling
 * identifiers. Resolution order:
 *   1. workspace namespaces (starlimsSslLsp.documentNamespaces)
 *   2. procedure in the current document
 *   3. procedures inside :INCLUDE libraries (live server)
 *   4. live STARLIMS lookup of "App.Procedure" style targets
 */

export interface StringCallServices {
  search(scriptName: string, itemType: string): Promise<{ uri: string } | undefined>;
  getLocalCopy(uri: string): Promise<string | undefined>;
}

const CALL_RE = /(DoProc|ExecFunction)\s*\(\s*["']([\w.\-]+)["']/i;

function findStringCallTarget(
  document: vscode.TextDocument,
  position: vscode.Position
): string | null {
  const line = document.lineAt(position.line).text;
  const match = line.match(CALL_RE);
  if (!match) {
    return null;
  }
  const callStart = (match.index ?? 0) + match[0].length - match[2].length - 2;
  const callEnd = callStart + match[2].length;
  if (position.character < callStart || position.character > callEnd) {
    return null;
  }
  return match[2];
}

function parseScriptTarget(target: string): { scriptName: string; procedureName?: string } {
  let components = target.split('.');
  if (components[0] === 'ServerScript') {
    components.shift();
    if (components[2] === 'main_') {
      components.pop();
    }
  }
  if (components.length <= 1) {
    return { scriptName: target, procedureName: target };
  }
  return {
    scriptName: components.slice(0, 2).join('.'),
    procedureName: components.length > 2 ? components[2] : undefined,
  };
}

function findProcedureRange(document: vscode.TextDocument, procedureName: string): vscode.Range | null {
  const text = document.getText();
  const procRegex = new RegExp(`:PROCEDURE\\s+${procedureName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const match = text.match(procRegex);
  if (match?.index === undefined) {
    return null;
  }
  const pos = document.positionAt(match.index);
  return new vscode.Range(pos, pos);
}

async function resolveViaNamespaces(
  target: string,
  workspaceFolder: vscode.WorkspaceFolder,
  namespaces: Record<string, string>
): Promise<vscode.Location | null> {
  const parts = target.split('.');
  const prefixes = Object.keys(namespaces)
    .filter((p) => parts.length > 1 && p.toLowerCase() === parts[0].toLowerCase());
  if (prefixes.length === 0) {
    return null;
  }
  const prefix = prefixes[0];
  const folder = namespaces[prefix];
  const rest = parts.slice(1);
  const fileName = rest.pop() + '.ssl';
  const relative = path.join(folder, ...rest, fileName);
  const filePath = path.join(workspaceFolder.uri.fsPath, relative);
  const fileUri = vscode.Uri.file(filePath);
  try {
    await vscode.workspace.fs.stat(fileUri);
  } catch {
    return null;
  }
  return new vscode.Location(fileUri, new vscode.Position(0, 0));
}

async function resolveOnServer(
  target: string,
  services: StringCallServices,
  language: string | undefined
): Promise<vscode.Location | null> {
  const { scriptName, procedureName } = parseScriptTarget(target);
  if (components(scriptName).length < 2) {
    return null;
  }
  const item = await services.search(scriptName, 'SS');
  if (!item) {
    return null;
  }
  const localPath = await services.getLocalCopy(item.uri);
  if (!localPath) {
    return null;
  }
  const uri = vscode.Uri.file(localPath);
  const doc = await vscode.workspace.openTextDocument(uri);
  if (procedureName) {
    const range = findProcedureRange(doc, procedureName);
    if (range) {
      return new vscode.Location(uri, range.start);
    }
  }
  return new vscode.Location(uri, new vscode.Position(0, 0));
}

function components(name: string): string[] {
  return name.split('.');
}

async function resolveIncludes(
  document: vscode.TextDocument,
  target: string,
  services: StringCallServices
): Promise<vscode.Location | null> {
  const includeRegex = /:INCLUDE\s+"([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = includeRegex.exec(document.getText())) !== null) {
    const library = m[1];
    const item = await services.search(library, 'SS');
    if (!item) {
      continue;
    }
    const localPath = await services.getLocalCopy(item.uri);
    if (!localPath) {
      continue;
    }
    const uri = vscode.Uri.file(localPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const range = findProcedureRange(doc, target);
    if (range) {
      return new vscode.Location(uri, range.start);
    }
  }
  return null;
}

export function registerSSLDefinitionProvider(
  context: vscode.ExtensionContext,
  services: StringCallServices,
  getLanguageForFile: (uri: vscode.Uri) => string | undefined
): void {
  const provider = vscode.languages.registerDefinitionProvider(
    [{ scheme: 'file', language: 'SSL' }],
    {
      async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position
      ): Promise<vscode.Location | vscode.Location[] | null> {
        const target = findStringCallTarget(document, position);
        if (!target) {
          return null;
        }

        // 1. Current document procedure
        const localRange = findProcedureRange(document, target);
        if (localRange) {
          return new vscode.Location(document.uri, localRange.start);
        }

        const results: vscode.Location[] = [];

        // 2. Workspace namespaces
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const cfg = vscode.workspace.getConfiguration('starlimsSslLsp');
        const namespaces = cfg.get<Record<string, string>>('documentNamespaces', {});
        if (workspaceFolder && namespaces && Object.keys(namespaces).length > 0) {
          const nsLocation = await resolveViaNamespaces(target, workspaceFolder, namespaces);
          if (nsLocation) {
            results.push(nsLocation);
          }
        }

        // 3. :INCLUDE libraries
        const { procedureName } = parseScriptTarget(target);
        if (components(target).length === 1 && procedureName) {
          const includeLocation = await resolveIncludes(document, target, services);
          if (includeLocation) {
            results.push(includeLocation);
          }
        }

        // 4. Live server lookup
        const serverLocation = await resolveOnServer(target, services, getLanguageForFile(document.uri));
        if (serverLocation) {
          results.push(serverLocation);
        }

        return results.length > 0 ? results : null;
      },
    }
  );
  context.subscriptions.push(provider);
}