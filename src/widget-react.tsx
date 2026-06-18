'use client';

import React, { useEffect, useRef, forwardRef, useImperativeHandle, useState } from 'react';
import type { RibauntWidgetElement, WidgetState } from './widget.js';

export interface RibauntWidgetProps extends Omit<React.HTMLAttributes<RibauntWidgetElement>, 'onError' | 'onLoad'> {
  challengeEndpoint?: string;
  verifyEndpoint?: string;
  autoVerify?: boolean | string;
  showWarning?: boolean | string;
  warningMessage?: string;
  solveTimeout?: number | string;
  disabled?: boolean | string;
  onVerify?: (detail: { solutions: any[] }) => void;
  onError?: (detail: { error: string; timeout?: boolean }) => void;
  onStateChange?: (detail: { state: WidgetState }) => void;
  onReady?: (detail: { state: WidgetState }) => void;
  onLoad?: (detail: { state: WidgetState }) => void;
  onEvent?: (type: 'verify' | 'error' | 'state-change' | 'ready', detail: unknown) => void;
}

export interface RibauntWidgetHandle {
  reset: () => void;
  getState: () => WidgetState | '';
  startVerification: () => void;
}

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

function syncWidgetProps(
  element: RibauntWidgetElement,
  {
    challengeEndpoint,
    verifyEndpoint,
    showWarning,
    warningMessage,
    solveTimeout,
    disabled,
    autoVerify,
  }: {
    challengeEndpoint: string | undefined;
    verifyEndpoint: string | undefined;
    autoVerify: boolean | string | undefined;
    showWarning: boolean | string | undefined;
    warningMessage: string | undefined;
    solveTimeout: number | string | undefined;
    disabled: boolean | string | undefined;
  }
) {
  syncAttribute(element, 'challenge-endpoint', challengeEndpoint);
  syncAttribute(element, 'verify-endpoint', verifyEndpoint);
  syncAttribute(element, 'auto-verify', autoVerify);
  syncAttribute(element, 'show-warning', showWarning);
  syncAttribute(element, 'warning-message', warningMessage);
  syncAttribute(element, 'solve-timeout', solveTimeout);
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
      disabled,
      autoVerify,
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
    const hasStateEventRef = useRef(false);
    const hasReadyRef = useRef(false);

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
        const customEvent = e as CustomEvent<{ solutions: any[] }>;
        callbacksRef.current.onVerify?.(customEvent.detail);
        callbacksRef.current.onEvent?.('verify', customEvent.detail);
      };

      const handleError = (e: Event) => {
        const customEvent = e as CustomEvent<{ error: string }>;
        callbacksRef.current.onError?.(customEvent.detail);
        callbacksRef.current.onEvent?.('error', customEvent.detail);
      };

      const handleStateChange = (e: Event) => {
        hasStateEventRef.current = true;
        const customEvent = e as CustomEvent<{ state: WidgetState }>;
        callbacksRef.current.onStateChange?.(customEvent.detail);
        callbacksRef.current.onEvent?.('state-change', customEvent.detail);
      };

      widget.addEventListener('verify', handleVerify);
      widget.addEventListener('error', handleError);
      widget.addEventListener('state-change', handleStateChange);

      // Apply any remaining standard HTML attributes to the element
      Object.entries(props).forEach(([key, value]) => {
        if (value !== undefined) {
          // Check if it's a valid property of the HTML element, if so set it
          if (key in widget) {
             (widget as any)[key] = value;
          } else {
             widget.setAttribute(key, String(value));
          }
        }
      });

      syncWidgetProps(widget, {
        challengeEndpoint,
        verifyEndpoint,
        autoVerify,
        showWarning,
        warningMessage,
        solveTimeout,
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
          callbacksRef.current.onStateChange?.({ state: currentState });
          callbacksRef.current.onEvent?.('state-change', { state: currentState });
        }
      }, 0);

      return () => {
        clearTimeout(fallbackTimer);
        widget.removeEventListener('verify', handleVerify);
        widget.removeEventListener('error', handleError);
        widget.removeEventListener('state-change', handleStateChange);
        widget.remove();
        widgetRef.current = null;
      };
    }, [isLoading]);

    useEffect(() => {
      if (!widgetRef.current) return;

      syncWidgetProps(widgetRef.current, {
        challengeEndpoint,
        verifyEndpoint,
        autoVerify,
        showWarning,
        warningMessage,
        solveTimeout,
        disabled,
      });
    }, [challengeEndpoint, verifyEndpoint, autoVerify, showWarning, warningMessage, solveTimeout, disabled]);

    return isLoading ? null : <div ref={containerRef} />;
  }
);

RibauntWidget.displayName = 'RibauntWidget';

export default RibauntWidget;
