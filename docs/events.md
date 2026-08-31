# Events Reference

The Ribaunt CAPTCHA widget emits four standard DOM events (`CustomEvent`) that notify you of the lifecycle and results.
It also emits an initial `state-change` event immediately after the widget mounts with one of these states:
`initial`, `fetching`, `solving`, `verifying`, `done`, `error`.

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
| `timeout` | The attempt exceeded the configured `solve-timeout` (covers fetching, solving, and verifying). |
| `aborted` | Solving was cancelled (e.g. widget reset). |
| `challenge-fetch-failed` | Challenge endpoint request failed. |
| `invalid-challenge` | Challenge response had an unexpected shape. |
| `solve-failed` | Solving produced no valid nonce. |
| `verification-failed` | Server verify endpoint rejected the solution. |
| `worker-unavailable` | Web Worker solver is not available (and `worker-mode="required"`). |
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
    case 'fetching':
      console.log('Fetching challenge...');
      break;
    case 'solving':
      console.log(`Solving PoW... ${progress}%`);
      break;
    case 'verifying':
      console.log('Verifying with server...');
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

- **`onEvent`**: Fires for all events with the event type (`'verify'`, `'error'`, `'state-change'`, `'solver-backend'`, or `'ready'`) and its detail. This is a catch-all handler that can be used instead of individual callbacks.

The React wrapper also syncs all widget props after mount, including `challengeEndpoint`, `verifyEndpoint`, `autoVerify`, `challengeMethod`, `calibrate`, `showWarning`, `warningMessage`, `solveTimeout`, `showProgress`, `workerMode`, `wasmMode`, and `disabled`. `solver-backend` now also emits `argon2id` for memory-hard challenges (worker auto-detects `payload.alg`).

## 4. `solver-backend`
Dispatched once per solve request when the worker selects its solving backend. Useful for adoption telemetry and A/B benchmarking. Never includes challenge contents, nonces, or hashes.

**Event Type:** `CustomEvent<{ backend: 'wasm' | 'js' | 'argon2id'; phase: 'solving' }>`

```javascript
widget.addEventListener('solver-backend', (e) => {
  console.log('Using backend:', e.detail.backend);
});
```

In React you can also listen via `onEvent` or directly via `addEventListener` on the element. The event is fired after the worker chooses `wasm` (when `wasm-mode="preferred"` and WebAssembly loads), `js` (when disabled or unavailable), or `argon2id` (for `algorithm:'argon2id'` challenges, via `hash-wasm` — not controlled by `wasm-mode`). No `solver-backend` is emitted when `worker-mode="preferred"` falls back to main-thread JS; `error` with `worker-unavailable` is only emitted when `worker-mode="required"` and the worker is unavailable.
