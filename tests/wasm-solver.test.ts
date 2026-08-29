/** @vitest-environment jsdom */
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import crypto from 'node:crypto';
import { createChallenge } from '../src/index';
import { solveSingleChallenge as solveSingleJS } from '../src/solver';
import { ensureWasm, solveBatch, resetWasmForTesting, setWasmUnavailableForTesting, getWasmState } from '../src/wasm-solver';

describe('wasm solver', () => {
  beforeAll(async () => {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
    Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: TextEncoder });
    Object.defineProperty(globalThis, 'atob', {
      configurable: true,
      value: (v: string) => Buffer.from(v, 'base64').toString('binary'),
    });
    // Ensure wasm loaded from built dist
    await ensureWasm();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads wasm successfully', () => {
    expect(getWasmState()).toBe('wasm-ready');
  });

  it('solves via WASM batch and matches JS for fixtures', async () => {
    const fixtures: Array<{ challenge: string; difficulty: number; start: number; batch: number }> = [
      { challenge: 'test', difficulty: 1, start: 0, batch: 256 },
      { challenge: 'abc', difficulty: 1, start: 20, batch: 10 },
      { challenge: 'abc', difficulty: 1, start: 26, batch: 1 },
      { challenge: 'unusual!@# $%^&*()_+', difficulty: 2, start: 0, batch: 1024 },
      { challenge: 'a', difficulty: 2, start: 1000, batch: 1024 },
      { challenge: 'test', difficulty: 2, start: 0, batch: 1024 },
      { challenge: 'hello', difficulty: 3, start: 0, batch: 1024 },
      { challenge: 'x', difficulty: 1, start: 0, batch: 1024 },
    ];

    for (const f of fixtures) {
      const prefix = '0'.repeat(f.difficulty);
      // Find JS solution within batch
      let jsSolution: { nonce: string; hash: string } | null = null;
      for (let n = f.start; n < f.start + f.batch; n++) {
        const hash = crypto.createHash('sha256').update(f.challenge + String(n)).digest('hex');
        if (hash.startsWith(prefix)) { jsSolution = { nonce: String(n), hash }; break; }
      }
      const wasmResult = solveBatch(f.challenge, f.start, f.batch, f.difficulty);
      if (jsSolution) {
        expect(wasmResult.found).toBe(true);
        expect(wasmResult.nonce).toBe(jsSolution.nonce);
        expect(wasmResult.hash).toBe(jsSolution.hash);
      } else {
        expect(wasmResult.found).toBe(false);
      }
    }
  });

  it('matches JS solver for deterministic JWT tokens', async () => {
    // Use createChallenge with known difficulty
    const tokens = await createChallenge(1, 3, 60);
    for (const token of tokens) {
      const jsSolution = await solveSingleJS(token);
      expect(jsSolution).toBeTruthy();
      // Decode token to get challenge/difficulty
      const parts = token.split('.');
      const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      const challenge: string = payload.challenge;
      const difficulty: number = payload.difficulty;
      // Solve via WASM batch loop to find first solution
      let start = 0;
      const batch = 1024;
      let wasmSolution: { nonce: string; hash: string } | null = null;
      while (start < 100000) {
        const r = solveBatch(challenge, start, batch, difficulty);
        if (r.found) { wasmSolution = { nonce: r.nonce!, hash: r.hash! }; break; }
        start += batch;
      }
      expect(wasmSolution).not.toBeNull();
      expect(wasmSolution?.nonce).toBe(jsSolution?.nonce);
      expect(wasmSolution?.hash).toBe(jsSolution?.hash);
    }
  });

  it('validates WASM hash invariants', () => {
    const r = solveBatch('test', 0, 1024, 1);
    expect(r.found).toBe(true);
    expect(r.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(r.hash?.startsWith('0')).toBe(true);
    expect(r.nonce).toMatch(/^\d+$/);
  });

  it('returns not-found when batch contains no solution', () => {
    const r = solveBatch('abc', 0, 5, 1); // nonce 26 is solution, 0-4 not
    expect(r.found).toBe(false);
  });

  it('handles solution exactly at batch boundary', () => {
    // nonce 26 is solution for abc diff1, batch 0..9 not, 20..29 contains
    const r1 = solveBatch('abc', 0, 26, 1);
    expect(r1.found).toBe(false); // 0..25 does not include 26
    const r2 = solveBatch('abc', 26, 1, 1);
    expect(r2.found).toBe(true);
    expect(r2.nonce).toBe('26');
    const r3 = solveBatch('abc', 20, 10, 1);
    expect(r3.found).toBe(true);
    expect(r3.nonce).toBe('26');
  });

  it('handles multi-digit nonce decimal encoding', () => {
    // ensure decimal encoding matches JS: challenge "a" with nonce 10 vs 010 etc
    const challenge = 'a';
    // brute JS find for difficulty 1 where nonce is two digits
    let foundAt = -1;
    for (let n = 9; n < 100; n++) {
      const h = crypto.createHash('sha256').update(challenge + String(n)).digest('hex');
      if (h.startsWith('0')) { foundAt = n; break; }
    }
    expect(foundAt).toBeGreaterThan(9);
    const r = solveBatch(challenge, 9, 100, 1);
    expect(r.found).toBe(true);
    expect(Number(r.nonce)).toBe(foundAt);
  });

  it('throws for invalid inputs', () => {
    expect(() => solveBatch('test', 0, 0, 1)).toThrow();
    expect(() => solveBatch('test', -1, 10, 1)).toThrow();
    expect(() => solveBatch('test', 0, 10, 0)).toThrow();
    expect(() => solveBatch('test', 0, 10, 65)).toThrow();
  });

  it('caches initialization and does not retry after failure', async () => {
    resetWasmForTesting();
    setWasmUnavailableForTesting();
    expect(getWasmState()).toBe('wasm-unavailable');
    const ok = await ensureWasm();
    expect(ok).toBe(false);
    expect(getWasmState()).toBe('wasm-unavailable');
    // second call should not try to load again
    const ok2 = await ensureWasm();
    expect(ok2).toBe(false);
    // reset for other tests
    resetWasmForTesting();
    const ok3 = await ensureWasm();
    expect(ok3).toBe(true);
  });
});
