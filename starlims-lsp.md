# STARLIMS SSL Language Server Protocol — Plan

## Overview

Build an LSP (Language Server Protocol) implementation for the **STARLIMS Scripting Language (SSL)** as a VS Code extension. Provides syntax highlighting, diagnostics, navigation, IntelliSense, and code editing support for `.ssl` and `.slsql` files.

---

## 1. Language Analysis

SSL is a dynamic, procedural scripting language with OOP support, SQL embedding, and .NET interop.

### File Types

| Extension | Type | Content |
|---|---|---|
| `.ssl` | Server Script / STARLIMS DS | Full scripting: procedures, classes, conditionals, SQL embedding, .NET interop |
| `.slsql` | SQL Data Source | `:PARAMETERS` header + raw SQL query |

### Keywords & Directives

```
Structure:    :PROCEDURE / :ENDPROC, :CLASS, :INHERIT, :INCLUDE, :DSN
Parameters:   :PARAMETERS, :DECLARE, :DEFAULT
Control:      :IF / :ELSE / :ENDIF, :BEGINCASE / :CASE / :EXITCASE / :OTHERWISE / :ENDCASE
Loops:        :FOR / :NEXT, :WHILE / :ENDWHILE, :LOOP
Errors:       :TRY / :CATCH / :FINALLY / :ENDTRY
Return:       :RETURN
Accessors:    :ACCESS / :ASSIGN
```

### Literals & Operators

```
Booleans:     .T. , .F.
Null:         NIL
Assignment:   :=
Comparison:   == , != , = , :==
Logical:      .AND. , .OR. , .NOT. , !
Arithmetic:   + , - , * , / , +=
String:       + (concat), $ (substring containment)
```

### Arrays

- Literals: `{}`, `{1, 2, 3}`, `{{"a",1},{"b",2}}`
- 1-indexed: `arr[1]`, `arr[i][j]`, `arr[i, j]`
- Functions: `AAdd()`, `Len()`, `AScanExact()`, `AEval()`, `ExtractCol()`, `BuildString()`, `BuildStringForIn()`

### SQL Embedding

- `?paramName?` — named bind parameters inside SQL strings
- `?` — positional parameters in function args
- `SQLExecute()`, `RunSQL()`, `GetDataSet()`, `LSearch()`, `LSelect1()`
- Connection names: `"DATABASE"`, `"DICTIONARY"`, `"SettingsDB"`
- Multi-DB: `EXEC('...') AT LINKED_SERVER`

### .NET Interop

```ssl
obj := LimsNetConnect(assembly, typeName, {constructorArgs});
cast := LimsNetCast(value, "enum:System.IO.FileMode");
obj:PropertyName
obj:MethodName(args)
```

### Comments

- Block only: `/* ... */`
- No line comments (`//` or `#` not standard)

### Key Conventions

- Everything is 1-indexed (arrays, `SubStr()`, `At()`)
- Hungarian prefix: `s`=string, `n`=numeric, `b`/`l`=bool, `a`=array, `o`=object, `str`/`arr` (legacy)
- Return convention: `{.T., data}` success / `{.F., "error"}` failure
- `Me:` = `this` reference in classes

### Documentation Sources

- `UserDoc/_static/oldDocs/ssl/sslreference.html` — 179 HTML files covering all statements and function libraries
- `UserDoc/SSLReference/index.html` — modern single-page reference with 30 function libraries
- Real code examples across 50+ SSL files in `Production/`

---

## 2. Architecture

**TypeScript/Node.js** with `vscode-languageserver` package.

### Pipeline

```
Source Code
    ↓
SSLLexer (character → token stream)
    ↓
SSLParser (token stream → AST, recursive descent, error recovery)
    ↓
SemanticModel (symbol table, scope resolution, type tracking)
    ↓
LanguageService (LSP handlers: diagnostics, completion, hover, definition, etc.)
```

### Process Model

```
VS Code Extension Host
  └─ LanguageClient (client/extension.ts)
       │  LSP (JSON-RPC over stdio)
       ▼
  Language Server Process (server/server.ts)
       │
       ├─ TextDocuments<TextDocument> (incremental sync)
       ├─ SSLLexer → SSLParser → SemanticModel
       ├─ Diagnostics: debounced 300ms on didChangeContent
       └─ LSP providers: completion, hover, definition, references, symbols, folding
```

### Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| LSP SDK | `vscode-languageserver` (Node.js) | Codebase is JS, Node.js v22 available, mature ecosystem |
| Parser | Hand-written recursive descent | SSL is simple (40 tokens, no ambiguities). Fastest to implement, debug, no build step |
| Doc sync | `TextDocumentSyncKind.Incremental` | Handled by library automatically |
| Validation | Debounced 300ms full reparse | SSL files are small (<1000 lines); 300ms prevents per-stroke overhead |
| Diagnostics | Push model (`sendDiagnostics`) | Simplest; good for SSL. Can migrate to pull diagnostics later |
| Syntax highlighting | TextMate grammar (.tmLanguage.json) | Declarative, zero runtime cost, VS Code native |
| Error recovery | Synchronized token sets + ERROR AST nodes | Continue parsing after errors; show squiggles on bad regions |
| Built-in docs source | `UserDoc/SSLReference/index.html` | Parse into JSON lookup table for hover + completion |

---

## 3. Project Structure

```
ssl-language-support/
├── package.json                       # Extension manifest
├── .vscodeignore                      # Files to exclude from packaging
├── client/
│   ├── package.json
│   └── src/
│       └── extension.ts               # LanguageClient bootstrap
├── server/
│   ├── package.json
│   └── src/
│       ├── server.ts                  # LSP server: capabilities, provider registration
│       ├── lexer.ts                   # Tokenizer: char → Token stream
│       ├── parser.ts                  # Recursive-descent parser: Token → AST
│       ├── ast.ts                     # AST node types (interfaces/classes)
│       ├── symbol-table.ts            # Scope + symbol resolution
│       ├── checker.ts                 # Semantic diagnostics (type checks, validations)
│       ├── completion.ts              # CompletionItem provider
│       ├── hover.ts                   # Hover content from builtin docs
│       ├── definition.ts             # Go-to-definition
│       └── references.ts             # Find references
├── syntaxes/
│   └── ssl.tmLanguage.json           # TextMate grammar for syntax highlighting
├── ssl-configuration/
│   └── language-configuration.json   # Comments, brackets, folding, indentation
└── snippets/
    └── ssl.json                       # Code snippets
```

---

## 4. Lexer Token Specification

```
Keywords:
  :PROCEDURE  :ENDPROC    :PARAMETERS  :DECLARE    :DEFAULT
  :RETURN     :IF         :ELSE        :ENDIF      :BEGINCASE
  :CASE       :EXITCASE   :OTHERWISE   :ENDCASE    :FOR
  :NEXT       :WHILE      :ENDWHILE    :LOOP       :EXIT
  :TRY        :CATCH      :FINALLY     :ENDTRY     :CLASS
  :INHERIT    :INCLUDE    :DSN         :ACCESS     :ASSIGN

Booleans:     .T.   .F.
Null:         NIL

Operators:
  :=   :==   ==   !=   =    +=
  +    -    *    /    <    >    <=    >=
  .AND.   .OR.   .NOT.
  !    $

Delimiters:   ;   ,   (   )   {   }   [   ]

Literals:
  "..."       — double-quoted string
  '...'       — single-quoted string
  [0-9]+      — integer
  [0-9]+.[0-9]+  — float

Comments:     /* ... */  (multi-line, not nestable)

SQL param:    ?identifier?  (inside strings)

Identifiers:  [a-zA-Z_][a-zA-Z0-9_]*
              qualified:  Module.ProcedureName
```

---

## 5. Parser Grammar

```
program         → (topLevelStmt)*

topLevelStmt    → classDecl | procedureDecl | includeStmt | globalStmt

classDecl       → ':CLASS' IDENTIFIER ';'
                  (':INHERIT' qualifiedId ';')?
                  classMember*
                  /* implicit end at file or next class */

classMember     → procedureDecl | accessorDecl

procedureDecl   → ':PROCEDURE' IDENTIFIER ';'
                  paramsDecl?
                  defaultDecl*
                  stmt*
                  ':ENDPROC' ';'

paramsDecl      → ':PARAMETERS' param (',' param)* ';'
param           → IDENTIFIER (':=' expr)?

defaultDecl     → ':DEFAULT' IDENTIFIER ',' expr ';'

includeStmt     → ':INCLUDE' qualifiedId ';'

stmt            → ifStmt | forStmt | whileStmt | caseStmt | tryStmt
                | declareStmt | returnStmt | loopStmt
                | assignmentStmt ';' | exprCallStmt ';'

ifStmt          → ':IF' expr ';' stmt*
                  (':ELSE' ';' stmt*)?
                  ':ENDIF' ';'

forStmt         → ':FOR' assignment ':TO' expr ';' stmt* ':NEXT' ';'

whileStmt       → ':WHILE' expr ';' stmt* ':ENDWHILE' ';'

caseStmt        → ':BEGINCASE' ';'
                  (caseBranch)*
                  (otherBranch)?
                  ':ENDCASE' ';'
caseBranch      → ':CASE' expr ';' stmt* (':EXITCASE' ';')?
otherBranch     → ':OTHERWISE' ';' stmt*

tryStmt         → ':TRY' ';' stmt*
                  (':CATCH' ';' stmt*)?
                  (':FINALLY' ';' stmt*)?
                  ':ENDTRY' ';'

declareStmt     → ':DECLARE' IDENTIFIER (',' IDENTIFIER)* ';'

returnStmt      → ':RETURN' expr? ';'

loopStmt        → ':LOOP' ';'

assignmentStmt  → lvalue ':=' expr
lvalue          → IDENTIFIER | memberAccess | arrayAccess

expr            → logicalOr
logicalOr       → logicalAnd ('.OR.' logicalAnd)*
logicalAnd      → bitwiseOr ('.AND.' bitwiseOr)*
bitwiseOr       → equality ('|' equality)?
equality        → comparison (('==' | '!=' | '=' | ':==') comparison)*
comparison      → addition (('<' | '>' | '<=' | '>=') addition)*
addition        → multiplication (('+' | '-') multiplication)*
multiplication  → unary (('*' | '/') unary)*
unary           → ('!' | '.NOT.' | '+' | '-') unary | primary
primary         → IDENTIFIER
                | STRING_LITERAL
                | NUMBER_LITERAL
                | BOOLEAN_LITERAL (.T. | .F.)
                | NIL_LITERAL
                | arrayLiteral
                | '(' expr ')'
                | memberAccess
                | arrayAccess
                | functionCall
                | qualifiedCall (Module.Proc)
memberAccess    → primary ':' IDENTIFIER ( '(' argList? ')' )?
arrayAccess     → primary '[' expr (',' expr)? ']'
functionCall    → IDENTIFIER '(' argList? ')'
qualifiedCall   → (IDENTIFIER '.')+ IDENTIFIER '(' argList? ')'
argList         → expr (',' expr)*
arrayLiteral    → '{' (expr (',' expr)*)? '}'
```

