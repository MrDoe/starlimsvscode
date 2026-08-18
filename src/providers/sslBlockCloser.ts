import * as vscode from 'vscode';

export interface BlockFamily {
  openerLine: RegExp;
  openerKeyword: RegExp;
  closerKeyword: RegExp;
  closerText: string;
}

export const FAMILIES: ReadonlyArray<BlockFamily> = [
  { openerLine: /^\s*:IF\b.*;\s*$/i, openerKeyword: /^\s*:IF\b/i, closerKeyword: /^\s*:ENDIF\b/i, closerText: ':ENDIF;' },
  { openerLine: /^\s*:WHILE\b.*;\s*$/i, openerKeyword: /^\s*:WHILE\b/i, closerKeyword: /^\s*:ENDWHILE\b/i, closerText: ':ENDWHILE;' },
  { openerLine: /^\s*:FOR\b.*;\s*$/i, openerKeyword: /^\s*:FOR\b/i, closerKeyword: /^\s*:NEXT\b/i, closerText: ':NEXT;' },
  { openerLine: /^\s*:BEGINCASE\b.*;\s*$/i, openerKeyword: /^\s*:BEGINCASE\b/i, closerKeyword: /^\s*:ENDCASE\b/i, closerText: ':ENDCASE;' },
  { openerLine: /^\s*:TRY\b.*;\s*$/i, openerKeyword: /^\s*:TRY\b/i, closerKeyword: /^\s*:ENDTRY\b/i, closerText: ':ENDTRY;' },
  { openerLine: /^\s*:PROCEDURE\b.*;\s*$/i, openerKeyword: /^\s*:PROCEDURE\b/i, closerKeyword: /^\s*:ENDPROC\b/i, closerText: ':ENDPROC;' },
  { openerLine: /^\s*:CLASS\b.*;\s*$/i, openerKeyword: /^\s*:CLASS\b/i, closerKeyword: /^\s*:ENDCLASS\b/i, closerText: ':ENDCLASS;' },
  { openerLine: /^\s*:REGION\b.*;\s*$/i, openerKeyword: /^\s*:REGION\b/i, closerKeyword: /^\s*:ENDREGION\b/i, closerText: ':ENDREGION;' },
  { openerLine: /^\s*:BEGININLINECODE\b.*;\s*$/i, openerKeyword: /^\s*:BEGININLINECODE\b/i, closerKeyword: /^\s*:ENDINLINECODE\b/i, closerText: ':ENDINLINECODE;' },
];

const inFlightDocs = new WeakSet<vscode.TextDocument>();

export function familyForOpener(line: string): BlockFamily | undefined {
  return FAMILIES.find((f) => f.openerLine.test(line));
}

export function leadingIndent(line: string): string {
  const match = line.match(/^\s*/);
  return match ? match[0] : '';
}

/**
 * Classifies, per line, whether the line starts in SSL "code" context as
 * opposed to inside a multi-line string or block comment. Block comments are
 * closed by the next `;` (STARLIMS style), strings by the matching quote.
 */
export function classifyLineStarts(lines: ReadonlyArray<string>): boolean[] {
  const startsInCode: boolean[] = new Array(lines.length);
  type State = 'code' | 'comment' | 'string-d' | 'string-s';
  let state: State = 'code';

  for (let i = 0; i < lines.length; i++) {
    startsInCode[i] = state === 'code';
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (state === 'code') {
        if (c === '/' && line[j + 1] === '*') {
          state = 'comment';
          j++;
        } else if (c === '"') {
          state = 'string-d';
        } else if (c === "'") {
          state = 'string-s';
        }
      } else if (state === 'comment') {
        if (c === ';') {
          state = 'code';
        }
      } else if (state === 'string-d') {
        if (c === '"') {
          state = 'code';
        }
      } else if (state === 'string-s') {
        if (c === "'") {
          state = 'code';
        }
      }
    }
  }
  return startsInCode;
}

/**
 * True when a matching closer for the opener at `openerLineNumber` already
 * exists later in the document (nested same-family blocks counted).
 */
export function closerAlreadyExistsInLines(
  lines: ReadonlyArray<string>,
  family: BlockFamily,
  openerLineNumber: number,
  startsInCode?: ReadonlyArray<boolean>
): boolean {
  const codeMask = startsInCode ?? classifyLineStarts(lines);
  let balance = 1;
  for (let i = openerLineNumber + 1; i < lines.length; i++) {
    if (!codeMask[i]) {
      continue;
    }
    const line = lines[i];
    if (family.closerKeyword.test(line)) {
      balance--;
      if (balance === 0) {
        return true;
      }
      continue;
    }
    if (family.openerKeyword.test(line)) {
      balance++;
    }
  }
  return false;
}

export interface BlockCloserDecision {
  family: BlockFamily;
  insertText: string;
}

export function decideBlockCloser(
  lines: ReadonlyArray<string>,
  openerLineNumber: number,
  cursorLine: number
): BlockCloserDecision | null {
  if (openerLineNumber < 0 || openerLineNumber >= lines.length) {
    return null;
  }
  if (cursorLine !== openerLineNumber + 1) {
    return null;
  }
  const openerLine = lines[openerLineNumber];
  const family = familyForOpener(openerLine);
  if (!family) {
    return null;
  }
  const codeMask = classifyLineStarts(lines);
  if (!codeMask[openerLineNumber]) {
    return null;
  }
  if (closerAlreadyExistsInLines(lines, family, openerLineNumber, codeMask)) {
    return null;
  }
  const indent = leadingIndent(openerLine);
  return { family, insertText: `\n${indent}${family.closerText}` };
}

export function registerSSLBlockCloser(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(async (event) => {
      const cfg = vscode.workspace.getConfiguration('starlimsSslLsp');
      if (cfg.get<boolean>('editor.autoInsertBlockClosers', true) === false) {
        return;
      }
      if (event.document.languageId !== 'SSL' && event.document.languageId !== 'SLSQL') {
        return;
      }
      if (inFlightDocs.has(event.document)) {
        return;
      }
      if (event.contentChanges.length !== 1) {
        return;
      }
      const change = event.contentChanges[0];
      if (change.rangeLength !== 0) {
        return;
      }
      if (!/^\r?\n[\t ]*$/.test(change.text)) {
        return;
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document !== event.document) {
        return;
      }

      const openerLineNumber = change.range.start.line;
      const cursor = editor.selection.active;

      const lines: string[] = [];
      for (let i = 0; i < event.document.lineCount; i++) {
        lines.push(event.document.lineAt(i).text);
      }
      const decision = decideBlockCloser(lines, openerLineNumber, cursor.line);
      if (!decision) {
        return;
      }
      const insertText = decision.insertText;

      inFlightDocs.add(event.document);
      try {
        await editor.edit(
          (builder) => {
            builder.insert(cursor, insertText);
          },
          { undoStopBefore: false, undoStopAfter: false }
        );
        editor.selection = new vscode.Selection(cursor, cursor);
      } finally {
        inFlightDocs.delete(event.document);
      }
    })
  );
}