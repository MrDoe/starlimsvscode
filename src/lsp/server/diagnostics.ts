import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { SSLParser, ParseError } from './parser';

export function computeDiagnostics(
  document: TextDocument,
  parser: SSLParser
): Diagnostic[] {
  const text = document.getText();
  const { errors } = parser.parse(text);

  return errors.map((err: ParseError) => {
    const range: Range = {
      start: { line: err.line, character: err.column },
      end: { line: err.line, character: err.column + 1 },
    };
    return {
      severity: DiagnosticSeverity.Error,
      range,
      message: err.message,
      source: 'ssl-lsp',
    };
  });
}
