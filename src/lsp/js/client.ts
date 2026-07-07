import * as path from 'path';
import * as fs from 'fs';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export function startJsLanguageClient(
  context: { asAbsolutePath: (relative: string) => string },
  workspaceRoot: string,
): LanguageClient {
  const serverModule = context.asAbsolutePath(path.join('dist', 'js-language-server.js'));

  // Read globals content to pass to the server
  let globalsContent: string | undefined;
  try {
    const globalsPath = context.asAbsolutePath(path.join('src', 'lsp', 'globals.d.ts'));
    if (fs.existsSync(globalsPath)) {
      globalsContent = fs.readFileSync(globalsPath, 'utf-8');
    }
  } catch { /* dev build without src available */ }

  // Try dist fallback for shipped extension
  if (!globalsContent) {
    try {
      const distGlobalsPath = context.asAbsolutePath(path.join('dist', 'starlims-globals.d.ts'));
      if (fs.existsSync(distGlobalsPath)) {
        globalsContent = fs.readFileSync(distGlobalsPath, 'utf-8');
      }
    } catch { /* ignore */ }
  }

  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc,
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6010'] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'javascript' },
    ],
    initializationOptions: {
      globalsContent,
    },
  };

  client = new LanguageClient(
    'jsLanguageServer',
    'STARLIMS JavaScript Language Server',
    serverOptions,
    clientOptions,
  );

  client.start();
  return client;
}

export function stopJsLanguageClient(): Thenable<void> | undefined {
  if (!client) return undefined;
  return client.stop();
}

export function getJsLanguageClient(): LanguageClient | undefined {
  return client;
}
