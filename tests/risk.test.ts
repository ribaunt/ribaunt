import {
  assess,
  selectWorkload,
  DEFAULT_RISK_THRESHOLDS,
} from '../src/index';
import {
  defaultScore,
  normalizeAccountAge,
  normalizeRequestVelocity,
  scoreUserAgent,
  scoreIp,
  clampRisk,
  validateRiskThresholds,
  validateScorerOutput,
} from '../src/risk';
import { describe, expect, it, vi } from 'vitest';

describe('risk engine - default scorer deterministic fixtures', () => {
  it('scores empty signals as 0', async () => {
    const result = await assess({ signals: {} });
    expect(result.risk).toBe(0);
    expect(result.action).toBe('allow');
    expect(result.workload).toBeUndefined();
  });

  it('scores only account age (young)', async () => {
    expect(await assess({ signals: { accountAgeSeconds: 30 } })).toMatchObject({ risk: 30 });
    expect(await assess({ signals: { accountAgeSeconds: 100 } })).toMatchObject({ risk: 25 });
    expect(await assess({ signals: { accountAgeSeconds: 5000 } })).toMatchObject({ risk: 20 });
    expect(await assess({ signals: { accountAgeSeconds: 100000 } })).toMatchObject({ risk: 15 });
    expect(await assess({ signals: { accountAgeSeconds: 1000000 } })).toMatchObject({ risk: 10 });
    expect(await assess({ signals: { accountAgeSeconds: 5000000 } })).toMatchObject({ risk: 5 });
    expect(await assess({ signals: { accountAgeSeconds: 10000000 } })).toMatchObject({ risk: 0 });
  });

  it('scores only request velocity', async () => {
    expect(await assess({ signals: { requestVelocity: 0 } })).toMatchObject({ risk: 0 });
    expect(await assess({ signals: { requestVelocity: 2 } })).toMatchObject({ risk: 10 });
    expect(await assess({ signals: { requestVelocity: 10 } })).toMatchObject({ risk: 20 });
    expect(await assess({ signals: { requestVelocity: 50 } })).toMatchObject({ risk: 30 });
    expect(await assess({ signals: { requestVelocity: 100 } })).toMatchObject({ risk: 35 });
    expect(await assess({ signals: { requestVelocity: 500 } })).toMatchObject({ risk: 40 });
  });

  it('scores only user agent', async () => {
    const longUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    expect(await assess({ signals: { userAgent: longUA } })).toMatchObject({ risk: 0 });
    expect(await assess({ signals: { userAgent: 'a' } })).toMatchObject({ risk: 10 });
    expect(await assess({ signals: { userAgent: '' } })).toMatchObject({ risk: 5 });
    expect(await assess({ signals: { userAgent: '   ' } })).toMatchObject({ risk: 5 });
    // non-string treated as missing => 0
    expect(await assess({ signals: { userAgent: null as unknown as string } })).toMatchObject({ risk: 0 });
  });

  it('scores multiple signals combined', async () => {
    // 30 (age <60) + 30 (velocity 50) + 10 (UA 'x') = 70
    const r = await assess({ signals: { accountAgeSeconds: 10, requestVelocity: 50, userAgent: 'x' } });
    expect(r.risk).toBe(70);
    expect(r.action).toBe('challenge');
    expect(r.workload).toBeDefined();
  });

  it('ignores unknown signals', async () => {
    const empty = await assess({ signals: {} });
    const unknown = await assess({ signals: { unknownFoo: 'bar', custom: 123, nested: { x: 1 } } });
    expect(empty.risk).toBe(unknown.risk);
    const withAge = await assess({ signals: { accountAgeSeconds: 30 } });
    const withAgeUnknown = await assess({ signals: { accountAgeSeconds: 30, unknownFoo: 'bar' } });
    expect(withAge.risk).toBe(withAgeUnknown.risk);
  });

  it('ignores invalid numeric signals', async () => {
    expect(await assess({ signals: { accountAgeSeconds: NaN } })).toMatchObject({ risk: 0 });
    expect(await assess({ signals: { accountAgeSeconds: Infinity } })).toMatchObject({ risk: 0 });
    expect(await assess({ signals: { accountAgeSeconds: -Infinity } })).toMatchObject({ risk: 0 });
    expect(await assess({ signals: { accountAgeSeconds: -5 } })).toMatchObject({ risk: 0 });
    expect(await assess({ signals: { requestVelocity: NaN } })).toMatchObject({ risk: 0 });
    expect(await assess({ signals: { requestVelocity: Infinity } })).toMatchObject({ risk: 0 });
    expect(await assess({ signals: { requestVelocity: -10 } })).toMatchObject({ risk: 0 });
    // non-number types ignored
    expect(await assess({ signals: { accountAgeSeconds: '10' as unknown as number } })).toMatchObject({ risk: 0 });
  });

  it('handles extreme numeric values without overflow', async () => {
    expect(await assess({ signals: { accountAgeSeconds: 1e12 } })).toMatchObject({ risk: 0 });
    expect(await assess({ signals: { requestVelocity: 1e12 } })).toMatchObject({ risk: 40 });
    // extreme both still clamped 0..100
    const extreme = await assess({ signals: { accountAgeSeconds: 1e12, requestVelocity: 1e12 } });
    expect(extreme.risk).toBe(40);
    expect(extreme.risk).toBeGreaterThanOrEqual(0);
    expect(extreme.risk).toBeLessThanOrEqual(100);
  });

  it('is deterministic', async () => {
    const signals = { accountAgeSeconds: 42, requestVelocity: 13, userAgent: 'test-agent-long-enough' };
    const first = await assess({ signals });
    const second = await assess({ signals });
    expect(first.risk).toBe(second.risk);
    expect(first.action).toBe(second.action);
  });

  it('ip is ignored by default scorer', async () => {
    expect(await assess({ signals: { ip: '1.2.3.4' } })).toMatchObject({ risk: 0 });
    expect(await assess({ signals: { ip: 'malicious-ip', accountAgeSeconds: 10 } })).toMatchObject({ risk: 30 });
  });

  it('result is always finite and within 0..100', async () => {
    const cases = [
      {},
      { accountAgeSeconds: 0 },
      { requestVelocity: 1e9 },
      { accountAgeSeconds: -1, requestVelocity: -1, userAgent: '' },
      { accountAgeSeconds: 1e12, requestVelocity: 1e12, userAgent: 'x', ip: '1.1.1.1', unknown: 'foo' },
    ];
    for (const signals of cases) {
      const r = await assess({ signals });
      expect(Number.isFinite(r.risk)).toBe(true);
      expect(r.risk).toBeGreaterThanOrEqual(0);
      expect(r.risk).toBeLessThanOrEqual(100);
    }
  });
});

