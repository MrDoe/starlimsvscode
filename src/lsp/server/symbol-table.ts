import {
  ASTNode, ProcedureDeclNode, ClassDeclNode, DeclareStmtNode,
  IdentifierNode, FunctionCallNode, MemberAccessNode, AssignmentStmtNode
} from './ast';

export enum SymbolKind {
  Procedure = 'procedure',
  Variable = 'variable',
  Parameter = 'parameter',
  Class = 'class',
  Property = 'property',
}

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  declarationNode: ASTNode;
  scope: Scope;
  type?: string;
}

export class Scope {
  parent: Scope | null;
  symbols: Map<string, SymbolInfo> = new Map();

  constructor(parent: Scope | null = null) {
    this.parent = parent;
  }

  define(info: SymbolInfo): void {
    this.symbols.set(info.name.toLowerCase(), info);
  }

  lookup(name: string): SymbolInfo | undefined {
    const lower = name.toLowerCase();
    const found = this.symbols.get(lower);
    if (found) return found;
    if (this.parent) return this.parent.lookup(name);
    return undefined;
  }

  lookupLocal(name: string): SymbolInfo | undefined {
    return this.symbols.get(name.toLowerCase());
  }
}

export class SymbolTable {
  private globalScope: Scope;
  private currentScope: Scope;
  private references: Map<string, { node: ASTNode; scope: Scope }[]> = new Map();

  constructor() {
    this.globalScope = new Scope();
    this.currentScope = this.globalScope;
  }

  getGlobalScope(): Scope {
    return this.globalScope;
  }

  getCurrentScope(): Scope {
    return this.currentScope;
  }

  pushScope(): Scope {
    const newScope = new Scope(this.currentScope);
    this.currentScope = newScope;
    return newScope;
  }

  popScope(): void {
    if (this.currentScope.parent) {
      this.currentScope = this.currentScope.parent;
    }
  }

  define(info: SymbolInfo): void {
    this.currentScope.define(info);
  }

  lookup(name: string): SymbolInfo | undefined {
    return this.currentScope.lookup(name);
  }

  addReference(name: string, node: ASTNode): void {
    const lower = name.toLowerCase();
    if (!this.references.has(lower)) {
      this.references.set(lower, []);
    }
    this.references.get(lower)!.push({ node, scope: this.currentScope });
  }

  getReferences(name: string): { node: ASTNode; scope: Scope }[] {
    return this.references.get(name.toLowerCase()) || [];
  }

  buildFromAST(ast: import('./ast').ProgramNode): void {
    for (const node of ast.body) {
      this.visitNode(node);
    }
  }

  private visitNode(node: ASTNode): void {
    switch (node.type) {
      case 'ProcedureDecl':
        this.visitProcedure(node as ProcedureDeclNode);
        break;
      case 'ClassDecl':
        this.visitClass(node as ClassDeclNode);
        break;
      case 'DeclareStmt':
        this.visitDeclare(node as DeclareStmtNode);
        break;
      case 'IfStmt': {
        const ifNode = node as import('./ast').IfStmtNode;
        for (const stmt of ifNode.thenBody) this.visitNode(stmt);
        if (ifNode.elseBody) {
          for (const stmt of ifNode.elseBody) this.visitNode(stmt);
        }
        break;
      }
      case 'ForStmt': {
        const forNode = node as import('./ast').ForStmtNode;
        this.pushScope();
        this.visitNode(forNode.init);
        for (const stmt of forNode.body) this.visitNode(stmt);
        this.popScope();
        break;
      }
      case 'WhileStmt': {
        const whileNode = node as import('./ast').WhileStmtNode;
        for (const stmt of whileNode.body) this.visitNode(stmt);
        break;
      }
      case 'CaseStmt': {
        const caseNode = node as import('./ast').CaseStmtNode;
        for (const branch of caseNode.branches) {
          for (const stmt of branch.body) this.visitNode(stmt);
        }
        if (caseNode.otherwise) {
          for (const stmt of caseNode.otherwise.body) this.visitNode(stmt);
        }
        break;
      }
      case 'TryStmt': {
        const tryNode = node as import('./ast').TryStmtNode;
        for (const stmt of tryNode.body) this.visitNode(stmt);
        if (tryNode.catchBody) {
          for (const stmt of tryNode.catchBody) this.visitNode(stmt);
        }
        if (tryNode.finallyBody) {
          for (const stmt of tryNode.finallyBody) this.visitNode(stmt);
        }
        break;
      }
      case 'Identifier':
        this.addReference((node as IdentifierNode).name, node);
        break;
      case 'FunctionCall': {
        const fc = node as FunctionCallNode;
        this.addReference(fc.name, fc);
        for (const arg of fc.args) this.visitNode(arg);
        break;
      }
      case 'MemberAccess': {
        const ma = node as MemberAccessNode;
        this.visitNode(ma.object);
        if (ma.args) {
          for (const arg of ma.args) this.visitNode(arg);
        }
        break;
      }
      case 'AssignmentStmt': {
        const assign = node as import('./ast').AssignmentStmtNode;
        this.visitNode(assign.target);
        this.visitNode(assign.value);
        break;
      }
      case 'BinaryExpr': {
        const bin = node as import('./ast').BinaryExprNode;
        this.visitNode(bin.left);
        this.visitNode(bin.right);
        break;
      }
      case 'UnaryExpr': {
        const unary = node as import('./ast').UnaryExprNode;
        this.visitNode(unary.operand);
        break;
      }
      case 'ExpressionStmt': {
        const expr = node as import('./ast').ExpressionStmtNode;
        this.visitNode(expr.expression);
        break;
      }
    }
  }

  private visitProcedure(node: ProcedureDeclNode): void {
    this.define({
      name: node.name,
      kind: SymbolKind.Procedure,
      declarationNode: node,
      scope: this.currentScope,
    });

    this.pushScope();

    if (node.params) {
      for (const param of node.params.params) {
        this.define({
          name: param.name,
          kind: SymbolKind.Parameter,
          declarationNode: param,
          scope: this.currentScope,
        });
      }
    }

    for (const defaultDecl of node.defaults) {
      this.define({
        name: defaultDecl.name,
        kind: SymbolKind.Parameter,
        declarationNode: defaultDecl,
        scope: this.currentScope,
      });
    }

    for (const stmt of node.body) {
      this.visitNode(stmt);
    }

    this.popScope();
  }

  private visitClass(node: ClassDeclNode): void {
    this.define({
      name: node.name,
      kind: SymbolKind.Class,
      declarationNode: node,
      scope: this.currentScope,
    });

    this.pushScope();

    for (const member of node.members) {
      this.visitNode(member);
    }

    this.popScope();
  }

  private visitDeclare(node: DeclareStmtNode): void {
    for (let i = 0; i < node.names.length; i++) {
      this.define({
        name: node.names[i],
        kind: SymbolKind.Variable,
        declarationNode: node.nameNodes[i],
        scope: this.currentScope,
      });
    }
  }
}
