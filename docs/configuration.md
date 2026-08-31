# Configuration & Options

Ribaunt CAPTCHA has a number of configuration options to fine-tune the user experience and solver difficulty.

## Server-Side: `createChallenge`

The main function on the server side dictates how long the challenge takes to solve.

```typescript
import { createChallenge } from 'ribaunt';

// Signature
// createChallenge(difficulty: number, amount: number, ttlSeconds: number): Promise<string[]>
// createChallenge(options: ChallengeOptions): Promise<string[]>
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `difficulty` | `number` | `5` | Number of leading zeros required in the hash. Higher values exponentially increase solve time. SHA-256 `1..64` (values `>6` may hang browsers); Argon2id `1..8` (defaults `1..2`). |
| `amount` | `number` | `4` | Number of individual PoW challenges generated at once. Distributes solving workload but requires more network bandwidth. |
| `ttlSeconds` | `number` | `30` | Expiration time of the JWT token. Rejects solutions submitted after this threshold. |
| `algorithm` | `'sha256' \| 'argon2id'` | `'sha256'` | PoW algorithm. `argon2id` is memory-hard (`hash-wasm@4.12.0`, `m=8192 t=1 p=1` via `argonProfile`). Opt-in `demo/argon.html` (`pnpm demo`). |
| `argonProfile` | `'mobile' \| 'standard'` | `'mobile'` | Only when `algorithm:'argon2id'`. Abstracts `m/t/p` (`{m:8192,t:1,p:1,hashLen:32}`, `HARD_MAX m=32768 t=3`). Never pass raw `m/t/p`. |

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
const challenges = await createChallenge({
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

Calibration is available in both server and browser environments:

```typescript
import { calibrateNode, calibrateArgonNode } from 'ribaunt';       // Node.js server-side
import { calibrateBrowser, calibrateArgonBrowser } from 'ribaunt/widget';  // Browser (Web Crypto vs hash-wasm)
```

Both exports also expose `calibrateClient` / `calibrateArgonClient` as cross-environment aliases for convenience. **Use the matching calibrator for the algorithm** (`sha` cal ≠ `argon` cal) — mismatched calibration will over/under-estimate. Bundlers resolve the correct implementation automatically via the package export map.

```typescript
import { calibrateClient, calibrateArgonClient } from 'ribaunt';     // Node.js
import { calibrateClient, calibrateArgonClient } from 'ribaunt/widget'; // browser (when bundling for the client)
```

### Auto Hardness Options

When using `difficulty: "auto"`, the following `ChallengeOptions` fields are available:

| Option | Type | Default | Description |
|---|---|---|---|
| `algorithm` | `'sha256' \| 'argon2id'` | `'sha256'` | When `'argon2id'`, uses `argonProfile` (`m=8192 t=1`) and caps `difficulty` to `1..8` (defaults `1..2`). |
| `argonProfile` | `'mobile' \| 'standard'` | `'mobile'` | Only with `algorithm:'argon2id'`. `high` (`m=32768 t=3`) is gated (Stage D). |
| `targetDurationMs` | `number` | `750` | Desired solve time in milliseconds. |
| `riskScore` | `number` | `50` | Server-side risk appetite (0–100). Higher values prefer more work within bounds, independent of calibration. |
| `calibration` | `ClientCalibration` | `undefined` | Untrusted client benchmark. Raise-only: can increase work above the server baseline, never below. **Must match `algorithm`** (`calibrateNode` vs `calibrateArgonNode`). |
| `minDifficulty` | `number` | `3` (`1` for argon) | Minimum difficulty floor. |
| `maxDifficulty` | `number` | `6` (`2` for argon) | Maximum difficulty ceiling. |
| `minAmount` | `number` | `1` | Minimum challenge amount. |
| `maxAmount` | `number` | `8` | Maximum challenge amount. |

### `selectWorkload(options)`

The adaptive engine is also exposed directly for advanced use cases, such as pre-computing workload before calling `createChallenge()`:

```typescript
import { selectWorkload } from 'ribaunt';

