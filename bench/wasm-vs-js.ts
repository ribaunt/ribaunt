/**
 * Benchmark: WASM vs JS solver throughput
 * Run: pnpm run build && node --input-type=module bench/wasm-vs-js.ts
 * This file is not part of the deterministic test suite.
 */
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import crypto from 'node:crypto';

// Polyfill for Node environment
// @ts-ignore
globalThis.crypto = webcrypto as unknown as Crypto;
// @ts-ignore
globalThis.TextEncoder = TextEncoder;
// @ts-ignore
globalThis.atob = (v: string) => Buffer.from(v, 'base64').toString('binary');

import { solveSingleChallenge as solveSingleJS } from '../src/solver.js';
import { ensureWasm, solveBatch } from '../src/wasm-solver.js';
import { createChallenge } from '../src/index.js';

async function benchOne(challenge: string, difficulty: number, batchSize: number): Promise<void> {
  const prefix = '0'.repeat(difficulty);
  // JS baseline: measure attempts/second via crypto loop (via solver's sha256 is WebCrypto, but we use node crypto for fair)
  const startJS = performance.now();
  let attemptsJS = 0;
  let foundJS: { nonce: string; hash: string } | null = null;
  for (let n = 0; n < 50000; n++) {
    const hash = crypto.createHash('sha256').update(challenge + String(n)).digest('hex');
    attemptsJS++;
    if (hash.startsWith(prefix)) { foundJS = { nonce: String(n), hash }; break; }
  }
  const jsMs = performance.now() - startJS;
  console.log(`JS: challenge=${challenge.slice(0,8)} diff=${difficulty} attempts=${attemptsJS} time=${jsMs.toFixed(2)}ms rate=${(attemptsJS / (jsMs/1000)).toFixed(0)} /s found=${Boolean(foundJS)}`);

  await ensureWasm();
  const startWasm = performance.now();
  let attemptsWasm = 0;
  let foundWasm: { nonce: string; hash: string } | null = null;
  let startNonce = 0;
  while (startNonce < 50000) {
    const batch = Math.min(batchSize, 50000 - startNonce);
    const r = solveBatch(challenge, startNonce, batch, difficulty);
    attemptsWasm += batch;
    if (r.found) { foundWasm = { nonce: r.nonce!, hash: r.hash! }; break; }
    startNonce += batch;
  }
  const wasmMs = performance.now() - startWasm;
  console.log(`WASM batch=${batchSize}: attempts=${attemptsWasm} time=${wasmMs.toFixed(2)}ms rate=${(attemptsWasm/(wasmMs/1000)).toFixed(0)} /s speedup=${(jsMs/wasmMs).toFixed(2)}x found=${Boolean(foundWasm)}`);
  console.log(`Match: ${foundJS?.nonce === foundWasm?.nonce && foundJS?.hash === foundWasm?.hash}`);
}

async function main(): Promise<void> {
  console.log('Benchmarking WASM vs JS (hardware-dependent, no CI assertion)');
  const batchCandidates = [256, 512, 1024, 2048, 4096, 8192];
  const difficulties = [2, 3, 4];
  const challenge = 'benchtest123';

  for (const diff of difficulties) {
    console.log(`\n=== Difficulty ${diff} ===`);
    for (const batch of batchCandidates) {
      await benchOne(challenge, diff, batch);
    }
  }

  // Also benchmark via actual solveSingleChallenge vs wasm loop for JWT tokens
  console.log('\n=== JWT token benchmark ===');
  process.env.RIBAUNT_SECRET ??= 'bench-secret-with-enough-entropy-32bytes!!';
  const [token] = await createChallenge(3, 1, 60);
  const t0 = performance.now();
  const jsSol = await solveSingleJS(token);
  const tJS = performance.now() - t0;
  console.log(`JS solveSingleChallenge: ${tJS.toFixed(2)}ms nonce=${jsSol?.nonce}`);

  // WASM via batch loop (decode token first)
  const payload = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8'));
  await ensureWasm();
  const t1 = performance.now();
  let start=0;
  const batch=1024;
  let wasmSol: { nonce: string; hash: string }|null=null;
  while (start < 200000) {
    const r = solveBatch(payload.challenge, start, batch, payload.difficulty);
    if (r.found) { wasmSol={nonce:r.nonce!,hash:r.hash!}; break; }
    start+=batch;
  }
  const tWasm = performance.now() - t1;
  console.log(`WASM batch loop: ${tWasm.toFixed(2)}ms nonce=${wasmSol?.nonce} speedup=${(tJS/tWasm).toFixed(2)}x`);
}

main().catch(e => { console.error(e); process.exit(1); });
