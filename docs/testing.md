# Testing Guide

Ribaunt now includes test coverage for the main integration layers:

- server-side challenge creation, solving, verification, and edge cases
- auto hardness via `selectWorkload()`, calibration raise-only semantics, `riskScore`, and bounded workload selection
 - `calibrateNode()` / `calibrateArgonNode()` for server-side calibration and `calibrateBrowser()` / `calibrateArgonBrowser()` for browser calibration (must match `algorithm`)
- `calibrateClient` / `calibrateArgonClient` cross-environment aliases in both Node and browser entry points
- `solveChallenge()` (sync, SHA only) vs `solveChallengeAsync()` (both, auto-detects `alg`)
- replay-prevention modes (default local/disabled/custom store)
- optional verification warning callbacks (`onWarning`) and warning reasons
- the browser solver in `src/solver.ts`
- browser solver cancellation via `AbortSignal`
- server-side solve guardrails (`maxIterations`, `maxDurationMs`)
 - the web component widget fetch/solve/verify flow, including `calibrate` attribute POST flow and `solver-backend: 'argon2id'` for Argon
- declarative widget auto-verification on load
- demo server (`demo/server.mjs`, `pnpm demo`) with real `/api/challenge[/argon]` and `/api/verify` for SHA and Argon2id, and static fallback (`mock fetch` when no server)
- widget opt-in solve-timeout failure path and warning animation behavior
- widget challenge payload parsing for supported response shapes and malformed payload rejection
- emitted widget events and disabled-state behavior
- the React wrapper's prop syncing, event forwarding, and imperative handle
- built package entry-point smoke tests for ESM, CJS, and browser bundles

## Run the Full Test Suite

```bash
pnpm test
```

The challenge-solving tests are CPU-heavy; deterministic timing is easier when they do not compete across workers, which is the default for a single-threaded local run. Use `pnpm vitest run --pool=forks --poolOptions.forks.singleFork` if you need strict serial execution.

## Main Test Files

| File | Coverage |
|---|---|---|
| `tests/challenge.test.ts` | Server-side challenge flow, malformed tokens, async verification, replay modes, expiry, invalid config, auto hardness (`selectWorkload`), calibration semantics, risk scores, and `calibrateNode` |
| `tests/argon.test.ts` | Opt-in `argon2id` — `algorithm`/`argonProfile` validation, `HARD_MAX`, `selectWorkload` argon device-aware, `calibrateArgonNode`, `solveChallengeAsync` vs sync `undefined` for argon, `verifySolution` argon + context/replay, tampered `m`/`difficulty` → `invalid-token`, and `assess` with argon workload |
| `tests/solver.test.ts` | Browser solver token decoding, solving, progress reporting, invalid-token handling, cancellation, missing Web Crypto behavior, and `calibrateBrowser` / `calibrateClient` |
| `tests/argon-solver.test.ts` | Browser Argon solver — `argon2id` auto-detect, batch progress, `calibrateArgonBrowser`/`calibrateArgonClient`, abort, and SHA↔Argon non-contamination |
| `tests/widget.test.ts` | Widget fetch/solve/verify flow, auto-verify behavior, solve-timeout behavior, warning visibility animation, emitted events, disabled behavior, and listener lifecycle |
| `tests/widget-react.test.tsx` | React wrapper prop syncing, including `autoVerify`, callback/event forwarding, imperative ref methods, live HTML-prop updates, and native handler binding |
| `tests/worker-client.test.ts` | Worker-mode solving, cooperative cancellation, fallbacks, and abort handling |
| `tests/worker-argon.test.ts` | Worker Argon — `argon2id` fallback to main-thread `hash-wasm`, `backend:'argon2id'` telemetry, and abort |
| `tests/redis.test.ts` | Atomic Redis replay-store consumption (integration tests run when `RIBAUNT_TEST_REDIS_URL` is set) and store adapter signatures |
| `tests/package-smoke.test.ts` | Built ESM/CJS entry points, browser bundle loading, package export targets, and pinned CI actions |
| `tests/wasm-solver.test.ts` | SHA WASM batch solver (`dist/ribaunt-solver.wasm`) — fixtures, JWT matching, and `wasm-unavailable` cache |

## Notes

- Widget and React tests run in `jsdom`.
- Tests import the TypeScript sources directly (for example `../src/widget`); the built artifacts are exercised separately by the packaging smoke tests.
- The solver suite covers the secure-context dependency by asserting the explicit Web Crypto error path.
- `pnpm test` and `pnpm run test:coverage` build the package first. The packaging smoke tests validate the emitted entry points from `dist/`; they never build anything themselves, so running vitest directly validates whatever is currently in `dist/`.
- The CommonJS build uses `dist/cjs/package.json` with `"type": "commonjs"` instead of renaming output files to `.cjs`.
- Build validation is still available directly:

```bash
pnpm run build
```
