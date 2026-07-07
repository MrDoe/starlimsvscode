const INCLUDE_RE = /\b\/\/\s*#include\s+"([^"]+)"/g;

export interface ResolvedInclude {
  includeName: string;
  uri: string;
  sourceText: string;
}

export function parseIncludes(source: string): string[] {
  const names: string[] = [];
  let match: RegExpExecArray | null;
  INCLUDE_RE.lastIndex = 0;
  while ((match = INCLUDE_RE.exec(source)) !== null) {
    names.push(match[1]);
  }
  return names;
}

export function buildWorkspaceIndex(rootPath: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const fs = require('fs');
  const path = require('path');

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'ServerLogs') continue;
      const full = path.join(dir, entry);
      let stat: import('fs').Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile() && entry.endsWith('.js')) {
        const base = entry.slice(0, -3).toLowerCase();
        const existing = index.get(base);
        if (existing) {
          existing.push(full);
        } else {
          index.set(base, [full]);
        }
      }
    }
  }

  if (rootPath && fs.existsSync(rootPath)) {
    walk(rootPath);
  }
  return index;
}

export function resolveIncludeLocally(
  includeName: string,
  workspaceIndex: Map<string, string[]>,
  rootPath: string
): string | undefined {
  const parts = includeName.split('.');
  const itemBase = parts[parts.length - 1].toLowerCase();
  const app = parts.length > 1 ? parts[0].toLowerCase() : undefined;

  const candidates = workspaceIndex.get(itemBase);
  if (!candidates || candidates.length === 0) return undefined;

  if (candidates.length === 1) return candidates[0];

  // Multiple candidates: prefer the one whose parent folder name matches the app prefix
  if (app) {
    for (const c of candidates) {
      const parent = require('path').basename(require('path').dirname(c)).toLowerCase();
      if (parent === app) return c;
    }
  }

  // Fallback: prefer ClientScripts over HTMLForms/CodeBehind
  const cs = candidates.find(c => c.includes('ClientScripts'));
  if (cs) return cs;
  return candidates[0];
}
