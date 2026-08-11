// Validates all STARLIMS backend .srvscr files with the SSL LSP parser.
// Compiles the LSP parser (tsconfig.lsp-test.json) and reports parse errors.
// Usage: npm run check:ssl
import { execFileSync } from "child_process";
import { createRequire } from "module";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const require = createRequire(import.meta.url);
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const backendDir = join(root, "src", "backend");

const tscJs = join(root, "node_modules", "typescript", "bin", "tsc");
execFileSync(process.execPath, [tscJs, "-p", "tsconfig.lsp-test.json"], { stdio: "inherit" });

const { SSLParser } = require(join(root, "out-lsp-test", "lsp", "server", "parser.js"));

function collectFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectFiles(full));
    } else if (full.endsWith(".srvscr")) {
      files.push(full);
    }
  }
  return files;
}

const files = collectFiles(backendDir).sort();
let totalErrors = 0;

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const { errors } = new SSLParser().parse(source);
  const label = relative(root, file);
  if (errors.length > 0) {
    totalErrors += errors.length;
    console.log(`${label}: ${errors.length} parse error(s)`);
    for (const error of errors.slice(0, 20)) {
      console.log(`  line ${error.line}, column ${error.column}: ${error.message}`);
    }
    if (errors.length > 20) {
      console.log(`  ... ${errors.length - 20} more`);
    }
  } else {
    console.log(`${label}: OK`);
  }
}

console.log(`${files.length} script(s) checked, ${totalErrors} parse error(s).`);
process.exit(totalErrors > 0 ? 1 : 0);
