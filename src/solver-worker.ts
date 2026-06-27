/// <reference lib="webworker" />

import { solveChallenge } from './solver.js';

interface SolveRequest {
  type: 'solve';
  id: string;
  tokens: string[];
}

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.addEventListener('message', (event: MessageEvent<SolveRequest>) => {
  const request = event.data;
  if (request?.type !== 'solve') return;

  solveChallenge(
    request.tokens,
    (progress) => workerScope.postMessage({ type: 'progress', id: request.id, progress })
  ).then(
    (solutions) => workerScope.postMessage({ type: 'result', id: request.id, solutions }),
    (error: unknown) => workerScope.postMessage({
      type: 'error',
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    })
  );
});

export {};
