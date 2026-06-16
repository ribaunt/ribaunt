import crypto from 'crypto';
import jwt from 'jsonwebtoken';

interface ChallengeTokenPayload {
  challenge: string;
  difficulty: number;
  expires: number;
  jti?: string;
}

export type ChallengeToken = string;

export interface ChallengeSolution {
  nonce: string;
  hash: string;
}

export interface ReplayStore {
  consume(jti: string, expiresAt: number): Promise<boolean>;
}

export type ReplayPreventionMode = 'disabled' | 'local' | 'remote';

export interface VerifySolutionOptions {
  replayPrevention?: ReplayPreventionMode;
  replayStore?: ReplayStore;
  debug?: boolean;
  onWarning?: (warning: VerifyWarning) => void;
}

export type VerifyWarningReason =
  | 'invalid-token'
  | 'expired-token'
  | 'invalid-solution'
  | 'replay-detected'
  | 'configuration-error';

export interface VerifyWarning {
  reason: VerifyWarningReason;
  message: string;
  error?: unknown;
}

export interface SolveChallengeOptions {
  maxIterations?: number;
  maxDurationMs?: number;
}

export class LocalReplayStore implements ReplayStore {
  private usedTokens = new Map<string, number>();

  async consume(jti: string, expiresAt: number): Promise<boolean> {
    this.cleanup();

    if (this.usedTokens.has(jti)) {
      return false;
    }

    this.usedTokens.set(jti, expiresAt);
    return true;
  }

  private cleanup(): void {
    const now = Math.floor(Date.now() / 1000);

    for (const [jti, expiresAt] of this.usedTokens.entries()) {
      if (expiresAt < now) {
        this.usedTokens.delete(jti);
      }
    }
  }
}

const defaultLocalReplayStore = new LocalReplayStore();
const DEFAULT_SOLVE_MAX_DURATION_MS = 30_000;

function generateChallenge(length = 8): string {
  const buffer = crypto.randomBytes(length);
  return buffer.toString('base64').slice(0, length);
}

function createChallengePayload(difficulty: number, ttlSeconds: number): ChallengeTokenPayload {
  return {
    challenge: generateChallenge(),
    difficulty,
    expires: Math.floor(Date.now() / 1000) + ttlSeconds,
    jti: crypto.randomUUID(),
  };
}

let cachedSecret: string | undefined;

function getSecret(): string {
  const secret = process.env.RIBAUNT_SECRET;

  if (!secret) {
    cachedSecret = undefined;
    throw new Error('RIBAUNT_SECRET environment variable is not set!');
  }

  if (cachedSecret === secret) {
    return cachedSecret;
  }

  cachedSecret = secret;
  return cachedSecret;
}

function shouldDebugVerifyErrors(options?: VerifySolutionOptions): boolean {
  if (options?.debug !== undefined) {
    return options.debug;
  }

  return process.env.NODE_ENV === 'development';
}

function logVerifyWarning(message: string, options?: VerifySolutionOptions, error?: unknown): void {
  const warning: VerifyWarning = {
    reason: classifyVerifyWarningReason(error),
    message,
    error,
  };

  options?.onWarning?.(warning);

  if (!shouldDebugVerifyErrors(options)) {
    return;
  }

  const details = error instanceof Error ? error.message : error;
  console.warn(`[ribaunt] ${message}`, details ?? '');
}

function emitVerifyWarning(
  reason: VerifyWarningReason,
  message: string,
  options?: VerifySolutionOptions,
  error?: unknown
): void {
  options?.onWarning?.({ reason, message, error });

  if (!shouldDebugVerifyErrors(options)) {
    return;
  }

  const details = error instanceof Error ? error.message : error;
  console.warn(`[ribaunt] ${message}`, details ?? '');
}

function classifyVerifyWarningReason(error: unknown): VerifyWarningReason {
  if (error && typeof error === 'object' && 'name' in error) {
    const name = String((error as { name?: unknown }).name);

    if (name === 'TokenExpiredError') {
      return 'expired-token';
    }

    if (name === 'JsonWebTokenError' || name === 'NotBeforeError') {
      return 'invalid-token';
    }
  }

  if (error instanceof Error && error.message.includes('replayStore')) {
    return 'configuration-error';
  }

  return 'invalid-token';
}

function normalizeMaxIterations(options?: SolveChallengeOptions): number | undefined {
  if (options?.maxIterations === undefined) {
    return undefined;
  }

  if (!Number.isFinite(options.maxIterations)) {
    return undefined;
  }

  const normalized = Math.floor(options.maxIterations);
  if (normalized < 1) {
    return 1;
  }

  return normalized;
}