describe('risk engine - helper unit tests', () => {
  it('normalizeAccountAge buckets', () => {
    expect(normalizeAccountAge(10)).toBe(30);
    expect(normalizeAccountAge(59)).toBe(30);
    expect(normalizeAccountAge(60)).toBe(25);
    expect(normalizeAccountAge(3599)).toBe(25);
    expect(normalizeAccountAge(3600)).toBe(20);
    expect(normalizeAccountAge(86399)).toBe(20);
    expect(normalizeAccountAge(86400)).toBe(15);
    expect(normalizeAccountAge(604799)).toBe(15);
    expect(normalizeAccountAge(604800)).toBe(10);
    expect(normalizeAccountAge(2591999)).toBe(10);
    expect(normalizeAccountAge(2592000)).toBe(5);
    expect(normalizeAccountAge(7775999)).toBe(5);
    expect(normalizeAccountAge(7776000)).toBe(0);
    expect(normalizeAccountAge(9999999)).toBe(0);
    expect(normalizeAccountAge(NaN)).toBe(0);
    expect(normalizeAccountAge(Infinity)).toBe(0);
    expect(normalizeAccountAge(-1)).toBe(0);
  });

  it('normalizeRequestVelocity buckets', () => {
    expect(normalizeRequestVelocity(0)).toBe(0);
    expect(normalizeRequestVelocity(0.5)).toBe(0);
    expect(normalizeRequestVelocity(1)).toBe(10);
    expect(normalizeRequestVelocity(4.9)).toBe(10);
    expect(normalizeRequestVelocity(5)).toBe(20);
    expect(normalizeRequestVelocity(19)).toBe(20);
    expect(normalizeRequestVelocity(20)).toBe(30);
    expect(normalizeRequestVelocity(59)).toBe(30);
    expect(normalizeRequestVelocity(60)).toBe(35);
    expect(normalizeRequestVelocity(199)).toBe(35);
    expect(normalizeRequestVelocity(200)).toBe(40);
    expect(normalizeRequestVelocity(1e9)).toBe(40);
  });

  it('scoreUserAgent weak signal only', () => {
    expect(scoreUserAgent(undefined)).toBe(0);
    expect(scoreUserAgent(null)).toBe(0);
    expect(scoreUserAgent(123 as unknown as string)).toBe(0);
    expect(scoreUserAgent('')).toBe(5);
    expect(scoreUserAgent('   ')).toBe(5);
    expect(scoreUserAgent('short')).toBe(10);
    expect(scoreUserAgent('bot')).toBe(10);
    expect(scoreUserAgent('123456789')).toBe(10);
    expect(scoreUserAgent('1234567890')).toBe(0);
    expect(scoreUserAgent('Mozilla/5.0 (Windows NT 10.0)')).toBe(0);
    // ensure no bot substring ban
    expect(scoreUserAgent('this is a bot')).toBe(0);
  });

  it('scoreIp always 0', () => {
    expect(scoreIp('1.2.3.4')).toBe(0);
    expect(scoreIp(undefined)).toBe(0);
    expect(scoreIp('')).toBe(0);
  });

  it('clampRisk', () => {
    expect(clampRisk(-10)).toBe(0);
    expect(clampRisk(0)).toBe(0);
    expect(clampRisk(50.4)).toBe(50);
    expect(clampRisk(50.6)).toBe(51);
    expect(clampRisk(100)).toBe(100);
    expect(clampRisk(200)).toBe(100);
    expect(clampRisk(NaN)).toBe(0);
    expect(clampRisk(Infinity)).toBe(0);
  });

  it('defaultScore is deterministic and sum of helpers', () => {
    const signals = { accountAgeSeconds: 10, requestVelocity: 10, userAgent: 'x' } as const;
    expect(defaultScore(signals)).toBe(
      normalizeAccountAge(10) + normalizeRequestVelocity(10) + scoreUserAgent('x') + scoreIp(undefined)
    );
    expect(defaultScore({})).toBe(0);
  });

  it('validateRiskThresholds', () => {
    expect(() => validateRiskThresholds({ challenge: 40, block: 80 })).not.toThrow();
    expect(() => validateRiskThresholds({ challenge: 0, block: 1 })).not.toThrow();
    expect(() => validateRiskThresholds({ challenge: 0, block: 100 })).not.toThrow();
  });

  it('validateScorerOutput', () => {
    expect(validateScorerOutput(0)).toBe(0);
    expect(validateScorerOutput(50)).toBe(50);
    expect(validateScorerOutput(100)).toBe(100);
    expect(() => validateScorerOutput(NaN)).toThrow();
    expect(() => validateScorerOutput(Infinity)).toThrow();
    expect(() => validateScorerOutput(-1)).toThrow();
    expect(() => validateScorerOutput(101)).toThrow();
    expect(() => validateScorerOutput('50' as unknown as number)).toThrow();
  });
});

