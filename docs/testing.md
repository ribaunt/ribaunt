# Testing Guide

Ribaunt now includes test coverage for the main integration layers:

- server-side challenge creation, solving, verification, and edge cases
- auto hardness via `selectWorkload()`, calibration raise-only semantics, `riskScore`, and bounded workload selection
- `calibrateNode()` for server-side calibration and `calibrateBrowser()` for browser calibration
- `calibrateClient` cross-environment alias in both Node and browser entry points
- replay-prevention modes (default local/disabled/custom store)
- optional verification warning callbacks (`onWarning`) and warning reasons
- the browser solver in `src/solver.ts`
- browser solver cancellation via `AbortSignal`
- server-side solve guardrails (`maxIterations`, `maxDurationMs`)
- the web component widget fetch/solve/verify flow, including `calibrate` attribute POST flow
- declarative widget auto-verification on load
- widget opt-in solve-timeout failure path and warning animation behavior
- widget challenge payload parsing for supported response shapes and malformed payload rejection
- emitted widget events and disabled-state behavior
- the React wrapper's prop syncing, event forwarding, and imperative handle
- built package entry-point smoke tests for ESM, CJS, and browser bundles

## Run the Full Test Suite

```bash
npm test -- --runInBand
```

`--runInBand` is useful here because the challenge-solving tests are CPU-heavy and deterministic timing is easier when they do not compete across workers.

## Main Test Files

| File | Coverage |
|---|---|---|
| `tests/challenge.test.ts` | Server-side challenge flow, malformed tokens, async verification, replay modes, expiry, invalid config, auto hardness (`selectWorkload`), calibration semantics, risk scores, and `calibrateNode` |
| `tests/solver.test.ts` | Browser solver token decoding, solving, progress reporting, invalid-token handling, cancellation, missing Web Crypto behavior, and `calibrateBrowser` / `calibrateClient` |
| `tests/widget.test.ts` | Widget fetch/solve/verify flow, auto-verify behavior, solve-timeout behavior, warning visibility animation, emitted events, disabled behavior, and listener lifecycle |
| `tests/widget-react.test.tsx` | React wrapper prop syncing, including `autoVerify`, callback/event forwarding, and imperative ref methods |
| `tests/package-smoke.test.ts` | Built ESM/CJS entry points, browser bundle loading, and package export targets |

## Notes

- Widget and React tests run in `jsdom`.
- The test config maps `.js` import specifiers back to TypeScript source files so source-level tests can exercise the same modules used in builds.
- The solver suite covers the secure-context dependency by asserting the explicit Web Crypto error path.
- Packaging smoke tests run `npm run build` and validate the emitted entry points from `dist/`.
- The CommonJS build now uses `dist/cjs/package.json` with `"type": "commonjs"` instead of renaming output files to `.cjs`.
- Build validation is still available directly:

```bash
npm run build
```
