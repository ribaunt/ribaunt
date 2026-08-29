/** @vitest-environment jsdom */
import { vi, type Mock } from 'vitest';

const mockSolveWithWorker = vi.fn();
const mockCalibrate = vi.fn();

vi.mock('../src/worker-client.js', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual<typeof import('../src/worker-client.js')>('../src/worker-client.js');
  return {
    ...actual,
    solveChallengeWithWorker: (...args: unknown[]) => mockSolveWithWorker(...args),
  };
});
vi.mock('../src/solver.js', () => ({
  calibrateBrowser: (...args: unknown[]) => mockCalibrate(...args),
}));

import '../src/widget';

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('RibauntWidget wasm-mode', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mockSolveWithWorker.mockReset();
    mockCalibrate.mockReset();
    global.fetch = vi.fn() as typeof fetch;
  });
  afterEach(() => vi.restoreAllMocks());

  it('defaults to preferred wasm-mode', async () => {
    const w = document.createElement('ribaunt-widget');
    w.setAttribute('challenge-endpoint', '/c');
    (global.fetch as Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ challenges: ['t'] }) });
    mockSolveWithWorker.mockResolvedValue([{ nonce: '1', hash: 'h' }]);
    document.body.appendChild(w);
    (w.shadowRoot?.querySelector('.captcha') as HTMLDivElement).click();
    await flush(); await flush();
    expect(mockSolveWithWorker).toHaveBeenCalledWith(['t'], expect.any(Function), expect.any(AbortSignal), 'preferred', 'preferred', expect.any(Function));
  });

  it('respects wasm-mode disabled', async () => {
    const w = document.createElement('ribaunt-widget');
    w.setAttribute('challenge-endpoint', '/c');
    w.setAttribute('wasm-mode', 'disabled');
    (global.fetch as Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ challenges: ['t'] }) });
    mockSolveWithWorker.mockResolvedValue([{ nonce: '1', hash: 'h' }]);
    document.body.appendChild(w);
    (w.shadowRoot?.querySelector('.captcha') as HTMLDivElement).click();
    await flush(); await flush();
    expect(mockSolveWithWorker).toHaveBeenCalledWith(['t'], expect.any(Function), expect.any(AbortSignal), 'preferred', 'disabled', expect.any(Function));
  });

  it('warns once about unknown wasm-mode but keeps solving', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = document.createElement('ribaunt-widget');
    w.setAttribute('challenge-endpoint', '/c');
    w.setAttribute('wasm-mode', 'fast');
    (global.fetch as Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ challenges: ['t'] }) });
    mockSolveWithWorker.mockResolvedValue([{ nonce: '1', hash: 'h' }]);
    document.body.appendChild(w);
    (w.shadowRoot?.querySelector('.captcha') as HTMLDivElement).click();
    await flush(); await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('wasm-mode'));
    expect(w.shadowRoot?.querySelector('.captcha')?.getAttribute('data-state')).toBe('done');
    warn.mockRestore();
  });

  it('emits solver-backend event', async () => {
    const w = document.createElement('ribaunt-widget');
    w.setAttribute('challenge-endpoint', '/c');
    const backendHandler = vi.fn();
    w.addEventListener('solver-backend', backendHandler as EventListener);
    (global.fetch as Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ challenges: ['t'] }) });
    mockSolveWithWorker.mockImplementation(async (_tokens: unknown, _onProgress: unknown, _sig: unknown, _wm: unknown, _wasm: unknown, onBackend: unknown) => {
      (onBackend as (b: string)=>void)?.('wasm');
      return [{ nonce: '1', hash: 'h' }];
    });
    document.body.appendChild(w);
    (w.shadowRoot?.querySelector('.captcha') as HTMLDivElement).click();
    await flush(); await flush();
    expect(backendHandler).toHaveBeenCalledTimes(1);
    const ev = backendHandler.mock.calls[0]?.[0] as CustomEvent<{ backend: string }>;
    expect(ev.detail.backend).toBe('wasm');
  });
});
