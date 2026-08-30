# Risk Engine

Ribaunt can assess application-provided signals and recommend an action without becoming a fingerprinting service, reputation database, or opaque ML model. The risk engine is an **optional, stateless, caller-driven policy layer**:

```
application signals
        |
        v
      assess()
        |
        +--> allow
        +--> challenge (+ reusable Workload)
        `--> block
```

All signals are **caller-supplied** and treated as **untrusted inputs**. Ribaunt does not observe IP, fingerprint devices, or track velocity itself. Your application decides what to send. The returned `risk` is a bounded heuristic score (0–100), not a probability, not “confidence the user is a bot”, and not an identity assertion.

## Quick Example

```ts
import { assess } from 'ribaunt';

const assessment = await assess({
  signals: {
    accountAgeSeconds: account.ageSeconds,          // your DB
    requestVelocity: requestsPerMinute,             // your rate counter
    userAgent: req.headers['user-agent'],           // your HTTP layer
    ip: req.ip,                                     // your infra — optional for default scorer
  },
});

switch (assessment.action) {
  case 'allow':
    // continue request
    break;
  case 'challenge':
    // issue PoW — assessment.workload is already a selectWorkload() result
    // Option A: use the workload directly with createChallenge
    // Option B: return workload to client to render widget with difficulty
    break;
  case 'block':
    // application decides how to reject (e.g. 429 / 403). Ribaunt does not send HTTP responses.
    break;
}
```

`assessment` always has `risk: number` (0–100, finite) and `action: 'allow' | 'challenge' | 'block'`. `workload` is present **only** when `action === 'challenge'`.

## Default Scorer

If you do not provide `scorer`, Ribaunt uses a **transparent, deterministic heuristic** (`defaultScore`). It is deliberately small so you can inspect it:

| Signal | Contribution | How |
|---|---|---|
| `accountAgeSeconds` | 0–30 | Younger → more risk. Buckets: `<60s:30`, `<1h:25`, `<1d:20`, `<7d:15`, `<30d:10`, `<90d:5`, `≥90d:0`. Negative/NaN/Infinity → 0 (ignored, no crash). Saturates — very large ages do not dominate. |
| `requestVelocity` | 0–40 | Higher → more risk. Buckets: `<1:0`, `<5:10`, `<20:20`, `<60:30`, `<200:35`, `≥200:40`. Negative/non-finite → 0. Caller-derived, not authoritative. |
| `userAgent` | 0–10 | Weak signal only. Missing/non-string → 0, empty → 5, `<10 chars` → 10, otherwise 0. No `ua.includes('bot')` bans — UA is not trustworthy. |
| `ip` | 0 | Accepted for custom scorers but default scorer does **not** pretend to know if an IP is malicious (returns 0). |
| unknown keys | 0 | Ignored by default scorer; custom scorers may use them. |

```
raw = age + velocity + ua + ip;  // max 80 with current buckets
risk = clamp(0..100, round(raw))
```

The mapping is documented here and in `src/risk.ts` (`normalizeAccountAge`, `normalizeRequestVelocity`, `scoreUserAgent`). It has no network/DB calls, no crypto, `O(1)`. If you need different policy, supply a custom scorer.

## Custom Scorer

```ts
import { assess, type RiskScorer, type RiskSignals } from 'ribaunt';

const scorer: RiskScorer = {
  async score(signals: RiskSignals): Promise<number> {
    // Use any app signals — including your custom keys via index signature
    if (signals.tier === 'enterprise') return 5;
    if (typeof signals.customField === 'string' && signals.customField === 'suspicious') return 85;
    return 40;
  },
};

const assessment = await assess({ signals: { customField: 'suspicious' } as any, scorer });
```

Interface is `async` so you can call a remote model without changing callers:

```ts
const remoteScorer: RiskScorer = {
  async score(signals) {
    const res = await fetch('https://risk.internal/score', { method: 'POST', body: JSON.stringify(signals) });
    const { risk } = await res.json();
    return risk; // must be finite 0..100 or assess() rejects
  },
};
```

Custom scorer **failures propagate** — `assess()` rejects, it does not invent `risk = 50`:

```ts
try {
  await assess({ signals: {}, scorer: { score: async () => { throw new Error('downstream down'); } } });
} catch (err) {
  // handle — do not fallback to challenge silently
}
```

Invalid outputs are rejected (not clamped): `NaN`, `Infinity`, `-Infinity`, `<0`, `>100`, non-numbers all throw `Scorer must return a finite number between 0 and 100`.

> If you supply a custom scorer, the default scorer is **not** executed.

## Custom Thresholds

```ts
import { assess, DEFAULT_RISK_THRESHOLDS } from 'ribaunt';