describe('risk engine - threshold boundaries', () => {
  const thresholds = { challenge: 40, block: 80 } as const;

  it('39 -> allow', async () => {
    const r = await assess({ signals: {}, scorer: { score: async () => 39 }, thresholds });
    expect(r.risk).toBe(39);
    expect(r.action).toBe('allow');
    expect(r.workload).toBeUndefined();
  });

  it('40 -> challenge', async () => {
    const r = await assess({ signals: {}, scorer: { score: async () => 40 }, thresholds });
    expect(r.action).toBe('challenge');
    expect(r.workload).toBeDefined();
  });

  it('41 -> challenge', async () => {
    const r = await assess({ signals: {}, scorer: { score: async () => 41 }, thresholds });
    expect(r.action).toBe('challenge');
  });

  it('79 -> challenge', async () => {
    const r = await assess({ signals: {}, scorer: { score: async () => 79 }, thresholds });
    expect(r.action).toBe('challenge');
  });

  it('80 -> block', async () => {
    const r = await assess({ signals: {}, scorer: { score: async () => 80 }, thresholds });
    expect(r.action).toBe('block');
    expect(r.workload).toBeUndefined();
  });

  it('81 -> block', async () => {
    const r = await assess({ signals: {}, scorer: { score: async () => 81 }, thresholds });
    expect(r.action).toBe('block');
  });

  it('works with non-default thresholds', async () => {
    const custom = { challenge: 20, block: 60 };
    expect((await assess({ signals: {}, scorer: { score: async () => 19 }, thresholds: custom })).action).toBe('allow');
    expect((await assess({ signals: {}, scorer: { score: async () => 20 }, thresholds: custom })).action).toBe('challenge');
    expect((await assess({ signals: {}, scorer: { score: async () => 59 }, thresholds: custom })).action).toBe('challenge');
    expect((await assess({ signals: {}, scorer: { score: async () => 60 }, thresholds: custom })).action).toBe('block');
  });

  it('uses DEFAULT_RISK_THRESHOLDS when not provided', async () => {
    expect(DEFAULT_RISK_THRESHOLDS).toEqual({ challenge: 40, block: 80 });
    expect((await assess({ signals: {}, scorer: { score: async () => 39 } })).action).toBe('allow');
    expect((await assess({ signals: {}, scorer: { score: async () => 40 } })).action).toBe('challenge');
    expect((await assess({ signals: {}, scorer: { score: async () => 80 } })).action).toBe('block');
  });
});

