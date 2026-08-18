import * as assert from 'assert';
import { SSLParser } from './parser';
import { computeStyleDiagnostics, DEFAULT_STYLE_RULE_CONFIG, StyleRuleConfig } from './styleRules';

function rules(src: string, config: Partial<StyleRuleConfig> = {}): Map<string, number[]> {
  const { ast } = new SSLParser().parse(src);
  const ds = computeStyleDiagnostics(src, ast, { ...DEFAULT_STYLE_RULE_CONFIG, ...config });
  const bySlug = new Map<string, number[]>();
  for (const d of ds) {
    const lines = bySlug.get(d.code as string) || [];
    lines.push(d.range.start.line + 1);
    bySlug.set(d.code as string, lines);
  }
  return bySlug;
}

describe('SSL style rules', () => {
  it('flags lowercase keywords (keyword_uppercase)', () => {
    const bySlug = rules(':if x;\n:endif;\n');
    assert.ok((bySlug.get('keyword_uppercase') || []).length >= 2);
  });

  it('flags <> operator (not_preferred_operator)', () => {
    const bySlug = rules(':IF a <> b;\n:ENDIF;\n');
    assert.deepStrictEqual(bySlug.get('not_preferred_operator'), [1]);
  });

  it('flags dot property access (dot_property_access)', () => {
    const bySlug = rules('x := oObj.GetValue("k");\n');
    assert.deepStrictEqual(bySlug.get('dot_property_access'), [1]);
  });

  it('does not flag colon member access', () => {
    const bySlug = rules('x := oObj:GetValue("k");\n');
    assert.strictEqual(bySlug.get('dot_property_access'), undefined);
  });

  it('flags == string comparisons only with string operands (equals_vs_strict_equals)', () => {
    const bySlug = rules('x := a = b;\ny := sName = "foo";\n');
    assert.deepStrictEqual(bySlug.get('equals_vs_strict_equals'), [2]);
  });

  it('flags missing space before :STEP (step_spacing)', () => {
    const bySlug = rules(':FOR i := 1 TO 10:STEP 2;\n:NEXT;\n');
    assert.deepStrictEqual(bySlug.get('step_spacing'), [1]);
  });

  it('flags unterminated comment (comment_termination)', () => {
    const bySlug = rules(':PROCEDURE p;\n/* this never ends\n');
    assert.ok((bySlug.get('comment_termination') || []).length >= 1);
  });

  it('flags SQL string concatenation (sql_injection)', () => {
    const bySlug = rules('oDS := SQLExecute("SELECT * FROM t WHERE x = " + sVal);\n');
    assert.deepStrictEqual(bySlug.get('sql_injection'), [1]);
  });

  it('flags non-parameterized SQL (require_parameterized_queries)', () => {
    const bySlug = rules('oDS := SQLExecute("SELECT * FROM t WHERE x = 5");\n');
    assert.deepStrictEqual(bySlug.get('require_parameterized_queries'), [1]);
  });

  it('accepts named placeholders in SQLExecute', () => {
    const bySlug = rules('oDS := SQLExecute("SELECT * FROM t WHERE x = ?xVal?");\n');
    assert.strictEqual(bySlug.get('require_parameterized_queries'), undefined);
    assert.strictEqual(bySlug.get('placeholder_policy'), undefined);
  });

  it('flags named placeholders in RunSQL (placeholder_policy)', () => {
    const bySlug = rules('RunSQL("UPDATE t SET a = ?xVal?");\n');
    assert.deepStrictEqual(bySlug.get('placeholder_policy'), [1]);
  });

  it('flags Hungarian notation violations (hungarian_notation)', () => {
    const bySlug = rules(':PROCEDURE p;\n:DECLARE json, sName;\n:ENDPROC;\n');
    assert.deepStrictEqual(bySlug.get('hungarian_notation'), [2]);
  });

  it('exempts loop counters from Hungarian notation', () => {
    const bySlug = rules(':PROCEDURE p;\n:DECLARE i;\n:ENDPROC;\n');
    assert.strictEqual(bySlug.get('hungarian_notation'), undefined);
  });

  it('flags deep block nesting (limit_block_depth)', () => {
    const src = [
      ':IF a;', ':IF b;', ':IF c;', ':IF d;', ':IF e;',
      ':ENDIF;', ':ENDIF;', ':ENDIF;', ':ENDIF;', ':ENDIF;',
    ].join('\n');
    const bySlug = rules(src);
    assert.ok((bySlug.get('limit_block_depth') || []).length >= 1);
  });

  it('flags too many parameters (max_params_per_procedure)', () => {
    const src = ':PROCEDURE p;\n:PARAMETERS a, b, c, d, e, f, g, h, i;\n:ENDPROC;\n';
    const bySlug = rules(src);
    assert.deepStrictEqual(bySlug.get('max_params_per_procedure'), [2]);
  });

  it('flags missing :OTHERWISE (missing_otherwise)', () => {
    const src = ':BEGINCASE;\n:CASE 1;\n:ENDCASE;\n';
    const bySlug = rules(src);
    assert.deepStrictEqual(bySlug.get('missing_otherwise'), [1]);
  });

  it('flags nested IIF (nested_iif)', () => {
    const bySlug = rules('x := IIF(a, IIF(b, 1, 2), 3);\n');
    assert.ok((bySlug.get('nested_iif') || []).length >= 1);
  });

  it('flags redeclared variables (redeclare_is_noop)', () => {
    const src = ':PROCEDURE p;\n:DECLARE sX;\n:DECLARE sX;\n:ENDPROC;\n';
    const bySlug = rules(src);
    assert.deepStrictEqual(bySlug.get('redeclare_is_noop'), [3]);
  });

  it('honors per-rule severity overrides and off', () => {
    const src = ':if x;\n:endif;\n';
    const bySlug = rules(src, { rules: { keyword_uppercase: 'off' } });
    assert.strictEqual(bySlug.get('keyword_uppercase'), undefined);
  });

  it('honors @ssl-disable-next-line suppression', () => {
    const src = '/* @ssl-disable-next-line keyword_uppercase; */\n:if x;\n:endif;\n';
    const bySlug = rules(src);
    assert.deepStrictEqual(bySlug.get('keyword_uppercase'), [3]);
  });

  it('honors @ssl-disable file suppression', () => {
    const src = '/* @ssl-disable keyword_uppercase; */\n:if x;\n:endif;\n';
    const bySlug = rules(src);
    assert.strictEqual(bySlug.get('keyword_uppercase'), undefined);
  });

  it('supports wildcard suppression', () => {
    const src = '/* @ssl-disable *; */\n:if x;\n:endif;\n';
    const bySlug = rules(src);
    assert.strictEqual(bySlug.size, 0);
  });
});