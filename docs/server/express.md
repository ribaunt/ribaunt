# Server Integration: Express

If you are using Node.js and Express, implementing the challenge generation and verification endpoints is very easy. 

## 1. Required Packages
Ensure you have `express` and `ribaunt` installed:

```bash
npm install express ribaunt
```

## 2. Server Implementation

```typescript
import 'dotenv/config';
import express from 'express';
import { createChallenge, verifySolution } from 'ribaunt';

const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Set a random secret of at least 32 UTF-8 bytes before handling requests.
// e.g. export RIBAUNT_SECRET="your_very_strong_random_secret_string"
if (!process.env.RIBAUNT_SECRET) {
  console.warn('WARNING: RIBAUNT_SECRET environment variable is not set!');
}

// 1. Endpoint to generate a challenge
app.get('/api/captcha/challenge', (req, res) => {
  try {
    // Generate 4 challenges with difficulty 5, valid for 120 seconds
    // Validate any user- or config-controlled inputs before passing them here.
    const challenges = createChallenge(5, 4, 120);
    res.json({ challenges });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate challenge' });
  }
});

// 2. Endpoint to verify the solution
app.post('/api/captcha/verify', async (req, res) => {
  try {
    const { tokens, solutions } = req.body;
    
    // Basic validation
    if (!tokens || !solutions) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing tokens or solutions' 
      });
    }
    
    // Verify the PoW solution against the original tokens.
    // The default replay mode blocks token reuse in this process.
    const result = await verifySolution(tokens, solutions, {
      onWarning: (warning) => {
        // Optional telemetry hook without enabling debug logs
        console.log('captcha warning', warning.reason, warning.message);
      },
    });
    
    if (result.valid) {
      // You can implement custom logic here like tracking the IP or setting a session token
      return res.json({ 
        success: true, 
        message: 'Verification successful' 
      });
    } else {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid or expired CAPTCHA solution' 
      });
    }
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
```

## 3. Best Practices
- **Challenge Response Contract:** Return `{ challenges: string[] }` from your challenge endpoint. `{ tokens: string[] }` and raw `string[]` are still accepted by the widget for compatibility.
- **Rate Limiting:** Implement IP-based rate limiting on the `/api/captcha/challenge` endpoint using tools like `express-rate-limit` to prevent abuse.
- **Session Linking:** Instead of simply returning `{ success: true }`, you can return a signed JWT (or set an HTTP-only cookie) that the client must include on subsequent form submissions. This guarantees the form is submitted by a user who recently solved a CAPTCHA.
- **Input Validation:** Current versions reject invalid `difficulty`, `amount`, and `ttlSeconds` values. Validate untrusted inputs before calling `createChallenge()`.
- **Replay Mode Selection:** The default process-local replay protection is suitable for single-process deployments. In serverless or multi-instance deployments, use `remote` with an atomic distributed store adapter. Use `disabled` only as a legacy opt-out when another layer prevents replay.
- **Verification Observability:** Use the optional `onWarning` callback with `verifySolution()` to capture structured warning reasons (for example `invalid-token`, `replay-detected`) without forcing production console logs.