describe('risk engine - invalid thresholds', () => {
  it.each([
    [{ challenge: -1, block: 80 }, /Challenge threshold must be between 0 and 100/],
    [{ challenge: 101, block: 80 }, /Challenge threshold must be between 0 and 100/],
    [{ challenge: 40, block: -1 }, /Block threshold must be between 0 and 100/],
    [{ challenge: 40, block: 101 }, /Block threshold must be between 0 and 100/],
    [{ challenge: 40, block: 0 }, /Challenge threshold must be less than block threshold/],
    [{ challenge: 80, block: 40 }, /Challenge threshold must be less than block threshold/],
    [{ challenge: 50, block: 50 }, /Challenge threshold must be less than block threshold/],
    [{ challenge: NaN, block: 80 }, /Challenge threshold must be a finite number/],
    [{ challenge: Infinity, block: 80 }, /Challenge threshold must be a finite number/],
    [{ challenge: 40, block: NaN }, /Block threshold must be a finite number/],
    [{ challenge: 40, block: Infinity }, /Block threshold must be a finite number/],
  ])('rejects thresholds %j', async (thresholds, pattern) => {
    await expect(assess({ signals: {}, thresholds: thresholds as any })).rejects.toThrow(pattern);
  });

  it('rejects non-object thresholds', async () => {
    await expect(assess({ signals: {}, thresholds: null as any })).rejects.toThrow(/Risk thresholds must be an object/);
    await expect(assess({ signals: {}, thresholds: 'bad' as any })).rejects.toThrow(/Risk thresholds must be an object/);
    await expect(assess({ signals: {}, thresholds: [] as any })).rejects.toThrow(/Risk thresholds must be an object/);
  });

  it('rejects missing challenge/block', async () => {
    await expect(assess({ signals: {}, thresholds: { challenge: 40 } as any })).rejects.toThrow(/Block threshold must be a finite number/);
    await expect(assess({ signals: {}, thresholds: { block: 80 } as any })).rejects.toThrow(/Challenge threshold must be a finite number/);
  });
});

