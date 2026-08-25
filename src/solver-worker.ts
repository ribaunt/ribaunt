/// <reference lib="webworker" />

import { solveChallenge, type ChallengeSolution } from './solver.js';

type WorkerRequest =
  | { type: 'solve'; id: string; tokens: string[] }
  | { type: 'cancel'; id: string };

type WorkerResponse =
  | { type: 'progress'; id: string; progress: number }
  | { type: 'result'; id: string; solutions: ChallengeSolution[] }
  | { type: 'error'; id: string; error: string }
  | { type: 'cancelled'; id: string };

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const activeControllers = new Map<string, AbortController>();

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

  solveChallenge(
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
  ).then(
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
      workerScope.postMessage({
        type: 'error',
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      } satisfies WorkerResponse);
    }
  );
});

export {};
