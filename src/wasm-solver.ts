/**
 * TypeScript adapter for the WASM SHA-256 solver.
 * Contains all WASM-specific implementation details and validates boundary values.
 */

export type WasmMode = 'preferred' | 'disabled';

export interface WasmBatchResult {
  found: boolean;
  nonce?: string;
  hash?: string;
}

interface WasmExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  alloc(size: number): number;
  solve_batch(challenge_ptr: number, challenge_len: number, start_nonce: number, batch_size: number, difficulty: number): number;
  get_hash_ptr(): number;
  get_hash_len(): number;
  get_msg_ptr(): number;
  reset_heap(): void;
}

let wasmInstance: WebAssembly.Instance | null = null;
let wasmState: 'uninitialized' | 'wasm-ready' | 'wasm-unavailable' = 'uninitialized';
let loadPromise: Promise<boolean> | null = null;
let cachedChallenge: string | null = null;
let cachedPtr = 0;
let cachedLen = 0;

// Internal WASM solver interface (narrow)
export interface WasmSolver {
  solveBatch(challenge: string, startNonce: number, batchSize: number, difficulty: number): WasmBatchResult;
}

const VALID_HASH_RE = /^[a-f0-9]{64}$/;
const VALID_NONCE_RE = /^\d+$/;
const VALID_SHA256_HEX_RE = /^[a-f0-9]{64}$/i;
// Embedded SHA-256 of dist/ribaunt-solver.wasm for integrity verification.
// Recompute with `shasum -a 256 dist/ribaunt-solver.wasm` after rebuilding wasm.
const EMBEDDED_WASM_SHA256 = '774398452596d67491a6ee5bd6291c9665dc4fc1a83db15f14dbbb4058f74c3e';

function isValidHash(hash: string): boolean {
  return VALID_HASH_RE.test(hash);
}

function isValidNonce(nonce: string): boolean {
  return nonce.length > 0 && VALID_NONCE_RE.test(nonce);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = typeof crypto !== 'undefined' ? (crypto as unknown as { subtle?: SubtleCrypto }).subtle : undefined;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes as unknown as BufferSource);
    return bytesToHex(new Uint8Array(digest));
  }
  // Node fallback when Web Crypto is unavailable
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeCrypto = await import('node:crypto') as any;
  return nodeCrypto.createHash('sha256').update(bytes).digest('hex') as string;
}

function getExpectedWasmSha256(): string | null {
  const g = globalThis as unknown as { __RIBAUNT_WASM_SHA256__?: string };
  const fromGlobal = typeof g.__RIBAUNT_WASM_SHA256__ === 'string' ? g.__RIBAUNT_WASM_SHA256__.trim().toLowerCase() : '';
  if (fromGlobal && VALID_SHA256_HEX_RE.test(fromGlobal)) return fromGlobal;
  const proc = typeof process !== 'undefined' ? (process as unknown as { env?: Record<string, string | undefined> }) : undefined;
  const fromEnv = proc?.env?.RIBAUNT_WASM_SHA256?.trim().toLowerCase() ?? '';
  if (fromEnv && VALID_SHA256_HEX_RE.test(fromEnv)) return fromEnv;
  if (EMBEDDED_WASM_SHA256 && VALID_SHA256_HEX_RE.test(EMBEDDED_WASM_SHA256)) return EMBEDDED_WASM_SHA256.toLowerCase();
  return null;
}

