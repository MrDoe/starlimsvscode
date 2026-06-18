import { Location, Range, Position } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ProgramNode, ASTNode, IdentifierNode, FunctionCallNode } from './ast';
import { SymbolTable } from './symbol-table';

export function findReferences(
  document: TextDocument,
  ast: ProgramNode,
  symbolTable: SymbolTable,
  position: Position
): Location[] {
  const text = document.getText();
  const offset = document.offsetAt(position);

  // Find the identifier at cursor
  const node = findIdentifierAtOffset(ast, offset);
  if (!node) return [];

  const name = node.name;
  if (!name) return [];

  // Get all references from symbol table
  const refs = symbolTable.getReferences(name);
  const locations: Location[] = [];

  for (const ref of refs) {
    const refNode = ref.node;
    const range: Range = {
      start: { line: refNode.startLine, character: refNode.startCol },
      end: { line: refNode.endLine, character: refNode.endCol },
    };
    locations.push(Location.create(document.uri, range));
  }

  return locations;
}

function findIdentifierAtOffset(node: ASTNode, offset: number): IdentifierNode | null {
  switch (node.type) {
    case 'Identifier': {
      const id = node as IdentifierNode;
      return id;
    }
    case 'FunctionCall': {
      const fc = node as FunctionCallNode;
      // Check if offset is on the function name
      if (offset >= fc.nameNode.startLine && offset <= fc.nameNode.endLine) {
        return fc.nameNode;
      }
      // Check args
      for (const arg of fc.args) {
        const found = findIdentifierAtOffset(arg, offset);
        if (found) return found;
      }
      return null;
    }
    case 'Program': {
      const prog = node as ProgramNode;
      for (const child of prog.body) {
        const found = findIdentifierAtOffset(child, offset);
        if (found) return found;
      }
      return null;
    }
    case 'ProcedureDecl': {
      const proc = node as import('./ast').ProcedureDeclNode;
      for (const stmt of proc.body) {
        const found = findIdentifierAtOffset(stmt, offset);
        if (found) return found;
      }
      return null;
    }
    case 'BinaryExpr': {
      const bin = node as import('./ast').BinaryExprNode;
      const leftFound = findIdentifierAtOffset(bin.left, offset);
      if (leftFound) return leftFound;
      return findIdentifierAtOffset(bin.right, offset);
    }
    case 'MemberAccess': {
      const ma = node as import('./ast').MemberAccessNode;
      return findIdentifierAtOffset(ma.object, offset);
    }
    default:
      return null;
  }
}
