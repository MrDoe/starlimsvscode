// Validates all STARLIMS backend .srvscr files with the SSL LSP parser.
// Compiles the LSP parser (tsconfig.lsp-test.json) and reports parse errors
// plus style-guide rule violations (always on).
// Exit code is non-zero only for parse errors or style rules with severity
// 'error' - style warnings/infos are reported but do not fail the build.
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
const { computeStyleDiagnostics } = require(join(root, "out-lsp-test", "lsp", "server", "styleRules.js"));

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
let totalWarnings = 0;
let totalInfos = 0;

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const { ast, errors } = new SSLParser().parse(source);
  const label = relative(root, file);

  let styleErrors = 0;
  let styleWarnings = 0;
  let styleInfos = 0;
  const styleDiagnostics = computeStyleDiagnostics(source, ast);

  for (const d of styleDiagnostics) {
    const sev = d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info";
    const where = `line ${d.range.start.line + 1}, column ${d.range.start.character + 1}`;
    if (sev === "error") {
      styleErrors++;
      console.log(`${label}: [${d.code}] ${where}: ${d.message}`);
    } else if (sev === "warning") {
      styleWarnings++;
    } else {
      styleInfos++;
    }
  }

  if (errors.length > 0) {
    totalErrors += errors.length;
    console.log(`${label}: ${errors.length} parse error(s)`);
    for (const error of errors.slice(0, 20)) {
      console.log(`  line ${error.line + 1}, column ${error.column + 1}: ${error.message}`);
    }
    if (errors.length > 20) {
      console.log(`  ... ${errors.length - 20} more`);
    }
  } else {
    const styleNote =
      styleErrors + styleWarnings + styleInfos > 0
        ? `, ${styleErrors} style error(s), ${styleWarnings} warning(s), ${styleInfos} info(s)`
        : "";
    console.log(`${label}: OK${styleNote}`);
  }
  totalWarnings += styleWarnings;
  totalInfos += styleInfos;
}

console.log(
  `${files.length} script(s) checked, ${totalErrors} parse error(s), ${totalWarnings} style warning(s), ${totalInfos} style info(s).`
);
process.exit(totalErrors > 0 ? 1 : 0);