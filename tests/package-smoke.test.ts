/** @vitest-environment jsdom */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const rootDir = resolve(__dirname, '..');

let built = false;

function ensureBuild() {
  if (built) return;

  execFileSync('npm', ['run', 'build'], {
    cwd: rootDir,
    stdio: 'pipe',
  });

  built = true;
}

describe('package smoke tests', () => {
  beforeAll(() => {
    ensureBuild();
  }, 60_000);

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
            verifySolution: typeof mod.verifySolution
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
            verifySolution: typeof mod.verifySolution
          }));
        `,
      ],
      { cwd: rootDir, encoding: 'utf8' }
    );

    expect(JSON.parse(esmOutput)).toEqual({
      createChallenge: 'function',
      verifySolution: 'function',
    });
    expect(JSON.parse(cjsOutput)).toEqual({
      createChallenge: 'function',
      verifySolution: 'function',
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
            widgetRegistered: Boolean(customElements.get('ribaunt-widget')),
            widgetReact: typeof widgetReactModule.default
          }));
        `,
      ],
      { cwd: rootDir, encoding: 'utf8' }
    );

    expect(JSON.parse(browserOutput)).toEqual({
      widget: 'function',
      widgetRegistered: true,
      widgetReact: 'object',
    });
  });

  it('points package exports at the built entry files', () => {
    const packageJson = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')) as {
      exports: Record<string, Record<string, string>>;
    };

    expect(packageJson.exports['.']?.import).toBe('./dist/index.js');
    expect(packageJson.exports['.']?.require).toBe('./dist/cjs/index.js');
    expect(packageJson.exports['./widget']?.default).toBe('./dist/widget-browser.js');
    expect(packageJson.exports['./widget-react']?.default).toBe('./dist/widget-react.js');
  });
});
