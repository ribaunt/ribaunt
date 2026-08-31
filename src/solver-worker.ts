/// <reference lib="webworker" />

import { solveChallenge, decodeChallengeToken, type ChallengeSolution } from './solver.js';
import { ensureWasm, solveBatch, resetWasmHeap } from './wasm-solver.js';
import type { WasmMode } from './wasm-solver.js';

type WorkerRequest =
  | { type: 'solve'; id: string; tokens: string[]; wasmMode?: WasmMode }
  | { type: 'cancel'; id: string };

type WorkerResponse =
  | { type: 'progress'; id: string; progress: number }
  | { type: 'result'; id: string; solutions: ChallengeSolution[] }
  | { type: 'error'; id: string; error: string }
  | { type: 'cancelled'; id: string }
  | { type: 'backend'; id: string; backend: 'wasm' | 'js' | 'argon2id' };

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const activeControllers = new Map<string, AbortController>();

// Cache WASM initialization per worker lifetime (wasm-solver already caches, but keep explicit)
let wasmBackendState: 'uninitialized' | 'wasm-ready' | 'wasm-unavailable' = 'uninitialized';

const WASM_BATCH_SIZE = 1024;

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
      (channel.port1 as unknown as { unref?: () => void }).unref?.();
    }
    return new Promise<void>((resolve) => {
      waiting.add(resolve);
      channel!.port2.postMessage(null);
    });
  };
})();

async function solveSingleChallengeWasm(
  token: string,
  signal?: AbortSignal
): Promise<ChallengeSolution | undefined> {
  const payload = decodeChallengeToken(token);
  if (!payload) return undefined;

  const { challenge, difficulty } = payload;
  let startNonce = 0;

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException('Challenge solving aborted', 'AbortError');
      }

      const result = solveBatch(challenge, startNonce, WASM_BATCH_SIZE, difficulty);

      if (result.found && result.nonce && result.hash) {
        // Validate before returning (wasm-solver already validated, but double-check)
        if (typeof result.nonce !== 'string' || typeof result.hash !== 'string') {
          throw new Error('Invalid WASM result shape');
        }
        return { nonce: result.nonce, hash: result.hash };
      }

      startNonce += WASM_BATCH_SIZE;

      // Overflow guard - do not wrap; allow final batch where last nonce is 0x7fffffff
      if (startNonce > 0x7fffffff - WASM_BATCH_SIZE + 1) {
        throw new Error('WASM solver nonce overflow');
      }

      // Yield every 2048 nonces to keep worker responsive (matches JS solver's 2048)
      if (startNonce % 2048 === 0) {
        await yieldToEventLoop();
      }
    }
  } finally {
    // Reset heap to avoid leak between tokens/requests
    try {
      resetWasmHeap();
    } catch {
      // ignore
    }
  }
}

async function solveChallengeWasm(
  tokens: string[],
  onProgress?: (progress: number) => void,
  signal?: AbortSignal
): Promise<ChallengeSolution[]> {
  const solutions: ChallengeSolution[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) throw new Error(`Invalid token at index ${i}`);
    if (signal?.aborted) throw new DOMException('Challenge solving aborted', 'AbortError');
    const solution = await solveSingleChallengeWasm(token, signal);
    if (!solution) throw new Error(`Failed to solve challenge ${i + 1}`);
    solutions.push(solution);
    if (onProgress) {
      const progress = Math.round(((i + 1) / tokens.length) * 100);
      onProgress(progress);
    }
  }
  return solutions;
}

async function selectBackend(wasmMode: WasmMode | undefined, isArgon: boolean): Promise<'wasm' | 'js' | 'argon2id'> {
  if (isArgon) return 'argon2id';
  if (wasmMode === 'disabled') return 'js';
  // preferred (default)
  if (wasmBackendState === 'wasm-unavailable') return 'js';
  if (wasmBackendState === 'wasm-ready') return 'wasm';

  // uninitialized -> try to init
  try {
    const ok = await ensureWasm();
    wasmBackendState = ok ? 'wasm-ready' : 'wasm-unavailable';
    return ok ? 'wasm' : 'js';
  } catch {
    wasmBackendState = 'wasm-unavailable';
    return 'js';
  }
}

function isArgonBatch(tokens: string[]): boolean {
  // Peek first token — batches are homogeneous (single createChallenge call)
  try {
    const p = decodeChallengeToken(tokens[0] ?? '');
    return (p as unknown as { alg?: string })?.alg === 'argon2id';
  } catch {
    return false;
  }
}

workerScope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (!request) return;

  if (request.type === 'cancel') {
    const controller = activeControllers.get(request.id);
    if (controller) {
      controller.abort();
      activeControllers.delete(request.id);
      workerScope.postMessage({ type: 'cancelled', id: request.id } satisfies WorkerResponse);
      workerScope.close();
    }
    return;
  }

  if (request.type !== 'solve') return;

  const controller = new AbortController();
  activeControllers.set(request.id, controller);

  const wasmMode: WasmMode = request.wasmMode === 'disabled' ? 'disabled' : 'preferred';

  (async () => {
    const isArgon = isArgonBatch(request.tokens);
    const backend = await selectBackend(wasmMode, isArgon);

    // Telemetry: report backend selection once per request
    if (!controller.signal.aborted) {
      try {
        workerScope.postMessage({ type: 'backend', id: request.id, backend } satisfies WorkerResponse);
      } catch {
        // telemetry must never break solving
      }
    }

    // For argon2id, solveChallenge already dispatches via hash-wasm and is the optimal path (WASM bundled as base64, not fetch)
    // For sha256, wasm batch path is preferred when available
    const solver = backend === 'wasm' ? solveChallengeWasm : solveChallenge;

    // For wasm-unavailable fallback, re-select if wasm fails during solve? We already selected js
    // But if backend is wasm and solve fails with internal error, we surface not fallback

    return solver(
      request.tokens,
      (progress) => {
        if (!controller.signal.aborted) {
          workerScope.postMessage({
            type: 'progress',
            id: request.id,
            progress,
          } satisfies WorkerResponse);
        }
      },
      controller.signal
    );
  })().then(
    (solutions) => {
      activeControllers.delete(request.id);
      if (controller.signal.aborted) return;
      workerScope.postMessage({
        type: 'result',
        id: request.id,
        solutions,
      } satisfies WorkerResponse);
    },
    (error: unknown) => {
      activeControllers.delete(request.id);
      if (controller.signal.aborted) return;
      // If WASM was selected and failed due to unexpected runtime error, surface as error
      // For expected initialization failures we already fell back to JS, so this error is genuine
      workerScope.postMessage({
        type: 'error',
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies WorkerResponse);
    }
  );
});

export {};
