import { Location, Range, Position } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ProgramNode, ASTNode, IdentifierNode, FunctionCallNode, DeclareStmtNode, ProcedureDeclNode } from './ast';
import { SymbolTable, SymbolKind } from './symbol-table';

export function findDefinition(
  document: TextDocument,
  ast: ProgramNode,
  symbolTable: SymbolTable,
  position: Position
): Location | null {
  const text = document.getText();
  const offset = document.offsetAt(position);

  // Find the token at cursor position
  const node = findNodeAtOffset(ast, offset);
  if (!node) return null;

  let name: string | undefined;
  if (node.type === 'Identifier') {
    name = (node as IdentifierNode).name;
  } else if (node.type === 'FunctionCall') {
    name = (node as FunctionCallNode).name;
  } else if (node.type === 'ProcedureDecl') {
    name = (node as ProcedureDeclNode).name;
  }

  if (!name) return null;

  // Look up in symbol table
  const symbol = symbolTable.lookup(name);
  if (!symbol) return null;

  const declNode = symbol.declarationNode;
  const defRange: Range = {
    start: { line: declNode.startLine, character: declNode.startCol },
    end: { line: declNode.endLine, character: declNode.endCol },
  };

  return Location.create(document.uri, defRange);
}

function findNodeAtOffset(node: ASTNode, offset: number): ASTNode | null {
  if (offset < nodeOffsetStart(node) || offset > nodeOffsetEnd(node)) {
    return null;
  }

  // Check children based on node type
  switch (node.type) {
    case 'Program': {
      const prog = node as ProgramNode;
      for (const child of prog.body) {
        const found = findNodeAtOffset(child, offset);
        if (found) return found;
      }
      break;
    }
    case 'ProcedureDecl': {
      const proc = node as ProcedureDeclNode;
      for (const stmt of proc.body) {
        const found = findNodeAtOffset(stmt, offset);
        if (found) return found;
      }
      return node;
    }
    case 'FunctionCall': {
      const fc = node as FunctionCallNode;
      for (const arg of fc.args) {
        const found = findNodeAtOffset(arg, offset);
        if (found) return found;
      }
      return node;
    }
    case 'BinaryExpr': {
      const bin = node as import('./ast').BinaryExprNode;
      const leftFound = findNodeAtOffset(bin.left, offset);
      if (leftFound) return leftFound;
      const rightFound = findNodeAtOffset(bin.right, offset);
      if (rightFound) return rightFound;
      break;
    }
    case 'IfStmt': {
      const ifStmt = node as import('./ast').IfStmtNode;
      for (const stmt of ifStmt.thenBody) {
        const found = findNodeAtOffset(stmt, offset);
        if (found) return found;
      }
      if (ifStmt.elseBody) {
        for (const stmt of ifStmt.elseBody) {
          const found = findNodeAtOffset(stmt, offset);
          if (found) return found;
        }
      }
      break;
    }
    case 'AssignmentStmt': {
      const assign = node as import('./ast').AssignmentStmtNode;
      const targetFound = findNodeAtOffset(assign.target, offset);
      if (targetFound) return targetFound;
      const valueFound = findNodeAtOffset(assign.value, offset);
      if (valueFound) return valueFound;
      break;
    }
  }

  return node;
}

function nodeOffsetStart(node: ASTNode): number {
  // Approximate offset from line/column (not exact without document)
  return 0;
}

function nodeOffsetEnd(node: ASTNode): number {
  return Infinity;
}