const workload = selectWorkload({
  calibration: { iterations: 128, durationMs: 50 },
  targetDurationMs: 750,
  minDifficulty: 3,
  maxDifficulty: 6,
  minAmount: 1,
  maxAmount: 8,
});
// { difficulty: 3, amount: 5, estimatedAttempts: 20480 }
```

Returns a `Workload` object with `{ difficulty, amount, estimatedAttempts, algorithm, argon? }`. This is the same function `createChallenge()` calls internally when `difficulty` is `"auto"`. For `argon2id`, `argon:{m,t,p}` is included and `profile` is device-aware.

### `assess(options)` — Risk Engine (optional policy layer)

V1 is deliberately small, stateless, and caller-driven. No IP reputation, fingerprinting, or storage is added. See `docs/risk-engine.md` for the full trust model.

```ts
import { assess, DEFAULT_RISK_THRESHOLDS, type RiskSignals } from 'ribaunt';

const assessment = await assess({
  signals: {
    accountAgeSeconds: 3600,
    requestVelocity: 12, // your own req/min counter
    userAgent: req.headers['user-agent'],
    ip: req.ip, // optional — default scorer ignores it
    tier: 'free', // custom keys allowed via index signature
  } as RiskSignals,
  thresholds: { challenge: 40, block: 80 }, // defaults if omitted
  workload: { minDifficulty: 3, maxDifficulty: 6, targetDurationMs: 750, calibration },
  scorer: myScorer, // optional — see below
});

// assessment: { risk: number, action: 'allow' | 'challenge' | 'block', workload?: Workload }
```

**Semantics:** `risk < challenge → allow`, `challenge ≤ risk < block → challenge`, `risk ≥ block → block`. When `challenge`, `workload` is a reusable `selectWorkload({ riskScore: risk, ...workload })` result. Invalid thresholds (`0 ≤ challenge < block ≤ 100`, finite) are rejected, not repaired. `DEFAULT_RISK_THRESHOLDS` is frozen — mutation does not affect later `assess()` calls (thresholds are copied). `riskScore` inside `workload` is ignored/overridden. Workload bounds are validated with documented upper bounds (`1 ≤ difficulty ≤ 64`, `1 ≤ amount ≤ 64`, candidate count ≤ 10 000) to bound the search before `selectWorkload()` is called.

**Default scorer** (transparent, deterministic, CPU-only, `O(1)`): `age 0–30 + velocity 0–40 + UA 0–10 + ip 0 → clamp 0..100`. Buckets documented in `docs/risk-engine.md` and `src/risk.ts`. Unknown keys are ignored; malformed numbers are ignored; very large values saturate. To change policy, provide a custom `RiskScorer`:

```ts
import type { RiskScorer } from 'ribaunt';
const scorer: RiskScorer = {
  async score(signals) {
    return signals.isInternal ? 0 : 75;
  },
};
await assess({ signals, scorer });
```

Custom scorers may be async/remote; errors propagate, and outputs outside finite `0..100` are rejected (not clamped).

**Compatibility:** existing `riskScore` on `createChallenge({ difficulty: 'auto', riskScore: 80 })` stays unchanged. `assess()` is additive — pair `assessment.workload` with `createChallenge({ workload })` or with `riskScore: assessment.risk`. `createChallenge()` never calls `assess()` implicitly.

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
    // warning.reason: invalid-token | expired-token | invalid-solution | context-mismatch
    //                 | replay-detected | replay-store-unavailable | configuration-error
    console.log('captcha-warning', warning.reason, warning.message);
  },
});
```

## Server-Side: `solveChallenge` (sync) / `solveChallengeAsync` (async)

`solveChallenge()` is provided mainly for testing/debugging flows and supports optional guardrails to prevent long synchronous runs. It solves `sha256` only and returns `undefined` for `argon2id` tokens. Use `solveChallengeAsync()` for both algorithms (auto-detects `payload.alg` per token):

| Option | Type | Default | Description |
|---|---|---|---|
| `maxIterations` | `number` | `undefined` | Optional hard cap on attempted nonces per token. Returns `undefined` if reached. |
| `maxDurationMs` | `number` | `30000` | Maximum synchronous solve time per token before returning `undefined`. |

```typescript
const solution = solveChallenge(token, { // sha256 only
  maxDurationMs: 2000,
  maxIterations: 500_000,
});
const solution2 = await solveChallengeAsync(tokens); // sha256 and argon2id
```