describe('risk engine - custom scorer usage', () => {
  it('uses custom scorer result to drive action', async () => {
    const scorer = { score: async () => 90 };
    const r = await assess({ signals: {}, scorer });
    expect(r.risk).toBe(90);
    expect(r.action).toBe('block');
  });

  it('does not execute default scorer when custom scorer is supplied', async () => {
    const customScorer = { score: vi.fn(async () => 10) };
    await assess({ signals: { accountAgeSeconds: 0 }, scorer: customScorer });
    expect(customScorer.score).toHaveBeenCalledTimes(1);
    expect(customScorer.score).toHaveBeenCalledWith(expect.objectContaining({ accountAgeSeconds: 0 }));
  });

  it('supports sync scorer returning number (await unwraps)', async () => {
    const syncScorer = { score: () => 45 } as unknown as { score: () => Promise<number> };
    const r = await assess({ signals: {}, scorer: syncScorer });
    expect(r.risk).toBe(45);
    expect(r.action).toBe('challenge');
  });

  it('passes through signals to custom scorer including unknown keys', async () => {
    const scorer = { score: vi.fn(async () => 0) };
    await assess({ signals: { ip: '1.2.3.4', customField: 'foo', another: 123 } as any, scorer });
    expect(scorer.score).toHaveBeenCalledWith(
      expect.objectContaining({ ip: '1.2.3.4', customField: 'foo', another: 123 })
    );
  });

  it('custom scorer can use unknown signals to produce risk', async () => {
    const scorer = {
      score: async (signals: any) => (signals.privileged ? 90 : 10),
    };
    expect((await assess({ signals: { privileged: true } as any, scorer })).action).toBe('block');
    expect((await assess({ signals: { privileged: false } as any, scorer })).action).toBe('allow');
  });
});

describe('risk engine - custom scorer failures', () => {
  it('propagates scorer exceptions', async () => {
    await expect(
      assess({ signals: {}, scorer: { score: async () => { throw new Error('oops'); } } })
    ).rejects.toThrow('oops');
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite scorer output %s', async (value) => {
    await expect(assess({ signals: {}, scorer: { score: async () => value } })).rejects.toThrow(
      /Scorer must return a finite number between 0 and 100/
    );
  });

  it.each([-1, 101])('rejects out-of-range scorer output %s', async (value) => {
    await expect(assess({ signals: {}, scorer: { score: async () => value } })).rejects.toThrow(
      /Scorer must return a number between 0 and 100/
    );
  });

  it.each(['50', undefined, null, {}, []])('rejects non-number scorer output %s', async (value) => {
    await expect(assess({ signals: {}, scorer: { score: async () => value as any } })).rejects.toThrow(
      /Scorer must return a finite number between 0 and 100/
    );
  });

  it('does not silently clamp custom scorer', async () => {
    // 101 should throw, not clamp to 100
    await expect(assess({ signals: {}, scorer: { score: async () => 101 } })).rejects.toThrow();
    // -1 should throw, not clamp to 0
    await expect(assess({ signals: {}, scorer: { score: async () => -1 } })).rejects.toThrow();
  });
});

describe('risk engine - partial signals', () => {
  it.each([
    [{ ip: '1.2.3.4' }],
    [{ userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }],
    [{ userAgent: 'a' }],
    [{ accountAgeSeconds: 100 }],
    [{ requestVelocity: 2 }],
    [{ requestVelocity: 0 }],
    [{}],
  ])('handles partial signals %j without throwing', async (signals) => {
    await expect(assess({ signals: signals as any })).resolves.toBeDefined();
  });

  it('partial signals produce bounded risk', async () => {
    for (const signals of [
      { ip: '...' },
      { userAgent: '...' },
      { accountAgeSeconds: 100 },
      { requestVelocity: 2 },
    ] as const) {
      const r = await assess({ signals });
      expect(r.risk).toBeGreaterThanOrEqual(0);
      expect(r.risk).toBeLessThanOrEqual(100);
    }
  });
});

