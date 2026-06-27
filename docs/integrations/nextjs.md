# Next.js Integration Guide

Integrating Ribaunt CAPTCHA into Next.js requires using our special React wrapper and SSR guards because the web component relies on browser-only APIs (`window`, `customElements`, and `Web Crypto API`).

## Step 1: Using the Next.js React Wrapper

We provide a specialized React wrapper exported via `ribaunt/widget-react` that handles dynamic imports internally, completely bypassing SSR errors.

```tsx
'use client'; // Required if using Next.js App Router

import React, { useRef } from 'react';
import RibauntWidget, { type RibauntWidgetHandle } from 'ribaunt/widget-react';

export default function MyPage() {
  const widgetRef = useRef<RibauntWidgetHandle>(null);

  const handleVerify = (detail: { solutions: any[] }) => {
    console.log('Verified solutions:', detail.solutions);
  };

  const handleError = (detail: { error: string }) => {
    console.error('Verification failed:', detail.error);
  };

  const handleStateChange = (detail: { state: string }) => {
    console.log('Current widget state:', detail.state);
  };

  const handleReady = (detail: { state: string }) => {
    console.log('Widget ready with state:', detail.state);
  };

  const handleEvent = (type: string, detail: unknown) => {
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
        showWarning={false}
        onVerify={handleVerify}
        onError={handleError}
        onStateChange={handleStateChange}
        onReady={handleReady}
        onEvent={handleEvent}
      />
      <button type="submit" onClick={() => widgetRef.current?.startVerification()}>
        Submit
      </button>
    </form>
  );
}
```

The wrapper also syncs `challengeEndpoint`, `verifyEndpoint`, `autoVerify`, `showWarning`, `warningMessage`, `solveTimeout`, and `disabled` after mount, so you generally do not need to force remounts when those props change.

## Step 2: Setting up Next.js Route Handlers (API Routes)

Create the necessary API endpoints in the `app/api/` directory (or `pages/api/` if using Pages Router).

### `app/api/captcha/challenge/route.ts`

```typescript
import 'dotenv/config';
import { NextResponse } from 'next/server';
import { createChallenge } from 'ribaunt';

export async function GET() {
  // Generates 4 challenges, difficulty 5, expiring in 300 seconds
  const challenges = createChallenge(5, 4, 300);
  return NextResponse.json({ challenges });
}
```

### `app/api/captcha/verify/route.ts`

```typescript
import 'dotenv/config';
import { NextResponse } from 'next/server';
import { verifySolution } from 'ribaunt';

export async function POST(req: Request) {
  const body = await req.json();
  const { tokens, solutions } = body;
  
  const result = await verifySolution(tokens, solutions, {
    onWarning: (warning) => {
      // Optional structured warning telemetry
      console.log('captcha warning', warning.reason);
    },
  });
  
  if (result.valid) {
    return NextResponse.json({ success: true });
  } else {
    return NextResponse.json({ success: false, error: result.reason }, { status: 400 });
  }
}
```

## Considerations for Next.js 

- **Always use `'use client'`**: The component needs to render in the browser.
- **Do not wrap in `next/dynamic`**: `ribaunt/widget-react` already handles dynamic importing internally, making your code cleaner.
- **Ready & initial state**: `onReady` fires once after the widget is mounted. `onStateChange` always fires at least once after mount with the current state.
- **Environment Variables**: Make sure your `RIBAUNT_SECRET` is defined in `.env.local` but *do not* prefix it with `NEXT_PUBLIC_` since it must stay on the server.
- **Secure context**: Browser solving uses Web Crypto, so development should run on `https://` or `http://localhost`. Plain local-network HTTP URLs may fail in some browsers.
- **Validation**: Validate any dynamic inputs before passing them to `createChallenge()`. Invalid `difficulty`, `amount`, and `ttlSeconds` values now throw.
- **Challenge endpoint contract**: Prefer returning `{ challenges: string[] }`. Compatibility formats (`{ tokens: string[] }` and raw `string[]`) are still accepted by the widget.
- **Auto verify**: Set `autoVerify` when the widget should begin verification as soon as it mounts, without a user click.
- **Disabled semantics**: `disabled` now blocks user interaction, `startVerification()`, and `autoVerify`.
- **Replay protection**: Verification defaults to process-local replay protection. Use `replayPrevention: 'remote'` with an atomic distributed store for serverless or multi-instance deployments.
- **Verification telemetry**: Use `onWarning` in `verifySolution()` to capture structured warning reasons without turning on debug logs.
- **Timeouts are opt-in**: `solveTimeout`/`solve-timeout` is optional. If omitted, solve attempts are not auto-cancelled.
