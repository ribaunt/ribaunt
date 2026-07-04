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
- Server helpers for creating, solving, and verifying PoW challenges
- Default process-local replay protection with support for remote replay stores
- CSS custom properties for theming
- TypeScript types included

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

app.get('/api/captcha/challenge', (_req, res) => {
  const challenges = createChallenge(5, 4, 120);
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

Creates signed challenge tokens.

```ts
const challenges = createChallenge(5, 4, 120);
```

| Parameter | Default | Description |
| --- | --- | --- |
| `difficulty` | `5` | Number of leading zeros required in the SHA-256 hash. Higher values increase solve time. |
| `amount` | `4` | Number of challenges to create. |
| `ttlSeconds` | `30` | Challenge token lifetime in seconds. |

Validate user- or config-controlled values before passing them to `createChallenge()`. Invalid values throw.

### `createChallenge({ difficulty: "auto", ... })`

Creates adaptive challenge tokens from a server-bounded calibration hint. Calibration is untrusted and raise-only: it can increase work for fast clients, but it never lowers the server baseline.

```ts
const challenges = createChallenge({
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
import { calibrateNode } from 'ribaunt';

const calibration = calibrateNode();
```

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

### `solveChallenge(token, options?)`

Solves challenges synchronously. This is mainly useful for tests and debugging.

```ts
const solutions = solveChallenge(challenges, {
  maxDurationMs: 2000,
  maxIterations: 500_000,
});
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
| `solve-timeout` | `solveTimeout` | Optional solve timeout in milliseconds. |
| `disabled` | `disabled` | Blocks user interaction and automatic verification. |

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
npm install
npm test
npm run build
```

## License

GPL-3.0-only. See [LICENSE](./LICENSE).