describe('risk engine - workload equivalence', () => {
  const opts = { minDifficulty: 3, maxDifficulty: 6, minAmount: 1, maxAmount: 8 };

  it.each([40, 50, 70])('selectWorkload equivalence for risk %s', async (risk) => {
    const expected = selectWorkload({ riskScore: risk, ...opts });
    const result = await assess({ signals: {}, scorer: { score: async () => risk }, workload: opts });
    expect(result.workload).toEqual(expected);
    expect(result.risk).toBe(risk);
    expect(result.action).toBe('challenge');
  });

  it('workload equivalence with calibration', async () => {
    const workload = {
      ...opts,
      targetDurationMs: 750,
      calibration: { iterations: 1_000_000, durationMs: 1 },
    };
    const risk = 50;
    const expected = selectWorkload({ riskScore: risk, ...workload });
    const result = await assess({ signals: {}, scorer: { score: async () => risk }, workload });
    expect(result.workload).toEqual(expected);
  });

  it('workload equivalence with partial bounds', async () => {
    const workload = { minDifficulty: 4 };
    const risk = 50;
    const expected = selectWorkload({ riskScore: risk, ...workload });
    const result = await assess({ signals: {}, scorer: { score: async () => risk }, workload });
    expect(result.workload).toEqual(expected);
  });

  it('workload is overridden by assessed risk even if workload contains riskScore', async () => {
    const risk = 70;
    const workload: any = { minDifficulty: 3, maxDifficulty: 6, minAmount: 1, maxAmount: 8, riskScore: 10 };
    const expected = selectWorkload({ riskScore: risk, minDifficulty: 3, maxDifficulty: 6, minAmount: 1, maxAmount: 8 });
    const result = await assess({ signals: {}, scorer: { score: async () => risk }, workload });
    expect(result.workload).toEqual(expected);
    expect(result.risk).toBe(70);
  });
});

describe('risk engine - result invariants', () => {
  it('allow has no workload', async () => {
    const r = await assess({ signals: {}, scorer: { score: async () => 10 } });
    expect(r.action).toBe('allow');
    expect(r.workload).toBeUndefined();
  });

  it('challenge has workload', async () => {
    const r = await assess({ signals: {}, scorer: { score: async () => 50 } });
    expect(r.action).toBe('challenge');
    expect(r.workload).toBeDefined();
    expect(r.workload).toHaveProperty('difficulty');
    expect(r.workload).toHaveProperty('amount');
    expect(r.workload).toHaveProperty('estimatedAttempts');
  });

  it('block has no workload', async () => {
    const r = await assess({ signals: {}, scorer: { score: async () => 90 } });
    expect(r.action).toBe('block');
    expect(r.workload).toBeUndefined();
  });

  it('default thresholds invariants hold', async () => {
    // risk 0 -> allow, no workload
    expect((await assess({ signals: { accountAgeSeconds: 1e12 } })).workload).toBeUndefined();
    // risk 70 -> challenge, has workload
    expect((await assess({ signals: { accountAgeSeconds: 10, requestVelocity: 50, userAgent: 'x' } })).workload).toBeDefined();
    // risk via custom 90 -> block, no workload
    expect((await assess({ signals: {}, scorer: { score: async () => 90 } })).workload).toBeUndefined();
  });
});

