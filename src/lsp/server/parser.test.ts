import * as assert from 'assert';
import * as fs from 'fs';
import { SSLParser, ParseError } from './parser';
import { ProgramNode, IncludeStmtNode } from './ast';

function parse(src: string): { ast: ProgramNode; errors: ParseError[] } {
  return new SSLParser().parse(src);
}

function findIncludes(ast: ProgramNode, body?: any[]): IncludeStmtNode[] {
  const nodes = body || ast.body;
  const result: IncludeStmtNode[] = [];
  for (const n of nodes) {
    if (n.type === 'IncludeStmt') { result.push(n as IncludeStmtNode); }
    if (n.type === 'ProcedureDecl') { result.push(...findIncludes(ast, (n as any).body)); }
  }
  return result;
}

function findBinops(ast: ProgramNode): any[] {
  const result: any[] = [];
  function walk(node: any): void {
    if (!node || typeof node !== 'object') { return; }
    if (node.type === 'BinaryExpr') { result.push(node); }
    for (const key of Object.keys(node)) {
      if (Array.isArray(node[key])) { node[key].forEach(walk); }
      else if (node[key] && typeof node[key] === 'object') { walk(node[key]); }
    }
  }
  walk(ast);
  return result;
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Include tests Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

describe('SSLParser Ã¢â‚¬â€ :INCLUDE', () => {

  it('single unqualified :INCLUDE at top level', () => {
    const { ast, errors } = parse(':INCLUDE FOO;');
    assert.strictEqual(errors.length, 0);
    const includes = findIncludes(ast);
    assert.strictEqual(includes.length, 1);
    assert.strictEqual(includes[0].target, 'FOO');
  });

  it('qualified :INCLUDE at top level (the 4 user lines)', () => {
    const src = [
      ':INCLUDE ENTERPRISE_DATA_PROVIDERS.ERRORMESSAGES;',
      ':INCLUDE ENTERPRISE_SERVER.USERPROPERTIES;',
      ':INCLUDE ENTERPRISE_DATA_PROVIDERS.UTILS;',
      ':INCLUDE ENTERPRISE_DATA_PROVIDERS.CacheUtils;',
    ].join('\n');
    const { ast, errors } = parse(src);
    assert.strictEqual(errors.length, 0);
    const includes = findIncludes(ast);
    assert.strictEqual(includes.length, 4);
    assert.strictEqual(includes[0].target, 'ENTERPRISE_DATA_PROVIDERS.ERRORMESSAGES');
    assert.strictEqual(includes[1].target, 'ENTERPRISE_SERVER.USERPROPERTIES');
    assert.strictEqual(includes[2].target, 'ENTERPRISE_DATA_PROVIDERS.UTILS');
    assert.strictEqual(includes[3].target, 'ENTERPRISE_DATA_PROVIDERS.CacheUtils');
  });

  it('qualified :INCLUDE inside :PROCEDURE', () => {
    const { ast, errors } = parse([
      ':PROCEDURE MyProc;',
      ':INCLUDE ENTERPRISE_DATA_PROVIDERS.ERRORMESSAGES;',
      ':ENDPROC;',
    ].join('\n'));
    assert.strictEqual(errors.length, 0);
    const includes = findIncludes(ast);
    assert.strictEqual(includes.length, 1);
    assert.strictEqual(includes[0].target, 'ENTERPRISE_DATA_PROVIDERS.ERRORMESSAGES');
  });

  it('qualified :INCLUDE with 3 parts (A.B.C)', () => {
    const { ast, errors } = parse(':INCLUDE MODULE.SUBSYSTEM.FILE;');
    assert.strictEqual(errors.length, 0);
    const includes = findIncludes(ast);
    assert.strictEqual(includes.length, 1);
    assert.strictEqual(includes[0].target, 'MODULE.SUBSYSTEM.FILE');
  });

  it(':INCLUDE at top level with top-level statements after it', () => {
    const { errors } = parse([
      ':INCLUDE ENTERPRISE_DATA_PROVIDERS.ERRORMESSAGES;',
      ':DECLARE x;',
      ':RETURN .T.;',
    ].join('\n'));
    assert.strictEqual(errors.length, 0);
  });

  it('malformed :INCLUDE ; still produces error (error recovery preserved)', () => {
    const { errors } = parse(':INCLUDE ;');
    assert.ok(errors.length >= 1, 'Expected at least 1 error for :INCLUDE ;');
  });
});

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ <> operator tests Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

describe('SSLParser Ã¢â‚¬â€ <> operator', () => {

  it('<> in :IF condition', () => {
    const { ast, errors } = parse(':IF sUsername <> GetSetting("x"); :ENDIF;');
    assert.strictEqual(errors.length, 0);
    const binops = findBinops(ast);
    const hasNeq = binops.some((b: any) => b.operator === '<>');
    assert.ok(hasNeq, 'expected a <> binary operator in the AST');
  });

  it('<> in assignment expression', () => {
    const { ast, errors } = parse('x := a <> b;');
    assert.strictEqual(errors.length, 0);
    const binops = findBinops(ast);
    const hasNeq = binops.some((b: any) => b.operator === '<>');
    assert.ok(hasNeq, 'expected a <> binary operator in the AST');
  });

  it('<> at top level via :RETURN', () => {
    const { errors } = parse(':RETURN a <> b;');
    assert.strictEqual(errors.length, 0);
  });

  it('!= still works (no regression)', () => {
    const { errors } = parse(':IF sUsername != "x"; :ENDIF;');
    assert.strictEqual(errors.length, 0);
  });

  it('!= and <> can coexist in the same expression', () => {
    const { errors } = parse('x := a <> b .AND. c != d;');
    assert.strictEqual(errors.length, 0);
  });
});

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ Regression: _CompareUsers.ssl Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

describe('SSLParser Ã¢â‚¬â€ real-world script regression', () => {

  it('_CompareUsers.ssl parses with 0 errors (top-level script, no PROCEDURE wrapper)', () => {
    const srcPath = 'C:\\Daten\\SLVSCODE\\Production\\ServerScripts\\AdvancedAnalytics\\_CompareUsers.ssl';
    if (!fs.existsSync(srcPath)) {
      console.warn('SKIP: _CompareUsers.ssl not found at ' + srcPath);
      return;
    }
    const src = fs.readFileSync(srcPath, 'utf8');
    const { errors } = parse(src);
    assert.strictEqual(errors.length, 0, 'Real-world script should have 0 parse errors');
  });

// �����? Regression: scOllamaService.ssl (class-based SSL with OOP features) �����?
describe('SSLParser ��� scOllamaService.ssl', () => {

  it('parses with 0 errors (regression test)', () => {
    const srcPath = 'C:\\\\Daten\\\\SLVSCODE\\\\Production\\\\ServerScripts\\\\BMBH_AI\\\\scOllamaService.ssl';
    if (!fs.existsSync(srcPath)) {
      console.warn('SKIP: scOllamaService.ssl not found at ' + srcPath);
      return;
    }
    const src = fs.readFileSync(srcPath, 'utf8');
    const { errors } = parse(src);
    if (errors.length > 0) {
      const details = errors.map(e => `L${e.line+1}:${e.column+1} ${e.message}`).join("; ");
      assert.strictEqual(errors.length, 0, `scOllamaService.ssl should have 0 parse errors. Errors: ${details}`);
    }
  });

});
});