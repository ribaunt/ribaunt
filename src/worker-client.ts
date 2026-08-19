import {
  solveChallenge,
  type ChallengeSolution,
} from './solver.js';

export type WorkerMode = 'preferred' | 'required' | 'disabled';

export class WorkerUnavailableError extends Error {
  readonly code = 'worker-unavailable';

  constructor(message = 'Web Worker solving is unavailable') {
    super(message);
    this.name = 'WorkerUnavailableError';
  }
}

interface WorkerMessage {
  type: 'progress' | 'result' | 'error' | 'cancelled';
  id: string;
  progress?: number;
  solutions?: ChallengeSolution[];
  error?: string;
}

interface WorkerRequest {
  type: 'solve' | 'cancel';
  id: string;
  tokens?: string[];
}

function abortError(): DOMException {
  return new DOMException('Challenge solving aborted', 'AbortError');
}

const CANCEL_GRACE_MS = 250;

function solveInWorker(
  tokens: string[],
  onProgress?: (progress: number) => void,
  signal?: AbortSignal
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
    worker.postMessage({ type: 'solve', id, tokens } satisfies WorkerRequest);
  });
}

export async function solveChallengeWithWorker(
  tokens: string[],
  onProgress?: (progress: number) => void,
  signal?: AbortSignal,
  mode: WorkerMode = 'preferred'
): Promise<ChallengeSolution[]> {
  if (mode === 'disabled') return solveChallenge(tokens, onProgress, signal);

  try {
    return await solveInWorker(tokens, onProgress, signal);
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