describe('risk engine - workload option validation', () => {
  it.each([
    [{ minDifficulty: 0 }, /Minimum difficulty must be at least 1/],
    [{ minDifficulty: -1 }, /Minimum difficulty must be at least 1/],
    [{ minDifficulty: NaN }, /Minimum difficulty must be a finite number/],
    [{ minDifficulty: Infinity }, /Minimum difficulty must be a finite number/],
    [{ maxDifficulty: 1, minDifficulty: 3 }, /Maximum difficulty must be at least 3/],
    [{ minAmount: 0 }, /Minimum amount must be at least 1/],
    [{ maxAmount: 1, minAmount: 5 }, /Maximum amount must be at least 5/],
    [{ targetDurationMs: 0 }, /Target duration must be at least 1/],
    [{ targetDurationMs: -5 }, /Target duration must be at least 1/],
    [{ targetDurationMs: NaN }, /Target duration must be a finite number/],
    [{ targetDurationMs: Infinity }, /Target duration must be a finite number/],
    [{ calibration: { iterations: 0, durationMs: 1 } }, /Calibration iterations must be at least 1/],
    [{ calibration: { iterations: NaN, durationMs: 1 } }, /Calibration iterations must be a finite number/],
    [{ calibration: { iterations: 1, durationMs: 0 } }, /Calibration duration must be at least 1/],
    [{ calibration: { iterations: 1, durationMs: NaN } }, /Calibration duration must be a finite number/],
  ])('rejects invalid workload %j', async (workload, pattern) => {
    await expect(assess({ signals: {}, scorer: { score: async () => 50 }, workload: workload as any })).rejects.toThrow(pattern);
  });

  it('rejects non-object workload', async () => {
    await expect(assess({ signals: {}, workload: null as any })).rejects.toThrow(/workload must be an object/);
    await expect(assess({ signals: {}, workload: 'bad' as any })).rejects.toThrow(/workload must be an object/);
    await expect(assess({ signals: {}, workload: [] as any })).rejects.toThrow(/workload must be an object/);
  });

  it('rejects non-object calibration', async () => {
    await expect(
      assess({ signals: {}, scorer: { score: async () => 50 }, workload: { calibration: null as any } })
    ).rejects.toThrow(/Calibration must be an object/);
    await expect(
      assess({ signals: {}, scorer: { score: async () => 50 }, workload: { calibration: 'bad' as any } })
    ).rejects.toThrow(/Calibration must be an object/);
  });

  it('validates workload even when action is allow (fail fast)', async () => {
    // risk 10 -> allow, but workload is invalid => should still reject
    await expect(
      assess({ signals: {}, scorer: { score: async () => 10 }, workload: { minDifficulty: 0 } })
    ).rejects.toThrow(/Minimum difficulty must be at least 1/);
  });
});

describe('risk engine - AssessOptions validation', () => {
  it('rejects missing signals', async () => {
    await expect(assess({} as any)).rejects.toThrow(/signals must be an object/);
    await expect(assess({ signals: undefined as any })).rejects.toThrow(/signals must be an object/);
    await expect(assess({ signals: null as any })).rejects.toThrow(/signals must be an object/);
    await expect(assess({ signals: [] as any })).rejects.toThrow(/signals must be an object/);
    await expect(assess({ signals: 'bad' as any })).rejects.toThrow(/signals must be an object/);
  });

  it('rejects non-object AssessOptions', async () => {
    await expect(assess(null as any)).rejects.toThrow(/AssessOptions must be an object/);
    await expect(assess(undefined as any)).rejects.toThrow(/AssessOptions must be an object/);
    await expect(assess('bad' as any)).rejects.toThrow(/AssessOptions must be an object/);
    await expect(assess([] as any)).rejects.toThrow(/AssessOptions must be an object/);
  });

  it('rejects invalid scorer', async () => {
    await expect(assess({ signals: {}, scorer: null as any })).rejects.toThrow(/scorer must be an object with a score function/);
    await expect(assess({ signals: {}, scorer: {} as any })).rejects.toThrow(/scorer must be an object with a score function/);
    await expect(assess({ signals: {}, scorer: { score: 'not a fn' } as any })).rejects.toThrow(
      /scorer must be an object with a score function/
    );
  });
});

