import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Redis } from 'ioredis';
import {
  createIORedisReplayStore,
  createNodeRedisReplayStore,
} from '../src/redis';
import { createChallenge, solveChallenge, verifySolution } from '../src/index';
import crypto from 'node:crypto';

const redisUrl = process.env.RIBAUNT_TEST_REDIS_URL;
describe.skipIf(!redisUrl)('Redis replay store concurrency', () => {
  let redis: Redis;
  const prefix = `{ribaunt}:replay:test:${crypto.randomUUID()}:`;

  beforeAll(() => {
    redis = new Redis(redisUrl!, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
  });

  afterAll(async () => {
    const keys = await redis?.keys(`${prefix}*`);
    if (keys?.length) await redis?.del(...keys);
    redis?.disconnect();
  });

  it('allows exactly one concurrent winner for single-token verification', async () => {
    const store = createIORedisReplayStore(redis, { prefix });
    const [token] = await createChallenge(2, 1, 30);
    const solution = solveChallenge(token);
    expect(solution).toBeTruthy();

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => verifySolution(token!, solution!, {
        replayPrevention: 'remote',
        replayStore: store,
      }))
    );
    const successes = results.filter((r) => r.status === 'fulfilled' && r.value.valid);
    const replays = results.filter(
      (r) => r.status === 'fulfilled' && !r.value.valid && r.value.reason === 'replay-detected'
    );

    expect(successes).toHaveLength(1);
    expect(replays).toHaveLength(49);
  }, 10_000);

  it('allows exactly one concurrent winner for duplicate batches', async () => {
    const store = createIORedisReplayStore(redis, { prefix });
    const tokens = await createChallenge(2, 3, 30);
    const solutions = solveChallenge(tokens);
    expect(solutions).toBeTruthy();

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => verifySolution(tokens, solutions!, {
        replayPrevention: 'remote',
        replayStore: store,
      }))
    );
    const successes = results.filter((r) => r.status === 'fulfilled' && r.value.valid);

    expect(successes).toHaveLength(1);
  }, 10_000);

  it('rejects every batch when an overlapping submission already consumed a shared jti', async () => {
    const store = createIORedisReplayStore(redis, { prefix });
    const [firstToken] = await createChallenge(2, 1, 30);
    const [secondToken] = await createChallenge(2, 1, 30);
    const [thirdToken] = await createChallenge(2, 1, 30);
    const firstSolution = solveChallenge(firstToken);
    const secondSolution = solveChallenge(secondToken);
    const thirdSolution = solveChallenge(thirdToken);
    expect(firstSolution).toBeTruthy();
    expect(secondSolution).toBeTruthy();
    expect(thirdSolution).toBeTruthy();

    const sharedBatch = await verifySolution(
      [firstToken, secondToken],
      [firstSolution, secondSolution],
      { replayPrevention: 'remote', replayStore: store }
    );
    expect(sharedBatch.valid).toBe(true);

    const overlapping = await verifySolution(
      [secondToken, thirdToken],
      [secondSolution, thirdSolution],
      { replayPrevention: 'remote', replayStore: store }
    );
    expect(overlapping).toMatchObject({ valid: false, reason: 'replay-detected' });
  });

  it('fails closed when the Redis connection is unavailable', async () => {
    const store = createIORedisReplayStore(new Redis('redis://127.0.0.1:1', {
      maxRetriesPerRequest: 1,
      retryStrategy: () => 100,
    }), { prefix });
    const [token] = await createChallenge(2, 1, 30);
    const solution = solveChallenge(token);
    expect(solution).toBeTruthy();

    await expect(
      verifySolution(token!, solution!, { replayPrevention: 'remote', replayStore: store })
    ).resolves.toMatchObject({ valid: false });
  }, 10_000);
});

describe('Redis replay stores', () => {
  it('uses the node-redis raw command signature for atomic batches', async () => {
    const sendCommand = vi.fn(async () => 1);
    const store = createNodeRedisReplayStore({ sendCommand });

    await expect(store.consumeMany?.(['one', 'two'], Math.floor(Date.now() / 1000) + 30))
      .resolves.toBe(true);

    const command = sendCommand.mock.calls[0]?.[0] as string[];
    expect(command[0]).toBe('EVAL');
    expect(command[2]).toBe('2');
    expect(command[3]).toBe('{ribaunt}:replay:one');
    expect(command[4]).toBe('{ribaunt}:replay:two');
    expect(Number(command[5])).toBeGreaterThan(0);
  });

  it('uses the ioredis eval signature and supports custom prefixes', async () => {
    const evalCommand = vi.fn(async () => '1');
    const store = createIORedisReplayStore(
      { eval: evalCommand },
      { prefix: '{captcha}:used:' }
    );

    await expect(store.consume('jti', Math.floor(Date.now() / 1000) + 30)).resolves.toBe(true);
    expect(evalCommand).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('EXISTS', key)"),
      1,
      '{captcha}:used:jti',
      expect.any(Number)
    );
  });

  it('rejects duplicate and already-consumed batches', async () => {
    const sendCommand = vi.fn(async () => 0);
    const store = createNodeRedisReplayStore({ sendCommand });
    const expiresAt = Math.floor(Date.now() / 1000) + 30;

    await expect(store.consumeMany?.(['same', 'same'], expiresAt)).resolves.toBe(false);
    expect(sendCommand).not.toHaveBeenCalled();
    await expect(store.consume('used', expiresAt)).resolves.toBe(false);
  });

  it('propagates Redis failures', async () => {
    const store = createNodeRedisReplayStore({
      sendCommand: async () => {
        throw new Error('redis unavailable');
      },
    });

    await expect(store.consume('jti', Math.floor(Date.now() / 1000) + 30))
      .rejects.toThrow('redis unavailable');
  });
});
