import * as assert from 'assert';
import { createLineDiff } from '../../utilities/textDiff';

describe('textDiff createLineDiff', () => {
  it('reports identical texts as unchanged with an empty diff', () => {
    const result = createLineDiff("line1\nline2\nline3", "line1\nline2\nline3");
    assert.strictEqual(result.changed, false);
    assert.strictEqual(result.coarse, false);
    assert.strictEqual(result.diff, "");
    assert.strictEqual(result.addedLines, 0);
    assert.strictEqual(result.removedLines, 0);
  });

  it('normalizes CRLF line endings before comparing', () => {
    const result = createLineDiff("a\r\nb\r\nc", "a\nb\nc");
    assert.strictEqual(result.changed, false);
  });

  it('emits one hunk with context and correct line numbers for a single change', () => {
    const oldText = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const newText = ["a", "b", "c", "X", "e", "f", "g"].join("\n");
    const result = createLineDiff(oldText, newText);

    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.addedLines, 1);
    assert.strictEqual(result.removedLines, 1);
    assert.strictEqual(result.coarse, false);
    assert.ok(result.diff.includes("@@ -1,7 +1,7 @@") || result.diff.includes("@@ -4,1 +4,1 @@"),
      `unexpected hunk header in:\n${result.diff}`);
    assert.ok(result.diff.includes("-d"));
    assert.ok(result.diff.includes("+X"));
  });

  it('splits distant changes into separate hunks and merges close ones', () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line${index}`);
    const farChanged = [...lines];
    farChanged[1] = "changed1";
    farChanged[30] = "changed30";
    const far = createLineDiff(lines.join("\n"), farChanged.join("\n"), { contextLines: 2 });
    const farHunkCount = far.diff.split("\n").filter((line) => line.startsWith("@@")).length;
    assert.strictEqual(farHunkCount, 2, `expected 2 hunks for distant changes:\n${far.diff}`);

    const nearChanged = [...lines];
    nearChanged[10] = "changed10";
    nearChanged[13] = "changed13";
    const near = createLineDiff(lines.join("\n"), nearChanged.join("\n"), { contextLines: 2 });
    const nearHunkCount = near.diff.split("\n").filter((line) => line.startsWith("@@")).length;
    assert.strictEqual(nearHunkCount, 1, `expected merged hunk for close changes:\n${near.diff}`);
    assert.strictEqual(near.addedLines, 2);
    assert.strictEqual(near.removedLines, 2);
  });

  it('diffs an empty left side as pure insertions', () => {
    const result = createLineDiff("", "new1\nnew2");
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.removedLines, 1); // the single empty left line
    assert.ok(result.diff.includes("+new1"));
    assert.ok(result.diff.includes("+new2"));
  });

  it('falls back to a coarse replace-all hunk beyond the LCS budget', () => {
    const oldText = Array.from({ length: 10 }, (_, index) => `old${index}`).join("\n");
    const newText = Array.from({ length: 10 }, (_, index) => `new${index}`).join("\n");
    const result = createLineDiff(oldText, newText, { maxDiffCells: 4 });

    assert.strictEqual(result.coarse, true);
    assert.strictEqual(result.addedLines, 10);
    assert.strictEqual(result.removedLines, 10);
    assert.ok(result.diff.startsWith("@@ "));
  });

  it('honors contextLines 0 for change lines only', () => {
    const oldText = ["a", "b", "c"].join("\n");
    const newText = ["a", "B", "c"].join("\n");
    const result = createLineDiff(oldText, newText, { contextLines: 0 });
    const hunkBodyLines = result.diff.split("\n").filter((line) => /^[+-]/.test(line));
    assert.deepStrictEqual(hunkBodyLines, ["-b", "+B"]);
  });
});
