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

function createKeys(jtis: string[], prefix: string): string[] {
  return jtis.map((jti) => `${prefix}${jti}`);
}

function ttlMilliseconds(expiresAt: number): number {
  return Math.max(1, Math.floor((expiresAt * 1000) - Date.now()));
}

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

export function createIORedisReplayStore(
  client: IORedisClientLike,
  options: RedisReplayStoreOptions = {}
): ReplayStore {
  return new RedisReplayStore(
    (keys, ttlMs) => client.eval(CONSUME_SCRIPT, keys.length, ...keys, ttlMs),
    options.prefix ?? '{ribaunt}:replay:'
  );
}
