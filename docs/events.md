# Events Reference

The Ribaunt CAPTCHA widget emits three standard DOM events (`CustomEvent`) that notify you of the lifecycle and results.
It also emits an initial `state-change` event immediately after the widget mounts with one of these states:
`initial`, `verifying`, `done`, `error`.

## 1. `verify`
Dispatched when the solver successfully solves all challenges and the server endpoint verifies it (if `verify-endpoint` is specified). 

If no `verify-endpoint` is specified, it just means the solver finished its local work.

**Event Type:** `CustomEvent<{ solutions: ChallengeSolution[]; phase: 'done'; progress: 100 }>`

```javascript
widget.addEventListener('verify', (e) => {
  const { solutions } = e.detail;
  // solutions: Array of { nonce: string, hash: string }
  console.log('Successfully completed challenge!', solutions);
});
```

## 2. `error`
Dispatched when an error occurs fetching tokens, solving them, or verifying them with the server.

**Event Type:** `CustomEvent<{ error: string; code: WidgetErrorCode; timeout: boolean; phase: 'error' }>`

The `code` field provides a machine-readable error classification:

| Code | Meaning |
|---|---|
| `timeout` | Solving exceeded the configured `solve-timeout`. |
| `aborted` | Solving was cancelled (e.g. widget reset). |
| `challenge-fetch-failed` | Challenge endpoint request failed. |
| `invalid-challenge` | Challenge response had an unexpected shape. |
| `solve-failed` | Solving produced no valid nonce. |
| `verification-failed` | Server verify endpoint rejected the solution. |
| `worker-unavailable` | Web Worker solver is not available. |
| `unknown` | An unclassified error occurred. |

```javascript
widget.addEventListener('error', (e) => {
  const { error, code, timeout } = e.detail;
  if (timeout) {
    console.warn('CAPTCHA timed out:', error);
    return;
  }
  console.error('CAPTCHA failed:', error, `(code: ${code})`);
});
```

## 3. `state-change`
Dispatched every time the widget moves from one visual state to another.

**Event Type:** `CustomEvent<{ state: WidgetState; phase: WidgetState; progress: number }>`

```javascript
widget.addEventListener('state-change', (e) => {
  const { state, progress } = e.detail;
  switch (state) {
    case 'initial':
      console.log('Ready to solve');
      break;
    case 'verifying':
      console.log(`Solving PoW... ${progress}%`);
      break;
    case 'done':
      console.log('Done!');
      break;
    case 'error':
      console.log('Oops! Failed.');
      break;
  }
});
```

## Listening in React
If you use the React wrapper (`ribaunt/widget-react`), you get built-in strongly-typed callback props, plus lifecycle hooks:

```tsx
<RibauntWidget
  onVerify={(detail) => console.log('Solutions:', detail.solutions)}
  onError={(detail) => console.error('Error:', detail.error)}
  onStateChange={(detail) => console.log('State:', detail.state)}
  onReady={(detail) => console.log('Ready state:', detail.state)}
  onLoad={(detail) => console.log('Widget loaded:', detail.state)}
  onEvent={(type, detail) => console.log('Event:', type, detail)}
/>
```

### React-Specific Behaviors

- **`onReady` & `onLoad`**: Both fire once after the widget mounts with the initial widget state. They are functionally equivalent; `onLoad` is provided as an alias for backward compatibility. These events are **React-only** and do not fire on the web component itself.

- **`onEvent`**: Fires for all events with the event type (`'verify'`, `'error'`, `'state-change'`, or `'ready'`) and its detail. This is a catch-all handler that can be used instead of individual callbacks.

The React wrapper also syncs key widget props after mount, including `challengeEndpoint`, `verifyEndpoint`, `autoVerify`, `challengeMethod`, `calibrate`, `showWarning`, `warningMessage`, `solveTimeout`, and `disabled`.
