'use client';

import React, { useEffect, useRef, forwardRef, useImperativeHandle, useState } from 'react';
import type {
  RibauntWidgetElement,
  WidgetErrorDetail,
  WidgetState,
  WidgetStateDetail,
  WidgetVerifyDetail,
} from './widget.js';
import type { WorkerMode, WasmMode } from './worker-client.js';

export type {
  RibauntWidgetElement,
  WidgetErrorDetail,
  WidgetState,
  WidgetStateDetail,
  WidgetVerifyDetail,
} from './widget.js';

export interface RibauntWidgetProps extends Omit<React.HTMLAttributes<RibauntWidgetElement>, 'onError' | 'onLoad'> {
  challengeEndpoint?: string;
  verifyEndpoint?: string;
  autoVerify?: boolean | string;
  showWarning?: boolean | string;
  warningMessage?: string;
  solveTimeout?: number | string;
  workerMode?: WorkerMode;
  wasmMode?: WasmMode;
  challengeMethod?: 'GET' | 'POST';
  calibrate?: boolean | string;
  showProgress?: boolean | string;
  disabled?: boolean | string;
  fallback?: React.ReactNode;
  onVerify?: (detail: WidgetVerifyDetail) => void;
  onError?: (detail: WidgetErrorDetail) => void;
  onStateChange?: (detail: WidgetStateDetail) => void;
  onReady?: (detail: { state: WidgetState }) => void;
  onLoad?: (detail: { state: WidgetState }) => void;
  onEvent?: (type: 'verify' | 'error' | 'state-change' | 'ready', detail: unknown) => void;
}

export interface RibauntWidgetHandle {
  reset: () => void;
  getState: () => WidgetState | '';
  startVerification: () => void;
}

/**
 * Synchronizes a React prop value to a DOM element attribute.
 * Removes the attribute if value is undefined, false, or 'false'.
 */
function syncAttribute(
  element: RibauntWidgetElement,
  name: string,
  value: string | number | boolean | undefined
) {
  if (value === undefined || value === false || value === 'false') {
    element.removeAttribute(name);
    return;
  }

  element.setAttribute(name, typeof value === 'boolean' ? 'true' : String(value));
}

const HANDLER_PROP_PATTERN = /^on[A-Z]/;

/**
 * Converts React event handler prop name to DOM event type.
 * Example: 'onClick' -> 'click'
 */
function toDomEventType(key: string): string {
  return key.slice(2).toLowerCase();
}

/**
 * Applies non-widget HTML props (title, className, data-*, ...) to the
 * custom element as attributes, and removes attributes for props that are
 * no longer present. Handler props (onClick, ...) and non-serializable
 * values (functions, objects) are ignored here; handlers are bound as real
 * event listeners because assigning `element.onClick` does nothing.
 */
const appliedPropsCache = new WeakMap<RibauntWidgetElement, Set<string>>();

function applyStandardProps(
  element: RibauntWidgetElement,
  props: Record<string, unknown>
) {
  const applied = new Set<string>();

  Object.entries(props).forEach(([key, value]) => {
    if (
      key === 'children'
      || value === undefined
      || value === null
      || typeof value === 'function'
      || typeof value === 'object'
      || HANDLER_PROP_PATTERN.test(key)
    ) {
      return;
    }

    element.setAttribute(key, value === true ? '' : String(value));
    applied.add(key);
  });

  const previous = appliedPropsCache.get(element);
  if (previous) {
    for (const key of previous) {
      if (!applied.has(key)) element.removeAttribute(key);
    }
  }
  appliedPropsCache.set(element, applied);
}

/**
 * Synchronizes all Ribaunt-specific widget props to DOM attributes.
 * Handles special cases like showProgress which uses tri-state logic.
 */
