import * as assert from 'assert';
import { formatSSL, formatSSLRange, DEFAULT_FORMAT_OPTIONS, SSLFormatOptions } from './formatter';

describe('SSLFormatter', () => {
  it('normalizes keyword casing to UPPERCASE', () => {
    const out = formatSSL(':procedure myProc;\n:endproc;\n');
    assert.strictEqual(out, ':PROCEDURE myProc;\n:ENDPROC;\n');
  });

  it('normalizes builtin functions to PascalCase', () => {
    const out = formatSSL('x := alltrim( str( 1 ) );\n');
    assert.strictEqual(out, 'x := AllTrim(Str(1));\n');
  });

  it('preserves non-builtin identifier casing', () => {
    const out = formatSSL('myVar := SomeThingElse(1);\n');
    assert.strictEqual(out, 'myVar := SomeThingElse(1);\n');
  });

  it('spaces operators and commas, removes inner-paren spaces', () => {
    const out = formatSSL('x:=( a+b )*2;\n');
    assert.strictEqual(out, 'x := (a + b) * 2;\n');
  });

  it('handles unary minus and bang', () => {
    const out = formatSSL('y := -5 + 3;\nz := !bFlag;\nw := (a) - b;\n');
    assert.strictEqual(out, 'y := -5 + 3;\nz := !bFlag;\nw := (a) - b;\n');
  });

  it('keeps colon member access tight', () => {
    const out = formatSSL('w := oObj : GetValue( "k" );\n');
    assert.strictEqual(out, 'w := oObj:GetValue("k");\n');
  });

  it('enforces semicolons on statement ends', () => {
    const out = formatSSL('x := 1\ny := 2;\n');
    assert.strictEqual(out, 'x := 1;\ny := 2;\n');
  });

  it('does not add semicolons to continuation lines', () => {
    const src = 'sFoo(\n  arg1,\n  arg2\n);\n';
    const out = formatSSL(src);
    assert.ok(out.includes('arg1,'), out);
    assert.ok(out.includes('arg2'), out);
    assert.ok(out.endsWith(');\n'), out);
  });

  it('indents nested blocks', () => {
    const src = [
      ':PROCEDURE p;',
      ':IF x;',
      ':FOR i := 1 TO n;',
      'sBody();',
      ':NEXT;',
      ':ENDIF;',
      ':ENDPROC;',
    ].join('\n');
    const out = formatSSL(src);
    const lines = out.split('\n');
    assert.ok(lines[1].startsWith('\t:IF'), lines[1]);
    assert.ok(lines[2].startsWith('\t\t:FOR'), lines[2]);
    assert.ok(lines[3].startsWith('\t\t\tsBody();'), lines[3]);
    assert.ok(lines[4].startsWith('\t\t:NEXT;'), lines[4]);
    assert.ok(lines[6].startsWith(':ENDPROC;'), lines[6]);
  });

  it('dedents :PARAMETERS and :DECLARE to procedure level', () => {
    const src = [':PROCEDURE p;', ':PARAMETERS x;', ':DECLARE y;', ':RETURN x;', ':ENDPROC;'].join('\n');
    const out = formatSSL(src);
    const lines = out.split('\n');
    assert.ok(lines[1].startsWith(':PARAMETERS'), lines[1]);
    assert.ok(lines[2].startsWith(':DECLARE'), lines[2]);
    assert.ok(lines[3].startsWith('\t:RETURN'), lines[3]);
  });

  it('places :ELSE at block depth', () => {
    const src = [':IF x;', 'a();', ':ELSE;', 'b();', ':ENDIF;'].join('\n');
    const out = formatSSL(src);
    const lines = out.split('\n');
    assert.ok(lines[0].startsWith(':IF'), lines[0]);
    assert.ok(lines[2].startsWith(':ELSE;'), lines[2]);
    assert.ok(lines[4].startsWith(':ENDIF;'), lines[4]);
  });

  it('preserves the file header comment verbatim', () => {
    const header = '/* =============================\n* header\n***/;';
    const out = formatSSL(header + '\n\n:INCLUDE FOO;\n');
    assert.ok(out.startsWith('/* =============================\n* header\n***/;'), out);
  });

  it('inserts blank lines between procedures', () => {
    const src = [':PROCEDURE a;', ':ENDPROC;', ':PROCEDURE b;', ':ENDPROC;'].join('\n');
    const out = formatSSL(src);
    const lines = out.split('\n');
    const idxA = lines.indexOf(':PROCEDURE a;');
    const idxB = lines.indexOf(':PROCEDURE b;');
    assert.ok(idxB - idxA >= 3, out); // ENDPROC + 1 blank + PROCEDURE
  });

  it('collapses excessive consecutive blank lines', () => {
    const src = 'a();\n\n\n\n\nb();\n';
    const out = formatSSL(src);
    const blankRun = out.replace(/\n$/, '').split('\n').filter((l) => l === '').length;
    assert.ok(blankRun <= 2, out);
  });

  it('formats inline SQL string literals', () => {
    const src = 'oDS := SQLExecute("select l.LAYERID, l.Name from LIMSLAYERS l where l.ACTIVE = 1 order by l.Name");\n';
    const out = formatSSL(src);
    assert.ok(out.includes('SELECT'), out);
    assert.ok(out.includes('FROM'), out);
    assert.ok(out.includes('WHERE'), out);
    assert.ok(out.includes('ORDER BY'), out);
    assert.ok(out.includes('\n'), out);
  });

  it('preserves ?param? placeholders in SQL', () => {
    const src = 'RunSQL("update LIMSLAYERS set ACTIVE=0 where LAYERID=?nLayerId?");\n';
    const out = formatSSL(src);
    assert.ok(out.includes('?nLayerId?'), out);
  });

  it('does not format non-SQL strings', () => {
    const src = 'sMsg := "hello world";\n';
    const out = formatSSL(src);
    assert.strictEqual(out, 'sMsg := "hello world";\n');
  });

  it('is idempotent', () => {
    const src = [
      ':procedure p( sName );',
      ':parameters sName;',
      ':if Empty( sName );',
      'sResult := alltrim( str( 5 ) );',
      ':endif;',
      ':return sResult;',
      ':endproc;',
    ].join('\n');
    const once = formatSSL(src);
    const twice = formatSSL(once);
    assert.strictEqual(once, twice);
  });

  it('range formatting only touches the given lines', () => {
    const src = [':PROCEDURE p;', ':IF x;', 'a();', ':ENDIF;', ':ENDPROC;'].join('\n');
    const out = formatSSLRange(src, 1, 3);
    const lines = out.split('\n');
    assert.strictEqual(lines[0], ':PROCEDURE p;'); // untouched
    assert.ok(lines[1].startsWith('\t:IF'), lines[1]);
    assert.ok(lines[2].startsWith('\t\ta();'), lines[2]);
    assert.ok(lines[3].startsWith('\t:ENDIF;'), lines[3]);
    assert.strictEqual(lines[4], ':ENDPROC;'); // untouched
  });

  it('space indent style works', () => {
    const opts: SSLFormatOptions = { ...DEFAULT_FORMAT_OPTIONS, indentStyle: 'space', indentWidth: 3 };
    const src = [':IF x;', 'a();', ':ENDIF;'].join('\n');
    const out = formatSSL(src, opts);
    assert.ok(out.includes('\n   a();'), out);
  });

  it('builtinFunctionCase preserve keeps user casing', () => {
    const opts: SSLFormatOptions = { ...DEFAULT_FORMAT_OPTIONS, builtinFunctionCase: 'preserve' };
    const out = formatSSL('x := ALLTRIM("a");\n', opts);
    assert.strictEqual(out, 'x := ALLTRIM("a");\n');
  });

  it('semicolonEnforcement off leaves bare statements', () => {
    const opts: SSLFormatOptions = { ...DEFAULT_FORMAT_OPTIONS, semicolonEnforcement: false };
    const out = formatSSL('x := 1\n', opts);
    assert.strictEqual(out, 'x := 1\n');
  });

  it('preserves multi-line comment content (comments end at ;)', () => {
    const src = ':PROCEDURE p;\n/* multi\nline\ncomment; */\n:ENDPROC;\n';
    const out = formatSSL(src);
    assert.ok(out.includes('\t/* multi\n\tline\n\tcomment;'), out);
  });
});