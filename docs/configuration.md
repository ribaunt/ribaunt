# Configuration & Options

Ribaunt CAPTCHA has a number of configuration options to fine-tune the user experience and solver difficulty.

## Server-Side: `createChallenge`

The main function on the server side dictates how long the challenge takes to solve.

```typescript
import { createChallenge } from 'ribaunt';

// Signature
// createChallenge(difficulty: number, amount: number, ttlSeconds: number): string[]
// createChallenge(options: ChallengeOptions): string[]
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `difficulty` | `number` | `5` | The number of leading zeros required in the SHA-256 hash. Higher values exponentially increase solve time. Values `> 6` may cause browsers to hang. |
| `amount` | `number` | `4` | Number of individual PoW challenges generated at once. Distributes solving workload but requires more network bandwidth. |
| `ttlSeconds` | `number` | `30` | Expiration time of the JWT token. Rejects solutions submitted after this threshold. |

### Validation Rules

`createChallenge()` now validates its numeric inputs at runtime.

- `difficulty` must be a finite number and at least `1`
- `amount` must be a finite number and at least `1`
- `ttlSeconds` must be a finite number and at least `1`
- fractional values are rounded down with `Math.floor()`

### Recommended Settings
- **Fast / Background:** `createChallenge(4, 4, 30)` - takes milliseconds
- **Moderate / Form Submission:** `createChallenge(5, 4, 60)` - takes ~1 second
- **High / Sensitive Actions:** `createChallenge(5, 8, 120)` - takes ~2 seconds

> **Warning:** Do not let users control `difficulty`, `amount`, or `ttlSeconds` without validation.

### Auto Hardness

Use `difficulty: "auto"` to adapt challenge work from a client benchmark while keeping the server in control.

```typescript
const challenges = createChallenge({
  difficulty: 'auto',
  calibration: body.calibration,
  targetDurationMs: 750,
  minDifficulty: 3,
  maxDifficulty: 6,
  minAmount: 1,
  maxAmount: 8,
  ttlSeconds: 60,
});
```

Calibration is self-reported and must be treated as untrusted. Ribaunt uses it as a raise-only hint: a fast calibration can increase work up to your maximums, but a slow or fake calibration cannot lower the server-owned baseline.

For Node or machine-to-machine clients:

```typescript
import { calibrateNode } from 'ribaunt';

const calibration = calibrateNode();
```

## Server-Side: `verifySolution` (async)

`verifySolution()` is asynchronous and supports optional replay-prevention modes.
When `context` is supplied, the challenge must have been created with the same context; unbound tokens are rejected.

```typescript
import { verifySolution } from 'ribaunt';

// Signature
// verifySolution(tokens, nonceOrSolutions, options?): Promise<VerifySolutionResult>
```

| Option | Type | Default | Description |
|---|---|---|---|
| `replayPrevention` | `'disabled' \| 'local' \| 'remote'` | `'local'` | `local` blocks token reuse in the current process, `remote` uses your custom distributed store, and `disabled` is a legacy opt-out. |
| `replayStore` | `{ consume(jti, expiresAt): Promise<boolean> }` | `undefined` | Required when `replayPrevention` is `remote`. Should perform atomic consume semantics (for example Redis `SET NX EX`). |
| `debug` | `boolean` | environment-based | Enables verification warnings for malformed/invalid submissions. |
| `onWarning` | `(warning) => void` | `undefined` | Optional callback for structured warning events (for example `invalid-token`, `replay-detected`, `invalid-solution`). Useful for telemetry while keeping production logging quiet. |

### Replay Modes

- `local` (default): replay checks are process-local and block repeated valid submissions in single-process deployments.
- `remote`: replay checks use your distributed store and are recommended for serverless or multi-instance setups.
- `disabled`: legacy opt-out with no replay checks; repeated valid submissions can still pass during token TTL. Use only if another layer handles replay.

### Migration Note

Current versions default to process-local replay protection. If you depended on the previous replayable behavior, pass `replayPrevention: 'disabled'` explicitly while you migrate. For production serverless or horizontally scaled deployments, prefer `remote` with an atomic store such as Redis/Valkey `SET NX EX`.

```typescript
const result = await verifySolution(tokens, solutions, {
  replayPrevention: 'remote',
  replayStore: {
    consume: async (jti, expiresAt) => {
      // Implement this with Redis/Valkey using an atomic "set if not exists" + expiry.
      return true;
    },
  },
});
```

### Optional Verification Warnings

`verifySolution()` returns `{ valid: false, reason, message }` for invalid inputs. You can also capture warning callbacks without enabling console logs:

```typescript
await verifySolution(tokens, solutions, {
  debug: false,
  onWarning: (warning) => {
    // warning.reason: invalid-token | expired-token | invalid-solution | replay-detected | configuration-error
    console.log('captcha-warning', warning.reason, warning.message);
  },
});
```

## Server-Side: `solveChallenge` (sync utility)

`solveChallenge()` is provided mainly for testing/debugging flows and supports optional guardrails to prevent long synchronous runs.

| Option | Type | Default | Description |
|---|---|---|---|
| `maxIterations` | `number` | `undefined` | Optional hard cap on attempted nonces per token. Returns `undefined` if reached. |
| `maxDurationMs` | `number` | `30000` | Maximum synchronous solve time per token before returning `undefined`. |

```typescript
const solution = solveChallenge(token, {
  maxDurationMs: 2000,
  maxIterations: 500_000,
});
```

## Client-Side: `RibauntWidget` Attributes

The `<ribaunt-widget>` web component exposes several standard HTML attributes. When using the React wrapper (`ribaunt/widget-react`), map these as camelCase props (`showWarning`).

## Browser Requirements

The browser solver depends on the Web Crypto API. That means client-side solving should be run in a secure context:

- `https://...`
- `http://localhost`