function syncWidgetProps(
  element: RibauntWidgetElement,
  {
    challengeEndpoint,
    verifyEndpoint,
    showWarning,
    warningMessage,
    solveTimeout,
    workerMode,
    wasmMode,
    challengeMethod,
    calibrate,
    showProgress,
    disabled,
    autoVerify,
  }: {
    challengeEndpoint: string | undefined;
    verifyEndpoint: string | undefined;
    autoVerify: boolean | string | undefined;
    showWarning: boolean | string | undefined;
    warningMessage: string | undefined;
    solveTimeout: number | string | undefined;
    workerMode: WorkerMode | undefined;
    wasmMode: WasmMode | undefined;
    challengeMethod: 'GET' | 'POST' | undefined;
    calibrate: boolean | string | undefined;
    showProgress: boolean | string | undefined;
    disabled: boolean | string | undefined;
  }
) {
  syncAttribute(element, 'challenge-endpoint', challengeEndpoint);
  syncAttribute(element, 'verify-endpoint', verifyEndpoint);
  syncAttribute(element, 'auto-verify', autoVerify);
  syncAttribute(element, 'show-warning', showWarning);
  syncAttribute(element, 'warning-message', warningMessage);
  syncAttribute(element, 'solve-timeout', solveTimeout);
  syncAttribute(element, 'worker-mode', workerMode);
  syncAttribute(element, 'wasm-mode', wasmMode);
  syncAttribute(element, 'challenge-method', challengeMethod);
  syncAttribute(element, 'calibrate', calibrate);
  // showProgress is tri-state, not presence-based: the widget hides progress
  // only when the attribute is present with literal value "false", so false
  // must be passed through verbatim instead of removing the attribute.
  if (showProgress === undefined) {
    element.removeAttribute('show-progress');
  } else {
    element.setAttribute('show-progress', String(showProgress));
  }
  syncAttribute(element, 'disabled', disabled);
}

/**
 * React wrapper for the Ribaunt Web Component.
 * Safely loads the web component dynamically, avoiding Next.js SSR issues.
 */
