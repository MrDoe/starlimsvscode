import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  CompletionItem,
  Hover,
  Location,
  DocumentSymbol,
  FoldingRange,
  Diagnostic,
  CompletionItemKind,
  TextDocumentChangeEvent,
  TextDocumentDidClose,
  CompletionParams,
  TextDocumentPositionParams,
  ReferenceParams,
  DocumentSymbolParams,
  FoldingRangeParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { SSLParser } from './parser';
import { SymbolTable } from './symbol-table';
import { ProgramNode } from './ast';
import { computeDiagnostics } from './diagnostics';
import { getDocumentSymbols } from './document-symbols';
import { findDefinition } from './definition';
import { findReferences } from './references';
import { getHover } from './hover';
import { getFoldingRanges } from './folding';
import { getAllBuiltinNames, getBuiltinFunction } from './builtins';

// Create LSP connection
const connection = createConnection(ProposedFeatures.all);

// Document manager
const documents = new TextDocuments(TextDocument);

// Parser and caches
const parser = new SSLParser();
const symbolTables = new Map<string, SymbolTable>();
const astCache = new Map<string, ProgramNode>();

// Debounce timer
let validationTimer: ReturnType<typeof setTimeout> | null = null;

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        triggerCharacters: [':', '.', '"', "'"],
        resolveProvider: false,
      },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      foldingRangeProvider: true,
    },
  };
});

connection.onInitialized(() => {
  connection.console.log('SSL Language Server initialized');
});

// Document sync
documents.onDidChangeContent((change: TextDocumentChangeEvent<TextDocument>) => {
  // Debounce validation
  if (validationTimer) {
    clearTimeout(validationTimer);
  }
  validationTimer = setTimeout(() => {
    validateDocument(change.document);
  }, 300);
});

documents.onDidClose((event: TextDocumentDidClose) => {
  // Clean up caches
  const uri = event.document.uri;
  symbolTables.delete(uri);
  astCache.delete(uri);
  // Clear diagnostics
  connection.sendDiagnostics({ uri, diagnostics: [] });
});

function validateDocument(document: TextDocument): void {
  const uri = document.uri;
  const text = document.getText();

  // Parse
  const { ast, errors } = parser.parse(text);
  astCache.set(uri, ast);

  // Build symbol table
  const symbolTable = new SymbolTable();
  symbolTable.buildFromAST(ast);
  symbolTables.set(uri, symbolTable);

  // Send diagnostics
  const diagnostics: Diagnostic[] = errors.map((err) => ({
    severity: 1, // Error
    range: {
      start: { line: err.line, character: err.column },
      end: { line: err.line, character: err.column + 1 },
    },
    message: err.message,
    source: 'ssl-lsp',
  }));

  connection.sendDiagnostics({ uri, diagnostics });
}

// Completion
connection.onCompletion((params: CompletionParams): CompletionItem[] => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];

  const items: CompletionItem[] = [];

  // Add SSL keywords
  const keywords = [
    ':PROCEDURE', ':ENDPROC', ':PARAMETERS', ':DECLARE', ':DEFAULT',
    ':RETURN', ':IF', ':ELSE', ':ENDIF', ':BEGINCASE', ':CASE',
    ':EXITCASE', ':OTHERWISE', ':ENDCASE', ':FOR', ':NEXT', ':WHILE',
    ':ENDWHILE', ':LOOP', ':EXIT', ':TRY', ':CATCH', ':FINALLY',
    ':ENDTRY', ':CLASS', ':INHERIT', ':INCLUDE', ':DSN',
    ':ACCESS', ':ASSIGN', ':TO', ':STEP', ':PUBLIC', ':ERROR',
    ':REGION', ':ENDREGION', ':BEGININLINECODE', ':ENDINLINECODE',
    ':RESUME', ':EXITFOR',
  ];

  for (const kw of keywords) {
    items.push({
      label: kw,
      kind: CompletionItemKind.Keyword,
      detail: 'SSL keyword',
    });
  }

  // Add built-in functions
  const builtinNames = getAllBuiltinNames();
  for (const name of builtinNames) {
    const builtins = getBuiltinFunction(name);
    if (builtins && builtins.length > 0) {
      const fn = builtins[0];
      items.push({
        label: name,
        kind: CompletionItemKind.Function,
        detail: `${fn.library} - ${fn.signature}`,
        documentation: fn.description,
      });
    }
  }

  // Add user-defined procedures from symbol table
  const symbolTable = symbolTables.get(params.textDocument.uri);
  if (symbolTable) {
    const globalScope = symbolTable.getGlobalScope();
    for (const [name, info] of globalScope.symbols) {
      items.push({
        label: info.name,
        kind: info.kind === 'procedure' ? CompletionItemKind.Function : CompletionItemKind.Variable,
        detail: info.kind,
      });
    }
  }

  return items;
});

// Hover
connection.onHover((params: TextDocumentPositionParams): Hover | null => {
  const document = documents.get(params.textDocument.uri);
  const ast = astCache.get(params.textDocument.uri);
  const symbolTable = symbolTables.get(params.textDocument.uri);
  if (!document || !ast || !symbolTable) return null;

  return getHover(document, ast, symbolTable, params.position);
});

// Definition
connection.onDefinition((params: TextDocumentPositionParams): Location | null => {
  const document = documents.get(params.textDocument.uri);
  const ast = astCache.get(params.textDocument.uri);
  const symbolTable = symbolTables.get(params.textDocument.uri);
  if (!document || !ast || !symbolTable) return null;

  return findDefinition(document, ast, symbolTable, params.position);
});

// References
connection.onReferences((params: ReferenceParams): Location[] => {
  const document = documents.get(params.textDocument.uri);
  const ast = astCache.get(params.textDocument.uri);
  const symbolTable = symbolTables.get(params.textDocument.uri);
  if (!document || !ast || !symbolTable) return [];

  return findReferences(document, ast, symbolTable, params.position);
});

// Document symbols
connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
  const ast = astCache.get(params.textDocument.uri);
  if (!ast) return [];

  return getDocumentSymbols(ast);
});

// Folding ranges
connection.onFoldingRanges((params: FoldingRangeParams): FoldingRange[] => {
  const ast = astCache.get(params.textDocument.uri);
  if (!ast) return [];

  return getFoldingRanges(ast);
});

// Listen
documents.listen(connection);
connection.listen();
