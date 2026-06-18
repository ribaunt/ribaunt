# Events Reference

The Ribaunt CAPTCHA widget emits three standard DOM events (`CustomEvent`) that notify you of the lifecycle and results.
It also emits an initial `state-change` event immediately after the widget mounts with one of these states:
`initial`, `verifying`, `done`, `error`.

## 1. `verify`
Dispatched when the solver successfully solves all challenges and the server endpoint verifies it (if `verify-endpoint` is specified). 

If no `verify-endpoint` is specified, it just means the solver finished its local work.

**Event Type:** `CustomEvent<{ solutions: ChallengeSolution[] }>`

```javascript
widget.addEventListener('verify', (e) => {
  const { solutions } = e.detail;
  // solutions: Array of { nonce: string, hash: string }
  console.log('Successfully completed challenge!', solutions);
});
```

## 2. `error`
Dispatched when an error occurs fetching tokens, solving them, or verifying them with the server.

**Event Type:** `CustomEvent<{ error: string }>`

The error event may also include a `timeout` boolean when `solve-timeout` is configured and solving exceeds that limit.

**Event Type (extended):** `CustomEvent<{ error: string; timeout?: boolean }>`

```javascript
widget.addEventListener('error', (e) => {
  const { error, timeout } = e.detail;
  if (timeout) {
    console.warn('CAPTCHA timed out:', error);
    return;
  }
  console.error('CAPTCHA failed:', error);
});
```

## 3. `state-change`
Dispatched every time the widget moves from one visual state to another.

**Event Type:** `CustomEvent<{ state: 'initial' | 'verifying' | 'done' | 'error' }>`

```javascript
widget.addEventListener('state-change', (e) => {
  const { state } = e.detail;
  switch (state) {
    case 'initial':
      console.log('Ready to solve');
      break;
    case 'verifying':
      console.log('Solving PoW...');
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

The React wrapper also syncs key widget props after mount, including `challengeEndpoint`, `verifyEndpoint`, `autoVerify`, `showWarning`, `warningMessage`, `solveTimeout`, and `disabled`.
