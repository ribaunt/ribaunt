# Ribaunt CAPTCHA Quick Start

Welcome to Ribaunt CAPTCHA! This guide will help you set up and integrate the stateless PoW CAPTCHA library into your project.

## Installation

Install Ribaunt via your preferred package manager:

```bash
npm install ribaunt
# or
yarn add ribaunt
# or
pnpm add ribaunt
```

## 1. Set Up Environment Variables

Ribaunt uses JWT to securely sign challenge tokens. You must set a strong secret in your server environment:

```env
RIBAUNT_SECRET="your-very-strong-random-secret-key"
```

Load this before handling requests. Importing `ribaunt` no longer fails immediately if the variable is missing, but `createChallenge()` and `verifySolution()` still require it at call time.

## 2. Server Implementation

You need two endpoints on your server: one to generate the challenge, and one to verify the solution.

```typescript
import 'dotenv/config';
import express from 'express';
import { createChallenge, verifySolution } from 'ribaunt';

const app = express();
app.use(express.json());

// 1. Endpoint to get a challenge
app.get('/api/captcha/challenge', (req, res) => {
  // Generate 4 challenges with difficulty 5, valid for 300 seconds
  const challenges = createChallenge(5, 4, 300);
  res.json({ challenges });
});

// 2. Endpoint to verify the solution
app.post('/api/captcha/verify', async (req, res) => {
  const { tokens, solutions } = req.body;

  const isValid = await verifySolution(tokens, solutions);
  
  if (isValid) {
    res.json({ success: true, message: 'Verified!' });
  } else {
    res.status(400).json({ success: false, error: 'Invalid solution' });
  }
});

app.listen(3000);
```

If these values come from config, env, or request input, validate them before calling `createChallenge()`. Current versions reject invalid `difficulty`, `amount`, and `ttlSeconds` values.

The recommended challenge response contract for widget integrations is:

```json
{ "challenges": ["jwt-token-1", "jwt-token-2"] }
```

For backwards compatibility, `{ tokens: string[] }` and raw `string[]` are also accepted.

By default, `verifySolution()` blocks replay in the current process. For serverless or multi-instance deployments, use `replayPrevention: 'remote'` with an atomic distributed store. Only use `replayPrevention: 'disabled'` if another layer already prevents replay.

For telemetry, you can capture structured validation warnings without enabling debug logs:

```typescript
const isValid = await verifySolution(tokens, solutions, {
  onWarning: (warning) => {
    console.log('captcha warning', warning.reason, warning.message);
  },
});
```

## 3. Frontend Integration

Browser solving requires a secure context. In practice, use `https://` or `http://localhost` during development. Loading the widget from a plain LAN URL such as `http://192.168.x.x` may fail because the Web Crypto API is not available there.

### Using React / Next.js
If you are using React or Next.js, use our pre-built React wrapper:

```jsx
import RibauntWidget from 'ribaunt/widget-react';

export default function MyForm() {
  return (
    <form>
      {/* Other form fields */}
      <RibauntWidget 
        challengeEndpoint="/api/captcha/challenge"
        verifyEndpoint="/api/captcha/verify"
        autoVerify={true}
        solveTimeout={15000}
        onVerify={() => console.log('User verified!')}
        onError={(detail) => console.error('Verification failed:', detail.error)}
        onReady={(detail) => console.log('Widget ready:', detail.state)}
      />
      <button type="submit">Submit</button>
    </form>
  );
}
```

The React wrapper now syncs `challengeEndpoint`, `verifyEndpoint`, `autoVerify`, `showWarning`, `warningMessage`, `solveTimeout`, and `disabled` after mount. You no longer need to force a remount just to update those props.

### Using Plain HTML
Include the widget in your HTML file directly:

```html
<script type="module" src="node_modules/ribaunt/dist/widget-browser.js"></script>

<ribaunt-widget 
  challenge-endpoint="/api/captcha/challenge"
  verify-endpoint="/api/captcha/verify"
  auto-verify="true"
></ribaunt-widget>

<script>
  const widget = document.querySelector('ribaunt-widget');
  widget.addEventListener('verify', (e) => {
    console.log('Verified!', e.detail.solutions);
  });
</script>
```

If the browser cannot access `crypto.subtle`, the widget will fail verification and emit an error. Current versions surface this clearly as: `Web Crypto API is unavailable. Use HTTPS or localhost.`

## What's Next?
- [Framework Integrations](./integrations/)
- [Server Examples](./server/)
- [Configuration Options](./configuration.md)
- [Theming & Styling](./theming.md)
- [Testing Guide](./testing.md)
