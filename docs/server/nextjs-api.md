# Server Integration: Next.js API Routes

If you are using Next.js, handling challenge generation and verification via Next.js Route Handlers (App Router) or API Routes (Pages Router) is straightforward.

## 1. Environment Variable Setup

In your `.env.local` file, define a random `RIBAUNT_SECRET` containing at least 32 UTF-8 bytes.

```env
# Server-side ONLY! Do NOT prefix with NEXT_PUBLIC_
RIBAUNT_SECRET="your_very_strong_random_secret_string_here"
```

This must be available before your route handlers start serving requests. Importing `ribaunt` is now less brittle, but challenge creation and verification still require the secret at call time.

## 2. App Router (Next.js 13+)

If you are using the modern `app/` directory, create the following route handlers:

### `app/api/captcha/challenge/route.ts`

```typescript
import 'dotenv/config';
import { NextResponse } from 'next/server';
import { createChallenge } from 'ribaunt';

export async function GET() {
  try {
    // Generate 4 challenges with difficulty 5, valid for 60 seconds
    // Validate any dynamic values before passing them to createChallenge().
    const challenges = createChallenge(5, 4, 60);
    return NextResponse.json({ challenges });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to generate challenge' },
      { status: 500 }
    );
  }
}
```

### `app/api/captcha/verify/route.ts`

```typescript
import 'dotenv/config';
import { NextResponse } from 'next/server';
import { verifySolution } from 'ribaunt';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { tokens, solutions } = body;

    if (!tokens || !solutions) {
      return NextResponse.json(
        { success: false, error: 'Missing tokens or solutions' },
        { status: 400 }
      );
    }

    // The default replay mode blocks token reuse in this process.
    const result = await verifySolution(tokens, solutions, {
      onWarning: (warning) => {
        // Optional telemetry hook without enabling debug logs
        console.log('captcha warning', warning.reason, warning.message);
      },
    });

    if (result.valid) {
      // You might also set a secure HTTP-only cookie here to track verification
      return NextResponse.json({ success: true, message: 'Verification successful' });
    }

    return NextResponse.json(
      { success: false, error: 'Invalid or expired CAPTCHA solution' },
      { status: 400 }
    );
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
```

## 3. Pages Router (Next.js 12 and below)

If you are using the traditional `pages/api/` directory:

### `pages/api/captcha/challenge.ts`

```typescript
import 'dotenv/config';
import type { NextApiRequest, NextApiResponse } from 'next';
import { createChallenge } from 'ribaunt';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const challenges = createChallenge(5, 4, 60);
    res.status(200).json({ challenges });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate challenge' });
  }
}
```

### `pages/api/captcha/verify.ts`

```typescript
import 'dotenv/config';
import type { NextApiRequest, NextApiResponse } from 'next';
import { verifySolution } from 'ribaunt';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { tokens, solutions } = req.body;

    if (!tokens || !solutions) {
      return res.status(400).json({ success: false, error: 'Missing tokens or solutions' });
    }

    // The default replay mode blocks token reuse in this process.
    const result = await verifySolution(tokens, solutions, {
      onWarning: (warning) => {
        // Optional telemetry hook without enabling debug logs
        console.log('captcha warning', warning.reason, warning.message);
      },
    });

    if (result.valid) {
      res.status(200).json({ success: true, message: 'Verification successful' });
    } else {
      res.status(400).json({ success: false, error: 'Invalid or expired CAPTCHA solution' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}
```

## Notes

- Validate any request- or config-controlled `difficulty`, `amount`, and `ttlSeconds` values before calling `createChallenge()`.
- Return the challenge response as `{ challenges: string[] }` (recommended contract). Compatibility formats (`{ tokens: string[] }` and `string[]`) are still supported by the widget.
- Keep `RIBAUNT_SECRET` server-only and never expose it through `NEXT_PUBLIC_` variables.
- Choose replay strategy per deployment shape:
  - single process: omit `replayPrevention` or pass `replayPrevention: 'local'`
  - multi-instance/serverless: `replayPrevention: 'remote'` with an atomic distributed replay store adapter
  - legacy opt-out only: `replayPrevention: 'disabled'`
- Use `onWarning` in `verifySolution()` for structured verification telemetry without forcing production logs.
