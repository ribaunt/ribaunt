import { describe, expect, it, vi } from 'vitest';
import {
  createIORedisReplayStore,
  createNodeRedisReplayStore,
} from '../src/redis';

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