function normalizeMaxDurationMs(options?: SolveChallengeOptions): number {
  if (options?.maxDurationMs === undefined) {
    return DEFAULT_SOLVE_MAX_DURATION_MS;
  }

  if (!Number.isFinite(options.maxDurationMs)) {
    return DEFAULT_SOLVE_MAX_DURATION_MS;
  }

  const normalized = Math.floor(options.maxDurationMs);
  if (normalized < 1) {
    return 1;
  }

  return normalized;
}

function getReplayStore(options?: VerifySolutionOptions): ReplayStore | undefined {
  const mode = options?.replayPrevention ?? 'local';

  if (mode === 'disabled') {
    return undefined;
  }

  if (mode === 'local') {
    return defaultLocalReplayStore;
  }

  if (!options?.replayStore) {
    throw new Error('A replayStore is required when replayPrevention is set to "remote"');
  }

  return options.replayStore;
}

function signChallenge(payload: ChallengeTokenPayload): ChallengeToken {
  return jwt.sign(payload, getSecret());
}

function assertValidAmount(amount: number): number {
  if (!Number.isFinite(amount)) {
    throw new Error('Challenge amount must be a finite number');
  }

  const normalized = Math.floor(amount);
  if (normalized < 1) {
    throw new Error('Challenge amount must be at least 1');
  }

  return normalized;
}

function assertValidDifficulty(difficulty: number): number {
  if (!Number.isFinite(difficulty)) {
    throw new Error('Challenge difficulty must be a finite number');
  }

  const normalized = Math.floor(difficulty);
  if (normalized < 1) {
    throw new Error('Challenge difficulty must be at least 1');
  }

  return normalized;
}

function assertValidTtl(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds)) {
    throw new Error('Challenge TTL must be a finite number');
  }

  const normalized = Math.floor(ttlSeconds);
  if (normalized < 1) {
    throw new Error('Challenge TTL must be at least 1 second');
  }

  return normalized;
}

function createSingleChallenge(difficulty: number, ttlSeconds: number): ChallengeToken {
  const payload = createChallengePayload(difficulty, ttlSeconds);
  return signChallenge(payload);
}

/**
 * Creates one or more PoW challenges and returns them as signed JWT tokens.
 *
 * @param difficulty - Number of leading zeros required in the hash (default 5)
 * @param amount - Number of challenges to create (default 4)
 * @param ttlSeconds - Time to live for each challenge in seconds (default 30)
 * @returns An array of JWT challenge tokens
 */
export function createChallenge(
  difficulty: number = 5,
  amount: number = 4,
  ttlSeconds: number = 30
): ChallengeToken[] {
  const normalizedDifficulty = assertValidDifficulty(difficulty);
  const normalizedAmount = assertValidAmount(amount);
  const normalizedTtl = assertValidTtl(ttlSeconds);

  const challenges = Array.from(
    { length: normalizedAmount },
    () => createSingleChallenge(normalizedDifficulty, normalizedTtl)
  );
  return challenges;
}

function solveSingleChallenge(
  token: ChallengeToken,
  options?: SolveChallengeOptions
): ChallengeSolution | undefined {
  try {
    const payload = jwt.decode(token) as ChallengeTokenPayload | null;
    if (!payload) return undefined;

    const { challenge, difficulty } = payload;
    const prefix = '0'.repeat(difficulty);
    const maxIterations = normalizeMaxIterations(options);
    const maxDurationMs = normalizeMaxDurationMs(options);
    const startedAt = Date.now();

    let nonce = 0;
    while (true) {
      if (maxIterations !== undefined && nonce >= maxIterations) {
        return undefined;
      }

      if (Date.now() - startedAt >= maxDurationMs) {
        return undefined;
      }

      const hash = crypto
        .createHash('sha256')
        .update(`${challenge}${nonce}`)
        .digest('hex');

      if (hash.startsWith(prefix)) {
        return { nonce: String(nonce), hash };
      }

      nonce++;
    }
  } catch (err) {
    return undefined;
  }
}

