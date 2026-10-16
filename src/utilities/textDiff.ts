/**
 * Minimal line-based unified diff used by the MCP `get_item_history_diff`
 * tool. Line-oriented LCS with common prefix/suffix trimming; texts that are
 * too large for the LCS matrix fall back to a single replace-all hunk
 * (`coarse: true`) so huge or very dissimilar inputs stay bounded.
 *
 * Deliberately dependency-free and side-effect-free so it can be unit tested
 * and reused; trailing-newline nuances are not annotated.
 */

export type LineDiffOptions = {
  /** Unchanged context lines kept around each hunk (default 3). */
  contextLines?: number;
  /** Maximum old*new middle-region cells for the LCS matrix (default 4_000_000). */
  maxDiffCells?: number;
};

export type LineDiffResult = {
  /** Unified-diff hunk text; empty when the texts are identical. */
  diff: string;
  addedLines: number;
  removedLines: number;
  changed: boolean;
  /** True when the input exceeded the LCS budget and a coarse replace-all hunk was emitted. */
  coarse: boolean;
};

type DiffOp = {
  kind: " " | "-" | "+";
  line: string;
};

function splitLines(text: string): string[] {
  return (text ?? "").replace(/\r\n/g, "\n").split("\n");
}

/**
 * Computes the edit script (kept/removed/added lines) for the middle region
 * after common prefix/suffix trimming, using a classic LCS dynamic program.
 */
function diffMiddle(oldMiddle: string[], newMiddle: string[], maxCells: number): { ops: DiffOp[]; coarse: boolean } {
  const oldCount = oldMiddle.length;
  const newCount = newMiddle.length;

  if (oldCount === 0 || newCount === 0 || oldCount * newCount > maxCells) {
    const ops: DiffOp[] = oldMiddle.map((line) => ({ kind: "-" as const, line }));
    for (const line of newMiddle) {
      ops.push({ kind: "+", line });
    }
    const coarse = oldCount > 0 && newCount > 0;
    return { ops, coarse };
  }

  // lcsTable[i][j] = LCS length of oldMiddle[i..] vs newMiddle[j..]
  const lcsTable: Int32Array[] = [];
  for (let i = 0; i <= oldCount; i++) {
    lcsTable.push(new Int32Array(newCount + 1));
  }
  for (let i = oldCount - 1; i >= 0; i--) {
    const row = lcsTable[i];
    const nextRow = lcsTable[i + 1];
    for (let j = newCount - 1; j >= 0; j--) {
      row[j] = oldMiddle[i] === newMiddle[j]
        ? nextRow[j + 1] + 1
        : Math.max(nextRow[j], row[j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < oldCount && j < newCount) {
    if (oldMiddle[i] === newMiddle[j]) {
      ops.push({ kind: " ", line: oldMiddle[i] });
      i++;
      j++;
    } else if (lcsTable[i + 1][j] >= lcsTable[i][j + 1]) {
      ops.push({ kind: "-", line: oldMiddle[i] });
      i++;
    } else {
      ops.push({ kind: "+", line: newMiddle[j] });
      j++;
    }
  }
  while (i < oldCount) {
    ops.push({ kind: "-", line: oldMiddle[i] });
    i++;
  }
  while (j < newCount) {
    ops.push({ kind: "+", line: newMiddle[j] });
    j++;
  }

  return { ops, coarse: false };
}

/**
 * Formats an edit script (full line space, trimmed prefix included as " " ops)
 * into unified-diff hunks with up to `context` context lines per side; changes
 * separated by at most 2*context unchanged lines are merged into one hunk.
 */
function formatHunks(ops: DiffOp[], context: number): string {
  const changeIndexes: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].kind !== " ") {
      changeIndexes.push(i);
    }
  }
  if (changeIndexes.length === 0) {
    return "";
  }

  // group change blocks into hunks
  const hunks: Array<{ start: number; end: number }> = [];
  let hunkStart = Math.max(0, changeIndexes[0] - context);
  let hunkEnd = Math.min(ops.length, changeIndexes[0] + 1 + context);
  for (let c = 1; c < changeIndexes.length; c++) {
    const nextStart = Math.max(0, changeIndexes[c] - context);
    if (nextStart <= hunkEnd) {
      hunkEnd = Math.min(ops.length, changeIndexes[c] + 1 + context);
    } else {
      hunks.push({ start: hunkStart, end: hunkEnd });
      hunkStart = nextStart;
      hunkEnd = Math.min(ops.length, changeIndexes[c] + 1 + context);
    }
  }
  hunks.push({ start: hunkStart, end: hunkEnd });

  // line numbers (1-based) of the hunk first lines
  const lines: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const hunk of hunks) {
    let oldCount = 0;
    let newCount = 0;
    for (let i = hunk.start; i < hunk.end; i++) {
      if (ops[i].kind !== "+") {
        oldCount++;
      }
      if (ops[i].kind !== "-") {
        newCount++;
      }
    }
    for (let i = 0; i < hunk.start; i++) {
      if (ops[i].kind !== "+") {
        oldLine++;
      }
      if (ops[i].kind !== "-") {
        newLine++;
      }
    }
    lines.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
    for (let i = hunk.start; i < hunk.end; i++) {
      lines.push(`${ops[i].kind}${ops[i].line}`);
    }
  }
  return lines.join("\n");
}

/**
 * Creates a unified line diff of two texts ("old" -> "new" direction:
 * "-" lines exist only in old, "+" lines only in new).
 * @param oldText the older / left text
 * @param newText the newer / right text
 * @param options hunk context size and LCS size budget
 */
export function createLineDiff(oldText: string, newText: string, options: LineDiffOptions = {}): LineDiffResult {
  const context = typeof options.contextLines === "number" && Number.isFinite(options.contextLines)
    ? Math.max(0, Math.floor(options.contextLines))
    : 3;
  const maxCells = typeof options.maxDiffCells === "number" && options.maxDiffCells > 0
    ? Math.floor(options.maxDiffCells)
    : 4_000_000;

  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const ops: DiffOp[] = [];
  for (let i = 0; i < prefix; i++) {
    ops.push({ kind: " ", line: oldLines[i] });
  }
  const middle = diffMiddle(
    oldLines.slice(prefix, oldLines.length - suffix),
    newLines.slice(prefix, newLines.length - suffix),
    maxCells
  );
  ops.push(...middle.ops);
  for (let i = oldLines.length - suffix; i < oldLines.length; i++) {
    ops.push({ kind: " ", line: oldLines[i] });
  }

  let addedLines = 0;
  let removedLines = 0;
  for (const op of ops) {
    if (op.kind === "+") {
      addedLines++;
    } else if (op.kind === "-") {
      removedLines++;
    }
  }

  return {
    diff: formatHunks(ops, context),
    addedLines,
    removedLines,
    changed: addedLines > 0 || removedLines > 0,
    coarse: middle.coarse
  };
}