Browser entry points (`ribaunt/widget` `solveChallenge`/`solveSingleChallenge`) auto-detect `alg` per token (Web Crypto SHA vs `hash-wasm` Argon) and `calibrateArgonBrowser` is available alongside `calibrateBrowser`.

### Proof-of-Work Algorithm — `argon2id` opt-in

Default remains `sha256` (microsecond hashes, cheap verify). For higher attacker memory cost, opt in to `argon2id`:

```typescript
const challenges = await createChallenge({
  algorithm: 'argon2id',
  argonProfile: 'mobile', // 'mobile' | 'standard' → {m:8192,t:1,p:1,hashLen:32}
  difficulty: 'auto',
  calibration: await calibrateArgonNode(), // must match algorithm
  targetDurationMs: 750,
  minDifficulty: 1, maxDifficulty: 2, // argon caps at 8, defaults 1..2
});
await verifySolution(tokens, await solveChallengeAsync(tokens)); // auto-dispatches
```

* `HARD_MAX` (`m=32768 t=3 p=1 hashLen=32`) is library-enforced. `high` profile is gated (Stage D, see `bench/BROWSERSTACK.md`).
* `argonProfile` abstracts `m/t/p` — never pass raw memory params. The adaptive engine (`riskScore` + `calibration`) keeps it device-aware, same as SHA.
* `assess({workload:{algorithm:'argon2id', argonProfile:'mobile'}})` threads the profile through; `verifySolution` needs no flag (payload carries `alg/m/t/p`).
* **Performance:** `bench/memory-hard-server.ts` (`hash-wasm@4.12.0`) mobile `~6ms/hash` Node (`~12ms` browser); `difficulty:1` ≈ `16` avg attempts → `~400ms` browser, `difficulty:2` → `256` avg → `~3s` (`×amount`). Use `difficulty:'auto'` with `calibrateArgonBrowser` for `~750ms` target. Demo: `demo/argon.html` (`pnpm demo` → `http://localhost:3000/argon.html`).
* **Worker:** `solver-worker.ts` auto-detects `alg` per batch, reports `backend:'argon2id'` (vs `'wasm'|'js'` for SHA). No `wasm-mode` tuning needed for Argon; `hash-wasm` WASM is base64-bundled (`demo/lib/hash-wasm.js` for static demo, `importmap` `hash-wasm` → `./lib/hash-wasm.js`).

```typescript
const a = await assess({ signals:{requestVelocity: 120}, workload:{algorithm:'argon2id', argonProfile:'mobile'} });
if (a.action==='challenge') await createChallenge({...a.workload, algorithm:'argon2id'});
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
| `show-progress` | `showProgress` | `boolean\|string` | `true` | Set to `"false"` to switch to the secondary loader: a plain bars spinner with a static `Loading...` label instead of the conic progress ring and percentage counter. Progress is still tracked and reported through events. |
| `solve-timeout` | `solveTimeout` | `number\|string` | `undefined` | Optional timeout in milliseconds for the whole verification attempt — fetching, solving, and verifying. If omitted, the attempt is not automatically timed out. |
| `worker-mode` | `workerMode` | `'preferred'\|'required'\|'disabled'` | `'preferred'` | Controls Web Worker solving. `preferred` falls back to main-thread solving when workers are unavailable; `required` fails with `worker-unavailable`; `disabled` always solves on the main thread. Unknown values fall back to `preferred` with a console warning. |
| `wasm-mode` | `wasmMode` | `'preferred'\|'disabled'` | `'preferred'` | Controls WASM batch solver inside worker. `preferred` uses WASM when available (transparent fallback to JS within worker); `disabled` always uses JS solver inside worker. Independent from `worker-mode`. Unknown values fall back to `preferred` with a warning. |
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
  worker-mode="preferred"
  wasm-mode="preferred"
  disabled="false"
></ribaunt-widget>
```

### WASM Solver

The browser solver now ships with an optional WebAssembly-backed SHA-256 batch solver for higher throughput. By default `wasm-mode="preferred"` the worker attempts to load `dist/ribaunt-solver.wasm` via `new URL('./ribaunt-solver.wasm', import.meta.url)` and runs a batched hash loop (`solve_batch`) amortizing JS/WASM call overhead. If WASM is unavailable (WebAssembly disabled, asset fetch failure, CSP blocking `wasm-unsafe-eval`, or instantiation failure) the worker transparently falls back to the existing JS/WebCrypto solver without protocol changes.