console.log(DEFAULT_RISK_THRESHOLDS); // { challenge: 40, block: 80 }

const assessment = await assess({
  signals,
  thresholds: { challenge: 30, block: 70 },
});

 // Semantics (same for defaults):
 //   risk < challenge              -> allow
 //   challenge <= risk < block     -> challenge
 //   risk >= block                 -> block
```

Validation is strict: `0 <= challenge < block <= 100`, finite numbers. Invalid thresholds throw — they are never silently repaired. Tune them to your application; defaults are **policy defaults, not security truth**.

## Challenge Workload

When `action === 'challenge'`, `assessment.workload` is a `Workload` generated by the **existing** `selectWorkload()`:

```ts
if (assessment.action === 'challenge') {
  const { difficulty, amount, estimatedAttempts } = assessment.workload!;
}

 // Equivalent to:
 //   selectWorkload({ riskScore: assessment.risk, ...workloadOptions })
```

Pass your own bounds if needed:

```ts
const assessment = await assess({
  signals,
  thresholds: { challenge: 40, block: 80 },
  workload: {
    minDifficulty: 3,
    maxDifficulty: 6,
    minAmount: 1,
    maxAmount: 8,
    targetDurationMs: 750,
    calibration: req.body.calibration, // untrusted, raise-only
  },
});
```

If `workload` contains `riskScore` (via `any`), it is **ignored/overridden** by the assessed `risk`. Workload validation reuses the same messages as `selectWorkload` (`Minimum difficulty must be at least 1`, etc.) — invalid workload is rejected even when `action` would be `allow`/`block` (fail-fast). See `docs/configuration.md` for auto-hardness details.

## Compatibility

Existing `riskScore` continues to work unchanged:

```ts
await createChallenge({ difficulty: 'auto', riskScore: 80, calibration: ... });
```

No storage, no migration. The new flow is **additive**:

```ts
const assessment = await assess({ signals });
if (assessment.action === 'challenge') {
  const challenges = await createChallenge({ workload: assessment.workload });
  // or await createChallenge({ difficulty: 'auto', riskScore: assessment.risk, ... })
}
```

`createChallenge()` does **not** call `assess()` implicitly — using the risk engine is opt-in.

## Limitations & Trust Model

Be explicit with your team and users:

- **Signals are caller-supplied, not verified facts.** Ribaunt does not independently observe IP/user-agent/account age. Your app is responsible for obtaining trustworthy inputs. Do not treat `signals.ip` as authenticated.
- **Default scorer is a heuristic, not a fraud probability.** Do not present `risk` as “probability of fraud” or “confidence the user is a bot”. It is a bounded 0–100 score for policy routing.
- **No reputation, no fingerprinting, no external feeds.** V1 has no IP reputation, device fingerprint, Redis velocity tracking, or ML model. That is intentional — it keeps the system transparent and optional. Custom scorers are the escape hatch for richer policy; a future V2 may add *optional* pluggable velocity stores.
- **No automatic enforcement.** `assess()` returns an `action`; it does not block HTTP requests, throw `403`, or ban IPs. Your application decides how to enforce `allow`/`challenge`/`block`. No framework-specific middleware is added to core.
- **Default scorer robustness:** missing signals succeed (empty `signals: {}` → `risk: 0, action: 'allow'`), malformed numbers are ignored, unknown keys are ignored, very large values saturate rather than overflow, and UA handling avoids fragile `includes('bot')` checks.

Type exports: `assess`, `RiskSignals`, `RiskScorer`, `RiskThresholds`, `AssessOptions` (+ `AssessWorkloadOptions`), `RiskAssessment`, `DEFAULT_RISK_THRESHOLDS` are all exported from `ribaunt` (`src/index.ts` → `dist/index.d.ts`).
