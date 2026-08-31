import {
  solveChallenge,
  type ChallengeSolution,
} from './solver.js';

export type WorkerMode = 'preferred' | 'required' | 'disabled';
export type WasmMode = 'preferred' | 'disabled';
export type PowAlgorithm = 'sha256' | 'argon2id';
export type SolverBackend = 'wasm' | 'js' | 'argon2id';
export type SolverBackendEvent = { type: 'solver-backend'; backend: SolverBackend };

export class WorkerUnavailableError extends Error {
  readonly code = 'worker-unavailable';

  constructor(message = 'Web Worker solving is unavailable') {
    super(message);
    this.name = 'WorkerUnavailableError';
  }
}

interface WorkerMessage {
  type: 'progress' | 'result' | 'error' | 'cancelled' | 'backend';
  id: string;
  progress?: number;
  solutions?: ChallengeSolution[];
  error?: string;
  backend?: SolverBackend;
}

interface WorkerRequest {
  type: 'solve' | 'cancel';
  id: string;
  tokens?: string[];
  wasmMode?: WasmMode;
}

function abortError(): DOMException {
  return new DOMException('Challenge solving aborted', 'AbortError');
}

const CANCEL_GRACE_MS = 250;

function solveInWorker(
  tokens: string[],
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
  wasmMode: WasmMode = 'preferred',
  onBackend?: (backend: SolverBackend) => void
): Promise<ChallengeSolution[]> {
  return new Promise((resolve, reject) => {
    if (typeof Worker === 'undefined') {
      reject(new WorkerUnavailableError());
      return;
    }

    let worker: Worker;
    try {
      worker = new Worker(new URL('./solver-worker.js', import.meta.url), { type: 'module' });
    } catch (error) {
      reject(new WorkerUnavailableError(error instanceof Error ? error.message : String(error)));
      return;
    }

    const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const release = () => {
      if (cancelTimer !== undefined) clearTimeout(cancelTimer);
      cancelTimer = undefined;
      signal?.removeEventListener('abort', handleAbort);
    };
    const finish = () => {
      release();
      worker.terminate();
    };
    const handleAbort = () => {
      if (cancelled) return;
      cancelled = true;
      worker.postMessage({ type: 'cancel', id } satisfies WorkerRequest);
      cancelTimer = setTimeout(() => {
        finish();
        reject(abortError());
      }, CANCEL_GRACE_MS);
    };

    worker.addEventListener('message', (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (!message || message.id !== id) return;
      if (message.type === 'cancelled') {
        release();
        reject(abortError());
        return;
      }
      if (message.type === 'backend' && message.backend) {
        if (cancelled) return;
        try {
          onBackend?.(message.backend);
        } catch {
          // telemetry must never break solving
        }
        return;
      }
      if (cancelled) return;
      if (message.type === 'progress' && message.progress !== undefined) {
        onProgress?.(message.progress);
      } else if (message.type === 'result' && message.solutions) {
        finish();
        resolve(message.solutions);
      } else if (message.type === 'error') {
        finish();
        reject(new Error(message.error ?? 'Worker solving failed'));
      }
    });
    worker.addEventListener('error', () => {
      finish();
      reject(new WorkerUnavailableError('The solver worker failed to load'));
    }, { once: true });

    if (signal?.aborted) {
      finish();
      reject(abortError());
      return;
    }

    signal?.addEventListener('abort', handleAbort, { once: true });
    worker.postMessage({ type: 'solve', id, tokens, wasmMode } satisfies WorkerRequest);
  });
}

export async function solveChallengeWithWorker(
  tokens: string[],
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
  mode: WorkerMode = 'preferred',
  wasmMode: WasmMode = 'preferred',
  onBackend?: (backend: SolverBackend) => void
): Promise<ChallengeSolution[]> {
  // Backwards compat: if wasmMode is an options object, normalize
  // Also support legacy 4-arg calls where 5th arg is wasmMode string
  let normalizedWasmMode: WasmMode = wasmMode;
  let normalizedOnBackend = onBackend;
  // If 5th arg looks like object with wasmMode property, handle (future proof)
  if (typeof wasmMode === 'object' && wasmMode !== null && 'wasmMode' in wasmMode) {
    const opts = wasmMode as unknown as { wasmMode?: WasmMode; onBackend?: (b: SolverBackend)=>void };
    normalizedWasmMode = opts.wasmMode ?? 'preferred';
    normalizedOnBackend = opts.onBackend as typeof onBackend;
  }
  if (normalizedWasmMode !== 'preferred' && normalizedWasmMode !== 'disabled') {
    normalizedWasmMode = 'preferred';
  }

  if (mode === 'disabled') {
    // Even when worker disabled, we still solve on main thread via JS (no wasm on main thread for v1)
    // Telemetry for main thread fallback is not needed
    return solveChallenge(tokens, onProgress, signal);
  }

  try {
    return await solveInWorker(tokens, onProgress, signal, normalizedWasmMode, normalizedOnBackend);
  } catch (error) {
    if (
      mode === 'preferred'
      && error instanceof WorkerUnavailableError
      && !signal?.aborted
    ) {
      return solveChallenge(tokens, onProgress, signal);
    }
    throw error;
  }
}
