# Ribaunt

[![npm version](https://img.shields.io/npm/v/ribaunt.svg)](https://www.npmjs.com/package/ribaunt)
[![license: GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-blue.svg)](./LICENSE)

Ribaunt is a stateless proof-of-work CAPTCHA library for Node.js and modern browsers. It issues signed JWT challenges from your server, solves them in the browser, and verifies the submitted proof before you accept a form, sign-up, comment, or other sensitive action.

- Website: [ribaunt.com](https://ribaunt.com)
- Package: [npmjs.com/package/ribaunt](https://www.npmjs.com/package/ribaunt)
- Docs: [GitHub docs](https://github.com/ribaunt/ribaunt/tree/main/docs)
- Context7: [context7.com/ribaunt/ribaunt](https://context7.com/ribaunt/ribaunt)

## Features

- Stateless challenge tokens signed with your `RIBAUNT_SECRET`
- Browser widget for plain HTML apps
- React and Next.js-friendly wrapper via `ribaunt/widget-react`
- Server helpers for creating, solving, and verifying PoW challenges — `sha256` default with opt-in `argon2id` memory-hard
- Programmable risk engine (`assess()`) with caller-supplied signals, pluggable scorers, and `allow`/`challenge`/`block` policy
- Default process-local replay protection with support for remote replay stores
- CSS custom properties for theming
- TypeScript types included

## What Ribaunt does not do

Read this before relying on Ribaunt alone.

- **Ribaunt does not rate-limit your endpoints.** Nothing stops an attacker from hammering your challenge or verify endpoints themselves, no solving required. Put a rate limiter (per-IP, per-account, or WAF-level) in front of both. Ribaunt exposes optional rate-limit and telemetry hooks so you can wire your own limiter and metrics in at the point challenges are issued and verified (see `rateLimiter` and `onEvent` below).
- **Ribaunt does not prove a human is present.** It raises the cost of automated abuse. A sufficiently resourced attacker can solve any proof-of-work challenge.
- **Ribaunt is one layer, not the whole stack.** Use it behind rate limiting and risk signals, and never as the sole gate for sensitive actions such as password reset, account recovery, or payments.

## Install

```bash
npm install ribaunt
```

```bash
yarn add ribaunt
```

```bash
pnpm add ribaunt
```

## Quick Start

Set a strong secret in your server environment. Keep this server-only.
Ribaunt requires at least 32 UTF-8 bytes; generate a random value rather than a memorable password.

```env
RIBAUNT_SECRET="replace-with-a-long-random-secret"
```

> **Upgrading from v0.1:** `verifySolution()` now returns a structured result object, not a boolean. Always check `result.valid`; using the result object directly in an `if` condition is unsafe because JavaScript objects are truthy.

Create two endpoints: one to issue challenges and one to verify solutions.

```ts
import 'dotenv/config';
import express from 'express';
import { createChallenge, verifySolution } from 'ribaunt';

const app = express();

app.use(express.json());

app.get('/api/captcha/challenge', async (_req, res) => {
  const challenges = await createChallenge(5, 4, 120);
  res.json({ challenges });
});

app.post('/api/captcha/verify', async (req, res) => {
  const { tokens, solutions } = req.body;
  const result = await verifySolution(tokens, solutions);

  if (!result.valid) {
    return res.status(400).json({ success: false, error: result.reason });
  }

  return res.json({ success: true });
});

app.listen(3000);
```

Add the widget to your frontend.

```html
<script type="module" src="/node_modules/ribaunt/dist/widget-browser.js"></script>

<ribaunt-widget
  challenge-endpoint="/api/captcha/challenge"
  verify-endpoint="/api/captcha/verify"
  auto-verify="true"
  solve-timeout="15000"
></ribaunt-widget>

<script>
  const widget = document.querySelector('ribaunt-widget');

  widget.addEventListener('verify', (event) => {
    console.log('Verified:', event.detail.solutions);
  });

  widget.addEventListener('error', (event) => {
    console.error('Verification failed:', event.detail.error);
  });
</script>
```

Browser solving requires a secure context. Use HTTPS in production or `http://localhost` during development.

## React Usage

```tsx
'use client';

import RibauntWidget from 'ribaunt/widget-react';

export function ContactFormCaptcha() {
  return (
    <RibauntWidget
      challengeEndpoint="/api/captcha/challenge"
      verifyEndpoint="/api/captcha/verify"
      autoVerify={true}
      solveTimeout={15000}
      onVerify={(detail) => console.log('Verified:', detail.solutions)}
      onError={(detail) => console.error('CAPTCHA failed:', detail.error)}
    />
  );
}
```

For Next.js App Router, keep the widget in a client component. Do not expose `RIBAUNT_SECRET` with a `NEXT_PUBLIC_` prefix.

## API

### `createChallenge(difficulty, amount, ttlSeconds)`

Creates signed challenge tokens. Since the optional `rateLimiter` hook can be async, `createChallenge()` returns a `Promise`:

```ts
const challenges = await createChallenge(5, 4, 120);
```

| Parameter | Default | Description |
| --- | --- | --- |
| `difficulty` | `5` | Number of leading zeros required in the hash. Higher values increase solve time (SHA-256 `1..64`, Argon2id `1..8`). |
| `amount` | `4` | Number of challenges to create. |
| `ttlSeconds` | `30` | Challenge token lifetime in seconds. |

Validate user- or config-controlled values before passing them to `createChallenge()`. Invalid values throw.

> **API note:** the options object form defaults to a single challenge (`amount: 1`) unless you pass `amount`; only the positional form above defaults to `4`.

### `createChallenge({ difficulty: "auto", ... })`

Creates adaptive challenge tokens from a server-bounded calibration hint. Calibration is untrusted and raise-only: it can increase work for fast clients, but it never lowers the server baseline.

```ts
const challenges = await createChallenge({
  difficulty: 'auto',
  calibration: requestBody.calibration,
  targetDurationMs: 750,
  minDifficulty: 3,
  maxDifficulty: 6,
  minAmount: 1,
  maxAmount: 8,
  ttlSeconds: 60,
});
```

For machine-to-machine checks, benchmark the Node client and send the same calibration shape:

```ts
import { calibrateNode } from 'ribaunt';             // SHA-256
import { calibrateArgonNode } from 'ribaunt';        // Argon2id (memory-hard, ~6ms/hash)

const calibration = calibrateNode();
const argonCalibration = await calibrateArgonNode();
```

Browser calibration is also available from the widget entry point:

```ts
import { calibrateBrowser, calibrateArgonBrowser } from 'ribaunt/widget';

const calibration = await calibrateBrowser();
const argonCalibration = await calibrateArgonBrowser();
```

Both environments expose `calibrateClient` / `calibrateArgonClient` as cross-environment aliases:

```ts
import { calibrateClient, calibrateArgonClient } from 'ribaunt';       // Node
import { calibrateClient, calibrateArgonClient } from 'ribaunt/widget'; // browser
```

### `selectWorkload(options)`

The adaptive workload engine used internally by `createChallenge()` with `difficulty: "auto"` is also directly exported:

```ts
import { selectWorkload } from 'ribaunt';

const workload = selectWorkload({
  calibration: { iterations: 128, durationMs: 50 },
  targetDurationMs: 750,
  minDifficulty: 3,
  maxDifficulty: 6,
});
 // { difficulty: 3, amount: 5, estimatedAttempts: 20480, algorithm: 'sha256' }

// Argon2id — profile abstracts m/t/p, workload stays device-aware:
const argonWorkload = selectWorkload({
  algorithm: 'argon2id',
  argonProfile: 'mobile', // 'mobile' | 'standard' → {m:8192,t:1,p:1} (high gated)
  calibration: await calibrateArgonNode(),
  targetDurationMs: 750,
});
// { difficulty: 1, amount: 5, estimatedAttempts: 80, algorithm:'argon2id', argon:{m:8192,t:1,p:1} }
```

### `assess(options)` — Risk Engine

 Stateless, caller-driven risk assessment. All signals are caller-supplied (untrusted). Returns a bounded heuristic risk score (0–100, not a probability) and a policy action.

```ts
import { assess } from 'ribaunt';

const assessment = await assess({
  signals: {
    accountAgeSeconds: account.ageSeconds,
    requestVelocity: requestsPerMinute,
    userAgent: req.headers['user-agent'],
    ip: req.ip, // accepted for custom scorers; default scorer ignores it
  },
  // thresholds: { challenge: 40, block: 80 }, // defaults shown
  // scorer: myScorer, // optional pluggable RiskScorer
  // workload: { minDifficulty: 3, maxDifficulty: 6, targetDurationMs: 750, calibration },
});

if (assessment.action === 'allow') { /* continue */ }
else if (assessment.action === 'challenge') {
  const workload = assessment.workload!; // { difficulty, amount, estimatedAttempts } from selectWorkload()
}
else { /* block — application decides how to reject */ }
```

- `risk < challenge` → `allow` (no workload)
- `challenge ≤ risk < block` → `challenge` (with workload via existing `selectWorkload()`)
- `risk ≥ block` → `block` (no workload)

Defaults are `DEFAULT_RISK_THRESHOLDS = { challenge: 40, block: 80 }` — tune to your app; they are policy defaults, not fraud probabilities. Custom scorers (`RiskScorer { score(signals): Promise<number> }`) are `async` so you can call a remote model; invalid outputs (`NaN`/`Infinity`/`<0`/`>100`/non-number) are rejected, not clamped, and thrown errors propagate. See `docs/risk-engine.md` for the full default-scorer buckets, trust model, and limitations.

### `verifySolution(tokens, solutions, options?)`

Verifies submitted solutions and returns a structured result:
`{ valid: true }` or `{ valid: false, reason, message }`.

```ts
const result = await verifySolution(tokens, solutions, {
  onWarning: (warning) => {
    console.log('captcha warning', warning.reason, warning.message);
  },
});
```

Replay prevention defaults to `local`, which blocks token reuse in the current process. For serverless or horizontally scaled deployments, use `replayPrevention: 'remote'` with an atomic distributed store.

```ts
const result = await verifySolution(tokens, solutions, {
  replayPrevention: 'remote',
  replayStore: {
    consume: async (jti, expiresAt) => {
      // Implement with Redis/Valkey using atomic set-if-not-exists plus expiry.
      return true;
    },
  },
});
```

### `rateLimiter` hook

Ribaunt does not rate-limit anything itself — bring your own limiter. Both `createChallenge()` and `verifySolution()` accept an optional `rateLimiter: { check(key?) => Promise<boolean> }` that runs before the operation. If it returns `false`, issuance or verification is blocked with a `RateLimitedError` (`code = 'rate-limited'`) so you can catch it specifically. Errors thrown by your limiter propagate unchanged.

```ts
import { RateLimitedError } from 'ribaunt';

const rateLimiter = {
  check: async (key?: string) => (await redisBucket.hit(key ?? 'unknown')) < 10,
};

// Challenge endpoint: key the limiter on the client IP by closing over the
// request instead of passing `context`. Passing `context: req.ip` here would
// also cryptographically bind each challenge to that IP, forcing the verify
// call to pass the exact same `context` (see `verifySolution` below).
app.get('/api/captcha/challenge', async (req, res) => {
  try {
    const challenges = await createChallenge({
      difficulty: 5,
      amount: 4,
      rateLimiter,
    });
    res.json({ challenges });
  } catch (error) {
    if (error instanceof RateLimitedError) {
      return res.status(429).json({ error: 'Too many challenge requests' });
    }
    throw error;
  }
});
```

> **Context binding:** if you *do* pass `context` to `createChallenge()`, every challenge token is bound to that context via an HMAC digest. You must then pass the identical `context` to `verifySolution()` or verification fails with `context-mismatch`. Use `context` for binding a challenge to a specific action (e.g. one signup attempt), not for rate limiting.

### `onEvent` telemetry hook

Both entry points accept an optional synchronous `onEvent` callback for structured lifecycle events. It is fire-and-forget: a throwing consumer can never break challenge issuance or verification.

```ts
const counts = { issued: 0, success: 0, failure: 0 };

const onEvent = (event: RibauntEvent) => {
  if (event.type === 'challenge-issued') counts.issued += 1;
  else if (event.type === 'verify-success') counts.success += 1;
  else if (event.type === 'verify-failure') counts.failure += 1;
};

await createChallenge({ difficulty: 5, amount: 4, onEvent });
const result = await verifySolution(tokens, solutions, { onEvent });
```

`verify-failure` events carry the same `reason` values as `VerifySolutionResult` (`invalid-token`, `expired-token`, `invalid-solution`, `context-mismatch`, `replay-detected`, `replay-store-unavailable`, `configuration-error`). Add aggregation over Windows, StatsD, or Prometheus yourself — Ribaunt only emits raw events.

### `solveChallenge(token, options?)` / `solveChallengeAsync(token, options?)`

`solveChallenge` solves SHA-256 challenges synchronously. This is mainly useful for tests and debugging. For `argon2id` (or mixed batches) use the async variant — it auto-detects `payload.alg` per token:

```ts
const solutions = solveChallenge(challenges, { // sha256 only, returns undefined for argon
  maxDurationMs: 2000,
  maxIterations: 500_000,
});
const solutions2 = await solveChallengeAsync(challenges); // sha256 and argon2id
```

Browser entry points expose the same auto-detecting `solveChallenge` / `solveSingleChallenge` via `ribaunt/widget` (Web Crypto for SHA, `hash-wasm` `argon2id` for Argon) and `calibrateArgonBrowser`. Worker mode auto-selects `backend: 'argon2id'` for Argon tokens.

### Proof-of-Work Algorithm — `argon2id` opt-in

Default remains `sha256` (microsecond hashes, cheap verify). Opt in to memory-hard Argon2id for higher attacker cost:

```ts
const challenges = await createChallenge({
  algorithm: 'argon2id',
  argonProfile: 'mobile', // 'mobile' | 'standard' → {m:8192,t:1,p:1,hashLen:32} (HARD_MAX m=32768 t=3)
  difficulty: 'auto',
  calibration: await calibrateArgonNode(), // must match algorithm (sha cal ≠ argon cal)
  targetDurationMs: 750,
  minDifficulty: 1, maxDifficulty: 2, // argon caps at 8, defaults 1..2 (sha 3..6)
});
 // tokens carry {alg:'argon2id',m,t,p,hashLen} and verify auto-dispatches
await verifySolution(tokens, await solveChallengeAsync(tokens));
```

`HARD_MAX` (`m=32768 t=3 p=1`) is library-enforced. `argonProfile` abstracts `m/t/p` so developers never pass raw memory params — the adaptive engine keeps it device-aware via `riskScore` + `calibration`. `assess({workload:{algorithm:'argon2id', argonProfile:'mobile'}})` threads the profile through. Demo: `demo/argon.html` (`pnpm demo` → `http://localhost:3000/argon.html`, `Network` shows real `/api/challenge/argon` when server is running, otherwise mock fallback).

**Performance (measured via `bench/memory-hard-server.ts` `hash-wasm@4.12.0`):** Argon mobile `~6ms/hash` Node, `~12ms` browser; `difficulty:1` ≈ `16` avg attempts → `~400ms` browser, `difficulty:2` → `256` avg → `~3s` (× `amount`). Use `difficulty:'auto'` with `calibrateArgonBrowser` for `~750ms` target. `high` profile is gated (Stage D).

```ts
// Risk-aware Argon
const a = await assess({ signals:{requestVelocity:120}, workload:{algorithm:'argon2id', argonProfile:'mobile'} });
if (a.action==='challenge') await createChallenge({...a.workload, algorithm:'argon2id'});
```

## Widget Configuration

```html
<ribaunt-widget
  challenge-endpoint="/api/captcha/challenge"
  verify-endpoint="/api/captcha/verify"
  auto-verify="true"
  challenge-method="POST"
  calibrate="true"
  show-warning="false"
  warning-message="Verification may take longer on this device."
  solve-timeout="15000"
  worker-mode="preferred"
  wasm-mode="preferred"
  disabled="false"
></ribaunt-widget>
```

| HTML attribute | React prop | Description |
| --- | --- | --- |
| `challenge-endpoint` | `challengeEndpoint` | Endpoint that returns `{ challenges: string[] }`. |
| `verify-endpoint` | `verifyEndpoint` | Endpoint that accepts `{ tokens, solutions }`. |
| `auto-verify` | `autoVerify` | Starts verification when the widget loads. |
| `challenge-method` | `challengeMethod` | Use `POST` when sending calibration to an auto-hardness endpoint. |
| `calibrate` | `calibrate` | Benchmarks the browser and sends `{ calibration }` with POST challenge requests. |
| `show-warning` | `showWarning` | Shows a warning banner. |
| `warning-message` | `warningMessage` | Custom warning text. |
| `show-progress` | `showProgress` | Set to `"false"` to swap the percentage ring for a plain bars spinner with a static `Loading...` label. |
| `solve-timeout` | `solveTimeout` | Optional timeout in milliseconds for the whole verification attempt (fetching, solving, and verifying). |
| `worker-mode` | `workerMode` | Web Worker solving: `preferred` (default; falls back to the main thread), `required` (fail if unavailable), or `disabled`. |
| `wasm-mode` | `wasmMode` | WASM solver: `preferred` (default; uses WASM batch solver inside worker if available), `disabled` (always use JS solver inside worker). Independent from `worker-mode`. |
| `disabled` | `disabled` | Blocks user interaction and automatic verification. |
| | `fallback` | React-only. Custom loading element while widget dynamic import loads. Defaults to a built-in shimmer skeleton. |

The recommended challenge response shape is:

```json
{ "challenges": ["jwt-token-1", "jwt-token-2"] }
```

The widget also accepts `{ "tokens": [...] }` and raw string arrays for compatibility.

## Theming

Customize the widget with CSS custom properties.

```css
ribaunt-widget {
  --ribaunt-background: #ffffff;
  --ribaunt-border-color: #d8dee4;
  --ribaunt-border-radius: 10px;
  --ribaunt-color: #111827;
  --ribaunt-widget-width: 260px;
  --ribaunt-spinner-color: #111827;
}
```

See [theming docs](https://github.com/ribaunt/ribaunt/blob/main/docs/theming.md) for the full variable list.

## Documentation

- [Quick start](https://github.com/ribaunt/ribaunt/blob/main/docs/quick-start.md)
- [Configuration](https://github.com/ribaunt/ribaunt/blob/main/docs/configuration.md)
- [Risk Engine](https://github.com/ribaunt/ribaunt/blob/main/docs/risk-engine.md)
- [Events](https://github.com/ribaunt/ribaunt/blob/main/docs/events.md)
- [HTML integration](https://github.com/ribaunt/ribaunt/blob/main/docs/integrations/html.md)
- [React integration](https://github.com/ribaunt/ribaunt/blob/main/docs/integrations/react.md)
- [Next.js integration](https://github.com/ribaunt/ribaunt/blob/main/docs/integrations/nextjs.md)
- [Vue integration](https://github.com/ribaunt/ribaunt/blob/main/docs/integrations/vue.md)
- [Express server example](https://github.com/ribaunt/ribaunt/blob/main/docs/server/express.md)
- [Next.js route handlers](https://github.com/ribaunt/ribaunt/blob/main/docs/server/nextjs-api.md)
- [Testing](https://github.com/ribaunt/ribaunt/blob/main/docs/testing.md)

You can also ask documentation-aware tools to use the Context7 library ID:

```text
/ribaunt/ribaunt
```

## Development

```bash
corepack enable
pnpm install
pnpm test
pnpm run build
```

## License

GPL-3.0-only. See [LICENSE](./LICENSE).
