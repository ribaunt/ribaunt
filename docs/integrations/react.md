# React Integration Guide

If you are using Vite, Create React App, or another React framework (that doesn't have SSR issues like Next.js), you can either use our provided `widget-react` wrapper or the raw web component.

Client-side solving relies on the Web Crypto API, so development should run in a secure context such as `https://...` or `http://localhost`. Plain local-network HTTP URLs may fail in some browsers.

## Method 1: Using the React Wrapper (Recommended)

Our React wrapper handles event binding cleanly and exposes a `ref` handle to easily reset or trigger verification.
It also guarantees a `state-change` callback after mount, exposes an explicit ready hook, and now syncs key props after mount instead of only during initial creation.

```tsx
import React, { useRef } from 'react';
import RibauntWidget from 'ribaunt/widget-react';

export default function MyReactApp() {
  const widgetRef = useRef(null);

  const handleVerify = (detail) => {
    console.log('Verified solutions:', detail.solutions);
  };

  const handleError = (detail) => {
    console.error('Verification failed:', detail.error);
  };

  const handleStateChange = (detail) => {
    console.log('Current widget state:', detail.state);
  };

  const handleReady = (detail) => {
    console.log('Widget ready with state:', detail.state);
  };

  const handleLoad = (detail) => {
    console.log('Widget loaded:', detail.state);
  };

  const handleEvent = (type, detail) => {
    console.log('Widget event:', type, detail);
  };

  return (
    <form>
      <RibauntWidget
        ref={widgetRef}
        challengeEndpoint="/api/captcha/challenge"
        verifyEndpoint="/api/captcha/verify"
        autoVerify={true}
        solveTimeout={15000}
        onVerify={handleVerify}
        onError={handleError}
        onStateChange={handleStateChange}
        onReady={handleReady}
        onLoad={handleLoad}
        onEvent={handleEvent}
      />
      <button type="button" onClick={() => widgetRef.current?.startVerification()}>
        Verify Manually
      </button>
      <button type="submit">Submit Form</button>
    </form>
  );
}
```

### Prop Updates

The React wrapper now updates these props live after mount:

- `challengeEndpoint`
- `verifyEndpoint`
- `autoVerify`
- `challengeMethod`
- `calibrate`
- `showWarning`
- `warningMessage`
- `solveTimeout`
- `disabled`

If your older integration used a changing `key` to force a remount when one of those values changed, that workaround can usually be removed.

### Loading Fallback

During SSR or while the widget's dynamic import loads, the React wrapper renders a built-in shimmer skeleton matching the widget dimensions. Pass a custom `fallback` prop to override it:

```tsx
<RibauntWidget
  challengeEndpoint="/api/captcha/challenge"
  fallback={<div style={{ height: 58, width: 230 }}>Loading…</div>}
/>
```

### Disabled State

When `disabled` is set, the wrapped widget blocks user interaction, `startVerification()`, and `autoVerify`. Remove or clear `disabled` before expecting the widget to run.

### Challenge Endpoint Response Contract

When using `challengeEndpoint`, the recommended response shape is `{ challenges: string[] }`.

For backwards compatibility, the widget also accepts `{ tokens: string[] }` and raw `string[]`.

### Secure Context Requirement

If the browser does not expose `crypto.subtle`, verification will fail with a clear error indicating that HTTPS or `localhost` is required.

## Method 2: Using the Raw Web Component

Since we provide TypeScript declarations for `HTMLElementTagNameMap` and `JSX.IntrinsicElements`, you can also import and use the raw web component natively in JSX.

```tsx
import React, { useEffect, useRef } from 'react';

// Side-effect import to register the web component
import 'ribaunt/widget'; 

export default function MyReactApp() {
  const widgetRef = useRef<import('ribaunt/widget').RibauntWidgetElement>(null);

  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget) return;

    const handleVerify = (e: CustomEvent) => {
      console.log('Verified!', e.detail.solutions);
    };

    widget.addEventListener('verify', handleVerify);
    return () => widget.removeEventListener('verify', handleVerify);
  }, []);

  return (
    <form>
      {/* Type-safe custom element properties! */}
      <ribaunt-widget
        ref={widgetRef}
        challenge-endpoint="/api/captcha/challenge"
        verify-endpoint="/api/captcha/verify"
      />
      <button type="submit">Submit Form</button>
    </form>
  );
}
```

Both approaches are completely type-safe out of the box!