---

## 6. Implementation Phases

### Phase 1 — Foundation

| Deliverable | Files | Provides |
|---|---|---|
| TextMate grammar | `syntaxes/ssl.tmLanguage.json` | Syntax highlighting: all keywords, operators, strings, `?params?`, comments, `.T.`/`.F.`, numbers, built-in functions |
| language-configuration | `ssl-configuration/language-configuration.json` | Comment toggle, bracket matching, auto-close pairs, folding, smart indent |
| Lexer | `server/src/lexer.ts`, `ast.ts` | Tokenize all constructs; track line/column/offset |
| Parser | `server/src/parser.ts` | Recursive descent for all grammar rules; error recovery with ERROR nodes |
| LSP server | `server/src/server.ts` | `initialize` capabilities, incremental sync, parse → `sendDiagnostics` |
| Client extension | `client/src/extension.ts` | LanguageClient bootstrap, spawns server, document selector `ssl`/`slsql` |
| Extension manifest | `package.json` | Language registration, activation events, contributes |

**Result**: Colored syntax, parse error underlines, outline view, bracket matching, folding, smart indentation.

### Phase 2 — Navigation & Information

| Feature | Implementation |
|---|---|
| Document Symbols | Walk AST → return `:PROCEDURE`, `:CLASS` names with ranges |
| Go to Definition | Symbol table lookup: procedure call → declaration, variable → declaration |
| Find References | Reverse symbol lookup: all references to a procedure or variable |
| Hover | Show signature from `:PARAMETERS` + doc comment for procedures; type info for variables |
| Folding Range | Report `:PROCEDURE/:ENDPROC`, `:IF/:ENDIF`, `:TRY/:ENDTRY`, `:FOR/:NEXT`, `:WHILE/:ENDWHILE` as folding ranges |

**Result**: Click navigation, hover info, outline, folding.

### Phase 3 — Advanced

| Feature | Implementation |
|---|---|
| Completion | Keywords, procedure names (from `DoProc`/`ExecFunction` targets), built-in functions (parsed from `UserDoc/SSLReference/index.html`), local variables, `?param?` inside SQL strings |
| Signature Help | Parameter list + defaults from `:PARAMETERS` declarations |
| Semantic Diagnostics | Unused variables, missing `:RETURN`, unbalanced blocks, unclosed `BeginLimsTransaction` |
| Rename Symbol | Scoped rename for variables/procedures across file via symbol table |
| Code Actions | Quick fix: add missing `:ENDPROC`, balanced `:ENDIF`, remove unused variable |
| Formatting | Indentation fixer based on AST tree structure |

---

## 7. TextMate Grammar Scope Map

