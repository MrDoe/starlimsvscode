import * as assert from 'assert';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Diagnostic, DiagnosticSeverity, Position, Range } from 'vscode-languageserver';
import { SSLParser } from './parser';
import { computeCodeActions } from './codeActions';

function makeDoc(text: string): TextDocument {
  return TextDocument.create('file:///test.ssl', 'ssl', 1, text);
}

function diag(line: number, character: number, code: string): Diagnostic {
  return {
    severity: DiagnosticSeverity.Warning,
    range: Range.create(line, character, line, character + 1),
    message: 'test',
    source: 'ssl-lsp',
    code,
  };
}

describe('SSL code actions', () => {
  it('uppercases a lowercase keyword', () => {
    const text = ':if x;\n:endif;\n';
    const doc = makeDoc(text);
    const { ast } = new SSLParser().parse(text);
    const actions = computeCodeActions(doc, ast, [diag(0, 0, 'keyword_uppercase')], doc.uri);
    const fix = actions.find((a) => a.title.startsWith('Uppercase'));
    assert.ok(fix);
    const edits = (fix!.edit!.changes as Record<string, any>)[doc.uri];
    assert.ok(edits.length === 1);
    assert.ok(edits[0].newText === ':IF');
  });

  it('replaces <> with !=', () => {
    const text = ':IF a <> b;\n:ENDIF;\n';
    const doc = makeDoc(text);
    const { ast } = new SSLParser().parse(text);
    const actions = computeCodeActions(doc, ast, [diag(0, 6, 'not_preferred_operator')], doc.uri);
    const fix = actions.find((a) => a.title.includes('!='));
    assert.ok(fix);
    const edits = (fix!.edit!.changes as Record<string, any>)[doc.uri];
    assert.strictEqual(edits[0].newText, '!=');
  });

  it('replaces dot with colon for property access', () => {
    const text = 'x := oObj.GetValue("k");\n';
    const doc = makeDoc(text);
    const { ast } = new SSLParser().parse(text);
    const actions = computeCodeActions(doc, ast, [diag(0, 9, 'dot_property_access')], doc.uri);
    const fix = actions.find((a) => a.title.includes(':'));
    assert.ok(fix);
  });

  it('appends ; to an unterminated comment', () => {
    const text = ':PROCEDURE p;\n/* unterminated';
    const doc = makeDoc(text);
    const { ast } = new SSLParser().parse(text);
    const actions = computeCodeActions(doc, ast, [diag(1, 0, 'comment_termination')], doc.uri);
    const fix = actions.find((a) => a.title.includes('terminate'));
    assert.ok(fix);
    const edits = (fix!.edit!.changes as Record<string, any>)[doc.uri];
    assert.strictEqual(edits[0].newText, ';');
  });

  it('offers suppression actions', () => {
    const text = ':if x;\n:endif;\n';
    const doc = makeDoc(text);
    const { ast } = new SSLParser().parse(text);
    const actions = computeCodeActions(doc, ast, [diag(0, 0, 'keyword_uppercase')], doc.uri);
    assert.ok(actions.some((a) => a.title.includes('Suppress') && a.title.includes('this line')));
    assert.ok(actions.some((a) => a.title.includes('Suppress') && a.title.includes('this file')));
  });

  it('inserts :OTHERWISE before :ENDCASE', () => {
    const text = ':BEGINCASE;\n:CASE 1;\n:ENDCASE;\n';
    const doc = makeDoc(text);
    const { ast } = new SSLParser().parse(text);
    const actions = computeCodeActions(doc, ast, [diag(0, 0, 'missing_otherwise')], doc.uri);
    const fix = actions.find((a) => a.title.includes('OTHERWISE'));
    assert.ok(fix);
    const edits = (fix!.edit!.changes as Record<string, any>)[doc.uri];
    assert.ok(edits[0].newText.includes(':OTHERWISE;'));
  });

  it('removes a redundant :DECLARE line', () => {
    const text = ':PROCEDURE p;\n:DECLARE sX;\n:DECLARE sX;\n:ENDPROC;\n';
    const doc = makeDoc(text);
    const { ast } = new SSLParser().parse(text);
    const actions = computeCodeActions(doc, ast, [diag(2, 9, 'redeclare_is_noop')], doc.uri);
    const fix = actions.find((a) => a.title.includes('Remove'));
    assert.ok(fix);
  });
});