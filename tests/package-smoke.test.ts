/** @vitest-environment jsdom */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const rootDir = resolve(__dirname, '..');

/**
 * The smoke tests validate built artifacts but never build anything
 * themselves: spawning the package manager or tsc from inside a test worker
 * has deadlocked under vitest's fork pool. `pnpm test` and CI run
 * `pnpm run build` first; these tests fail fast with instructions if dist/
 * is missing.
 */
function requireBuiltDist() {
  const entry = resolve(rootDir, 'dist', 'index.js');
  if (!existsSync(entry)) {
    throw new Error(
      'dist/index.js not found. Run `pnpm run build` (or `pnpm test`) before the smoke tests.'
    );
  }
}

describe('package smoke tests', () => {
  beforeAll(() => {
    requireBuiltDist();
  });

  it('exports working ESM and CJS server entry points', async () => {
    const esmOutput = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          const mod = await import(${JSON.stringify(new URL(`file://${resolve(rootDir, 'dist/index.js')}`).href)});
          console.log(JSON.stringify({
            createChallenge: typeof mod.createChallenge,
            verifySolution: typeof mod.verifySolution,
            selectWorkload: typeof mod.selectWorkload,
            calibrateNode: typeof mod.calibrateNode,
            calibrateClient: typeof mod.calibrateClient
          }));
        `,
      ],
      { cwd: rootDir, encoding: 'utf8' }
    );

    const cjsOutput = execFileSync(
      process.execPath,
      [
        '-e',
        `
          const mod = require(${JSON.stringify(resolve(rootDir, 'dist/cjs/index.js'))});
          console.log(JSON.stringify({
            createChallenge: typeof mod.createChallenge,
            verifySolution: typeof mod.verifySolution,
            selectWorkload: typeof mod.selectWorkload,
            calibrateNode: typeof mod.calibrateNode,
            calibrateClient: typeof mod.calibrateClient
          }));
        `,
      ],
      { cwd: rootDir, encoding: 'utf8' }
    );

    expect(JSON.parse(esmOutput)).toEqual({
      createChallenge: 'function',
      verifySolution: 'function',
      selectWorkload: 'function',
      calibrateNode: 'function',
      calibrateClient: 'function',
    });
    expect(JSON.parse(cjsOutput)).toEqual({
      createChallenge: 'function',
      verifySolution: 'function',
      selectWorkload: 'function',
      calibrateNode: 'function',
      calibrateClient: 'function',
    });
  });

  it('loads browser widget entry points from built artifacts', async () => {
    const browserOutput = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          globalThis.window = {};
          globalThis.HTMLElement = class HTMLElement {};
          globalThis.customElements = {
            registry: new Map(),
            define(name, ctor) {
              this.registry.set(name, ctor);
            },
            get(name) {
              return this.registry.get(name);
            }
          };

          const widgetModule = await import(${JSON.stringify(new URL(`file://${resolve(rootDir, 'dist/widget-browser.js')}`).href)});
          const widgetReactModule = await import(${JSON.stringify(new URL(`file://${resolve(rootDir, 'dist/widget-react.js')}`).href)});

          console.log(JSON.stringify({
            widget: typeof widgetModule.RibauntWidget,
            calibrateBrowser: typeof widgetModule.calibrateBrowser,
            calibrateClient: typeof widgetModule.calibrateClient,
            widgetRegistered: Boolean(customElements.get('ribaunt-widget')),
            widgetReact: typeof widgetReactModule.default
          }));
        `,
      ],
      { cwd: rootDir, encoding: 'utf8' }
    );

    expect(JSON.parse(browserOutput)).toEqual({
      widget: 'function',
      calibrateBrowser: 'function',
      calibrateClient: 'function',
      widgetRegistered: true,
      widgetReact: 'object',
    });
  });

  it('re-exports widget types from the browser entry declarations', () => {
    requireBuiltDist();

    const widgetDts = readFileSync(resolve(rootDir, 'dist/widget-browser.d.ts'), 'utf8');

    expect(widgetDts).toContain('RibauntWidgetElement');
    expect(widgetDts).toContain('WidgetState');
    expect(widgetDts).toContain('WidgetError');
    expect(widgetDts).toContain('calibrateBrowser');
    expect(widgetDts).toContain('calibrateClient');
  });

  it('points package exports at the built entry files', () => {
    const packageJson = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')) as {
      exports: Record<string, Record<string, string>>;
    };

    expect(packageJson.exports['.']?.import).toBe('./dist/index.js');
    expect(packageJson.exports['.']?.require).toBe('./dist/cjs/index.js');
    expect(packageJson.exports['./widget']?.default).toBe('./dist/widget-browser.js');
    expect(packageJson.exports['./widget-react']?.default).toBe('./dist/widget-react.js');
    expect(packageJson.exports['./redis']?.import).toBe('./dist/redis.js');
    expect(packageJson.exports['./worker']?.default).toBe('./dist/solver-worker.js');
  });

  it('pins privileged workflow actions to immutable commits', () => {
    const workflows = [
      readFileSync(resolve(rootDir, '.github/workflows/ci.yml'), 'utf8'),
      readFileSync(resolve(rootDir, '.github/workflows/release.yml'), 'utf8'),
    ].join('\n');

    expect(workflows).not.toMatch(/uses:\s+actions\/(?:checkout|setup-node)@v\d+/);
    expect(workflows).toContain('actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10');
    expect(workflows).toContain('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020');
  });

  it('includes the WASM solver artifact in the package', () => {
    const wasmPath = resolve(rootDir, 'dist/ribaunt-solver.wasm');
    expect(existsSync(wasmPath)).toBe(true);
    const stat = readFileSync(wasmPath);
    expect(stat.length).toBeGreaterThan(0);
    // Check that npm pack dry-run would include it (files not ignored)
    const npmIgnore = readFileSync(resolve(rootDir, '.npmignore'), 'utf8');
    expect(npmIgnore).not.toContain('ribaunt-solver.wasm');
    expect(npmIgnore).not.toMatch(/^dist\//m);
  });

  it('exposes wasm-mode via widget types', () => {
    const widgetDts = readFileSync(resolve(rootDir, 'dist/widget.d.ts'), 'utf8');
    expect(widgetDts).toContain('wasm-mode');
    expect(widgetDts).toContain('WasmMode');
    const workerClientDts = readFileSync(resolve(rootDir, 'dist/worker-client.d.ts'), 'utf8');
    expect(workerClientDts).toContain('WasmMode');
    expect(workerClientDts).toContain('SolverBackend');
  });

  it('points worker assets remain resolvable', () => {
    expect(existsSync(resolve(rootDir, 'dist/solver-worker.js'))).toBe(true);
    expect(existsSync(resolve(rootDir, 'dist/wasm-solver.js'))).toBe(true);
    expect(existsSync(resolve(rootDir, 'dist/ribaunt-solver.wasm'))).toBe(true);
  });
});
