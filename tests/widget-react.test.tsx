/** @vitest-environment jsdom */

import React, { act, createRef } from 'react';
import { vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../src/widget-browser.js', () => ({}));

import '../src/widget';
import RibauntWidget, { type RibauntWidgetHandle } from '../src/widget-react';

// React 19 expects the test runtime to opt into act-aware scheduling.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function flushPromises(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function waitFor(check: () => boolean, attempts = 10): Promise<void> {
  for (let index = 0; index < attempts; index++) {
    if (check()) {
      return;
    }

    await act(async () => {
      await flushPromises();
    });
  }

  throw new Error('Timed out waiting for condition');
}

describe('RibauntWidget React wrapper', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await flushPromises();
    });
  });

  it('syncs widget attributes after mount and on prop changes', async () => {
    await act(async () => {
      root.render(
        <RibauntWidget
          challengeEndpoint="/challenge-a"
          verifyEndpoint="/verify-a"
          showWarning={true}
          warningMessage="First warning"
          solveTimeout={2500}
          disabled={true}
        />
      );
      await flushPromises();
    });

    await waitFor(() => {
      const widget = container.querySelector('ribaunt-widget');
      return widget?.getAttribute('challenge-endpoint') === '/challenge-a';
    });

    const widget = container.querySelector('ribaunt-widget') as HTMLElement;
    expect(widget).toBeTruthy();
    expect(widget.getAttribute('challenge-endpoint')).toBe('/challenge-a');
    expect(widget.getAttribute('verify-endpoint')).toBe('/verify-a');
    expect(widget.getAttribute('show-warning')).toBe('true');
    expect(widget.getAttribute('warning-message')).toBe('First warning');
    expect(widget.getAttribute('solve-timeout')).toBe('2500');
    expect(widget.getAttribute('disabled')).toBe('true');

    await act(async () => {
      root.render(
        <RibauntWidget
          challengeEndpoint="/challenge-b"
          verifyEndpoint="/verify-b"
          showWarning={false}
          warningMessage="Second warning"
          disabled={false}
        />
      );
      await flushPromises();
    });

    expect(widget.getAttribute('challenge-endpoint')).toBe('/challenge-b');
    expect(widget.getAttribute('verify-endpoint')).toBe('/verify-b');
    expect(widget.getAttribute('show-warning')).toBeNull();
    expect(widget.getAttribute('warning-message')).toBe('Second warning');
    expect(widget.getAttribute('solve-timeout')).toBeNull();
    expect(widget.getAttribute('disabled')).toBeNull();
  });

  it('forwards remaining HTML props as properties or attributes', async () => {
    await act(async () => {
      root.render(
        <RibauntWidget
          title="Widget title"
          data-custom="custom-value"
          aria-label={undefined}
        />
      );
      await flushPromises();
    });

    await waitFor(() => Boolean(container.querySelector('ribaunt-widget')));

    const widget = container.querySelector('ribaunt-widget') as HTMLElement;
    expect(widget.title).toBe('Widget title');
    expect(widget.getAttribute('data-custom')).toBe('custom-value');
  });

  it('forwards widget events to React callbacks', async () => {
    const onVerify = vi.fn();
    const onError = vi.fn();
    const onStateChange = vi.fn();
    const onReady = vi.fn();
    const onEvent = vi.fn();

    await act(async () => {
      root.render(
        <RibauntWidget
          onVerify={onVerify}
          onError={onError}
          onStateChange={onStateChange}
          onReady={onReady}
          onEvent={onEvent}
        />
      );
      await flushPromises();
    });

    await waitFor(() => Boolean(container.querySelector('ribaunt-widget')));

    const widget = container.querySelector('ribaunt-widget') as HTMLElement;

    await act(async () => {
      widget.dispatchEvent(new CustomEvent('verify', { detail: { solutions: [{ nonce: '1', hash: 'h' }] } }));
      widget.dispatchEvent(new CustomEvent('error', { detail: { error: 'boom' } }));
      widget.dispatchEvent(new CustomEvent('state-change', { detail: { state: 'done' } }));
      await flushPromises();
    });

    expect(onReady).toHaveBeenCalledWith({ state: 'initial' });
    expect(onVerify).toHaveBeenCalledWith({ solutions: [{ nonce: '1', hash: 'h' }] });
    expect(onError).toHaveBeenCalledWith({ error: 'boom' });
    expect(onStateChange).toHaveBeenCalledWith({ state: 'done' });
    expect(onEvent).toHaveBeenCalledWith('ready', { state: 'initial' });
    expect(onEvent).toHaveBeenCalledWith('verify', { solutions: [{ nonce: '1', hash: 'h' }] });
    expect(onEvent).toHaveBeenCalledWith('error', { error: 'boom' });
    expect(onEvent).toHaveBeenCalledWith('state-change', { state: 'done' });
  });

  it('exposes the imperative handle methods', async () => {
    const ref = createRef<RibauntWidgetHandle>();

    await act(async () => {
      root.render(<RibauntWidget ref={ref} />);
      await flushPromises();
    });

    await waitFor(() => ref.current !== null);

    expect(ref.current).toBeTruthy();
    expect(ref.current?.getState()).toBe('initial');

    await act(async () => {
      ref.current?.reset();
      ref.current?.startVerification();
      await flushPromises();
    });

    expect(ref.current?.getState()).toBe('error');
  });

  it('emits fallback ready state when the custom element does not emit state-change', async () => {
    const originalCreateElement = document.createElement.bind(document);
    const fallbackWidget = originalCreateElement('div') as HTMLElement & {
      reset: () => void;
      startVerification: () => void;
    };
    fallbackWidget.reset = vi.fn();
    fallbackWidget.startVerification = vi.fn();
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tagName, options) => {
      if (tagName === 'ribaunt-widget') {
        return fallbackWidget;
      }

      return originalCreateElement(tagName, options);
    });
    const onStateChange = vi.fn();
    const onEvent = vi.fn();
    const ref = createRef<RibauntWidgetHandle>();

    await act(async () => {
      root.render(
        <RibauntWidget
          ref={ref}
          onStateChange={onStateChange}
          onEvent={onEvent}
        />
      );
      await flushPromises();
    });

    await waitFor(() => onStateChange.mock.calls.length > 0);

    expect(onStateChange).toHaveBeenCalledWith({ state: 'initial' });
    expect(onEvent).toHaveBeenCalledWith('state-change', { state: 'initial' });
    expect(ref.current?.getState()).toBe('');

    createElementSpy.mockRestore();
  });
});
