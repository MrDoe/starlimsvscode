import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  CompletionItem,
  CompletionItemKind,
  Hover,
  Location,
  Position,
  Range,
  SymbolInformation,
  FoldingRange,
  Diagnostic,
  DiagnosticSeverity,
  TextDocumentChangeEvent,
  CompletionParams,
  TextDocumentPositionParams,
  ReferenceParams,
  DocumentSymbolParams,
  FoldingRangeParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as ts from 'typescript';
import { StarlimsJsLanguageHost } from './languageHost';
import { RemoteFileCache } from './remoteFileCache';
import { parseIncludes, buildWorkspaceIndex, resolveIncludeLocally } from './includeResolver';
import { createBridge } from './bridge';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let languageHost: StarlimsJsLanguageHost | undefined;
let languageService: ts.LanguageService | undefined;
let workspaceIndex = new Map<string, string[]>();
let remoteFileCache: RemoteFileCache | undefined;
let bridge: ReturnType<typeof createBridge> | undefined;
let workspaceRoot = '';

const validationTimers = new Map<string, ReturnType<typeof setTimeout>>();

function getSourceForUri(uri: string): string | undefined {
  if (!languageHost) return undefined;
  const doc = languageHost.getOpenDocument(uri);
  if (doc) return doc.getText();
  const cached = remoteFileCache?.get(uri);
  if (cached) return cached.sourceText;
  return undefined;
}

function offsetToPosition(text: string, offset: number): Position {
  let line = 0;
  let col = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      col = 0;
    } else if (text[i] !== '\r') {
      col++;
    }
  }
  return { line, character: col };
}

function tsSpanToRange(uri: string, span: ts.TextSpan): Range {
  const source = getSourceForUri(uri);
  if (source) {
    const start = offsetToPosition(source, span.start);
    const end = offsetToPosition(source, span.start + span.length);
    return { start, end };
  }
  return {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  };
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  workspaceRoot = params.rootPath || params.rootUri?.replace(/^file:\/\//, '') || '';
  const opts = params.initializationOptions || {};
  const globalsContent: string | undefined = opts.globalsContent;

  remoteFileCache = new RemoteFileCache();
  languageHost = new StarlimsJsLanguageHost(remoteFileCache, workspaceRoot, globalsContent);
  languageService = ts.createLanguageService(languageHost);
  bridge = createBridge(connection);

  workspaceIndex = buildWorkspaceIndex(workspaceRoot);
  connection.console.log(`JS Language Server initialised. Workspace: ${workspaceRoot}, JS files indexed: ${workspaceIndex.size}`);

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        triggerCharacters: ['.', '(', '"', "'"],
        resolveProvider: true,
      },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      foldingRangeProvider: true,
      signatureHelpProvider: {
        triggerCharacters: ['(', ','],
      },
    },
  };
});

connection.onInitialized(() => {
  connection.console.log('JS Language Server initialised');
});

documents.onDidChangeContent((change: TextDocumentChangeEvent<TextDocument>) => {
  const uri = change.document.uri;
  const existing = validationTimers.get(uri);
  if (existing) clearTimeout(existing);
  validationTimers.set(uri, setTimeout(() => {
    validationTimers.delete(uri);
    void validateDocument(change.document);
  }, 300));
});

documents.onDidClose((event: TextDocumentChangeEvent<TextDocument>) => {
  const uri = event.document.uri;
  const existing = validationTimers.get(uri);
  if (existing) { clearTimeout(existing); validationTimers.delete(uri); }
});