async function loadWasmBytes(): Promise<Uint8Array> {
  const candidates: URL[] = [];
  try {
    candidates.push(new URL('./ribaunt-solver.wasm', import.meta.url));
  } catch (_e) { void _e; }
  try {
    candidates.push(new URL('../dist/ribaunt-solver.wasm', import.meta.url));
  } catch (_e) { void _e; }
  try {
    candidates.push(new URL('./dist/ribaunt-solver.wasm', import.meta.url));
  } catch (_e) { void _e; }

  // Browser / worker path: try fetch for each candidate (only http/https and valid wasm)
  if (typeof fetch === 'function') {
    for (const cand of candidates) {
      try {
        const url = cand instanceof URL ? cand : new URL(String(cand));
        if (url.protocol === 'file:') continue;
        const res = await fetch(cand);
        if (res.ok) {
          const buf = await res.arrayBuffer();
          if (buf.byteLength > 0) {
            const u8 = new Uint8Array(buf);
            if (u8.length >= 4 && u8[0] === 0x00 && u8[1] === 0x61 && u8[2] === 0x73 && u8[3] === 0x6d) {
              return u8;
            }
          }
        }
      } catch (_e) { void _e; }
    }
  }

  // Node.js fallback: try fs for candidates plus cwd
  const fsCandidates: (string | URL)[] = [...candidates];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pathMod = await import('node:path') as any;
    const cwd = typeof process !== 'undefined' ? process.cwd() : '';
    if (cwd) {
      fsCandidates.push(pathMod.resolve(cwd, 'dist/ribaunt-solver.wasm'));
      fsCandidates.push(pathMod.resolve(cwd, 'dist/cjs/ribaunt-solver.wasm'));
    }
  } catch (_e) { void _e; }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fs = await import('node:fs/promises') as any;
    for (const cand of fsCandidates) {
      try {
        const bytes = await fs.readFile(cand as string);
        if (bytes && (bytes as Uint8Array).length > 0) return bytes as Uint8Array;
      } catch (_e) { void _e; }
    }
  } catch (_e) { void _e; }

  throw new Error('WASM asset fetch failure');
}

async function instantiateWasm(): Promise<boolean> {
  if (typeof WebAssembly === 'undefined') return false;

  try {
    const bytes = await loadWasmBytes();
    const expectedSha256 = getExpectedWasmSha256();
    if (!expectedSha256) return false;
    const actualSha256 = await sha256Hex(bytes);
    if (actualSha256 !== expectedSha256) return false;
    const mod = await WebAssembly.compile(bytes as unknown as BufferSource);
    const instance = await WebAssembly.instantiate(mod, {});
    const exp = instance.exports as Partial<WasmExports>;

    if (!exp.memory || typeof exp.solve_batch !== 'function' || typeof exp.get_hash_ptr !== 'function' || typeof exp.alloc !== 'function') {
      return false;
    }

    wasmInstance = instance;
    wasmState = 'wasm-ready';
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures the WASM solver module is loaded and ready for use.
 * Loads, verifies integrity, and compiles the solver on first call.
 * Subsequent calls return cached state.
 *
 * @returns true if WASM is ready, false if unavailable
 */
export async function ensureWasm(): Promise<boolean> {
  if (wasmState === 'wasm-ready') return true;
  if (wasmState === 'wasm-unavailable') return false;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const ok = await instantiateWasm();
    wasmState = ok ? 'wasm-ready' : 'wasm-unavailable';
    return ok;
  })();

  return loadPromise;
}

/**
 * Returns the current WASM module state.
 */
export function getWasmState(): typeof wasmState {
  return wasmState;
}

/**
 * Resets WASM state for testing purposes.
 * Should not be called in production code.
 */
export function resetWasmForTesting(): void {
  wasmInstance = null;
  wasmState = 'uninitialized';
  loadPromise = null;
  cachedChallenge = null;
  cachedPtr = 0;
  cachedLen = 0;
}

/**
 * Marks WASM as unavailable for testing fallback behavior.
 * Should not be called in production code.
 */
export function setWasmUnavailableForTesting(): void {
  wasmState = 'wasm-unavailable';
  wasmInstance = null;
  loadPromise = Promise.resolve(false);
}

/**
 * Checks if the WASM solver is currently loaded and ready.
 */
export function isWasmAvailable(): boolean {
  return wasmState === 'wasm-ready';
}

/**
 * Clears the WASM memory heap and cached challenge data.
 * Called between tokens to prevent memory leaks.
 */
export function resetWasmHeap(): void {
  cachedChallenge = null;
  cachedPtr = 0;
  cachedLen = 0;
  if (wasmInstance) {
    try {
      const exp = wasmInstance.exports as unknown as { reset_heap?: () => void };
      exp.reset_heap?.();
    } catch {
      // ignore
    }
  }
}

/**
 * Synchronous batch solver - must be called after ensureWasm() succeeds.
 * Encodes challenge as UTF-8, allocates in WASM memory, calls solve_batch,
 * validates and returns result.
 */
