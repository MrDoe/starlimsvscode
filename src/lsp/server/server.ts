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
  CompletionParams,
  TextDocumentPositionParams,
  ReferenceParams,
  DocumentSymbolParams,
  FoldingRangeParams,
  DocumentFormattingParams,
  DocumentRangeFormattingParams,
  TextEdit,
  Range,
  CodeActionKind,
  CodeActionParams,
  InsertTextFormat,
  SignatureHelpParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { SSLParser } from './parser';
import { SymbolTable } from './symbol-table';
import { ProgramNode } from './ast';
import { computeDiagnostics } from './diagnostics';
import {
  computeStyleDiagnostics,
  DEFAULT_STYLE_RULE_CONFIG,
  StyleRuleConfig,
} from './styleRules';
import { getDocumentSymbols } from './document-symbols';
import { findDefinition } from './definition';
import { findReferences } from './references';
import { getHover } from './hover';
import { getFoldingRanges } from './folding';
import { getAllBuiltinNames, getBuiltinFunction } from './builtins';
import { formatSSL, formatSSLRange, SSLFormatOptions, DEFAULT_FORMAT_OPTIONS } from './formatter';
import { computeCodeActions } from './codeActions';
import { getSignatureHelp } from './signatureHelp';
import {
  getDocumentHighlights,
  getRenameEdits,
  getInlayHints,
  getCodeLenses,
  prepareCallHierarchy,
  getIncomingCalls,
  getOutgoingCalls,
} from './navigation';

// Create LSP connection
const connection = createConnection(ProposedFeatures.all);

// Document manager
const documents = new TextDocuments(TextDocument);

// Parser and caches
const parser = new SSLParser();
const symbolTables = new Map<string, SymbolTable>();
const astCache = new Map<string, ProgramNode>();

// Per-document debounce timers
const validationTimers = new Map<string, ReturnType<typeof setTimeout>>();

connection.onInitialize((_params: InitializeParams): InitializeResult => {
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        triggerCharacters: [':', '.', '"', "'"],
        resolveProvider: false,
      },
      signatureHelpProvider: {
        triggerCharacters: ['(', ','],
      },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      foldingRangeProvider: true,
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      documentHighlightProvider: true,
      renameProvider: { prepareProvider: false },
      inlayHintProvider: true,
      codeLensProvider: {},
      callHierarchyProvider: true,
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix],
      },
    },
  };
});

connection.onInitialized(() => {
  connection.console.log('SSL Language Server initialized');
});

// Document sync
documents.onDidChangeContent((change: TextDocumentChangeEvent<TextDocument>) => {
  const uri = change.document.uri;
  // Cancel any pending validation for this document
  const existing = validationTimers.get(uri);
  if (existing) {
    clearTimeout(existing);
  }
  validationTimers.set(uri, setTimeout(() => {
    validationTimers.delete(uri);
    validateDocument(change.document);
  }, 300));
});

documents.onDidClose((event: TextDocumentChangeEvent<TextDocument>) => {
  const uri = event.document.uri;
  // Cancel pending validation
  const existing = validationTimers.get(uri);
  if (existing) {
    clearTimeout(existing);
    validationTimers.delete(uri);
  }
  // Clean up caches
  symbolTables.delete(uri);
  astCache.delete(uri);
  // Clear diagnostics
  connection.sendDiagnostics({ uri, diagnostics: [] });
});

async function validateDocument(document: TextDocument): Promise<void> {
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
  const diagnostics: Diagnostic[] = computeDiagnostics(errors);
  diagnostics.push(...computeStyleDiagnostics(text, ast, await getStyleConfig()));

  connection.sendDiagnostics({ uri, diagnostics });
}

async function getStyleConfig(): Promise<StyleRuleConfig> {
  try {
    const cfg = await connection.workspace.getConfiguration({ section: 'starlimsSslLsp' });
    const diag = cfg && cfg.diagnostics;
    const naming = cfg && cfg.naming && cfg.naming.hungarianNotation;
    const styleGuide = cfg && cfg.styleGuide;

    const rules: Record<string, 'off' | 'info' | 'warn' | 'error'> = {};
    const ruleOverrides = diag && diag.rules;
    if (ruleOverrides && typeof ruleOverrides === 'object') {
      for (const [slug, sev] of Object.entries(ruleOverrides as Record<string, string>)) {
        if (sev === 'off' || sev === 'info' || sev === 'warn' || sev === 'error') {
          rules[slug] = sev;
        }
      }
    }

    return {
      rules,
      strict: diag && diag.strictStyleGuideMode === true,
      globals: diag && Array.isArray(diag.globals) ? diag.globals : DEFAULT_STYLE_RULE_CONFIG.globals,
      hungarianPrefixes: naming && Array.isArray(naming.prefixes) && naming.enabled !== false
        ? naming.prefixes
        : DEFAULT_STYLE_RULE_CONFIG.hungarianPrefixes,
      limitBlockDepth: styleGuide && typeof styleGuide.limitBlockDepth === 'number'
        ? styleGuide.limitBlockDepth
        : DEFAULT_STYLE_RULE_CONFIG.limitBlockDepth,
      maxParamsPerProcedure: styleGuide && typeof styleGuide.maxParamsPerProcedure === 'number'
        ? styleGuide.maxParamsPerProcedure
        : DEFAULT_STYLE_RULE_CONFIG.maxParamsPerProcedure,
    };
  } catch {
    return DEFAULT_STYLE_RULE_CONFIG;
  }
}