export const RibauntWidget = forwardRef<RibauntWidgetHandle, RibauntWidgetProps>(
  (
    {
      challengeEndpoint,
      verifyEndpoint,
      showWarning,
      warningMessage,
      solveTimeout,
      workerMode,
      wasmMode,
      challengeMethod,
      calibrate,
      showProgress,
      disabled,
      autoVerify,
      fallback,
      onVerify,
      onError,
      onStateChange,
      onReady,
      onLoad,
      onEvent,
      ...props
    },
    ref
  ) => {
    const widgetRef = useRef<RibauntWidgetElement | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [isLoading, setIsLoading] = useState(true);
    const callbacksRef = useRef({
      onVerify,
      onError,
      onStateChange,
      onReady,
      onLoad,
      onEvent,
    });
    const handlersRef = useRef<Map<string, Array<(event: Event) => void>>>(new Map());
    const boundEventTypesRef = useRef<Set<string>>(new Set());
    const nativeDispatcherRef = useRef<(event: Event) => void>((event) => {
      for (const handler of handlersRef.current.get(event.type) ?? []) {
        handler(event);
      }
    });
    const hasStateEventRef = useRef(false);
    const hasReadyRef = useRef(false);

    const standardProps: Record<string, unknown> = {};
    const nextHandlers = new Map<string, Array<(event: Event) => void>>();
    Object.entries(props as Record<string, unknown>).forEach(([key, value]) => {
      if (value === undefined) return;
      if (HANDLER_PROP_PATTERN.test(key) && typeof value === 'function') {
        const eventType = toDomEventType(key);
        const listeners = nextHandlers.get(eventType) ?? [];
        listeners.push(value as (event: Event) => void);
        nextHandlers.set(eventType, listeners);
        return;
      }
      standardProps[key] = value;
    });
    handlersRef.current = nextHandlers;

    useImperativeHandle(ref, () => ({
      reset: () => widgetRef.current?.reset?.(),
      getState: () => widgetRef.current?.getState?.() ?? '',
      startVerification: () => widgetRef.current?.startVerification?.(),
    }));

    useEffect(() => {
      // Dynamically import the browser component to bypass SSR issues
      import('./widget-browser.js')
        .then(() => {
          setIsLoading(false);
        })
        .catch(console.error);
    }, []);

    useEffect(() => {
      callbacksRef.current = {
        onVerify,
        onError,
        onStateChange,
        onReady,
        onLoad,
        onEvent,
      };
    }, [onVerify, onError, onStateChange, onReady, onLoad, onEvent]);

    useEffect(() => {
      if (isLoading || !containerRef.current || widgetRef.current) return;

      const widget = document.createElement('ribaunt-widget') as RibauntWidgetElement;

      const handleVerify = (e: Event) => {
        const customEvent = e as CustomEvent<WidgetVerifyDetail>;
        callbacksRef.current.onVerify?.(customEvent.detail);
        callbacksRef.current.onEvent?.('verify', customEvent.detail);
      };

      const handleError = (e: Event) => {
        const customEvent = e as CustomEvent<WidgetErrorDetail>;
        callbacksRef.current.onError?.(customEvent.detail);
        callbacksRef.current.onEvent?.('error', customEvent.detail);
      };

      const handleStateChange = (e: Event) => {
        hasStateEventRef.current = true;
        const customEvent = e as CustomEvent<WidgetStateDetail>;
        callbacksRef.current.onStateChange?.(customEvent.detail);
        callbacksRef.current.onEvent?.('state-change', customEvent.detail);
      };

      widget.addEventListener('verify', handleVerify);
      widget.addEventListener('error', handleError);
      widget.addEventListener('state-change', handleStateChange);

      syncWidgetProps(widget, {
        challengeEndpoint,
        verifyEndpoint,
        autoVerify,
        showWarning,
        warningMessage,
        solveTimeout,
        workerMode,
        wasmMode,
        challengeMethod,
        calibrate,
        showProgress,
        disabled,
      });

      containerRef.current.appendChild(widget);
      widgetRef.current = widget;

      const currentState = widget.getState?.() ?? 'initial';

      if (!hasReadyRef.current) {
        hasReadyRef.current = true;
        callbacksRef.current.onReady?.({ state: currentState });
        callbacksRef.current.onLoad?.({ state: currentState });
        callbacksRef.current.onEvent?.('ready', { state: currentState });
      }

      const fallbackTimer = setTimeout(() => {
        if (!hasStateEventRef.current) {
          hasStateEventRef.current = true;
          const detail: WidgetStateDetail = {
            state: currentState,
            phase: currentState,
            progress: 0,
          };
          callbacksRef.current.onStateChange?.(detail);
          callbacksRef.current.onEvent?.('state-change', detail);
        }
      }, 0);

      // The dispatcher is a stable ref created once, so capturing it here is
      // safe and keeps the cleanup function self-contained.
      const dispatchNativeEvent = nativeDispatcherRef.current;

      return () => {
        clearTimeout(fallbackTimer);
        widget.removeEventListener('verify', handleVerify);
        widget.removeEventListener('error', handleError);
        widget.removeEventListener('state-change', handleStateChange);
        for (const eventType of boundEventTypesRef.current) {
          widget.removeEventListener(eventType, dispatchNativeEvent);
        }
        boundEventTypesRef.current = new Set();
        handlersRef.current = new Map();
        widget.remove();
        widgetRef.current = null;
      };
      // Creation-only effect: prop changes are synced to the element by the
      // effects below, so re-creating the element on every prop change would
      // reset the widget and restart any verification in flight.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isLoading]);

    // Re-apply standard HTML props after every render so updates propagate
    // to the imperatively-created element (React never re-renders it), and
    // bind native listeners for any newly-seen handler props (onClick, ...).
    useEffect(() => {
      const widget = widgetRef.current;
      if (!widget) return;

      applyStandardProps(widget, standardProps);

      for (const eventType of handlersRef.current.keys()) {
        if (boundEventTypesRef.current.has(eventType)) continue;
        boundEventTypesRef.current.add(eventType);
        widget.addEventListener(eventType, nativeDispatcherRef.current);
      }
    });

    useEffect(() => {
      if (!widgetRef.current) return;

      syncWidgetProps(widgetRef.current, {
        challengeEndpoint,
        verifyEndpoint,
        autoVerify,
        showWarning,
        warningMessage,
        solveTimeout,
        workerMode,
        wasmMode,
        challengeMethod,
        calibrate,
        showProgress,
        disabled,
      });
    }, [
      challengeEndpoint,
      verifyEndpoint,
      autoVerify,
      showWarning,
      warningMessage,
      solveTimeout,
      workerMode,
      wasmMode,
      challengeMethod,
      calibrate,
      showProgress,
      disabled,
    ]);

    return isLoading ? (fallback ?? (
      <>
        <style>{`
          @keyframes ribaunt-react-shimmer {
            0% { background-position: 200% 0; }
            100% { background-position: -200% 0; }
          }
        `}</style>
        <div
          style={{
            height: 'var(--ribaunt-widget-height, 58px)',
            width: 'var(--ribaunt-widget-width, 230px)',
            borderRadius: 'var(--ribaunt-border-radius, 14px)',
            background: 'linear-gradient(90deg, #f0f0f0 25%, #e2e2e2 50%, #f0f0f0 75%)',
            backgroundSize: '200% 100%',
            animation: 'ribaunt-react-shimmer 1.5s ease-in-out infinite',
          }}
        />
      </>
    )) : <div ref={containerRef} />;
  }
);

RibauntWidget.displayName = 'RibauntWidget';

export default RibauntWidget;