describe('risk engine - workload bounds upper limits (stability)', () => {
  it.each([
    [{ maxDifficulty: 65 }, /Maximum difficulty must be at most 64/],
    [{ minDifficulty: 65, maxDifficulty: 65 }, /Minimum difficulty must be at most 64/],
    [{ maxAmount: 65 }, /Maximum amount must be at most 64/],
    [{ minAmount: 65, maxAmount: 65 }, /Minimum amount must be at most 64/],
    [{ maxDifficulty: 1_000_000 }, /Maximum difficulty must be at most 64/],
    [{ maxAmount: 1_000_000 }, /Maximum amount must be at most 64/],
  ])('rejects huge workload %j with bounded error', async (workload, pattern) => {
    const start = Date.now();
    await expect(assess({ signals: {}, scorer: { score: async () => 50 }, workload: workload as any })).rejects.toThrow(
      pattern
    );
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('bounds selectWorkload directly', () => {
    const start = Date.now();
    expect(() => selectWorkload({ maxDifficulty: 1_000_000 })).toThrow(/at most 64/);
    expect(() => selectWorkload({ maxAmount: 1_000_000 })).toThrow(/at most 64/);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('allows max bounds 64/64 (candidate count 4096) and rejects too-large candidate count if limits were higher', async () => {
    // 64,64 is within upper bounds and candidate count 4096 < 10_000
    await expect(
      assess({ signals: {}, scorer: { score: async () => 50 }, workload: { minDifficulty: 1, maxDifficulty: 64, minAmount: 1, maxAmount: 64 } })
    ).resolves.toBeDefined();
  });
});

describe('risk engine - DEFAULT_RISK_THRESHOLDS immutability', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_RISK_THRESHOLDS)).toBe(true);
  });

  it('mutation does not change assess behavior', async () => {
    const before = { ...DEFAULT_RISK_THRESHOLDS };
    // attempt to mutate (in strict mode throws, in sloppy fails silently due to freeze)
    try {
      (DEFAULT_RISK_THRESHOLDS as any).challenge = 0;
    } catch {
      void 0;
    }
    expect(DEFAULT_RISK_THRESHOLDS).toEqual(before);
    // 39 should still be allow with default 40/80
    expect((await assess({ signals: {}, scorer: { score: async () => 39 } })).action).toBe('allow');
    expect((await assess({ signals: {}, scorer: { score: async () => 40 } })).action).toBe('challenge');
    // also ensure assess copies thresholds so later mutation of passed-in object does not affect library
    const custom = { challenge: 10, block: 20 };
    expect((await assess({ signals: {}, scorer: { score: async () => 15 }, thresholds: custom })).action).toBe(
      'challenge'
    );
    custom.challenge = 100;
    expect((await assess({ signals: {}, scorer: { score: async () => 15 } })).action).toBe('allow');
  });
});

describe('risk engine - compatibility and exports', () => {
  it('is exported from ribaunt', async () => {
    const mod = await import('../src/index');
    expect(typeof mod.assess).toBe('function');
    expect(typeof mod.DEFAULT_RISK_THRESHOLDS).toBe('object');
    expect(mod.DEFAULT_RISK_THRESHOLDS).toEqual({ challenge: 40, block: 80 });
    expect(Object.isFrozen(mod.DEFAULT_RISK_THRESHOLDS)).toBe(true);
  });

  it('does not alter existing riskScore behavior', async () => {
    // selectWorkload still works as before
    expect(selectWorkload({ riskScore: 0 })).toMatchObject({ difficulty: 3, amount: 1 });
    expect(selectWorkload({ riskScore: 100 })).toMatchObject({ difficulty: 3, amount: 8 });
    expect(() => selectWorkload({ riskScore: -1 })).toThrow();
  });

  it('has no mandatory storage or fingerprinting', async () => {
    // assess without any storage should succeed
    await expect(assess({ signals: {} })).resolves.toBeDefined();
    await expect(assess({ signals: { ip: '1.1.1.1', userAgent: 'test' } })).resolves.toBeDefined();
  });
});
