import type { ReplayStore } from './index.js';

export interface RedisReplayStoreOptions {
  prefix?: string;
}

export interface NodeRedisClientLike {
  sendCommand(command: string[]): Promise<unknown>;
}

export interface IORedisClientLike {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

/**
 * Redis Lua script that atomically checks and marks tokens as consumed.
 * Returns 1 if all tokens were not previously seen (success), 0 if any existed (replay detected).
 */
const CONSUME_SCRIPT = `
for i, key in ipairs(KEYS) do
  if redis.call('EXISTS', key) == 1 then
    return 0
  end
end
local ttl = tonumber(ARGV[1])
for i, key in ipairs(KEYS) do
  redis.call('SET', key, '1', 'PX', ttl)
end
return 1
`;

/**
 * Prepends the configured prefix to each JTI to construct Redis keys.
 */
function createKeys(jtis: string[], prefix: string): string[] {
  return jtis.map((jti) => `${prefix}${jti}`);
}

/**
 * Converts Unix timestamp (seconds) to milliseconds remaining from now.
 * Returns at least 1ms to ensure TTL is always positive.
 */
function ttlMilliseconds(expiresAt: number): number {
  return Math.max(1, Math.floor((expiresAt * 1000) - Date.now()));
}

/**
 * Interprets Redis EVAL return value as success (token consumed) or failure (replay detected).
 */
function resultIsConsumed(result: unknown): boolean {
  return result === 1 || result === '1' || result === true;
}

class RedisReplayStore implements ReplayStore {
  constructor(
    private readonly evaluate: (keys: string[], ttlMs: number) => Promise<unknown>,
    private readonly prefix: string
  ) {}

  consume(jti: string, expiresAt: number): Promise<boolean> {
    return this.consumeMany([jti], expiresAt);
  }

  async consumeMany(jtis: string[], expiresAt: number): Promise<boolean> {
    if (jtis.length === 0 || new Set(jtis).size !== jtis.length) return false;
    const result = await this.evaluate(createKeys(jtis, this.prefix), ttlMilliseconds(expiresAt));
    return resultIsConsumed(result);
  }
}

/**
 * Creates a Redis-backed replay store for use with the node-redis client.
 * The store prevents token replay attacks by tracking consumed JTIs with automatic expiration.
 *
 * @param client - node-redis client instance
 * @param options - Optional configuration including key prefix (default: '{ribaunt}:replay:')
 * @returns ReplayStore instance compatible with verifySolution
 */
export function createNodeRedisReplayStore(
  client: NodeRedisClientLike,
  options: RedisReplayStoreOptions = {}
): ReplayStore {
  return new RedisReplayStore(
    (keys, ttlMs) => client.sendCommand([
      'EVAL',
      CONSUME_SCRIPT,
      String(keys.length),
      ...keys,
      String(ttlMs),
    ]),
    options.prefix ?? '{ribaunt}:replay:'
  );
}

/**
 * Creates a Redis-backed replay store for use with the ioredis client.
 * The store prevents token replay attacks by tracking consumed JTIs with automatic expiration.
 *
 * @param client - ioredis client instance
 * @param options - Optional configuration including key prefix (default: '{ribaunt}:replay:')
 * @returns ReplayStore instance compatible with verifySolution
 */
export function createIORedisReplayStore(
  client: IORedisClientLike,
  options: RedisReplayStoreOptions = {}
): ReplayStore {
  return new RedisReplayStore(
    (keys, ttlMs) => client.eval(CONSUME_SCRIPT, keys.length, ...keys, ttlMs),
    options.prefix ?? '{ribaunt}:replay:'
  );
}
