import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const wasmSrc = resolve(root, 'src/wasm/solver.ts');
const outFile = resolve(root, 'dist/ribaunt-solver.wasm');

if (!existsSync(wasmSrc)) {
  console.error(`[build-wasm] Missing WASM source: ${wasmSrc}`);
  process.exit(1);
}

// Ensure dist exists (clean may have removed it)
mkdirSync(resolve(root, 'dist'), { recursive: true });

// Use local asc binary via npx
// Prefer direct invocation of assemblyscript CLI for reproducibility
const result = spawnSync(
  'npx',
  [
    'asc',
    wasmSrc,
    '--outFile', outFile,
    '--optimize',
    '--runtime', 'stub',
    '--use', 'abort=',
    '--noAssert',
  ],
  { stdio: 'inherit', cwd: root }
);

if (result.error) {
  console.error('[build-wasm] Failed to spawn asc:', result.error);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`[build-wasm] asc exited with code ${result.status}`);
  process.exit(result.status ?? 1);
}

if (!existsSync(outFile)) {
  console.error(`[build-wasm] Expected output missing: ${outFile}`);
  process.exit(1);
}

const stat = statSync(outFile);
if (stat.size === 0) {
  console.error(`[build-wasm] Output is empty: ${outFile}`);
  process.exit(1);
}

console.log(`[build-wasm] Built ${outFile} (${stat.size} bytes)`);
