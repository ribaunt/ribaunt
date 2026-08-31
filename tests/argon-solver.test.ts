/** @vitest-environment jsdom */
import { vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { createChallenge } from '../src/index';
import {
  solveSingleChallenge,
  solveChallenge,
  calibrateBrowser,
  calibrateArgonBrowser,
  calibrateArgonClient,
  __resetArgonForTesting,
} from '../src/solver';

describe('browser solver argon2id', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    Object.defineProperty(globalThis, 'TextEncoder', { value: TextEncoder, configurable: true });
    Object.defineProperty(globalThis, 'atob', {
      value: (value: string) => Buffer.from(value, 'base64').toString('binary'),
      configurable: true,
    });
  });

  afterEach(() => {
    __resetArgonForTesting();
  });

  it('solves argon single token (auto-detect alg)', async () => {
    const [token] = await createChallenge({ algorithm: 'argon2id', difficulty: 1, amount: 1 });
    const sol = await solveSingleChallenge(token);
    expect(sol).toBeTruthy();
    expect(sol?.hash.startsWith('0')).toBe(true);
  });

  it('solves argon batch and reports progress', async () => {
    const tokens = await createChallenge({ algorithm: 'argon2id', difficulty: 1, amount: 2 });
    const onProgress = vi.fn();
    const sols = await solveChallenge(tokens, onProgress);
    expect(sols).toHaveLength(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, 50);
    expect(onProgress).toHaveBeenNthCalledWith(2, 100);
    sols.forEach(s => expect(s.hash.startsWith('0')).toBe(true));
  });

  it('still solves sha after argon (no cross-contamination)', async () => {
    const [sha] = await createChallenge({ difficulty: 1, amount: 1 });
    const shaSol = await solveSingleChallenge(sha);
    expect(shaSol?.hash.startsWith('0')).toBe(true);
    const [argon] = await createChallenge({ algorithm: 'argon2id', difficulty: 1, amount: 1 });
    const argonSol = await solveSingleChallenge(argon);
    expect(argonSol?.hash.startsWith('0')).toBe(true);
  });

  it('calibrates argon browser', async () => {
    const cal = await calibrateArgonBrowser(2);
    const cal2 = await calibrateArgonClient(2);
    expect(cal.iterations).toBe(2);
    expect(cal.durationMs).toBeGreaterThanOrEqual(1);
    expect(cal2.iterations).toBe(2);
  });

  it('calibrates sha browser still works', async () => {
    const cal = await calibrateBrowser(2);
    expect(cal.iterations).toBe(2);
  });

  it('aborts argon solving', async () => {
    const [tok] = await createChallenge({ algorithm: 'argon2id', difficulty: 2, amount: 1 });
    const controller = new AbortController();
    const p = solveSingleChallenge(tok, controller.signal);
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborts pre-aborted signal for argon', async () => {
    const [tok] = await createChallenge({ algorithm: 'argon2id', difficulty: 2, amount: 1 });
    const c = new AbortController();
    c.abort();
    await expect(solveSingleChallenge(tok, c.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('yields while solving argon (hash is memory-hard but still responsive)', async () => {
    const [tok] = await createChallenge({ algorithm: 'argon2id', difficulty: 1, amount: 1 });
    const sol = await solveSingleChallenge(tok);
    expect(sol?.hash.startsWith('0')).toBe(true);
  });
});
