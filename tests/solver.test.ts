/** @vitest-environment jsdom */

import { vi } from 'vitest';
import { createChallenge } from '../src/index';
import { calibrateBrowser, calibrateClient, solveChallenge, solveSingleChallenge } from '../src/solver';

describe('browser solver', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: require('node:crypto').webcrypto,
    });
    Object.defineProperty(globalThis, 'TextEncoder', {
      configurable: true,
      value: require('node:util').TextEncoder,
    });
    Object.defineProperty(globalThis, 'atob', {
      configurable: true,
      value: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    });
  });

  it('solves a single valid challenge token', async () => {
    const [token] = createChallenge(1, 1, 60);

    const solution = await solveSingleChallenge(token);

    expect(solution).toBeTruthy();
    expect(solution?.nonce).toBeDefined();
    expect(solution?.hash.startsWith('0')).toBe(true);
  });

  it('calibrates browser clients with the shared calibration shape', async () => {
    const calibration = await calibrateBrowser(2);
    const clientCalibration = await calibrateClient(2);

    expect(calibration.iterations).toBe(2);
    expect(calibration.durationMs).toBeGreaterThanOrEqual(1);
    expect(clientCalibration.iterations).toBe(2);
    expect(clientCalibration.durationMs).toBeGreaterThanOrEqual(1);
  });

  it('returns undefined for malformed tokens', async () => {
    await expect(solveSingleChallenge('not-a-token')).resolves.toBeUndefined();
    await expect(solveSingleChallenge('a.b.c')).resolves.toBeUndefined();
  });

  it('solves multiple tokens and reports progress', async () => {
    const [tokenA, tokenB] = createChallenge(1, 2, 60);
    const onProgress = vi.fn();

    const solutions = await solveChallenge([tokenA, tokenB], onProgress);

    expect(solutions).toHaveLength(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, 50);
    expect(onProgress).toHaveBeenNthCalledWith(2, 100);
  });

  it('throws when a token entry is missing', async () => {
    await expect(solveChallenge([''])).rejects.toThrow('Invalid token at index 0');
  });

  it('throws when a token cannot be solved', async () => {
    await expect(solveChallenge(['not-a-token'])).rejects.toThrow('Failed to solve challenge 1');
  });

  it('throws a clear error when Web Crypto is unavailable', async () => {
    const [token] = createChallenge(1, 1, 60);
    const originalCrypto = globalThis.crypto;

    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: undefined,
    });

    await expect(solveSingleChallenge(token)).rejects.toThrow('Web Crypto API is unavailable. Use HTTPS or localhost.');

    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: originalCrypto,
    });
  });

  it('throws a clear error when TextEncoder is unavailable', async () => {
    const [token] = createChallenge(1, 1, 60);
    const originalTextEncoder = globalThis.TextEncoder;

    Object.defineProperty(globalThis, 'TextEncoder', {
      configurable: true,
      value: undefined,
    });

    await expect(solveSingleChallenge(token)).rejects.toThrow('TextEncoder is unavailable in this browser environment');

    Object.defineProperty(globalThis, 'TextEncoder', {
      configurable: true,
      value: originalTextEncoder,
    });
  });

  it('yields while solving long-running browser challenges', async () => {
    const payload = btoa(JSON.stringify({
      challenge: 'abc',
      difficulty: 3,
      expires: Math.floor(Date.now() / 1000) + 60,
    })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const token = `header.${payload}.signature`;

    const solution = await solveSingleChallenge(token);

    expect(Number(solution?.nonce)).toBeGreaterThanOrEqual(1000);
    expect(solution?.hash.startsWith('000')).toBe(true);
  });

  it('aborts solving when signal is cancelled', async () => {
    const [token] = createChallenge(7, 1, 60);
    const controller = new AbortController();

    const promise = solveSingleChallenge(token, controller.signal);
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('passes abort signal through solveChallenge', async () => {
    const [tokenA, tokenB] = createChallenge(1, 2, 60);
    const controller = new AbortController();

    const solutions = await solveChallenge([tokenA, tokenB], undefined, controller.signal);

    expect(solutions).toHaveLength(2);
  });
});