// Completion
const SNIPPETS: { label: string; detail: string; insertText: string }[] = [
  {
    label: ':PROCEDURE',
    detail: 'SSL procedure block',
    insertText: ':PROCEDURE ${1:procedureName};\n\t:PARAMETERS ${2:parameterList};\n\t${3:/*put procedure body here;}\n:ENDPROC;',
  },
  {
    label: ':IF',
    detail: 'IF / ELSE block',
    insertText: ':IF ${1:condition};\n\t${2:/*statements;}\n:ELSE;\n\t${3:/*else statements;}\n:ENDIF;',
  },
  {
    label: ':WHILE',
    detail: 'WHILE loop',
    insertText: ':WHILE ${1:condition};\n\t${2:/*loop body;}\n:ENDWHILE;',
  },
  {
    label: ':FOR',
    detail: 'FOR loop',
    insertText: ':FOR ${1:i} := ${2:1} TO ${3:n};\n\t${4:/*loop body;}\n:NEXT;',
  },
  {
    label: ':TRY',
    detail: 'TRY / CATCH / FINALLY block',
    insertText: ':TRY;\n\t${1:/*statements;}\n:CATCH;\n\t${2:/*error handling;}\n:FINALLY;\n\t${3:/*clean-up;}\n:ENDTRY;',
  },
  {
    label: ':BEGINCASE',
    detail: 'CASE block',
    insertText: ':BEGINCASE;\n:CASE ${1:condition};\n\t${2:/*statements;}\n\t:EXITCASE;\n:OTHERWISE;\n\t${3:/*default;}\n:ENDCASE;',
  },
  {
    label: ':REGION',
    detail: 'REGION block',
    insertText: ':REGION ${1:regionName};\n\t${2:/*region body;}\n:ENDREGION;',
  },
  {
    label: ':CLASS',
    detail: 'CLASS definition',
    insertText: ':CLASS ${1:ClassName}${2: :INHERIT ${3:BaseClass}};\n\t${4:/*members;}\n:ENDCLASS;',
  },
];

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
    ':RESUME', ':EXITFOR', ':EXITWHILE',
  ];

  for (const kw of keywords) {
    items.push({
      label: kw,
      kind: CompletionItemKind.Keyword,
      detail: 'SSL keyword',
    });
  }

  // Add snippets for common constructs
  for (const snip of SNIPPETS) {
    items.push({
      label: snip.label,
      kind: CompletionItemKind.Snippet,
      detail: snip.detail,
      insertText: snip.insertText,
      insertTextFormat: InsertTextFormat.Snippet,
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
    for (const [, info] of globalScope.symbols) {
      items.push({
        label: info.name,
        kind: info.kind === 'procedure' ? CompletionItemKind.Function : CompletionItemKind.Variable,
        detail: info.kind === 'procedure' ? 'SSL Procedure' : info.kind,
      });
    }
  }

  return items;
});

// Signature help
connection.onSignatureHelp((params: SignatureHelpParams) => {
  const document = documents.get(params.textDocument.uri);
  const symbolTable = symbolTables.get(params.textDocument.uri);
  if (!document || !symbolTable) {
    return null;
  }

  return getSignatureHelp(document, symbolTable, params.position);
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

// Formatting
async function getFormatOptions(): Promise<SSLFormatOptions> {
  try {
    const cfg = await connection.workspace.getConfiguration({ section: 'starlimsSslLsp' });
    const f = (cfg && cfg.format) || {};
    const sql = f.sql || {};
    return {
      indentStyle: f.indentStyle ?? DEFAULT_FORMAT_OPTIONS.indentStyle,
      indentWidth: f.indentWidth ?? DEFAULT_FORMAT_OPTIONS.indentWidth,
      operatorSpacing: f.operatorSpacing ?? DEFAULT_FORMAT_OPTIONS.operatorSpacing,
      commaSpacing: f.commaSpacing ?? DEFAULT_FORMAT_OPTIONS.commaSpacing,
      builtinFunctionCase: f.builtinFunctionCase ?? DEFAULT_FORMAT_OPTIONS.builtinFunctionCase,
      wrapLength: f.wrapLength ?? DEFAULT_FORMAT_OPTIONS.wrapLength,
      semicolonEnforcement: f.semicolonEnforcement ?? DEFAULT_FORMAT_OPTIONS.semicolonEnforcement,
      blankLinesBetweenProcs: f.blankLinesBetweenProcs ?? DEFAULT_FORMAT_OPTIONS.blankLinesBetweenProcs,
      trimTrailingWhitespace: f.trimTrailingWhitespace ?? DEFAULT_FORMAT_OPTIONS.trimTrailingWhitespace,
      maxConsecutiveBlankLines: f.maxConsecutiveBlankLines ?? DEFAULT_FORMAT_OPTIONS.maxConsecutiveBlankLines,
      sql: {
        enabled: sql.enabled ?? DEFAULT_FORMAT_OPTIONS.sql.enabled,
        keywordCase: sql.keywordCase ?? DEFAULT_FORMAT_OPTIONS.sql.keywordCase,
        indentSpaces: sql.indentSpaces ?? DEFAULT_FORMAT_OPTIONS.sql.indentSpaces,
        style: sql.style ?? DEFAULT_FORMAT_OPTIONS.sql.style,
      },
    };
  } catch {
    return DEFAULT_FORMAT_OPTIONS;
  }
}

connection.onDocumentFormatting(async (params: DocumentFormattingParams): Promise<TextEdit[]> => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }

  const options = await getFormatOptions();
  const text = document.getText();
  const formatted = formatSSL(text, options);
  if (formatted === text) return [];

  const fullRange = Range.create(0, 0, text.length, text.length);
  return [TextEdit.replace(fullRange, formatted)];
});