Plain LAN URLs such as `http://192.168.x.x` may not expose `crypto.subtle`, especially on mobile browsers.

| Attribute | React Prop | Type | Default | Description |
|---|---|---|---|---|
| `challenge-endpoint` | `challengeEndpoint` | `string` | `undefined` | URL endpoint that returns the JWT tokens. If undefined, the widget cannot auto-fetch. |
| `verify-endpoint` | `verifyEndpoint` | `string` | `undefined` | URL endpoint to POST the solutions. If undefined, you must handle verification manually using the solver directly. |
| `auto-verify` | `autoVerify` | `boolean\|string` | `false` | Starts verification automatically once the widget loads. Set to `"false"` or omit it to require user interaction or `startVerification()`. |
| `challenge-method` | `challengeMethod` | `'GET'\|'POST'` | `'GET'` | Use `POST` when your challenge endpoint accepts calibration for `difficulty: "auto"`. |
| `calibrate` | `calibrate` | `boolean\|string` | `false` | Sends `{ calibration }` with POST challenge requests. |
| `show-warning` | `showWarning` | `boolean\|string` | `false` | Shows a red warning banner above the widget. Often used to alert users if WebAssembly is missing for future fast-solvers. |
| `warning-message` | `warningMessage` | `string` | `"Enable WASM..."` | Custom message text for the warning banner. |
| `solve-timeout` | `solveTimeout` | `number\|string` | `undefined` | Optional timeout in milliseconds for solving. If omitted, solving is not automatically timed out. |
| `disabled` | `disabled` | `boolean\|string` | `false` | Disables user interaction and programmatic verification while set. |

### Challenge Endpoint Response Shapes

The widget currently supports these response formats from `challenge-endpoint`:

- `{ challenges: string[] }` (recommended contract)
- `{ tokens: string[] }` (legacy compatibility)
- `string[]` (legacy compatibility)

Invalid or mixed-type token arrays now fail fast with a clear widget error event.

### Disabled Behavior

When `disabled` is present and not equal to `"false"`:

- click interaction is blocked
- keyboard activation is blocked
- `startVerification()` does nothing
- `auto-verify` will not start while the widget is disabled
- the widget is removed from tab order
- `aria-disabled="true"` is applied for accessibility

### Example

```html
<ribaunt-widget
  challenge-endpoint="https://api.myapp.com/challenge"
  verify-endpoint="https://api.myapp.com/verify"
  challenge-method="POST"
  calibrate="true"
  auto-verify="true"
  show-warning="true"
  warning-message="WASM is disabled; this may take 3x longer!"
  solve-timeout="15000"
  disabled="false"
></ribaunt-widget>
```

## React: `RibauntWidget` Props and Callbacks

When using the React wrapper (`ribaunt/widget-react`), all HTML attributes above are available as camelCase props. Additionally, you can use typed callback props:

| Prop | Type | Description |
|---|---|---|
| `challengeEndpoint` | `string` | (HTML: `challenge-endpoint`) |
| `verifyEndpoint` | `string` | (HTML: `verify-endpoint`) |
| `autoVerify` | `boolean\|string` | (HTML: `auto-verify`) |
| `showWarning` | `boolean\|string` | (HTML: `show-warning`) |
| `warningMessage` | `string` | (HTML: `warning-message`) |
| `solveTimeout` | `number\|string` | (HTML: `solve-timeout`) |
| `disabled` | `boolean\|string` | (HTML: `disabled`) |
| `onVerify` | `(detail) => void` | Fired when verification succeeds |
| `onError` | `(detail) => void` | Fired when an error occurs |
| `onStateChange` | `(detail) => void` | Fired when state changes |
| `onReady` | `(detail) => void` | Fired once after widget mounts (React-only) |
| `onLoad` | `(detail) => void` | Alias for onReady (React-only) |
| `onEvent` | `(type, detail) => void` | Catch-all for all event types |
| `ref` | `React.Ref<RibauntWidgetHandle>` | Imperative handle for `reset()`, `getState()`, `startVerification()` |
