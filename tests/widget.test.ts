/** @vitest-environment jsdom */

import { vi, type Mock } from 'vitest';

const mockSolveChallenge = vi.fn();
const mockCalibrateBrowser = vi.fn();

vi.mock('../src/solver.js', () => ({
  solveChallenge: (...args: unknown[]) => mockSolveChallenge(...args),
  calibrateBrowser: (...args: unknown[]) => mockCalibrateBrowser(...args),
}));

import '../src/widget';

function flushPromises(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('RibauntWidget', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mockSolveChallenge.mockReset();
    mockCalibrateBrowser.mockReset();
    global.fetch = vi.fn() as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches, solves, verifies, and emits lifecycle events', async () => {
    const widget = document.createElement('ribaunt-widget');
    widget.setAttribute('challenge-endpoint', '/challenge');
    widget.setAttribute('verify-endpoint', '/verify');

    const states: string[] = [];
    const verifyHandler = vi.fn();

    widget.addEventListener('state-change', ((event: CustomEvent<{ state: string }>) => {
      states.push(event.detail.state);
    }) as EventListener);
    widget.addEventListener('verify', verifyHandler as EventListener);

    (global.fetch as Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ challenges: ['token-1', 'token-2'] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

    mockSolveChallenge.mockImplementation(async (_tokens: string[], onProgress?: (progress: number) => void) => {
      onProgress?.(25);
      onProgress?.(100);
      return [
        { nonce: '1', hash: 'hash-1' },
        { nonce: '2', hash: 'hash-2' },
      ];
    });

    document.body.appendChild(widget);

    const captcha = widget.shadowRoot?.querySelector('.captcha') as HTMLDivElement;
    expect(captcha).toBeTruthy();

    captcha.click();
    await flushPromises();
    await flushPromises();

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      '/challenge',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(mockSolveChallenge).toHaveBeenCalledWith(
      ['token-1', 'token-2'],
      expect.any(Function),
      expect.any(AbortSignal)
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      '/verify',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(verifyHandler).toHaveBeenCalledTimes(1);
    expect(states).toContain('initial');
    expect(states).toContain('fetching');
    expect(states).toContain('solving');
    expect(states).toContain('verifying');
    expect(states).toContain('done');
    expect(widget.shadowRoot?.querySelector('p')?.textContent).toBe("You're a human");
  });

  it('posts timing-only calibration when explicitly enabled', async () => {
    const widget = document.createElement('ribaunt-widget');
    widget.setAttribute('challenge-endpoint', '/challenge');
    widget.setAttribute('challenge-method', 'POST');
    widget.setAttribute('calibrate', 'true');
    widget.setAttribute('worker-mode', 'disabled');
    mockCalibrateBrowser.mockResolvedValue({ iterations: 128, durationMs: 12 });
    (global.fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ challenges: ['token-1'] }),
    });
    mockSolveChallenge.mockResolvedValue([{ nonce: '1', hash: 'hash-1' }]);

    document.body.appendChild(widget);
    (widget.shadowRoot?.querySelector('.captcha') as HTMLDivElement).click();
    await flushPromises();
    await flushPromises();

    expect(global.fetch).toHaveBeenCalledWith('/challenge', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        calibration: { iterations: 128, durationMs: 12 },
      }),
    }));
  });

  it('automatically verifies on load when auto-verify is enabled', async () => {
    const widget = document.createElement('ribaunt-widget');
    widget.setAttribute('challenge-endpoint', '/challenge');
    widget.setAttribute('verify-endpoint', '/verify');
    widget.setAttribute('auto-verify', 'true');

    const verifyHandler = vi.fn();
    widget.addEventListener('verify', verifyHandler as EventListener);

    (global.fetch as Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ challenges: ['token-1'] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

    mockSolveChallenge.mockResolvedValue([{ nonce: '1', hash: 'hash-1' }]);

    document.body.appendChild(widget);
    await flushPromises();
    await flushPromises();

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      '/challenge',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(mockSolveChallenge).toHaveBeenCalledWith(
      ['token-1'],
      expect.any(Function),
      expect.any(AbortSignal)
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      '/verify',
      expect.objectContaining({
        method: 'POST',
      })
    );
    expect(verifyHandler).toHaveBeenCalledTimes(1);
    expect(widget.getState()).toBe('done');
  });

  it('does not auto-verify when disabled or explicitly opted out', async () => {
    const disabledWidget = document.createElement('ribaunt-widget');
    disabledWidget.setAttribute('challenge-endpoint', '/challenge');
    disabledWidget.setAttribute('auto-verify', 'true');
    disabledWidget.setAttribute('disabled', 'true');

    const optedOutWidget = document.createElement('ribaunt-widget');
    optedOutWidget.setAttribute('challenge-endpoint', '/challenge');
    optedOutWidget.setAttribute('auto-verify', 'false');

    document.body.append(disabledWidget, optedOutWidget);
    await flushPromises();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockSolveChallenge).not.toHaveBeenCalled();
    expect(disabledWidget.getState()).toBe('initial');
    expect(optedOutWidget.getState()).toBe('initial');
  });

  it('emits an error event when challenge fetch fails', async () => {
    const widget = document.createElement('ribaunt-widget');
    widget.setAttribute('challenge-endpoint', '/challenge');

    const errorHandler = vi.fn();
    widget.addEventListener('error', errorHandler as EventListener);

    (global.fetch as Mock).mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
    });

    document.body.appendChild(widget);
    (widget.shadowRoot?.querySelector('.captcha') as HTMLDivElement).click();

    await flushPromises();
    await flushPromises();

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(widget.shadowRoot?.querySelector('.captcha')?.getAttribute('data-state')).toBe('error');
  });

  it('accepts challenge responses shaped as { tokens: string[] }', async () => {
    const widget = document.createElement('ribaunt-widget');
    widget.setAttribute('challenge-endpoint', '/challenge');
    widget.setAttribute('verify-endpoint', '/verify');

    (global.fetch as Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ tokens: ['token-1'] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

    mockSolveChallenge.mockResolvedValue([{ nonce: '1', hash: 'hash-1' }]);

    document.body.appendChild(widget);
    (widget.shadowRoot?.querySelector('.captcha') as HTMLDivElement).click();

    await flushPromises();
    await flushPromises();

    expect(mockSolveChallenge).toHaveBeenCalledWith(
      ['token-1'],
      expect.any(Function),
      expect.any(AbortSignal)
    );
    expect(widget.shadowRoot?.querySelector('.captcha')?.getAttribute('data-state')).toBe('done');
  });

  it('accepts raw challenge token arrays', async () => {
    const widget = document.createElement('ribaunt-widget');
    widget.setAttribute('challenge-endpoint', '/challenge');

    (global.fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ['token-1'],
    });
    mockSolveChallenge.mockResolvedValue([{ nonce: '1', hash: 'hash-1' }]);

    document.body.appendChild(widget);
    (widget.shadowRoot?.querySelector('.captcha') as HTMLDivElement).click();

    await flushPromises();
    await flushPromises();

    expect(mockSolveChallenge).toHaveBeenCalledWith(
      ['token-1'],
      expect.any(Function),
      expect.any(AbortSignal)
    );
    expect(widget.shadowRoot?.querySelector('.captcha')?.getAttribute('data-state')).toBe('done');
  });

  it('emits an error when challenge response contains invalid token values', async () => {
    const widget = document.createElement('ribaunt-widget');
    widget.setAttribute('challenge-endpoint', '/challenge');

    const errorHandler = vi.fn();
    widget.addEventListener('error', errorHandler as EventListener);

    (global.fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ challenges: ['token-1', 42] }),
    });

    document.body.appendChild(widget);
    (widget.shadowRoot?.querySelector('.captcha') as HTMLDivElement).click();

    await flushPromises();
    await flushPromises();

    expect(errorHandler).toHaveBeenCalledTimes(1);
    const event = errorHandler.mock.calls[0]?.[0] as CustomEvent<{ error: string }>;
    expect(event.detail.error).toBe('Challenge response contains invalid token values');
    expect(widget.shadowRoot?.querySelector('.captcha')?.getAttribute('data-state')).toBe('error');
  });

  it('emits errors for invalid challenge response shapes', async () => {
    const cases: Array<[unknown, string]> = [
      [null, 'Challenge response must be an object or array of token strings'],
      [{}, 'Challenge response must include "challenges" or "tokens"'],
      [{ challenges: [] }, 'No challenge tokens available'],
      [{ challenges: 'token-1' }, 'Challenge response must be an array of token strings'],
    ];

    for (const [payload, message] of cases) {
      document.body.innerHTML = '';
      const widget = document.createElement('ribaunt-widget');
      widget.setAttribute('challenge-endpoint', '/challenge');
      const errorHandler = vi.fn();
      widget.addEventListener('error', errorHandler as EventListener);
      (global.fetch as Mock).mockReset();
      (global.fetch as Mock).mockResolvedValueOnce({
        ok: true,
        json: async () => payload,
      });

      document.body.appendChild(widget);
      (widget.shadowRoot?.querySelector('.captcha') as HTMLDivElement).click();

      await flushPromises();
      await flushPromises();

      const event = errorHandler.mock.calls[0]?.[0] as CustomEvent<{ error: string }>;
      expect(event.detail.error).toBe(message);
      expect(widget.shadowRoot?.querySelector('.captcha')?.getAttribute('data-state')).toBe('error');
    }
  });

  it('does not start verification while disabled', async () => {
    const widget = document.createElement('ribaunt-widget');
    widget.setAttribute('challenge-endpoint', '/challenge');
    widget.setAttribute('disabled', 'true');

    document.body.appendChild(widget);

    const captcha = widget.shadowRoot?.querySelector('.captcha') as HTMLDivElement;
    expect(captcha.getAttribute('aria-disabled')).toBe('true');
    expect(captcha.tabIndex).toBe(-1);

    captcha.click();
    widget.startVerification?.();
    await flushPromises();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockSolveChallenge).not.toHaveBeenCalled();
    expect(captcha.getAttribute('data-state')).toBe('initial');
  });

  it('updates aria state while resetting a disabled connected widget', () => {
    const widget = document.createElement('ribaunt-widget');
    widget.setAttribute('disabled', 'true');
    document.body.appendChild(widget);

    widget.reset();

    const captcha = widget.shadowRoot?.querySelector('.captcha') as HTMLDivElement;
    expect(captcha.tabIndex).toBe(-1);
    expect(captcha.getAttribute('aria-disabled')).toBe('true');
  });

  it('does not duplicate click listeners across rerenders', async () => {
    const widget = document.createElement('ribaunt-widget');
    widget.setAttribute('challenge-endpoint', '/challenge');

    (global.fetch as Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ challenges: ['token-1'] }),
    });
    mockSolveChallenge.mockResolvedValue([{ nonce: '1', hash: 'hash-1' }]);

    document.body.appendChild(widget);
    widget.setAttribute('show-warning', 'true');

    const captcha = widget.shadowRoot?.querySelector('.captcha') as HTMLDivElement;
    captcha.click();
    await flushPromises();
    await flushPromises();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockSolveChallenge).toHaveBeenCalledTimes(1);
  });

  it('does not start verification when the logo is clicked', async () => {
    const widget = document.createElement('ribaunt-widget');
    widget.setAttribute('challenge-endpoint', '/challenge');

    document.body.appendChild(widget);

    const logo = widget.shadowRoot?.querySelector('.logo') as HTMLAnchorElement;
    expect(logo).toBeTruthy();

    logo.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushPromises();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockSolveChallenge).not.toHaveBeenCalled();
    expect(widget.shadowRoot?.querySelector('.captcha')?.getAttribute('data-state')).toBe('initial');
  });

  it('supports keyboard activation and ignores non-activation keys', async () => {
    const widget = document.createElement('ribaunt-widget');
    widget.setAttribute('challenge-endpoint', '/challenge');

    (global.fetch as Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ challenges: ['token-1'] }),
    });
    mockSolveChallenge.mockResolvedValue([{ nonce: '1', hash: 'hash-1' }]);

    document.body.appendChild(widget);
    const captcha = widget.shadowRoot?.querySelector('.captcha') as HTMLDivElement;

    captcha.dispatchEvent(new KeyboardEvent('keypress', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(global.fetch).not.toHaveBeenCalled();

    captcha.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true, cancelable: true }));
    await flushPromises();
    await flushPromises();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not restart verification while already verifying', async () => {
    const widget = document.createElement('ribaunt-widget');
    widget.setAttribute('challenge-endpoint', '/challenge');

    (global.fetch as Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ challenges: ['token-1'] }),
    });
    mockSolveChallenge.mockImplementation(async () => new Promise(() => {}));

    document.body.appendChild(widget);
    const captcha = widget.shadowRoot?.querySelector('.captcha') as HTMLDivElement;

    captcha.click();
    await flushPromises();
    captcha.click();
    widget.startVerification();

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps progress styling when rerendering during verification', async () => {
    const widget = document.createElement('ribaunt-widget');
    widget.setAttribute('challenge-endpoint', '/challenge');

    (global.fetch as Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ challenges: ['token-1'] }),
    });
    mockSolveChallenge.mockImplementation(async (_tokens: string[], onProgress?: (progress: number) => void) => {
      onProgress?.(33.34);
      return new Promise(() => {});
    });

    document.body.appendChild(widget);
    (widget.shadowRoot?.querySelector('.captcha') as HTMLDivElement).click();
    await flushPromises();
    widget.setAttribute('warning-message', 'Still working');

    const captcha = widget.shadowRoot?.querySelector('.captcha') as HTMLDivElement;
    expect(captcha.style.getPropertyValue('--progress')).toBe('33.3%');
  });

  it('emits an error when verification endpoint rejects the solution', async () => {
    const widget = document.createElement('ribaunt-widget');
    widget.setAttribute('challenge-endpoint', '/challenge');
    widget.setAttribute('verify-endpoint', '/verify');
    const errorHandler = vi.fn();
    widget.addEventListener('error', errorHandler as EventListener);

    (global.fetch as Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ challenges: ['token-1'] }),
      })
      .mockResolvedValueOnce({
        ok: false,
      });
    mockSolveChallenge.mockResolvedValue([{ nonce: '1', hash: 'hash-1' }]);

    document.body.appendChild(widget);
    (widget.shadowRoot?.querySelector('.captcha') as HTMLDivElement).click();

    await flushPromises();
    await flushPromises();

    const event = errorHandler.mock.calls[0]?.[0] as CustomEvent<{ error: string }>;
    expect(event.detail.error).toBe('Verification failed');
    expect(widget.shadowRoot?.querySelector('.captcha')?.getAttribute('data-state')).toBe('error');
  });

  it('stringifies non-Error failures in error events', async () => {
    const widget = document.createElement('ribaunt-widget');
    widget.setAttribute('challenge-endpoint', '/challenge');
    const errorHandler = vi.fn();
    widget.addEventListener('error', errorHandler as EventListener);

    (global.fetch as Mock).mockRejectedValueOnce('network-string-failure');

    document.body.appendChild(widget);
    (widget.shadowRoot?.querySelector('.captcha') as HTMLDivElement).click();

    await flushPromises();
    await flushPromises();

    const event = errorHandler.mock.calls[0]?.[0] as CustomEvent<{ error: string }>;
    expect(event.detail.error).toBe('network-string-failure');
  });

  it('treats invalid solve-timeout values as no timeout', async () => {
    const widget = document.createElement('ribaunt-widget');
    widget.setAttribute('challenge-endpoint', '/challenge');
    widget.setAttribute('solve-timeout', 'not-a-number');

    (global.fetch as Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ challenges: ['token-1'] }),
    });
    mockSolveChallenge.mockResolvedValue([{ nonce: '1', hash: 'hash-1' }]);

    document.body.appendChild(widget);
    (widget.shadowRoot?.querySelector('.captcha') as HTMLDivElement).click();
    await flushPromises();
    await flushPromises();

    expect(mockSolveChallenge).toHaveBeenCalledWith(
      ['token-1'],
      expect.any(Function),
      expect.any(AbortSignal)
    );
    expect(widget.shadowRoot?.querySelector('.captcha')?.getAttribute('data-state')).toBe('done');
  });

  it('transitions to error and emits timeout metadata when solve-timeout is set', async () => {
    const widget = document.createElement('ribaunt-widget');
    widget.setAttribute('challenge-endpoint', '/challenge');
    widget.setAttribute('solve-timeout', '10');

    const errorHandler = vi.fn();
    widget.addEventListener('error', errorHandler as EventListener);

    (global.fetch as Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ challenges: ['token-1'] }),
    });

    mockSolveChallenge.mockImplementation(async (_tokens: string[], _onProgress?: (progress: number) => void, signal?: AbortSignal) => {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('Challenge solving aborted', 'AbortError'));
        });
      });
    });

    document.body.appendChild(widget);
    (widget.shadowRoot?.querySelector('.captcha') as HTMLDivElement).click();

    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(widget.shadowRoot?.querySelector('.captcha')?.getAttribute('data-state')).toBe('error');
    expect(errorHandler).toHaveBeenCalledTimes(1);
    const event = errorHandler.mock.calls[0]?.[0] as CustomEvent<{ error: string; timeout?: boolean }>;
    expect(event.detail.timeout).toBe(true);
    expect(event.detail.error).toBe('Timed out. Try again.');
  });

  it('animates warning by applying visible class after render', async () => {
    const widget = document.createElement('ribaunt-widget');
    widget.setAttribute('show-warning', 'true');
    document.body.appendChild(widget);

    const warning = widget.shadowRoot?.querySelector('.warning') as HTMLDivElement;
    expect(warning).toBeTruthy();
    expect(warning.classList.contains('visible')).toBe(false);

    await flushPromises();

    expect(warning.classList.contains('visible')).toBe(true);
  });

  it('renders warning-message as inert text', () => {
    const widget = document.createElement('ribaunt-widget');
    const warningMessage = '<img src=x onerror="globalThis.__ribauntXss=1"><span>owned</span>';
    widget.setAttribute('show-warning', 'true');
    widget.setAttribute('warning-message', warningMessage);

    document.body.appendChild(widget);

    const warning = widget.shadowRoot?.querySelector('.warning') as HTMLDivElement;
    expect(warning.textContent).toBe(warningMessage);
    expect(warning.querySelector('img')).toBeNull();
    expect(warning.querySelector('span')).toBeNull();
  });

  it('ignores unchanged attribute updates', () => {
    const widget = document.createElement('ribaunt-widget');
    document.body.appendChild(widget);
    const initialCaptcha = widget.shadowRoot?.querySelector('.captcha');

    widget.attributeChangedCallback?.('disabled', 'true', 'true');

    expect(widget.shadowRoot?.querySelector('.captcha')).toBe(initialCaptcha);
  });

  it('handles public methods before the element is connected', () => {
    const widget = document.createElement('ribaunt-widget');
    const states: string[] = [];
    widget.addEventListener('state-change', ((event: CustomEvent<{ state: string }>) => {
      states.push(event.detail.state);
    }) as EventListener);

    widget.reset();

    expect(widget.getState()).toBe('initial');
    expect(states).toContain('initial');
  });

  it('tolerates missing internals when attaching listeners defensively', () => {
    const widget = document.createElement('ribaunt-widget');
    const internals = widget as unknown as {
      captchaElement: HTMLDivElement | null;
      logoElement: HTMLAnchorElement | null;
      attachEventListeners: () => void;
    };

    internals.captchaElement = null;
    internals.logoElement = null;

    expect(() => internals.attachEventListeners()).not.toThrow();
  });

  it('cleans up warning animation when disconnected before the timer runs', async () => {
    const widget = document.createElement('ribaunt-widget');
    widget.setAttribute('show-warning', 'true');

    document.body.appendChild(widget);
    const warning = widget.shadowRoot?.querySelector('.warning') as HTMLDivElement;
    (widget as unknown as { warningElement: HTMLDivElement | null }).warningElement = null;

    await flushPromises();

    expect(warning.classList.contains('visible')).toBe(false);
  });
});
