// Generate .d.ts from STARLIMS JSDoc-annotated runtime JS files
// Usage: node tools/generate-starlims-typings.mjs <path-to-slvscode>
// Outputs: dist/starlims-runtime.d.ts

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, basename } from 'path';

const SLVSCODE_ROOT = process.argv[2];
if (!SLVSCODE_ROOT) {
  console.error('Usage: node tools/generate-starlims-typings.mjs <path-to-slvscode>');
  process.exit(1);
}

const distDir = resolve(import.meta.dirname || '.', '..', 'dist');
const sourceFiles = [
  'htmlruntime/common/starlims.lims.js',
  'htmlruntime/desktop/starlims.forms.js',
  'htmlruntime/desktop/starlims.dialogs.js',
];

let combined = '// Auto-generated STARLIMS runtime declarations\n';
combined += '// Source: starlims.lims.js, starlims.forms.js, starlims.dialogs.js\n\n';

for (const relPath of sourceFiles) {
  const fullPath = resolve(SLVSCODE_ROOT, relPath);
  if (!existsSync(fullPath)) {
    console.warn(`  [SKIP] ${relPath} not found`);
    continue;
  }

  console.log(`  Processing ${relPath}...`);
  const source = readFileSync(fullPath, 'utf-8');

  // Extract JSDoc type comments and function signatures
  // This is a best-effort extraction; tsc --allowJs --declaration would be more accurate
  // but requires tsc installation. We use a simple pattern as fallback.
  const decls = extractDeclarations(source, basename(relPath));
  combined += decls + '\n';
}

mkdirSync(distDir, { recursive: true });
const outPath = resolve(distDir, 'starlims-runtime.d.ts');
writeFileSync(outPath, combined, 'utf-8');
console.log(`\nWrote ${outPath}`);
console.log('Note: For accurate typings, also run:');
console.log('  tsc --allowJs --checkJs false --declaration --emitDeclarationOnly');
console.log('  --outFile dist/starlims-runtime-complete.d.ts <js-files>');

function extractDeclarations(source, fileName) {
  const lines = source.split('\n');
  const decls = [];
  let i = 0;

  // Extract Ext.define class declarations
  const classRe = /Ext\.define\(['"](\w+)['"]\s*,\s*\{/;
  const methodRe = /^\s+(\w+):\s*function\s+(?:\w+\s*)?\(([^)]*)\)/;

  while (i < lines.length) {
    const line = lines[i];

    // Class declarations (Ext.define)
    const classMatch = line.match(classRe);
    if (classMatch) {
      const className = classMatch[1];
      decls.push(`\n// From ${fileName}: ${className}`);
      decls.push(`declare class ${className} {`);

      // Collect methods inside this class
      let braceDepth = 1;
      i++;
      while (i < lines.length && braceDepth > 0) {
        const inner = lines[i];
        // Track braces
        for (const ch of inner) {
          if (ch === '{') braceDepth++;
          if (ch === '}') braceDepth--;
        }

        const methodMatch = inner.match(methodRe);
        if (methodMatch) {
          const methodName = methodMatch[1];
          const params = methodMatch[2];
          // Try to find JSDoc above
          let jsdoc = '';
          for (let j = i - 1; j >= 0 && j >= i - 5; j--) {
            const trimmed = lines[j].trim();
            if (trimmed.startsWith('* @param') || trimmed.startsWith('* @returns') || trimmed.startsWith('* @see') || trimmed.startsWith('* @')) {
              jsdoc = lines[j].trim() + '\n' + jsdoc;
            } else if (trimmed.startsWith('/**') || trimmed.startsWith('/*')) {
              jsdoc = lines[j].trim() + '\n' + jsdoc;
              break;
            } else if (trimmed !== '*' && trimmed !== '' && !trimmed.startsWith('*')) {
              break;
            }
          }
          const jsdocStr = jsdoc ? `\n  ${jsdoc.replace(/\n/g, '\n  ')}` : '';
          decls.push(`${jsdocStr}\n  ${methodName}(${params}): any;`);
        }
        i++;
      }
      decls.push(`}\n`);
      continue;
    }

    i++;
  }

  return decls.join('\n');
}