For `argon2id`, the worker uses `hash-wasm@4.12.0` (`argon2id` base64 WASM, `demo/lib/hash-wasm.js` for static demos, `importmap` `hash-wasm` → `./lib/hash-wasm.js`). It is not covered by `wasm-mode` (which controls SHA WASM only) and reports `backend:'argon2id'`.

- `worker-mode` and `wasm-mode` are orthogonal: `worker-mode` controls worker availability, `wasm-mode` controls WASM inside a healthy worker.
- `wasm-mode="disabled"` forces JS solver inside worker; useful for debugging or restrictive CSP deployments.
- Batch size is an internal implementation detail (default 1024) tuned via `bench/wasm-vs-js.ts` benchmarks.
- Cancellation is observed at batch boundaries; worst-case latency is one batch.
- The WASM binary is built reproducibly from `src/wasm/solver.ts` via `scripts/build-wasm.mjs` using the pinned `assemblyscript` toolchain. No third-party binary is fetched at runtime.

**CSP / Bundling:** WASM loading may require `script-src` to allow `wasm-unsafe-eval` in strict CSP deployments and `connect-src`/`script-src` access to the `.wasm` asset. Vite, Next.js, and native ESM all handle `new URL(..., import.meta.url)` assets; verify your bundler preserves the sibling `.wasm` file (pnpm pack includes it; check `dist/ribaunt-solver.wasm` exists).

To disable WASM entirely: `<ribaunt-widget wasm-mode="disabled">` or `wasmMode="disabled"` in React. To observe backend selection, listen for `solver-backend` DOM event: `widget.addEventListener('solver-backend', e => console.log(e.detail.backend))` (`wasm`|`js`|`argon2id`). Telemetry never includes challenge contents.

### Secondary Loader: `show-progress="false"`

The primary spinner is a conic progress ring paired with a live percentage (`Solving... 42%`). For a quieter experience you can hide the completion rate entirely:

```html
<ribaunt-widget
  challenge-endpoint="/api/challenge"
  verify-endpoint="/api/verify"
  show-progress="false"
></ribaunt-widget>
```

With `show-progress="false"` the widget switches to the secondary design: a 12-bar pulse spinner inside the checkbox and a static `Loading...` label during fetching, solving, and verifying. The progress number is no longer rendered, but it is still reported in `state-change` event details so telemetry and analytics keep working.

## React: `RibauntWidget` Props and Callbacks

When using the React wrapper (`ribaunt/widget-react`), all HTML attributes above are available as camelCase props. Additionally, you can use typed callback props:

| Prop | Type | Description |
|---|---|---|
| `challengeEndpoint` | `string` | (HTML: `challenge-endpoint`) |
| `verifyEndpoint` | `string` | (HTML: `verify-endpoint`) |
| `autoVerify` | `boolean\|string` | (HTML: `auto-verify`) |
| `showWarning` | `boolean\|string` | (HTML: `show-warning`) |
| `warningMessage` | `string` | (HTML: `warning-message`) |
| `showProgress` | `boolean\|string` | (HTML: `show-progress`) |
| `solveTimeout` | `number\|string` | (HTML: `solve-timeout`) |
| `wasmMode` | `WasmMode` | (HTML: `wasm-mode`) `preferred`\|`disabled` |
| `disabled` | `boolean\|string` | (HTML: `disabled`) |
| `onVerify` | `(detail) => void` | Fired when verification succeeds |
| `onError` | `(detail) => void` | Fired when an error occurs |
| `onStateChange` | `(detail) => void` | Fired when state changes |
| `onReady` | `(detail) => void` | Fired once after widget mounts (React-only) |
| `onLoad` | `(detail) => void` | Alias for onReady (React-only) |
| `onEvent` | `(type, detail) => void` | Catch-all for all event types |
| `ref` | `React.Ref<RibauntWidgetHandle>` | Imperative handle for `reset()`, `getState()`, `startVerification()` |
| `fallback` | `React.ReactNode` | Custom loading element while the widget's dynamic import loads. Defaults to a built-in shimmer skeleton. |
