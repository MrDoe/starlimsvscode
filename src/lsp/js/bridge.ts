import { Connection } from 'vscode-languageserver/node';

export interface ResolveIncludeResult {
  uri: string;
  sourceText: string;
}

export interface ResolveIncludeParams {
  includeName: string;
  workspaceRoot: string;
}

export function createBridge(connection: Connection) {
  async function resolveInclude(
    includeName: string,
    workspaceRoot: string,
  ): Promise<ResolveIncludeResult | null> {
    try {
      const result = await connection.sendRequest<ResolveIncludeResult | null>(
        'starlims/resolveInclude',
        { includeName, workspaceRoot } as ResolveIncludeParams,
      );
      return result;
    } catch {
      return null;
    }
  }

  return { resolveInclude };
}