connection.onDocumentRangeFormatting(
  async (params: DocumentRangeFormattingParams): Promise<TextEdit[]> => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];

    const options = await getFormatOptions();
    const text = document.getText();
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const startLine = params.range.start.line;
    const endLine = params.range.end.line;

    const formatted = formatSSLRange(text, startLine, endLine, options);
    if (formatted === text) return [];

    const prefix = lines.slice(0, startLine).join(eol) + (startLine > 0 ? eol : '');
    const suffix = endLine + 1 < lines.length ? eol + lines.slice(endLine + 1).join(eol) : '';
    const replacement = formatted.slice(prefix.length, formatted.length - suffix.length);
    const startPos = document.positionAt(prefix.length);
    const endPos = document.positionAt(text.length - suffix.length);

    return [TextEdit.replace(Range.create(startPos, endPos), replacement)];
  }
);

// Code actions (quick fixes keyed on style-rule slugs)
connection.onCodeAction((params: CodeActionParams) => {
  const document = documents.get(params.textDocument.uri);
  const ast = astCache.get(params.textDocument.uri);
  if (!document || !ast) return [];

  return computeCodeActions(
    document,
    ast,
    params.context.diagnostics,
    params.textDocument.uri
  );
});

// Document highlights
connection.onDocumentHighlight((params: TextDocumentPositionParams) => {
  const document = documents.get(params.textDocument.uri);
  const ast = astCache.get(params.textDocument.uri);
  const symbolTable = symbolTables.get(params.textDocument.uri);
  if (!document || !ast || !symbolTable) return [];

  return getDocumentHighlights(document, ast, symbolTable, params.position);
});

// Rename
connection.onRenameRequest((params) => {
  const document = documents.get(params.textDocument.uri);
  const ast = astCache.get(params.textDocument.uri);
  const symbolTable = symbolTables.get(params.textDocument.uri);
  if (!document || !ast || !symbolTable || !params.newName) {
    return null;
  }

  return getRenameEdits(document, ast, symbolTable, params.position, params.newName);
});

// Inlay hints
connection.languages.inlayHint.on((params) => {
  const document = documents.get(params.textDocument.uri);
  const ast = astCache.get(params.textDocument.uri);
  const symbolTable = symbolTables.get(params.textDocument.uri);
  if (!document || !ast || !symbolTable) return [];

  return getInlayHints(document, ast, symbolTable, params.range);
});

// CodeLens
connection.onCodeLens((params) => {
  const ast = astCache.get(params.textDocument.uri);
  const symbolTable = symbolTables.get(params.textDocument.uri);
  if (!ast || !symbolTable) return [];

  return getCodeLenses(ast, symbolTable);
});

// Call hierarchy
connection.languages.callHierarchy.onPrepare((params: TextDocumentPositionParams) => {
  const document = documents.get(params.textDocument.uri);
  const ast = astCache.get(params.textDocument.uri);
  if (!document || !ast) return null;

  return prepareCallHierarchy(document, ast, params.position);
});

connection.languages.callHierarchy.onIncomingCalls((params) => {
  const document = documents.get(params.item.uri);
  const ast = astCache.get(params.item.uri);
  const symbolTable = symbolTables.get(params.item.uri);
  if (!document || !ast || !symbolTable) return [];

  return getIncomingCalls(document, ast, symbolTable, params.item);
});

connection.languages.callHierarchy.onOutgoingCalls((params) => {
  const document = documents.get(params.item.uri);
  const ast = astCache.get(params.item.uri);
  const symbolTable = symbolTables.get(params.item.uri);
  if (!document || !ast || !symbolTable) return [];

  return getOutgoingCalls(document, ast, symbolTable, params.item);
});

// Listen
documents.listen(connection);
connection.listen();
