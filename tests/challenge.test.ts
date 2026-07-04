import {
    createChallenge,
    solveChallenge,
    verifySolution,
    selectWorkload,
    calibrateNode,
    LocalReplayStore,
} from '../src/index';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

const originalSecret = process.env.RIBAUNT_SECRET;

const verifyValid = async (...args: Parameters<typeof verifySolution>): Promise<boolean> => {
    return (await verifySolution(...args)).valid;
};

beforeEach(() => {
    process.env.RIBAUNT_SECRET ??= 'codex-audit-test-secret-with-enough-entropy';
});

afterEach(() => {
    vi.useRealTimers();

    if (originalSecret === undefined) {
        delete process.env.RIBAUNT_SECRET;
        return;
    }

    process.env.RIBAUNT_SECRET = originalSecret;
});

describe('test challenge flow', () => {
    it('creates one challenge by default with the options API', () => {
        expect(createChallenge({ difficulty: 2 })).toHaveLength(1);
        expect(createChallenge(2)).toHaveLength(4);
    });

    it('binds signed challenges to an opaque context digest', async () => {
        const context = 'signup:user-42:attempt-7';
        const [token] = createChallenge({ difficulty: 2, context });
        const solution = solveChallenge(token!);
        const payload = jwt.decode(token!) as Record<string, unknown>;

        expect(payload.contextHash).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(payload)).not.toContain(context);
        expect(payload.contextHash).not.toBe(
            crypto.createHash('sha256').update(context, 'utf8').digest('hex')
        );
        await expect(verifySolution(token!, solution!, {
            context,
            replayPrevention: 'disabled',
        })).resolves.toEqual({ valid: true });
        await expect(verifySolution(token!, solution!, {
            context: 'wrong-context',
            replayPrevention: 'disabled',
        })).resolves.toMatchObject({
            valid: false,
            reason: 'context-mismatch',
        });
        await expect(verifySolution(token!, solution!, {
            replayPrevention: 'disabled',
        })).resolves.toMatchObject({
            valid: false,
            reason: 'context-mismatch',
        });
    });

    it('rejects unbound challenges when verification requires context', async () => {
        const [token] = createChallenge(2, 1);
        const solution = solveChallenge(token!);

        await expect(verifySolution(token!, solution!, {
            context: 'ignored-for-unbound-token',
            replayPrevention: 'disabled',
        })).resolves.toMatchObject({
            valid: false,
            reason: 'context-mismatch',
        });
    });

    it('uses unlinkable context digests for separate challenges', () => {
        const context = 'signup:user-42';
        const [firstToken] = createChallenge({ difficulty: 2, context });
        const [secondToken] = createChallenge({ difficulty: 2, context });
        const firstPayload = jwt.decode(firstToken!) as Record<string, unknown>;
        const secondPayload = jwt.decode(secondToken!) as Record<string, unknown>;

        expect(firstPayload.contextHash).toMatch(/^[a-f0-9]{64}$/);
        expect(secondPayload.contextHash).toMatch(/^[a-f0-9]{64}$/);
        expect(firstPayload.contextHash).not.toBe(secondPayload.contextHash);
    });

    it('rejects empty challenge batches', async () => {
        await expect(verifySolution([], [], { debug: false })).resolves.toMatchObject({
            valid: false,
            reason: 'invalid-solution',
        });
    });

    it('rejects signing secrets shorter than 32 bytes', () => {
        process.env.RIBAUNT_SECRET = 'too-short';

        expect(() => createChallenge({ difficulty: 2 })).toThrow(
            'RIBAUNT_SECRET must be at least 32 bytes'
        );
    });

    it('rejects signed challenge payloads without a replay identifier', async () => {
        const token = jwt.sign({
            challenge: 'legacy',
            difficulty: 1,
            expires: Math.floor(Date.now() / 1000) + 60,
        }, process.env.RIBAUNT_SECRET!);
        const solution = solveChallenge(token);

        await expect(verifySolution(token, solution!, { debug: false })).resolves.toMatchObject({
            valid: false,
            reason: 'invalid-token',
        });
    });

    it('selects deterministic bounded adaptive workloads', () => {
        expect(selectWorkload()).toEqual({
            difficulty: 3,
            amount: 5,
            estimatedAttempts: 20_480,
        });
        expect(selectWorkload({ riskScore: 0 })).toMatchObject({ difficulty: 3, amount: 1 });
        expect(selectWorkload({
            riskScore: 0,
            calibration: { iterations: 1_000_000, durationMs: 1 },
        })).toMatchObject({ difficulty: 6, amount: 8 });
        expect(() => selectWorkload({ riskScore: -1 })).toThrow('Risk score must be between 0 and 100');
        expect(() => selectWorkload({
            calibration: { iterations: 0, durationMs: 1 },
        })).toThrow('Calibration iterations must be at least 1');
    });

    it('uses raise-only adaptive workload for auto difficulty challenges', () => {
        const baseline = createChallenge({
            difficulty: 'auto',
            riskScore: 0,
            minDifficulty: 3,
            maxDifficulty: 6,
            minAmount: 1,
            maxAmount: 8,
        });
        const slowClaim = createChallenge({
            difficulty: 'auto',
            riskScore: 0,
            calibration: { iterations: 1, durationMs: 1_000_000 },
            minDifficulty: 3,
            maxDifficulty: 6,
            minAmount: 1,
            maxAmount: 8,
        });
        const fastClaim = createChallenge({
            difficulty: 'auto',
            riskScore: 0,
            calibration: { iterations: 1_000_000, durationMs: 1 },
            minDifficulty: 3,
            maxDifficulty: 6,
            minAmount: 1,
            maxAmount: 8,
        });

        const baselinePayload = jwt.decode(baseline[0]!) as Record<string, unknown>;
        const slowPayload = jwt.decode(slowClaim[0]!) as Record<string, unknown>;
        const fastPayload = jwt.decode(fastClaim[0]!) as Record<string, unknown>;

        expect(baseline).toHaveLength(1);
        expect(slowClaim).toHaveLength(1);
        expect(baselinePayload.difficulty).toBe(3);
        expect(slowPayload.difficulty).toBe(3);
        expect(fastClaim).toHaveLength(8);
        expect(fastPayload.difficulty).toBe(6);
    });

    it('lets explicit workload override auto difficulty selection', () => {
        const tokens = createChallenge({
            difficulty: 'auto',
            calibration: { iterations: 1_000_000, durationMs: 1 },
            workload: { difficulty: 2, amount: 2 },
        });
        const payload = jwt.decode(tokens[0]!) as Record<string, unknown>;

        expect(tokens).toHaveLength(2);
        expect(payload.difficulty).toBe(2);
    });

    it('calibrates Node clients for M2M challenge requests', () => {
        const calibration = calibrateNode(2);

        expect(calibration.iterations).toBe(2);
        expect(calibration.durationMs).toBeGreaterThanOrEqual(1);
    });

    it('uses an explicit workload when creating an options challenge', () => {
        const tokens = createChallenge({
            difficulty: 1,
            amount: 7,
            workload: { difficulty: 2, amount: 2 },
        });
        const payload = jwt.decode(tokens[0]!) as Record<string, unknown>;

        expect(tokens).toHaveLength(2);
        expect(payload.difficulty).toBe(2);
    });

    it('validates all batch proofs before atomically consuming replay keys', async () => {
        const tokens = createChallenge(2, 2);
        const solutions = solveChallenge(tokens)!;
        const replayStore = {
            consume: vi.fn(async () => true),
            consumeMany: vi.fn(async () => true),
        };

        await expect(verifyValid(tokens, [
            solutions[0]!,
            { nonce: 'invalid', hash: '' },
        ], {
            replayPrevention: 'remote',
            replayStore,
            debug: false,
        })).resolves.toBe(false);
        expect(replayStore.consume).not.toHaveBeenCalled();
        expect(replayStore.consumeMany).not.toHaveBeenCalled();

        await expect(verifyValid(tokens, solutions, {
            replayPrevention: 'remote',
            replayStore,
        })).resolves.toBe(true);
        expect(replayStore.consumeMany).toHaveBeenCalledTimes(1);
        expect(replayStore.consume).not.toHaveBeenCalled();
    });

    it('requires atomic remote replay support for challenge batches', async () => {
        const tokens = createChallenge(2, 2);
        const solutions = solveChallenge(tokens)!;

        await expect(verifySolution(tokens, solutions, {
            replayPrevention: 'remote',
            replayStore: { consume: async () => true },
            debug: false,
        })).resolves.toMatchObject({
            valid: false,
            reason: 'configuration-error',
        });
    });

    it('creates the default number of JWT challenge tokens', () => {
        const tokens = createChallenge(2,3);

        expect(Array.isArray(tokens)).toBe(true);
        expect(tokens).toHaveLength(3);
        tokens.forEach((token) => {
            expect(typeof token).toBe('string');
            expect(token.split('.').length).toBe(3);
        });
    });

    it('solves multiple challenges and validates each solution', async () => {
        const tokens = createChallenge(2, 2);
        const solutions = solveChallenge(tokens);

        expect(Array.isArray(solutions)).toBe(true);
        expect(solutions).toHaveLength(2);

        const nonces = (solutions ?? []).map((solution) => solution.nonce);
        nonces.forEach((nonce) => {
            expect(typeof nonce).toBe('string');
            expect(nonce.length).toBeGreaterThan(0);
        });

                const verification = await verifyValid(tokens, nonces);
                expect(verification).toBe(true);
    });

            it('solves a single challenge and validates the solution', async () => {
        const [token] = createChallenge(3, 1);
        const solution = solveChallenge(token);

        expect(solution).toBeTruthy();
        expect(typeof solution?.nonce).toBe('string');
        expect(solution?.nonce.length).toBeGreaterThan(0);

        const isValid = await verifyValid(token, solution!.nonce);
        expect(isValid).toBe(true);
    });

    it('rejects an invalid nonce for a valid token', async () => {
        const [token] = createChallenge(3, 1);
        const isValid = await verifyValid(token, 'invalid-nonce');
        expect(isValid).toBe(false);
    });

    it('returns false when the challenge token is tampered with', async () => {
        const [token] = createChallenge(3, 1);
        const tamperedToken = `${token}tampered`;
        const solution = solveChallenge(token);

        const isValid = solution ? await verifyValid(tamperedToken, solution.nonce, { debug: false }) : false;
        expect(isValid).toBe(false);
    });

    it('returns undefined when solving fails for an invalid token', () => {
        const solution = solveChallenge('not-a-valid-token');
        expect(solution).toBeUndefined();
    });

    it('returns undefined when solve guard maxIterations is reached', () => {
        const [token] = createChallenge(10, 1);
        const solution = solveChallenge(token, { maxIterations: 1 });
        expect(solution).toBeUndefined();
    });

    it('normalizes solve guard edge values', () => {
        const [token] = createChallenge(2, 1);
        const [hardToken] = createChallenge(10, 1);

        expect(solveChallenge(token, { maxIterations: Number.NaN })).toBeTruthy();
        expect(solveChallenge(token, { maxIterations: 0 })).toBeUndefined();
        expect(solveChallenge(token, { maxDurationMs: Number.NaN })).toBeTruthy();
        expect(solveChallenge(token, { maxDurationMs: 1000.75 })).toBeTruthy();
        expect(solveChallenge(hardToken, { maxDurationMs: 0 })).toBeUndefined();
    });

    it('returns undefined when any token in an array cannot be solved', () => {
        const [token] = createChallenge(2, 1);

        expect(solveChallenge([token, 'not-a-valid-token'])).toBeUndefined();
        expect(solveChallenge({} as never)).toBeUndefined();
        expect(solveChallenge(Symbol('bad-token') as never)).toBeUndefined();
    });

    it('returns undefined when token decoding throws unexpectedly', () => {
        const decodeSpy = vi.spyOn(jwt, 'decode').mockImplementation(() => {
            throw new Error('decode exploded');
        });

        expect(solveChallenge('throws-during-decode')).toBeUndefined();

        decodeSpy.mockRestore();
    });

    it('marks mismatched nonce arrays as invalid', async () => {
        const tokens = createChallenge(3, 2);
        const verification = await verifyValid(tokens, ['only-one-nonce']);

        expect(verification).toBe(false);
    });

    it('rejects expired challenges', async () => {
        vi.useFakeTimers();
        const issuedAt = new Date('2026-01-01T00:00:00Z');
        vi.setSystemTime(issuedAt);

        const [token] = createChallenge(2, 1, 1);
        const solution = solveChallenge(token);

        vi.setSystemTime(new Date('2026-01-01T00:00:03Z'));

        expect(solution).toBeTruthy();
        await expect(verifyValid(token, solution!.nonce)).resolves.toBe(false);
    });

    it('returns false for malformed tokens during verification', async () => {
        await expect(verifyValid('not-a-jwt', '123', { debug: false })).resolves.toBe(false);
        await expect(verifyValid(['still-not-a-jwt'], ['123'], { debug: false })).resolves.toBe(false);
    });

    it('emits debug warnings to console when enabled', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await expect(verifyValid('not-a-jwt', '123', { debug: true })).resolves.toBe(false);

        expect(warn).toHaveBeenCalledWith('[ribaunt] verifySolution rejected a token or nonce', expect.any(String));
        warn.mockRestore();
    });

    it('uses NODE_ENV development as the default debug mode', async () => {
        const originalNodeEnv = process.env.NODE_ENV;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        process.env.NODE_ENV = 'development';

        await expect(verifyValid('not-a-jwt', '123')).resolves.toBe(false);

        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
        if (originalNodeEnv === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = originalNodeEnv;
        }
    });

    it('emits debug warnings for direct validation failures', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const [token] = createChallenge(2, 1, 30);

        await expect(verifyValid(token, null as never, { debug: true })).resolves.toBe(false);

        expect(warn).toHaveBeenCalledWith('[ribaunt] verifySolution received an empty nonce', '');
        warn.mockRestore();
    });

    it('handles non-Error verification failures', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const [token] = createChallenge(2, 1, 30);
        const solution = solveChallenge(token);
        const replayStore = {
            consume: async () => {
                throw { custom: 'failure' };
            },
        };

        await expect(verifyValid(token, solution!.nonce, {
            replayPrevention: 'remote',
            replayStore,
            debug: true,
        })).resolves.toBe(false);

        expect(warn).toHaveBeenCalledWith('[ribaunt] verifySolution rejected a token or nonce', { custom: 'failure' });
        warn.mockRestore();
    });

    it('logs an empty detail for undefined verification failures', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const [token] = createChallenge(2, 1, 30);
        const solution = solveChallenge(token);
        const replayStore = {
            consume: async () => {
                throw undefined;
            },
        };

        await expect(verifyValid(token, solution!.nonce, {
            replayPrevention: 'remote',
            replayStore,
            debug: true,
        })).resolves.toBe(false);

        expect(warn).toHaveBeenCalledWith('[ribaunt] verifySolution rejected a token or nonce', '');
        warn.mockRestore();
    });

    it('classifies JWT expiration errors from standard exp claims', async () => {
        const onWarning = vi.fn();
        const token = jwt.sign({
            challenge: 'expired-standard-claim',
            difficulty: 1,
            expires: Math.floor(Date.now() / 1000) + 60,
            exp: Math.floor(Date.now() / 1000) - 1,
        }, process.env.RIBAUNT_SECRET!);

        await expect(verifyValid(token, '1', { onWarning, debug: false })).resolves.toBe(false);

        expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({
            reason: 'expired-token',
        }));
    });

    it('emits warning callbacks for malformed tokens without requiring debug logs', async () => {
        const onWarning = vi.fn();

        await expect(verifyValid('not-a-jwt', '123', {
            debug: false,
            onWarning,
        })).resolves.toBe(false);

        expect(onWarning).toHaveBeenCalledTimes(1);
        expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({
            reason: 'invalid-token',
        }));
    });

    it('emits replay-detected warning reason when replay protection blocks a token reuse', async () => {
        const onWarning = vi.fn();
        const [token] = createChallenge(2, 1, 30);
        const solution = solveChallenge(token);

        expect(solution).toBeTruthy();
        await expect(verifyValid(token, solution!.nonce, {
            replayPrevention: 'local',
            onWarning,
            debug: false,
        })).resolves.toBe(true);

        await expect(verifyValid(token, solution!.nonce, {
            replayPrevention: 'local',
            onWarning,
            debug: false,
        })).resolves.toBe(false);

        expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({
            reason: 'replay-detected',
        }));
    });

    it('emits expired-token warning reason for expired challenges', async () => {
        vi.useFakeTimers();
        const onWarning = vi.fn();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const [token] = createChallenge(2, 1, 1);
        const solution = solveChallenge(token);

        vi.setSystemTime(new Date('2026-01-01T00:00:03Z'));

        await expect(verifyValid(token, solution!.nonce, { onWarning, debug: false })).resolves.toBe(false);
        expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({
            reason: 'expired-token',
        }));
    });

    it('rejects invalid nonce payload shapes', async () => {
        const [token] = createChallenge(2, 1, 30);

        await expect(verifyValid(token, { nonce: '', hash: '' })).resolves.toBe(false);
        await expect(verifyValid(token, { nonce: null } as never)).resolves.toBe(false);
        await expect(verifyValid([token], [{ nonce: '', hash: '' }])).resolves.toBe(false);
        await expect(verifyValid(token, undefined as never)).resolves.toBe(false);
        await expect(verifyValid(token, [])).resolves.toBe(false);
        await expect(verifyValid(token, [undefined as never])).resolves.toBe(false);
        await expect(verifyValid([token], '1' as never)).resolves.toBe(false);
        await expect(verifyValid([undefined as never], ['1'])).resolves.toBe(false);
    });

    it('accepts solution object arrays and single-item nonce arrays', async () => {
        const tokens = createChallenge(2, 2, 30);
        const solutions = solveChallenge(tokens);
        const [singleToken] = createChallenge(2, 1, 30);
        const singleSolution = solveChallenge(singleToken);

        expect(Array.isArray(solutions)).toBe(true);
        await expect(verifyValid(tokens, solutions as NonNullable<typeof solutions>, {
            replayPrevention: 'disabled',
        })).resolves.toBe(true);
        await expect(verifyValid(singleToken, [singleSolution!.nonce], {
            replayPrevention: 'disabled',
        })).resolves.toBe(true);
        await expect(verifyValid(singleToken, [singleSolution!], {
            replayPrevention: 'disabled',
        })).resolves.toBe(true);
    });

    it('accepts numeric nonce values', async () => {
        const [token] = createChallenge(2, 1, 30);
        const solution = solveChallenge(token);

        expect(solution).toBeTruthy();
        await expect(verifyValid(token, Number(solution!.nonce), {
            replayPrevention: 'disabled',
        })).resolves.toBe(true);
    });

    it('blocks replay by default with local replay prevention', async () => {
        const [token] = createChallenge(2, 1, 30);
        const solution = solveChallenge(token);

        expect(solution).toBeTruthy();
        await expect(verifyValid(token, solution!.nonce)).resolves.toBe(true);
        await expect(verifyValid(token, solution!.nonce)).resolves.toBe(false);
    });

    it('allows repeated submissions only when replay prevention is explicitly disabled', async () => {
        const [token] = createChallenge(2, 1, 30);
        const solution = solveChallenge(token);

        expect(solution).toBeTruthy();
        await expect(verifyValid(token, solution!.nonce, { replayPrevention: 'disabled' })).resolves.toBe(true);
        await expect(verifyValid(token, solution!.nonce, { replayPrevention: 'disabled' })).resolves.toBe(true);
    });

    it('keeps local replay prevention behavior explicit', async () => {
        const [token] = createChallenge(2, 1, 30);
        const solution = solveChallenge(token);

        expect(solution).toBeTruthy();
        await expect(verifyValid(token, solution!.nonce, { replayPrevention: 'local' })).resolves.toBe(true);
        await expect(verifyValid(token, solution!.nonce, { replayPrevention: 'local' })).resolves.toBe(false);
    });

    it('supports custom remote replay stores', async () => {
        const [token] = createChallenge(2, 1, 30);
        const solution = solveChallenge(token);
        const consumed = new Set<string>();

        const remoteStore = {
            consume: async (jti: string) => {
                if (consumed.has(jti)) {
                    return false;
                }

                consumed.add(jti);
                return true;
            },
        };

        expect(solution).toBeTruthy();
        await expect(verifyValid(token, solution!.nonce, {
            replayPrevention: 'remote',
            replayStore: remoteStore,
        })).resolves.toBe(true);
        await expect(verifyValid(token, solution!.nonce, {
            replayPrevention: 'remote',
            replayStore: remoteStore,
        })).resolves.toBe(false);
    });

    it('cleans expired entries from local replay stores', async () => {
        vi.useFakeTimers();
        const store = new LocalReplayStore();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

        await expect(store.consume('expired-jti', 1)).resolves.toBe(true);

        vi.setSystemTime(new Date('2026-01-01T00:00:03Z'));

        await expect(store.consume('fresh-jti', 10)).resolves.toBe(true);
        await expect(store.consume('expired-jti', 10)).resolves.toBe(true);
    });

    it('throws when remote replay prevention is selected without a store', async () => {
        const [token] = createChallenge(2, 1, 30);
        const solution = solveChallenge(token);

        expect(solution).toBeTruthy();
        await expect(verifyValid(token, solution!.nonce, {
            replayPrevention: 'remote',
        })).resolves.toBe(false);
    });

    it('throws for invalid challenge config values', () => {
        expect(() => createChallenge(0, 1, 30)).toThrow('Challenge difficulty must be at least 1');
        expect(() => createChallenge(1, 0, 30)).toThrow('Challenge amount must be at least 1');
        expect(() => createChallenge(1, 1, 0)).toThrow('Challenge TTL must be at least 1 second');
        expect(() => createChallenge(1, Number.NaN, 30)).toThrow('Challenge amount must be a finite number');
        expect(() => createChallenge(Number.NaN, 1, 30)).toThrow('Challenge difficulty must be a finite number');
        expect(() => createChallenge(1, 1, Number.NaN)).toThrow('Challenge TTL must be a finite number');
    });

    it('throws when secret-dependent operations run without RIBAUNT_SECRET', async () => {
        delete process.env.RIBAUNT_SECRET;

        expect(() => createChallenge(1, 1, 30)).toThrow('RIBAUNT_SECRET environment variable is not set!');
        await expect(verifyValid('not-a-real-token', '1', { debug: false })).resolves.toBe(false);
    });

    it('can use an isolated local replay store instance', async () => {
        const [token] = createChallenge(2, 1, 30);
        const solution = solveChallenge(token);
        const localStore = new LocalReplayStore();

        expect(solution).toBeTruthy();

        const adapter = {
            consume: (jti: string, expiresAt: number) => localStore.consume(jti, expiresAt),
        };

        await expect(verifyValid(token, solution!.nonce, {
            replayPrevention: 'remote',
            replayStore: adapter,
        })).resolves.toBe(true);

        await expect(verifyValid(token, solution!.nonce, {
            replayPrevention: 'remote',
            replayStore: adapter,
        })).resolves.toBe(false);
    });
});
