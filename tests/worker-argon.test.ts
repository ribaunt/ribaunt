/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createChallenge } from '../src/index';
import { solveChallengeWithWorker } from '../src/worker-client';

afterEach(() => vi.unstubAllGlobals());

describe('worker argon2id opt-in', () => {
  it('worker solves argon2id via main-thread fallback when Worker unavailable (preferred)', async () => {
    vi.stubGlobal('Worker', undefined);
    const tokens = await createChallenge({ algorithm: 'argon2id', difficulty: 1, amount: 1 });
    const sols = await solveChallengeWithWorker(tokens, undefined, undefined, 'preferred');
    expect(sols).toHaveLength(1);
    expect(sols[0]!.hash.startsWith('0')).toBe(true);
  });

  it('reports argon2id backend telemetry', async () => {
    const tokens = await createChallenge({ algorithm: 'argon2id', difficulty: 1, amount: 1 });
    class ArgonWorker extends EventTarget {
      terminate() {}
      postMessage(msg: { id: string }) {
        queueMicrotask(() => {
          this.dispatchEvent(new MessageEvent('message', { data: { type: 'backend', id: msg.id, backend: 'argon2id' } }));
          this.dispatchEvent(new MessageEvent('message', { data: { type: 'result', id: msg.id, solutions: [{ nonce: '1', hash: '0abc' }] } }));
        });
      }
    }
    vi.stubGlobal('Worker', ArgonWorker);
    const onBackend = vi.fn();
    const res = await solveChallengeWithWorker(tokens, undefined, undefined, 'required', 'preferred', onBackend);
    expect(onBackend).toHaveBeenCalledWith('argon2id');
    expect(res).toEqual([{ nonce: '1', hash: '0abc' }]);
  });

  it('worker argon respects abort', async () => {
    const tokens = await createChallenge({ algorithm: 'argon2id', difficulty: 2, amount: 1 });
    const controller = new AbortController();
    class SlowWorker extends EventTarget {
      terminate() {}
      postMessage(_msg: { id: string }) {
        // never reply, abort should terminate
      }
    }
    vi.stubGlobal('Worker', SlowWorker);
    const p = solveChallengeWithWorker(tokens, undefined, controller.signal, 'required');
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('falls back to js argon when worker unavailable and mode preferred', async () => {
    vi.stubGlobal('Worker', undefined);
    const tokens = await createChallenge({ algorithm: 'argon2id', difficulty: 1, amount: 2 });
    const sols = await solveChallengeWithWorker(tokens, undefined, undefined, 'preferred', 'disabled');
    expect(sols).toHaveLength(2);
  });
});
