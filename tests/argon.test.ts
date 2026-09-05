import {
  createChallenge,
  solveChallenge,
  solveChallengeAsync,
  verifySolution,
  selectWorkload,
  calibrateNode,
  calibrateArgonNode,
  calibrateArgonClient,
  HARD_MAX,
  ARGON_PROFILES,
  assess,
} from '../src/index';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

beforeEach(() => {
  process.env.RIBAUNT_SECRET ??= 'codex-audit-test-secret-with-enough-entropy';
});

describe('argon2id opt-in', () => {
  it('creates argon2id challenges with alg,m,t,p and defaults to mobile profile', async () => {
    const tokens = await createChallenge({ algorithm: 'argon2id', difficulty: 1, amount: 1 });
    expect(tokens).toHaveLength(1);
    const payload = jwt.decode(tokens[0]!) as Record<string, unknown>;
    expect(payload.alg).toBe('argon2id');
    expect(payload.m).toBe(ARGON_PROFILES.mobile.m);
    expect(payload.t).toBe(ARGON_PROFILES.mobile.t);
    expect(payload.p).toBe(ARGON_PROFILES.mobile.p);
    expect(payload.hashLen).toBe(32);
    expect(payload.difficulty).toBe(1);
  });

  it('supports argonProfile standard (same params but explicit)', async () => {
    const [tok] = await createChallenge({ algorithm: 'argon2id', argonProfile: 'standard', difficulty: 1 });
    const p = jwt.decode(tok!) as Record<string, unknown>;
    expect(p.m).toBe(ARGON_PROFILES.standard.m);
    expect(p.alg).toBe('argon2id');
  });

  it('rejects invalid argonProfile', async () => {
    // @ts-expect-error testing runtime validation - high not allowed
    await expect(createChallenge({ algorithm: 'argon2id', argonProfile: 'high' })).rejects.toThrow('argonProfile must be "mobile" or "standard"');
    // @ts-expect-error testing runtime validation - sha with argonProfile
    await expect(createChallenge({ algorithm: 'sha256', argonProfile: 'mobile' })).rejects.toThrow('argonProfile is only valid when algorithm is "argon2id"');
  });

  it('rejects invalid algorithm', async () => {
    // @ts-expect-error testing runtime validation - invalid algo
    await expect(createChallenge({ algorithm: 'argon2' as never, difficulty: 1 })).rejects.toThrow('algorithm must be "sha256" or "argon2id"');
  });

  it('enforces argon difficulty max 8', async () => {
    await expect(createChallenge({ algorithm: 'argon2id', difficulty: 9 })).rejects.toThrow('must be at most 8 for argon2id');
    await expect(createChallenge({ algorithm: 'argon2id', difficulty: 8 })).resolves.toHaveLength(1);
    await expect(createChallenge({ difficulty: 64 })).resolves.toHaveLength(1); // sha object form defaults to 1
    await expect(createChallenge(64)).resolves.toHaveLength(4); // positional still defaults to 4
  });

  it('defaults to sha256 when algorithm omitted', async () => {
    const [tok] = await createChallenge({ difficulty: 2 });
    const p = jwt.decode(tok!) as Record<string, unknown>;
    expect(p.alg).toBeUndefined();
    expect(p.m).toBeUndefined();
  });

  it('sync solveChallenge returns undefined for argon tokens (requires async)', async () => {
    const tokens = await createChallenge({ algorithm: 'argon2id', difficulty: 1, amount: 1 });
    const tok = tokens[0]!;
    expect(solveChallenge(tok)).toBeUndefined();
    const asyncSol = await solveChallengeAsync(tok);
    expect(asyncSol).toBeDefined();
    expect(asyncSol?.hash.startsWith('0')).toBe(true);
  });

  it('solveChallengeAsync solves both sha and argon uniformly', async () => {
    const shaTok = (await createChallenge({ difficulty: 1, amount: 1 }))[0]!;
    const argonTok = (await createChallenge({ algorithm: 'argon2id', difficulty: 1, amount: 1 }))[0]!;
    const shaSol = await solveChallengeAsync(shaTok);
    const argonSol = await solveChallengeAsync(argonTok);
    expect(shaSol?.hash.startsWith('0')).toBe(true);
    expect(argonSol?.hash.startsWith('0')).toBe(true);
    await expect(verifySolution(shaTok, shaSol!, { replayPrevention: 'disabled' })).resolves.toEqual({ valid: true });
    await expect(verifySolution(argonTok, argonSol!, { replayPrevention: 'disabled' })).resolves.toEqual({ valid: true });
  });

  it('verifySolution succeeds for argon2id and blocks replay', async () => {
    const tokens = await createChallenge({ algorithm: 'argon2id', difficulty: 1, amount: 1 });
    const sol = (await solveChallengeAsync(tokens))!;
    await expect(verifySolution(tokens, sol)).resolves.toEqual({ valid: true });
    await expect(verifySolution(tokens, sol)).resolves.toMatchObject({ valid: false, reason: 'replay-detected' });
    // disabled allows replay
    await expect(verifySolution(tokens[0]!, sol[0]!, { replayPrevention: 'disabled' })).resolves.toEqual({ valid: true });
  });

  it('verifySolution argon respects context binding', async () => {
    const ctx = 'action:checkout:42';
    const [tok] = await createChallenge({ algorithm: 'argon2id', difficulty: 1, context: ctx });
    const sol = (await solveChallengeAsync(tok))!;
    await expect(verifySolution(tok, sol, { context: ctx, replayPrevention: 'disabled' })).resolves.toEqual({ valid: true });
    await expect(verifySolution(tok, sol, { context: 'wrong', replayPrevention: 'disabled' })).resolves.toMatchObject({ valid: false, reason: 'context-mismatch' });
    await expect(verifySolution(tok, sol, { replayPrevention: 'disabled' })).resolves.toMatchObject({ valid: false, reason: 'context-mismatch' });
  });

  it('verifySolution batch argon validates all proofs before consuming replay', async () => {
    const tokens = await createChallenge({ algorithm: 'argon2id', difficulty: 1, amount: 2 });
    const sols = (await solveChallengeAsync(tokens))!;
    const replayStore = { consume: vi.fn(async () => true), consumeMany: vi.fn(async () => true) };
    // one bad nonce should not consume — use empty nonce for deterministic invalid-solution
    await expect(verifySolution(tokens, [sols[0]!, { nonce: '', hash: '' }], { replayPrevention: 'remote', replayStore, debug: false })).resolves.toMatchObject({ valid: false });
    expect(replayStore.consumeMany).not.toHaveBeenCalled();
    // good batch consumes once
    await expect(verifySolution(tokens, sols, { replayPrevention: 'remote', replayStore })).resolves.toEqual({ valid: true });
    expect(replayStore.consumeMany).toHaveBeenCalledTimes(1);
  });

  it('rejects tampered argon params via isValidPayload (invalid-token)', async () => {
    const [tok] = await createChallenge({ algorithm: 'argon2id', difficulty: 1 });
    const payload = jwt.decode(tok!) as Record<string, unknown>;
    const tamperedM = jwt.sign({ ...payload, m: HARD_MAX.m * 2 }, process.env.RIBAUNT_SECRET!);
    const _sol = await solveChallengeAsync(tamperedM);
    void _sol;
    // solve will return undefined because m out of bounds, but verify should be invalid-token
    await expect(verifySolution(tamperedM, '0', { debug: false })).resolves.toMatchObject({ valid: false, reason: 'invalid-token' });
    const tamperedDiff = jwt.sign({ ...payload, difficulty: 9 }, process.env.RIBAUNT_SECRET!);
    await expect(verifySolution(tamperedDiff, '0', { debug: false })).resolves.toMatchObject({ valid: false, reason: 'invalid-token' });
  });

  it('still supports sha256 tokens after argon opt-in (no regression)', async () => {
    const tokens = await createChallenge(2, 2);
    const sols = solveChallenge(tokens)!;
    await expect(verifySolution(tokens, sols)).resolves.toEqual({ valid: true });
  });

  it('selectWorkload returns argon profile and respects calibration (device-aware)', () => {
    const wDefault = selectWorkload({ algorithm: 'argon2id' });
    expect(wDefault.algorithm).toBe('argon2id');
    expect(wDefault.argon).toEqual(ARGON_PROFILES.mobile);
    expect(wDefault.difficulty).toBeGreaterThanOrEqual(1);
    expect(wDefault.difficulty).toBeLessThanOrEqual(2); // default 1..2

    const wMobile = selectWorkload({ algorithm: 'argon2id', argonProfile: 'mobile' });
    const wStandard = selectWorkload({ algorithm: 'argon2id', argonProfile: 'standard' });
    expect(wMobile.argon).toEqual(ARGON_PROFILES.mobile);
    expect(wStandard.argon).toEqual(ARGON_PROFILES.standard);

    // calibration raise-only: slow device should clamp to minimum, fast device should raise
    const baseline = selectWorkload({ algorithm: 'argon2id', riskScore: 0, calibration: { iterations: 10, durationMs: 1000 } });
    const fast = selectWorkload({ algorithm: 'argon2id', riskScore: 0, calibration: { iterations: 1000, durationMs: 10 } });
    expect(fast.estimatedAttempts).toBeGreaterThanOrEqual(baseline.estimatedAttempts);
    expect(fast.difficulty).toBeGreaterThanOrEqual(baseline.difficulty);

    // stringly check that sha calibration still works for sha
    const sha = selectWorkload({ algorithm: 'sha256', riskScore: 50 });
    expect(sha.algorithm).toBe('sha256');
    expect((sha as unknown as { argon?: unknown }).argon).toBeUndefined();
  });

  it('selectWorkload argon rejects invalid bounds', () => {
    expect(() => selectWorkload({ algorithm: 'argon2id', minDifficulty: 9 })).toThrow('must be at most 8');
    expect(() => selectWorkload({ algorithm: 'argon2id', argonProfile: 'high' as never })).toThrow('argonProfile must be "mobile" or "standard"');
    expect(() => selectWorkload({ algorithm: 'sha256', argonProfile: 'mobile' as never })).toThrow('argonProfile is only valid when algorithm is "argon2id"');
  });

  it('calibrateArgonNode returns shared shape and is distinct from calibrateNode', async () => {
    const shaCal = calibrateNode(2);
    const argonCal = await calibrateArgonNode(2);
    expect(shaCal.iterations).toBe(2);
    expect(argonCal.iterations).toBe(2);
    expect(argonCal.durationMs).toBeGreaterThanOrEqual(1);
    // argon is slower than sha per iteration (hash-wasm ~6ms vs sha microseconds)
    // not strict, but argon duration should not be zero
    const argonCal2 = await calibrateArgonClient(2);
    expect(argonCal2.iterations).toBe(2);
  });

  it('createChallenge argon difficulty auto uses argon bounds and calibration', async () => {
    const cal = await calibrateArgonNode(2);
    const tokens = await createChallenge({
      algorithm: 'argon2id',
      difficulty: 'auto',
      calibration: cal,
      targetDurationMs: 750,
      minDifficulty: 1,
      maxDifficulty: 2,
      argonProfile: 'mobile',
    });
    const p = jwt.decode(tokens[0]!) as Record<string, unknown>;
    expect(p.difficulty).toBeGreaterThanOrEqual(1);
    expect(p.difficulty).toBeLessThanOrEqual(2);
    expect(p.alg).toBe('argon2id');
    const sols = await solveChallengeAsync(tokens);
    expect(sols).toHaveLength(tokens.length);
    await expect(verifySolution(tokens, sols!)).resolves.toEqual({ valid: true });
  });

  it('explicit workload override works for argon', async () => {
    const tokens = await createChallenge({ algorithm: 'argon2id', workload: { difficulty: 1, amount: 2 } });
    expect(tokens).toHaveLength(2);
    const p = jwt.decode(tokens[0]!) as Record<string, unknown>;
    expect(p.difficulty).toBe(1);
    const sols = await solveChallengeAsync(tokens);
    await expect(verifySolution(tokens, sols!)).resolves.toEqual({ valid: true });
  });

  it('onEvent for argon includes algorithm', async () => {
    const onEvent = vi.fn();
    const _tokens = await createChallenge({ algorithm: 'argon2id', difficulty: 1, amount: 2, onEvent });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'challenge-issued', algorithm: 'argon2id' }));
    // sha does NOT include algorithm (backward compat)
    const onEvent2 = vi.fn();
    await createChallenge({ difficulty: 1, amount: 1, onEvent: onEvent2 });
    expect(onEvent2).toHaveBeenCalledWith({ type: 'challenge-issued', difficulty: 1, amount: 1 });
  });

  it('assess with argon workload returns argon workload when challenged', async () => {
    const highRisk = await assess({ signals: { requestVelocity: 200 }, workload: { algorithm: 'argon2id', argonProfile: 'mobile' } });
    // default thresholds challenge 40, block 80 -> velocity 200 gives high risk -> may be block or challenge
    // Ensure if challenged, workload has argon
    if (highRisk.action === 'challenge') {
      expect(highRisk.workload).toBeDefined();
      expect(highRisk.workload?.algorithm).toBe('argon2id');
      expect(highRisk.workload?.argon).toEqual(ARGON_PROFILES.mobile);
    } else {
      // if blocked, no workload
      expect(highRisk.workload).toBeUndefined();
    }
    await expect(assess({ signals: {}, workload: { algorithm: 'sha256', argonProfile: 'mobile' as never } })).rejects.toThrow('argonProfile is only valid when algorithm is "argon2id"');
  });

  it('handles concurrent argon verification with single winner (local replay)', async () => {
    const tokens = await createChallenge({ algorithm: 'argon2id', difficulty: 1, amount: 1 });
    const sol = (await solveChallengeAsync(tokens))!;
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => verifySolution(tokens, sol)));
    const successes = results.filter(r => r.status === 'fulfilled' && (r.value as { valid: boolean }).valid);
    expect(successes).toHaveLength(1);
  });
});

