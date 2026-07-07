import {
  ScriptSnapshot,
  IScriptSnapshot,
  CompilerOptions,
  ScriptTarget,
  ScriptKind,
  ModuleKind,
  ModuleResolutionKind,
  createLanguageService,
  LanguageService,
  LanguageServiceHost,
  getDefaultLibFilePath,
} from 'typescript';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { RemoteFileCache } from './remoteFileCache';

interface DocumentState {
  document: TextDocument;
  version: number;
}

export class StarlimsJsLanguageHost implements LanguageServiceHost {
  private openDocs = new Map<string, DocumentState>();
  private ambientSnapshots = new Map<string, IScriptSnapshot>();
  private ambientFileNames: string[] = [];
  private extraScriptUris = new Set<string>();

  constructor(
    private remoteFileCache: RemoteFileCache,
    private workspaceRoot: string,
    globalsContent?: string,
  ) {
    this.loadAmbientContent(globalsContent);
  }

  getCompilationSettings(): CompilerOptions {
    return {
      allowJs: true,
      checkJs: false,
      target: ScriptTarget.ES2020,
      module: ModuleKind.None,
      moduleResolution: ModuleResolutionKind.Classic,
      strict: false,
      noEmit: true,
      skipLibCheck: true,
      lib: ['ES2020'],
    };
  }

  getScriptFileNames(): string[] {
    const seen = new Set<string>();
    const names: string[] = [];
    this.openDocs.forEach((_state, uri) => {
      if (!seen.has(uri)) { seen.add(uri); names.push(uri); }
    });
    this.extraScriptUris.forEach(uri => {
      if (!seen.has(uri)) { seen.add(uri); names.push(uri); }
    });
    this.ambientFileNames.forEach(fn => {
      if (!seen.has(fn)) { names.push(fn); }
    });
    return names;
  }

  getScriptKind(fileName: string): ScriptKind {
    if (fileName.endsWith('.d.ts')) return ScriptKind.TS;
    return ScriptKind.JS;
  }

  getScriptVersion(fileName: string): string {
    const doc = this.openDocs.get(fileName);
    if (doc) return String(doc.version);
    const cached = this.remoteFileCache.get(fileName);
    if (cached) return String(cached.version);
    return '0';
  }

  getScriptSnapshot(fileName: string): IScriptSnapshot | undefined {
    const doc = this.openDocs.get(fileName);
    if (doc) {
      return ScriptSnapshot.fromString(doc.document.getText());
    }
    const cached = this.remoteFileCache.get(fileName);
    if (cached) {
      return ScriptSnapshot.fromString(cached.sourceText);
    }
    const ambient = this.ambientSnapshots.get(fileName);
    if (ambient) return ambient;
    return undefined;
  }

  getCurrentDirectory(): string {
    return this.workspaceRoot;
  }

  getDefaultLibFileName(options: CompilerOptions): string {
    return getDefaultLibFilePath(options);
  }

  readFile(path: string): string | undefined {
    try {
      return require('fs').readFileSync(path, 'utf-8');
    } catch {
      return undefined;
    }
  }

  fileExists(path: string): boolean {
    try {
      return require('fs').statSync(path).isFile();
    } catch {
      return false;
    }
  }

  openDocument(uri: string, document: TextDocument): void {
    const existing = this.openDocs.get(uri);
    this.openDocs.set(uri, {
      document,
      version: existing ? existing.version + 1 : 1,
    });
  }

  closeDocument(uri: string): void {
    this.openDocs.delete(uri);
  }

  addRemoteFile(uri: string): void {
    this.extraScriptUris.add(uri);
  }

  getOpenDocument(uri: string): TextDocument | undefined {
    return this.openDocs.get(uri)?.document;
  }

  private loadAmbientContent(globalsContent?: string, typingsContent?: string): void {
    if (globalsContent) {
      const key = '/starlims-globals.d.ts';
      this.ambientFileNames.push(key);
      this.ambientSnapshots.set(key, ScriptSnapshot.fromString(globalsContent));
    }
    if (typingsContent) {
      const key = '/starlims-runtime.d.ts';
      this.ambientFileNames.push(key);
      this.ambientSnapshots.set(key, ScriptSnapshot.fromString(typingsContent));
    }
  }
}
