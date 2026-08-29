/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { solveChallengeWithWorker } from '../src/worker-client';

afterEach(() => vi.unstubAllGlobals());

describe('worker-client wasmMode', () => {
  it('passes wasmMode to worker', async () => {
    const terminate = vi.fn();
    const messages: unknown[] = [];
    class W extends EventTarget {
      terminate = terminate;
      postMessage(msg: unknown) { messages.push(msg); }
    }
    vi.stubGlobal('Worker', W);
    // Avoid fallback by making Worker appear available, but we will abort before result
    const controller = new AbortController();
    const p = solveChallengeWithWorker(['t'], undefined, controller.signal, 'required', 'disabled');
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(messages[0]).toMatchObject({ type: 'solve', wasmMode: 'disabled' });
  });

  it('defaults wasmMode to preferred', async () => {
    const postMessage = vi.fn();
    class W extends EventTarget {
      terminate() {}
      postMessage(msg: unknown) { postMessage(msg); }
    }
    vi.stubGlobal('Worker', W);
    const controller = new AbortController();
    const p = solveChallengeWithWorker(['t'], undefined, controller.signal, 'required');
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ wasmMode: 'preferred' }));
  });

  it('forwards backend telemetry via onBackend', async () => {
    const terminate = vi.fn();
    class BackendWorker extends EventTarget {
      terminate = terminate;
      postMessage(msg: { id: string; wasmMode?: string }) {
        queueMicrotask(() => {
          this.dispatchEvent(new MessageEvent('message', { data: { type: 'backend', id: msg.id, backend: 'wasm' } }));
          this.dispatchEvent(new MessageEvent('message', { data: { type: 'result', id: msg.id, solutions: [{ nonce: '1', hash: 'h' }] } }));
        });
      }
    }
    vi.stubGlobal('Worker', BackendWorker);
    const onBackend = vi.fn();
    const res = await solveChallengeWithWorker(['t'], undefined, undefined, 'required', 'preferred', onBackend);
    expect(onBackend).toHaveBeenCalledWith('wasm');
    expect(res).toEqual([{ nonce: '1', hash: 'h' }]);
  });

  it('tolerates backend callback throwing', async () => {
    class W extends EventTarget {
      terminate() {}
      postMessage(msg: { id: string }) {
        queueMicrotask(() => {
          this.dispatchEvent(new MessageEvent('message', { data: { type: 'backend', id: msg.id, backend: 'js' } }));
          this.dispatchEvent(new MessageEvent('message', { data: { type: 'result', id: msg.id, solutions: [{ nonce: '1', hash: 'h' }] } }));
        });
      }
    }
    vi.stubGlobal('Worker', W);
    const onBackend = vi.fn(() => { throw new Error('telemetry explode'); });
    await expect(solveChallengeWithWorker(['t'], undefined, undefined, 'required', 'preferred', onBackend)).resolves.toEqual([{ nonce: '1', hash: 'h' }]);
    expect(onBackend).toHaveBeenCalled();
  });
});
