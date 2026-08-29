import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const root = process.cwd();
const dist = resolve(root, 'dist');
const demoLib = resolve(root, 'demo/lib');

if (!existsSync(dist)) {
  console.log('[prepare-demo] dist not found, skipping');
  process.exit(0);
}

await mkdir(demoLib, { recursive: true });

const files = [
  'widget-browser.js',
  'widget-browser.js.map',
  'widget.js',
  'widget.js.map',
  'solver.js',
  'solver.js.map',
  'worker-client.js',
  'worker-client.js.map',
  'solver-worker.js',
  'solver-worker.js.map',
  'wasm-solver.js',
  'wasm-solver.js.map',
  'ribaunt-solver.wasm',
];

for (const f of files) {
  try {
    await cp(resolve(dist, f), resolve(demoLib, f), { force: true });
  } catch {
    // ignore missing map files
  }
}

console.log(`[prepare-demo] Synced ${files.length} files to demo/lib`);