async function validateDocument(document: TextDocument): Promise<void> {
  const uri = document.uri;
  if (!languageHost || !languageService) return;

  languageHost.openDocument(uri, document);

  const text = document.getText();
  const includeNames = parseIncludes(text);
  for (const includeName of includeNames) {
    const localPath = resolveIncludeLocally(includeName, workspaceIndex, workspaceRoot);
    if (localPath) {
      if (!remoteFileCache!.has(localPath)) {
        try {
          const fs = require('fs');
          const source = fs.readFileSync(localPath, 'utf-8');
          remoteFileCache!.set(localPath, source);
        } catch { /* skip unreadable */ continue; }
      }
      languageHost.addRemoteFile(localPath);
      continue;
    }
    const cacheKey = `starlims://${includeName}`;
    if (!remoteFileCache!.has(cacheKey)) {
      if (bridge) {
        const result = await bridge.resolveInclude(includeName, workspaceRoot);
        if (result) {
          remoteFileCache!.set(result.uri, result.sourceText);
          languageHost.addRemoteFile(result.uri);
        }
      }
    } else {
      languageHost.addRemoteFile(cacheKey);
    }
  }

  const diagnostics: Diagnostic[] = [];

  // Syntactic errors (parse)
  const syntacticDiags = languageService.getSyntacticDiagnostics(uri);
  for (const diag of syntacticDiags) {
    if (!diag.file || !diag.start) continue;
    const start = diag.file.getLineAndCharacterOfPosition(diag.start);
    const end = diag.file.getLineAndCharacterOfPosition(diag.start + diag.length);
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: {
        start: { line: start.line, character: start.character },
        end: { line: end.line, character: end.character },
      },
      message: typeof diag.messageText === 'string' ? diag.messageText : diag.messageText.messageText,
      source: 'js-lsp',
    });
  }

  // Suggestion diagnostics (unused variables, etc.) — cross-file aware
  const suggestionDiags = languageService.getSuggestionDiagnostics(uri);
  for (const diag of suggestionDiags) {
    if (!diag.file || !diag.start) continue;
    const start = diag.file.getLineAndCharacterOfPosition(diag.start);
    const end = diag.file.getLineAndCharacterOfPosition(diag.start + diag.length);
    diagnostics.push({
      severity: DiagnosticSeverity.Warning,
      range: {
        start: { line: start.line, character: start.character },
        end: { line: end.line, character: end.character },
      },
      message: typeof diag.messageText === 'string' ? diag.messageText : diag.messageText.messageText,
      source: 'js-lsp',
    });
  }

  connection.sendDiagnostics({ uri, diagnostics });
}

// Completion
connection.onCompletion((params: CompletionParams): CompletionItem[] => {
  if (!languageService) return [];
  const uri = params.textDocument.uri;
  const pos = params.position;
  const doc = languageHost?.getOpenDocument(uri);
  if (!doc) return [];
  const offset = doc.offsetAt(pos);
  const items = languageService.getCompletionsAtPosition(uri, offset, {
    includeCompletionsForModuleExports: true,
    includeCompletionsWithInsertText: true,
    triggerCharacter: params.context?.triggerCharacter as ts.CompletionsTriggerCharacter | undefined,
  });
  if (!items) return [];
  return items.entries.map(entry => ({
    label: entry.name,
    kind: mapCompletionKind(entry.kind),
    sortText: entry.sortText,
    data: { uri, offset, entryName: entry.name },
  }));
});

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
  if (!languageService || !item.data) return item;
  const { uri, offset, entryName } = item.data as any;
  const details = languageService.getCompletionEntryDetails(uri, offset, entryName, {}, undefined, undefined, undefined);
  if (details) {
    item.detail = details.displayParts?.map(p => p.text).join('') || '';
    item.documentation = details.documentation?.map(p => p.text).join('') || '';
  }
  return item;
});

// Hover
connection.onHover((params: TextDocumentPositionParams): Hover | null => {
  if (!languageService) return null;
  const uri = params.textDocument.uri;
  const doc = languageHost?.getOpenDocument(uri);
  if (!doc) return null;
  const offset = doc.offsetAt(params.position);
  const info = languageService.getQuickInfoAtPosition(uri, offset);
  if (!info) return null;
  const text = info.displayParts?.map(p => p.text).join('') || '';
  if (!text) return null;
  return {
    contents: { kind: 'markdown', value: text },
    range: info.textSpan ? tsSpanToRange(uri, info.textSpan) : undefined,
  };
});

// Definition
connection.onDefinition((params: TextDocumentPositionParams): Location[] | null => {
  if (!languageService) return null;
  const uri = params.textDocument.uri;
  const doc = languageHost?.getOpenDocument(uri);
  if (!doc) return null;
  const offset = doc.offsetAt(params.position);
  const defs = languageService.getDefinitionAtPosition(uri, offset);
  if (!defs || defs.length === 0) return null;
  return defs.map(def => Location.create(def.fileName, tsSpanToRange(def.fileName, def.textSpan)));
});

