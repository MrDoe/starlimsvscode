import * as fs from 'fs';
import * as path from 'path';

export interface ResolveIncludeParams {
  includeName: string;
  workspaceRoot: string;
}

export interface ResolveIncludeResult {
  uri: string;
  sourceText: string;
}

export function registerJsIncludeResolver(
  client: any,
  enterpriseService: any,
  workspaceRoot: string,
): void {
  if (!client || !client.onRequest) return;

  client.onRequest('starlims/resolveInclude', async (params: ResolveIncludeParams) => {
    const { includeName } = params;
    if (!includeName) return null;

    const parts = includeName.split('.');
    const itemBase = parts[parts.length - 1];
    const app = parts.length > 1 ? parts[0] : undefined;

    const localPaths: string[] = [];
    if (app) {
      localPaths.push(
        path.join(workspaceRoot, 'Production', 'ClientScripts', app, `${itemBase}.js`),
      );
    }
    localPaths.push(...findJsFiles(workspaceRoot, itemBase));

    for (const p of localPaths) {
      try {
        if (fs.statSync(p).isFile()) {
          const sourceText = fs.readFileSync(p, 'utf-8');
          return { uri: p, sourceText } as ResolveIncludeResult;
        }
      } catch { /* not found */ }
    }

    try {
      const result = await resolveViaMcp(enterpriseService, includeName);
      if (result) return result;
    } catch { /* MCP unavailable */ }

    return null;
  });
}

function findJsFiles(root: string, itemBase: string): string[] {
  const results: string[] = [];
  const baseLower = itemBase.toLowerCase();

  function walk(dir: string): void {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'ServerLogs') continue;
      const full = path.join(dir, entry);
      let stat: fs.Stats;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile() && entry.endsWith('.js') && entry.slice(0, -3).toLowerCase() === baseLower) {
        results.push(full);
      }
    }
  }

  walk(root);
  return results;
}

async function resolveViaMcp(
  enterpriseService: any,
  includeName: string,
): Promise<ResolveIncludeResult | null> {
  if (!enterpriseService || !enterpriseService.starLimsClient) return null;

  try {
    const parts = includeName.split('.');
    const shortName = parts[parts.length - 1];

    const searchResult = await enterpriseService.starLimsClient.searchByName(shortName, undefined, true);
    if (!searchResult || searchResult.length === 0) return null;

    const item = searchResult[0];
    const codeResult = await enterpriseService.starLimsClient.getCode(item.uri);
    if (!codeResult) return null;

    const sourceText = typeof codeResult === 'string' ? codeResult : codeResult.code || '';
    const uri = `starlims://${includeName}`;
    return { uri, sourceText } as ResolveIncludeResult;
  } catch {
    return null;
  }
}