| SSL Construct | TextMate Scope |
|---|---|
| `:PROCEDURE`, `:IF`, `:FOR`, etc. | `keyword.control.ssl` |
| `.T.`, `.F.`, `NIL` | `constant.language.ssl` |
| `:=`, `==`, `+`, etc. | `keyword.operator.ssl` |
| `"..."`, `'...'` | `string.quoted.double.ssl` / `string.quoted.single.ssl` |
| `?param?` (inside strings) | `variable.parameter.sql.ssl` |
| `/* ... */` | `comment.block.ssl` |
| `AAdd`, `Len`, `SQLExecute`, `UsrMes` | `support.function.builtin.ssl` |
| `123`, `3.14` | `constant.numeric.ssl` |
| `DoProc`, `ExecFunction` | `support.function.interproc.ssl` |
| `LimsNetConnect`, `LimsNetCast`, `CreateUDObject` | `support.function.net.ssl` |
| `MyUserName`, `CrLf`, `PLATFORMA` | `constant.language.ssl` |
| `Me:` | `variable.language.ssl` |
| `ss*`, `sc*`, `ds*`, `cs*` prefixed functions | `entity.name.function.ssl` |
| `?placeholder?` | `variable.parameter.sql.ssl` |

---

## 8. Declarative Editing Features

### `language-configuration.json`

| Section | SSL-specific |
|---|---|
| `comments.blockComment` | `["/*", "*/"]` |
| `brackets` | `{}`, `[]`, `()` |
| `autoClosingPairs` | `{`, `[`, `(`, `"`, `'` = close on type; `/*` = `*/` |
| `surroundingPairs` | `{`, `[`, `(`, `"`, `'` |
| `folding.markers` | `#region` / `#endregion` (existing convention) |
| `indentationRules.increaseIndentPattern` | `:IF`, `:FOR`, `:WHILE`, `:PROCEDURE`, `:CLASS`, `:TRY`, `:BEGINCASE`, `:ELSE`, `:CASE`, `:OTHERWISE`, `:CATCH`, `:FINALLY` |
| `indentationRules.decreaseIndentPattern` | `:ENDIF`, `:NEXT`, `:ENDWHILE`, `:ENDPROC`, `:ENDTRY`, `:ENDCASE` |
| `wordPattern` | Identifiers, numbers, `:keywords`, `.T.`/`.F.` |

### Snippets (`snippets/ssl.json`)

| Trigger | Expands to |
|---|---|
| `proc` | Full `:PROCEDURE` / `:ENDPROC` scaffold with params |
| `if` | `:IF` / `:ENDIF` block |
| `for` | `:FOR` / `:NEXT` loop |
| `while` | `:WHILE` / `:ENDWHILE` loop |
| `try` | `:TRY` / `:CATCH` / `:ENDTRY` with error handling |
| `case` | `:BEGINCASE` / `:CASE` / `:ENDCASE` switch |
| `trans` | `BeginLimsTransaction` / `EndLimsTransaction` pair |
| `class` | `:CLASS` skeleton with constructor |
| `ds` | Data source template (header + params + SQL) |
| `sql` | `SQLExecute(...)` call |
| `return` | `{.T., ...}` / `{.F., ...}` return pattern |
| `net` | `LimsNetConnect()` call |

---

## 9. Built-in Function Documentation Integration

### Source

`UserDoc/SSLReference/index.html` — single-file HTML with 30 libraries documented:
ArrayLib, Builtin, DatabaseLib, DataTypeLib, DateLib, DocumentumLib, EmailLib, FileLib, FtpLib, GlobalSettings, HtmlMergerLib, ImpexLib, LateBinding, MiscLib, ModesOfOperation, NumericLib, ORMLib, ProcessLib, ReportingLib, SecurityLib, StringLib, SftpLib, Sync, SynchronizationLib, TransactionSettings, UdoLib, WebLib, XfdMergerLib, XmlLib, ZipLib

### Build Step

Extract function signatures + descriptions → `builtin-functions.json` included with extension. Used by:
- **Completion**: suggest function names with parameter info
- **Hover**: show description + signature
- **Signature Help**: parameter list with types

---

## 10. Development Environment

| Tool | Version | Purpose |
|---|---|---|
| Node.js | 22.14.0 | LSP server runtime |
| npm | 11.17.0 | Package management |
| TypeScript | 5.x | Language for implementation |
| ESLint | 8.57.1 | Code quality |
| dprint | 0.54.0 | Formatting |
| `@vscode/vsce` | latest | Extension packaging (.vsix) |

### Build & Test Commands

```powershell
cd ssl-language-support
npm install
npm run compile        # tsc -b
npx vsce package       # → .vsix for local install
code --install-extension *.vsix   # install in VS Code
```

---

## 11. Open Questions

1. **Scope**: start with Phase 1 only (MVP) or target Phases 1–2?
2. **Repository location**: inside this repo as `extensions/ssl-language-support/` or separate repo?
3. **`.ssl.ssl` suffix**: some files have double extension — should the grammar support both `.ssl` and `.ssl.ssl`?
4. **Built-in docs parsing**: build-time extraction from `UserDoc/SSLReference/index.html` into JSON, or lazy-load at runtime?