// References
connection.onReferences((params: ReferenceParams): Location[] | null => {
  if (!languageService) return null;
  const uri = params.textDocument.uri;
  const doc = languageHost?.getOpenDocument(uri);
  if (!doc) return null;
  const offset = doc.offsetAt(params.position);
  const refs = languageService.getReferencesAtPosition(uri, offset);
  if (!refs || refs.length === 0) return null;
  return refs.map(ref => Location.create(ref.fileName, tsSpanToRange(ref.fileName, ref.textSpan)));
});

// Document Symbols
connection.onDocumentSymbol((params: DocumentSymbolParams): SymbolInformation[] => {
  if (!languageService) return [];
  const uri = params.textDocument.uri;
  const items = languageService.getNavigationBarItems(uri);
  if (!items || items.length === 0) return [];
  const symbols: SymbolInformation[] = [];
  function walk(barItems: ts.NavigationBarItem[]) {
    for (const item of barItems) {
      for (const span of item.spans) {
        symbols.push({
          name: item.text,
          kind: mapSymbolKind(item.kind),
          location: Location.create(uri, tsSpanToRange(uri, span)),
        });
      }
      if (item.childItems) walk(item.childItems);
    }
  }
  walk(items);
  return symbols;
});

// Folding Ranges
connection.onFoldingRanges((params: FoldingRangeParams): FoldingRange[] => {
  if (!languageService) return [];
  const uri = params.textDocument.uri;
  const source = getSourceForUri(uri);
  if (!source) return [];
  const spans = languageService.getOutliningSpans(uri);
  if (!spans || spans.length === 0) return [];
  return spans.map(span => {
    const start = offsetToPosition(source, span.textSpan.start);
    const end = offsetToPosition(source, span.textSpan.start + span.textSpan.length);
    return {
      startLine: start.line,
      endLine: end.line,
      kind: span.kind === ts.OutliningSpanKind.Comment ? 'comment' as const : undefined,
    };
  });
});

// Signature Help
connection.onSignatureHelp((params: TextDocumentPositionParams) => {
  if (!languageService) return null;
  const uri = params.textDocument.uri;
  const doc = languageHost?.getOpenDocument(uri);
  if (!doc) return null;
  const offset = doc.offsetAt(params.position);
  const help = languageService.getSignatureHelpItems(uri, offset, { triggerReason: { kind: 'invoked' as const } });
  if (!help) return null;
  return {
    signatures: help.items.map(item => ({
      label: [...item.prefixDisplayParts, ...item.suffixDisplayParts].map(p => p.text).join('') ||
        item.parameters.map((p, i) => (i > 0 ? ', ' : '') + p.displayParts.map(d => d.text).join('')).join(''),
      documentation: item.documentation?.map(p => p.text).join('') || '',
      parameters: item.parameters.map(p => ({
        label: p.displayParts.map(d => d.text).join(''),
        documentation: p.documentation?.map(d => d.text).join('') || '',
      })),
    })),
    activeSignature: help.selectedItemIndex,
    activeParameter: help.argumentIndex,
  };
});

// Mapping helpers
function mapCompletionKind(kind: string): CompletionItemKind {
  switch (kind) {
    case 'method': return CompletionItemKind.Method;
    case 'function': return CompletionItemKind.Function;
    case 'constructor': return CompletionItemKind.Constructor;
    case 'field': return CompletionItemKind.Field;
    case 'variable': return CompletionItemKind.Variable;
    case 'class': return CompletionItemKind.Class;
    case 'interface': return CompletionItemKind.Interface;
    case 'module': return CompletionItemKind.Module;
    case 'property': return CompletionItemKind.Property;
    case 'constant': return CompletionItemKind.Constant;
    case 'keyword': return CompletionItemKind.Keyword;
    case 'string': return CompletionItemKind.Text;
    default: return CompletionItemKind.Text;
  }
}

function mapSymbolKind(kind: ts.ScriptElementKind): SymbolInformation['kind'] {
  switch (kind) {
    case ts.ScriptElementKind.functionElement: return 12;
    case ts.ScriptElementKind.classElement: return 5;
    case ts.ScriptElementKind.interfaceElement: return 11;
    case ts.ScriptElementKind.variableElement: return 13;
    case ts.ScriptElementKind.memberFunctionElement: return 6;
    case ts.ScriptElementKind.memberVariableElement: return 8;
    case ts.ScriptElementKind.parameterElement: return 15;
    default: return 13;
  }
}

documents.listen(connection);
connection.listen();
