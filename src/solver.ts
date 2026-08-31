/**
 * Browser-compatible challenge solver using Web Crypto API
 */

export interface ChallengeSolution {
  nonce: string;
  hash: string;
}

export interface BrowserCalibration {
  iterations: number;
  durationMs: number;
}

export type PowAlgorithm = 'sha256' | 'argon2id';

export interface ChallengePayload {
  challenge: string;
  difficulty: number;
  expires: number;
  alg?: PowAlgorithm;
  m?: number;
  t?: number;
  p?: number;
  hashLen?: number;
}

/**
 * Decode JWT token (browser-compatible, without verification)
 */
function decodeJWT(token: string): ChallengePayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;

    const normalizedPayload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const paddedPayload = normalizedPayload.padEnd(
      normalizedPayload.length + ((4 - (normalizedPayload.length % 4)) % 4),
      '='
    );

    const payload = JSON.parse(atob(paddedPayload));
    return payload as ChallengePayload;
  } catch {
    return null;
  }
}

/**
 * SHA-256 hash using Web Crypto API
 */
async function sha256(message: string): Promise<string> {
  if (typeof TextEncoder === 'undefined') {
    throw new Error('TextEncoder is unavailable in this browser environment');
  }

  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto API is unavailable. Use HTTPS or localhost.');
  }

  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

// Argon2id support (isomorphic via hash-wasm) — same params as server HARD_MAX
const HARD_MAX = { m: 32 * 1024, t: 3, p: 1, hashLen: 32 } as const;
const ARGON_PROFILES = {
  mobile: { m: 8 * 1024, t: 1, p: 1, hashLen: 32 },
  standard: { m: 8 * 1024, t: 1, p: 1, hashLen: 32 },
} as const;

type Argon2idFn = (opts: { password: string; salt: string; parallelism: number; iterations: number; memorySize: number; hashLength: number; outputType: 'hex' }) => Promise<string>;
let cachedArgon2id: Argon2idFn | null = null;
let argon2idPromise: Promise<Argon2idFn> | null = null;

async function getArgon2id(): Promise<Argon2idFn> {
  if (cachedArgon2id) return cachedArgon2id;
  if (argon2idPromise) return argon2idPromise;
  argon2idPromise = (async () => {
    let lastError: unknown;
    const isBrowser = typeof window !== 'undefined' || typeof self !== 'undefined';
    // 1) bare specifier — works when bundled (vite/next) or Node (node_modules)
    // 2) relative URLs — work when served statically (demo server, no bundler, worker)
    // 3) CDN — last resort for file:// demos
    const candidates: string[] = ['hash-wasm'];
    if (isBrowser) {
      try {
        const base = (import.meta as unknown as { url: string }).url as string;
        candidates.push(new URL('./hash-wasm.js', base).toString());
        candidates.push(new URL('../demo/lib/hash-wasm.js', base).toString());
      } catch (_e) { void _e; }
      try {
        const origin = (globalThis as unknown as { location?: { origin?: string } }).location?.origin;
        if (origin) candidates.push(new URL('/lib/hash-wasm.js', origin).toString());
      } catch (_e) { void _e; }
      candidates.push('https://esm.sh/hash-wasm@4.12.0', 'https://cdn.jsdelivr.net/npm/hash-wasm@4.12.0/dist/index.esm.js');
    }
    for (const spec of candidates) {
      try {
        const mod: unknown = await import(spec);
        const pkg = (mod as { default?: unknown }).default ?? mod;
        const fn = (pkg as { argon2id?: Argon2idFn }).argon2id;
        if (typeof fn === 'function') {
          cachedArgon2id = fn;
          return fn;
        }
        lastError = new Error(`hash-wasm at ${spec} has no argon2id`);
      } catch (e) {
        lastError = e;
      }
    }
    throw new Error(`hash-wasm argon2id not available: ${String((lastError as Error)?.message || lastError)}`);
  })();
  return argon2idPromise;
}

function padSalt(challenge: string): string {
  if (challenge.length >= 16) return challenge.slice(0, 16);
  return challenge.padEnd(16, '0');
}

function resolveArgonParams(payload: ChallengePayload): { m: number; t: number; p: number; hashLen: number } {
  if (payload.m !== undefined) {
    // Token carries explicit params — validate against HARD_MAX
    const m = payload.m;
    const t = payload.t ?? 1;
    const p = payload.p ?? 1;
    const hashLen = payload.hashLen ?? 32;
    if (m < 8 || m > HARD_MAX.m || t < 1 || t > HARD_MAX.t || p < 1 || p > HARD_MAX.p || hashLen !== 32) {
      throw new Error('Invalid argon2id token params');
    }
    return { m, t, p, hashLen };
  }
  // Legacy fallback — should not happen for argon tokens but use mobile
  return ARGON_PROFILES.mobile;
}

async function argon2idHash(challenge: string, nonce: number | string, payload: ChallengePayload): Promise<string> {
  const argon2id = await getArgon2id();
  const params = resolveArgonParams(payload);
  const salt = padSalt(challenge);
  const password = `${challenge}${String(nonce)}`;
  return argon2id({
    password,
    salt,
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m,
    hashLength: params.hashLen,
    outputType: 'hex',
  });
}

/**
 * Yield to the event loop without the ~4ms clamping browsers apply to
 * nested setTimeout calls. MessageChannel tasks run as macrotasks with
 * microsecond-level latency, keeping the UI responsive at a fraction of
 * the timer overhead.
 *
 * The channel is created lazily on first yield, and the receiving port is
 * unref'd where supported (Node.js): a port with an active message listener
 * otherwise keeps the host event loop alive and prevents clean exit.
 */
