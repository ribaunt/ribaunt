/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChallenge } from '../src/index';
import {
  solveChallengeWithWorker,
  WorkerUnavailableError,
} from '../src/worker-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('worker solver client', () => {
  it('falls back to cooperative solving when workers are unavailable', async () => {
    vi.stubGlobal('Worker', undefined);
    const [token] = createChallenge(1, 1);

    await expect(solveChallengeWithWorker([token!], undefined, undefined, 'preferred'))
      .resolves.toHaveLength(1);
  });

  it('fails with a stable error when worker mode is required', async () => {
    vi.stubGlobal('Worker', undefined);

    await expect(solveChallengeWithWorker(['token'], undefined, undefined, 'required'))
      .rejects.toBeInstanceOf(WorkerUnavailableError);
  });

  it('terminates the worker when an attempt is aborted', async () => {
    const terminate = vi.fn();
    class PendingWorker extends EventTarget {
      terminate = terminate;
      postMessage() {}
    }
    vi.stubGlobal('Worker', PendingWorker);
    const controller = new AbortController();
    const solving = solveChallengeWithWorker(['token'], undefined, controller.signal, 'required');

    controller.abort();

    await expect(solving).rejects.toMatchObject({ name: 'AbortError' });
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('forwards worker progress and resolves worker results', async () => {
    const terminate = vi.fn();
    class SuccessfulWorker extends EventTarget {
      terminate = terminate;

      postMessage(message: { id: string }) {
        queueMicrotask(() => {
          this.dispatchEvent(new MessageEvent('message', {
            data: { type: 'progress', id: message.id, progress: 50 },
          }));
          this.dispatchEvent(new MessageEvent('message', {
            data: {
              type: 'result',
              id: message.id,
              solutions: [{ nonce: '4', hash: '00abc' }],
            },
          }));
        });
      }
    }
    vi.stubGlobal('Worker', SuccessfulWorker);
    const onProgress = vi.fn();

    await expect(solveChallengeWithWorker(['token'], onProgress, undefined, 'required'))
      .resolves.toEqual([{ nonce: '4', hash: '00abc' }]);
    expect(onProgress).toHaveBeenCalledWith(50);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('reports worker load and worker response failures', async () => {
    class LoadFailureWorker extends EventTarget {
      terminate() {}
      postMessage() {
        queueMicrotask(() => this.dispatchEvent(new Event('error')));
      }
    }
    vi.stubGlobal('Worker', LoadFailureWorker);
    await expect(solveChallengeWithWorker(['token'], undefined, undefined, 'required'))
      .rejects.toBeInstanceOf(WorkerUnavailableError);

    class SolveFailureWorker extends EventTarget {
      terminate() {}
      postMessage(message: { id: string }) {
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
          data: { type: 'error', id: message.id, error: 'solver failed' },
        })));
      }
    }
    vi.stubGlobal('Worker', SolveFailureWorker);
    await expect(solveChallengeWithWorker(['token'], undefined, undefined, 'required'))
      .rejects.toThrow('solver failed');
  });

  it('honors an already-aborted signal before posting work', async () => {
    const terminate = vi.fn();
    const postMessage = vi.fn();
    class IdleWorker extends EventTarget {
      terminate = terminate;
      postMessage = postMessage;
    }
    vi.stubGlobal('Worker', IdleWorker);
    const controller = new AbortController();
    controller.abort();

    await expect(solveChallengeWithWorker(['token'], undefined, controller.signal, 'required'))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(postMessage).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});