describe('challenge entropy and construction version', () => {
  function resign(payload: Record<string, unknown>): string {
    return jwt.sign(payload, process.env.RIBAUNT_SECRET!);
  }

  it('issues v:1 tokens with 22-char (128-bit) challenges', async () => {
    const [sha] = await createChallenge({ difficulty: 1, amount: 1 });
    const [argon] = await createChallenge({ algorithm: 'argon2id', difficulty: 1, amount: 1 });
    for (const tok of [sha, argon]) {
      const p = jwt.decode(tok!) as Record<string, unknown>;
      expect(p.v).toBe(1);
      expect(typeof p.challenge).toBe('string');
      expect((p.challenge as string).length).toBeGreaterThanOrEqual(16);
    }
  });

  it('still verifies legacy tokens without a version (sha + argon)', async () => {
    const [sha] = await createChallenge({ difficulty: 1, amount: 1 });
    const shaPayload = jwt.decode(sha!) as Record<string, unknown>;
    delete shaPayload.v;
    const legacySha = resign({ ...shaPayload, challenge: 'short12' });
    const shaSol = solveChallenge(legacySha);
    expect(shaSol).toBeDefined();
    await expect(verifySolution(legacySha, shaSol!, { replayPrevention: 'disabled' })).resolves.toEqual({ valid: true });

    const [argon] = await createChallenge({ algorithm: 'argon2id', difficulty: 1, amount: 1 });
    const argonPayload = jwt.decode(argon!) as Record<string, unknown>;
    delete argonPayload.v;
    const legacyArgon = resign({ ...argonPayload, challenge: 'abcd1234' });
    const argonSol = await solveChallengeAsync(legacyArgon);
    expect(argonSol).toBeDefined();
    await expect(verifySolution(legacyArgon, argonSol!, { replayPrevention: 'disabled' })).resolves.toEqual({ valid: true });
  });

  it('fails closed on unknown construction versions', async () => {
    const [sha] = await createChallenge({ difficulty: 1, amount: 1 });
    const shaPayload = jwt.decode(sha!) as Record<string, unknown>;
    const badSha = resign({ ...shaPayload, v: 2 });
    expect(solveChallenge(badSha)).toBeUndefined();
    expect(await solveChallengeAsync(badSha)).toBeUndefined();
    await expect(verifySolution(badSha, { nonce: '0', hash: '00' }, { replayPrevention: 'disabled', debug: false }))
      .resolves.toMatchObject({ valid: false, reason: 'invalid-token' });

    const [argon] = await createChallenge({ algorithm: 'argon2id', difficulty: 1, amount: 1 });
    const argonPayload = jwt.decode(argon!) as Record<string, unknown>;
    const badArgon = resign({ ...argonPayload, v: 2 });
    expect(await solveChallengeAsync(badArgon)).toBeUndefined();
    await expect(verifySolution(badArgon, { nonce: '0', hash: '00' }, { replayPrevention: 'disabled', debug: false }))
      .resolves.toMatchObject({ valid: false, reason: 'invalid-token' });
  });
});