const yieldToEventLoop: () => Promise<void> = (() => {
  if (typeof MessageChannel !== 'function') {
    return () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  let channel: MessageChannel | null = null;
  const waiting = new Set<() => void>();

  return () => {
    if (!channel) {
      channel = new MessageChannel();
      channel.port1.onmessage = () => {
        for (const resolve of waiting) resolve();
        waiting.clear();
      };
      (channel.port1 as MessagePort & { unref?: () => void }).unref?.();
    }
    return new Promise<void>((resolve) => {
      waiting.add(resolve);
      channel!.port2.postMessage(null);
    });
  };
})();

export async function calibrateBrowser(iterations = 128): Promise<BrowserCalibration> {
  if (!Number.isFinite(iterations) || iterations < 1) {
    throw new Error('Calibration iterations must be at least 1');
  }

  const normalizedIterations = Math.floor(iterations);
  const startedAt = performance.now();
  for (let index = 0; index < normalizedIterations; index++) {
    await sha256(`ribaunt-calibration:${index}`);
  }

  return {
    iterations: normalizedIterations,
    durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
  };
}

export const calibrateClient = calibrateBrowser;

let calibrateArgonWarmup: Promise<void> | null = null;
async function ensureArgonWarmup(): Promise<void> {
  if (calibrateArgonWarmup) return calibrateArgonWarmup;
  calibrateArgonWarmup = (async () => {
    try {
      const argon = await getArgon2id();
      await argon({
        password: 'ribaunt-warmup',
        salt: 'ribaunt-warmup-16b',
        parallelism: 1,
        iterations: 1,
        memorySize: 8 * 1024,
        hashLength: 32,
        outputType: 'hex',
      });
    } catch {
      // best-effort
    }
  })();
  return calibrateArgonWarmup;
}

export async function calibrateArgonBrowser(iterations = 16): Promise<BrowserCalibration> {
  if (!Number.isFinite(iterations) || iterations < 1) {
    throw new Error('Calibration iterations must be at least 1');
  }
  const normalizedIterations = Math.floor(iterations);
  await ensureArgonWarmup();
  const payload: ChallengePayload = { challenge: 'ribaunt-calibration', difficulty: 1, expires: 0, alg: 'argon2id', ...ARGON_PROFILES.mobile };
  const startedAt = performance.now();
  for (let index = 0; index < normalizedIterations; index++) {
    await argon2idHash(`ribaunt-calibration:${index}`, '0', payload);
  }
  return {
    iterations: normalizedIterations,
    durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
  };
}

export const calibrateArgonClient = calibrateArgonBrowser;

// Test hook
export function __resetArgonForTesting(): void {
  cachedArgon2id = null;
  argon2idPromise = null;
  calibrateArgonWarmup = null;
}

export function decodeChallengeToken(token: string): ChallengePayload | null {
  return decodeJWT(token);
}

/**
 * Solve a single challenge token (browser-compatible) — auto-detects sha256 vs argon2id via payload.alg.
 * For argon2id the heavy WASM hash is not internally abortable; cancellation is observed between candidates
 * with a setTimeout(0) yield (mirrors bench/memory-hard-server.ts:198) and worker.terminate fallback after 250ms.
 */
export async function solveSingleChallenge(
  token: string,
  signal?: AbortSignal
): Promise<ChallengeSolution | undefined> {
  const payload = decodeJWT(token);
  if (!payload) return undefined;

  const { challenge, difficulty } = payload;
  const alg = (payload as ChallengePayload).alg ?? 'sha256';
  const prefix = '0'.repeat(difficulty);

  if (alg === 'argon2id') {
    let nonce = 0;
    while (true) {
      if (signal?.aborted) {
        throw new DOMException('Challenge solving aborted', 'AbortError');
      }
      const hash = await argon2idHash(challenge, nonce, payload as ChallengePayload);
      if (hash.startsWith(prefix)) {
        return { nonce: String(nonce), hash };
      }
      nonce++;
      // Yield per candidate — argon hash already blocks ~6ms (mobile) to ~63ms (high), so per-iteration yield is cheap
      // and guarantees abort visibility before the next heavy alloc.
      await new Promise<void>(r => setTimeout(r, 0));
      if (signal?.aborted) {
        throw new DOMException('Challenge solving aborted', 'AbortError');
      }
      // Extra UI yield every 2048 for parity with SHA path when needed
      if (nonce % 2048 === 0) {
        await yieldToEventLoop();
      }
    }
  }

  let nonce = 0;
  while (true) {
    if (signal?.aborted) {
      throw new DOMException('Challenge solving aborted', 'AbortError');
    }

    const hash = await sha256(`${challenge}${nonce}`);

    if (hash.startsWith(prefix)) {
      return { nonce: String(nonce), hash };
    }

    nonce++;

    // Yield to keep the UI responsive; each batch amortizes the yield cost.
    if (nonce % 2048 === 0) {
      await yieldToEventLoop();
    }
  }
}

/**
 * Solve multiple challenge tokens (browser-compatible)
 */
export async function solveChallenge(
  tokens: string[],
  onProgress?: (progress: number) => void,
  signal?: AbortSignal
): Promise<ChallengeSolution[]> {
  const solutions: ChallengeSolution[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) {
      throw new Error(`Invalid token at index ${i}`);
    }
    
    const solution = await solveSingleChallenge(token, signal);
    if (!solution) {
      throw new Error(`Failed to solve challenge ${i + 1}`);
    }

    solutions.push(solution);

    // Report progress
    if (onProgress) {
      const progress = Math.round(((i + 1) / tokens.length) * 100);
      onProgress(progress);
    }
  }

  return solutions;
}