async function verifySingleSolution(
  token: ChallengeToken,
  nonce: number | string | undefined,
  options?: VerifySolutionOptions
): Promise<boolean> {
  if (nonce === undefined || nonce === null) {
    emitVerifyWarning('invalid-solution', 'verifySolution received an empty nonce', options);
    return false;
  }

  try {
    const replayStore = getReplayStore(options);
    const payload = jwt.verify(token, getSecret()) as ChallengeTokenPayload;

    const now = Math.floor(Date.now() / 1000);
    if (payload.expires < now) {
      emitVerifyWarning('expired-token', 'verifySolution rejected an expired challenge token', options);
      return false;
    }

    const nonceValue = typeof nonce === 'number' ? String(nonce) : nonce;
    const hash = crypto
      .createHash('sha256')
      .update(`${payload.challenge}${nonceValue}`)
      .digest('hex');

    const prefix = '0'.repeat(payload.difficulty);
    const isValid = hash.startsWith(prefix);
    if (!isValid) {
      emitVerifyWarning('invalid-solution', 'verifySolution rejected an invalid nonce', options);
      return false;
    }

    if (replayStore && payload.jti) {
      const consumed = await replayStore.consume(payload.jti, payload.expires);
      if (!consumed) {
        emitVerifyWarning('replay-detected', 'verifySolution rejected a replayed token', options);
        return false;
      }
    }

    return true;
  } catch (err) {
    logVerifyWarning('verifySolution rejected a token or nonce', options, err);
    return false;
  }
}

/**
 * Solves one or more PoW challenges encoded in JWT tokens.
 *
 * @param token - The JWT challenge token or an array of tokens
 * @param options - Optional guardrails for test/debug usage (`maxIterations`, `maxDurationMs`)
 * @returns The nonce/hash pair for single input or an array of them for multiple tokens
 */
export function solveChallenge(token: ChallengeToken): ChallengeSolution | undefined;
export function solveChallenge(
  token: ChallengeToken,
  options?: SolveChallengeOptions
): ChallengeSolution | undefined;
export function solveChallenge(token: ChallengeToken[]): ChallengeSolution[] | undefined;
export function solveChallenge(
  token: ChallengeToken[],
  options?: SolveChallengeOptions
): ChallengeSolution[] | undefined;
export function solveChallenge(
  token: ChallengeToken | ChallengeToken[],
  options?: SolveChallengeOptions
): ChallengeSolution | ChallengeSolution[] | undefined {
  if (Array.isArray(token)) {
    const solutions: ChallengeSolution[] = [];

    for (const singleToken of token) {
      const solution = solveSingleChallenge(singleToken, options);
      if (!solution) {
        return undefined;
      }

      solutions.push(solution);
    }

    return solutions;
  }

  const solution = solveSingleChallenge(token, options);
  return solution;
}

/**
 * Verifies a PoW solution returned by the client.
 *
 * @param token - The original JWT issued as the challenge (single token or array of tokens)
 * @param nonce - The nonce/answer submitted by the client (single nonce, array of nonces, or array of solution objects)
 * @returns true only if every provided solution is valid; otherwise false
 */
export function verifySolution(
  token: ChallengeToken | ChallengeToken[],
  nonce: number | string | Array<number | string> | ChallengeSolution | ChallengeSolution[],
  options?: VerifySolutionOptions
): Promise<boolean> {
  if (Array.isArray(token)) {
    let nonces: Array<number | string>;
    if (Array.isArray(nonce)) {
      if (nonce.length !== token.length) {
        return Promise.resolve(false);
      }
      if (nonce.length > 0 && typeof nonce[0] === 'object' && 'nonce' in nonce[0]) {
        nonces = (nonce as ChallengeSolution[]).map(s => s.nonce);
      } else {
        nonces = nonce as Array<number | string>;
      }
    } else {
      return Promise.resolve(false);
    }

    return (async () => {
      for (let index = 0; index < token.length; index++) {
        const challengeToken = token[index];
        const nonceEntry = nonces[index];

        if (challengeToken === undefined || nonceEntry === undefined) {
          return false;
        }

        if (!await verifySingleSolution(challengeToken, nonceEntry, options)) {
          return false;
        }
      }

      return true;
    })();
  }

  let effectiveNonce: number | string;
  if (Array.isArray(nonce)) {
    if (nonce.length === 0) {
      return Promise.resolve(false);
    }
    if (typeof nonce[0] === 'object' && 'nonce' in nonce[0]) {
      effectiveNonce = (nonce[0] as ChallengeSolution).nonce;
    } else {
      effectiveNonce = nonce[0] as number | string;
    }
  } else if (typeof nonce === 'object' && 'nonce' in nonce) {
    effectiveNonce = (nonce as ChallengeSolution).nonce;
  } else {
    effectiveNonce = nonce as number | string;
  }

  if (effectiveNonce === undefined) {
    return Promise.resolve(false);
  }

  return verifySingleSolution(token, effectiveNonce, options);
}