export function solveBatch(
  challenge: string,
  startNonce: number,
  batchSize: number,
  difficulty: number
): WasmBatchResult {
  if (wasmState !== 'wasm-ready' || !wasmInstance) {
    throw new Error('WASM solver not initialized');
  }

  // Validate inputs
  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 64) {
    throw new Error('Invalid difficulty');
  }
  if (!Number.isInteger(batchSize) || batchSize <= 0 || batchSize > 16384) {
    throw new Error('Invalid batchSize');
  }
  if (!Number.isInteger(startNonce) || startNonce < 0 || !Number.isFinite(startNonce)) {
    throw new Error('Invalid startNonce');
  }
  if (typeof challenge !== 'string') {
    throw new Error('Invalid challenge');
  }
  // Overflow guard before calling WASM (also checked inside)
  if (startNonce > 0xffffffff - batchSize + 1) {
    throw new Error('Nonce range exceeds u32');
  }
  // Also guard signed limit to avoid sentinel confusion (max 2^31-1 for v1); allow final batch where last nonce is 0x7fffffff
  if (startNonce > 0x7fffffff || startNonce + batchSize > 0x7fffffff + 1) {
    throw new Error('Nonce exceeds wasm signed limit');
  }

  const exp = wasmInstance.exports as unknown as WasmExports;
  const mem = exp.memory;

  let ptr: number;
  let challengeLen: number;
  if (cachedChallenge === challenge && cachedPtr !== 0) {
    ptr = cachedPtr;
    challengeLen = cachedLen;
  } else {
    // Encode challenge as UTF-8 bytes
    const encoder = new TextEncoder();
    const challengeBytes = encoder.encode(challenge);
    if (challengeBytes.length > 1014) {
      throw new Error('Challenge too long for WASM solver');
    }
    const newPtr = exp.alloc(challengeBytes.length);
    // Refresh view after possible growth
    const memU8 = new Uint8Array(mem.buffer);
    // Bounds check: ensure ptr + len within memory
    if (newPtr < 0 || newPtr + challengeBytes.length > memU8.length) {
      throw new Error('WASM memory allocation out of bounds');
    }
    memU8.set(challengeBytes, newPtr);
    cachedChallenge = challenge;
    cachedPtr = newPtr;
    cachedLen = challengeBytes.length;
    ptr = newPtr;
    challengeLen = cachedLen;
  }

  let result: number;
  try {
    result = exp.solve_batch(ptr, challengeLen, startNonce >>> 0, batchSize, difficulty);
  } catch (e) {
    throw new Error(`WASM solver trap: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }

  if (result === -1) {
    return { found: false };
  }
  if (result === -2) {
    throw new Error('WASM solver overflow');
  }
  if (result < 0) {
    throw new Error(`WASM solver internal error: ${result}`);
  }

  // Validate nonce
  const nonceStr = String(result >>> 0);
  if (!isValidNonce(nonceStr)) {
    throw new Error('WASM returned invalid nonce');
  }

  // Read hash
  const hashPtr = exp.get_hash_ptr();
  const hashLen = 32;
  const mem2 = new Uint8Array(mem.buffer);
  if (hashPtr < 0 || hashPtr + hashLen > mem2.length) {
    throw new Error('WASM hash pointer out of bounds');
  }
  const hashBytes = mem2.slice(hashPtr, hashPtr + hashLen);
  const hashHex = Array.from(hashBytes).map(b => b.toString(16).padStart(2, '0')).join('');

  if (!isValidHash(hashHex)) {
    throw new Error('WASM returned invalid hash');
  }
  if (!hashHex.startsWith('0'.repeat(difficulty))) {
    throw new Error('WASM returned hash that does not satisfy difficulty');
  }

  // Additional validation: ensure hash corresponds to challenge+nonce (defense in depth)
  // We trust WASM but validate shape; deeper verification (re-hashing in JS) could be done
  // but would duplicate work. We just validate invariants.

  return { found: true, nonce: nonceStr, hash: hashHex };
}

/**
 * Checks if TextEncoder is available in the current environment.
 * Used by worker to determine if UTF-8 encoding is supported.
 */
export function isTextEncoderAvailable(): boolean {
  return typeof TextEncoder !== 'undefined';
}
