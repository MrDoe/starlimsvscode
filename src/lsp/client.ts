import * as path from 'path';
import { workspace, ExtensionContext } from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export function startLanguageClient(context: ExtensionContext): LanguageClient {
  // Server module path
  const serverModule = context.asAbsolutePath(path.join('dist', 'ssl-language-server.js'));

  // Server options
  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc,
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: {
        execArgv: ['--nolazy', '--inspect=6009'],
      },
    },
  };

  // Client options
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'SSL' },
      { scheme: 'file', language: 'SLSQL' },
    ],
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher('**/*.ssl'),
    },
  };

  // Create and start client
  client = new LanguageClient(
    'sslLanguageServer',
    'SSL Language Server',
    serverOptions,
    clientOptions
  );

  client.start();

  return client;
}

export function stopLanguageClient(): Thenable<void> | undefined {
  if (!client) return undefined;
  return client.stop();
}
