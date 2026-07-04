import crypto from 'crypto';
import jwt from 'jsonwebtoken';

interface ChallengeTokenPayload {
  challenge: string;
  difficulty: number;
  expires: number;
  jti?: string;
  contextHash?: string;
}

export type ChallengeToken = string;

export interface ChallengeSolution {
  nonce: string;
  hash: string;
}

export interface ClientCalibration {
  iterations: number;
  durationMs: number;
}

export interface WorkloadBounds {
  minDifficulty?: number;
  maxDifficulty?: number;
  minAmount?: number;
  maxAmount?: number;
}

export interface AdaptiveWorkloadOptions extends WorkloadBounds {
  riskScore?: number;
  targetDurationMs?: number;
  calibration?: ClientCalibration;
}

export interface Workload {
  difficulty: number;
  amount: number;
  estimatedAttempts: number;
}

export interface ChallengeOptions {
  difficulty?: number | 'auto';
  amount?: number;
  ttlSeconds?: number;
  context?: string;
  workload?: Pick<Workload, 'difficulty' | 'amount'>;
  riskScore?: number;
  targetDurationMs?: number;
  calibration?: ClientCalibration;
  minDifficulty?: number;
  maxDifficulty?: number;
  minAmount?: number;
  maxAmount?: number;
}

export interface ReplayStore {
  consume(jti: string, expiresAt: number): Promise<boolean>;
  consumeMany?(jtis: string[], expiresAt: number): Promise<boolean>;
}

export type ReplayPreventionMode = 'disabled' | 'local' | 'remote';

export interface VerifySolutionOptions {
  replayPrevention?: ReplayPreventionMode;
  replayStore?: ReplayStore;
  context?: string;
  debug?: boolean;
  onWarning?: (warning: VerifyWarning) => void;
}

export type VerifyFailureReason =
  | 'invalid-token'
  | 'expired-token'
  | 'invalid-solution'
  | 'context-mismatch'
  | 'replay-detected'
  | 'configuration-error';

export type VerifyWarningReason = VerifyFailureReason;

export interface VerifyWarning {
  reason: VerifyWarningReason;
  message: string;
  error?: unknown;
}

export type VerifySolutionResult =
  | { valid: true }
  | { valid: false; reason: VerifyFailureReason; message: string };

export interface SolveChallengeOptions {
  maxIterations?: number;
  maxDurationMs?: number;
}

export class LocalReplayStore implements ReplayStore {
  private usedTokens = new Map<string, number>();

  async consume(jti: string, expiresAt: number): Promise<boolean> {
    return this.consumeMany([jti], expiresAt);
  }

  async consumeMany(jtis: string[], expiresAt: number): Promise<boolean> {
    this.cleanup();

    if (new Set(jtis).size !== jtis.length || jtis.some((jti) => this.usedTokens.has(jti))) {
      return false;
    }

    for (const jti of jtis) {
      this.usedTokens.set(jti, expiresAt);
    }
    return true;
  }

  private cleanup(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [jti, expiresAt] of this.usedTokens.entries()) {
      if (expiresAt < now) this.usedTokens.delete(jti);
    }
  }
}

const defaultLocalReplayStore = new LocalReplayStore();
const DEFAULT_SOLVE_MAX_DURATION_MS = 30_000;
const DEFAULT_BOUNDS = {
  minDifficulty: 3,
  maxDifficulty: 6,
  minAmount: 1,
  maxAmount: 8,
};

function assertFiniteInteger(value: number, name: string, minimum: number): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  const normalized = Math.floor(value);
  if (normalized < minimum) throw new Error(`${name} must be at least ${minimum}`);
  return normalized;
}

function isValidPayload(payload: unknown): payload is ChallengeTokenPayload {
  if (!payload || typeof payload !== 'object') return false;
  const value = payload as Partial<ChallengeTokenPayload>;
  return typeof value.challenge === 'string'
    && value.challenge.length > 0
    && typeof value.difficulty === 'number'
    && Number.isInteger(value.difficulty)
    && value.difficulty >= 1
    && value.difficulty <= 64
    && typeof value.expires === 'number'
    && Number.isInteger(value.expires)
    && typeof value.jti === 'string'
    && value.jti.length > 0
    && (value.contextHash === undefined || /^[a-f0-9]{64}$/.test(value.contextHash));
}

function assertRange(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizeBounds(options: WorkloadBounds) {
  const minDifficulty = assertFiniteInteger(
    options.minDifficulty ?? DEFAULT_BOUNDS.minDifficulty,
    'Minimum difficulty',
    1
  );
  const maxDifficulty = assertFiniteInteger(
    options.maxDifficulty ?? DEFAULT_BOUNDS.maxDifficulty,
    'Maximum difficulty',
    minDifficulty
  );
  const minAmount = assertFiniteInteger(options.minAmount ?? DEFAULT_BOUNDS.minAmount, 'Minimum amount', 1);
  const maxAmount = assertFiniteInteger(
    options.maxAmount ?? DEFAULT_BOUNDS.maxAmount,
    'Maximum amount',
    minAmount
  );
  return { minDifficulty, maxDifficulty, minAmount, maxAmount };
}

function closestWorkload(targetAttempts: number, bounds: ReturnType<typeof normalizeBounds>): Workload {
  let best: Workload | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let difficulty = bounds.minDifficulty; difficulty <= bounds.maxDifficulty; difficulty++) {
    for (let amount = bounds.minAmount; amount <= bounds.maxAmount; amount++) {
      const estimatedAttempts = (16 ** difficulty) * amount;
      const distance = Math.abs(Math.log(estimatedAttempts / targetAttempts));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { difficulty, amount, estimatedAttempts };
      }
    }
  }

  return best!;
}

/**
 * Selects bounded proof-of-work using a server-owned risk floor and untrusted timing calibration.
 */
export function selectWorkload(options: AdaptiveWorkloadOptions = {}): Workload {
  const bounds = normalizeBounds(options);
  const riskScore = assertRange(options.riskScore ?? 50, 'Risk score', 0, 100);
  const targetDurationMs = assertFiniteInteger(
    options.targetDurationMs ?? 750,
    'Target duration',
    1
  );

  const minimumAttempts = 16 ** bounds.minDifficulty
    * (bounds.minAmount + (bounds.maxAmount - bounds.minAmount) * (riskScore / 100));

  let targetAttempts = minimumAttempts;
  const calibration = options.calibration;
  if (calibration) {
    const iterations = assertFiniteInteger(calibration.iterations, 'Calibration iterations', 1);
    const durationMs = assertFiniteInteger(calibration.durationMs, 'Calibration duration', 1);
    const calibratedAttempts = (iterations / durationMs) * targetDurationMs;
    targetAttempts = Math.max(minimumAttempts, calibratedAttempts);
  }

  const maximumAttempts = (16 ** bounds.maxDifficulty) * bounds.maxAmount;
  return closestWorkload(Math.min(targetAttempts, maximumAttempts), bounds);
}

export function calibrateNode(iterations = 128): ClientCalibration {
  if (!Number.isFinite(iterations) || iterations < 1) {
    throw new Error('Calibration iterations must be at least 1');
  }

  const normalizedIterations = Math.floor(iterations);
  const startedAt = performance.now();
  for (let index = 0; index < normalizedIterations; index++) {
    crypto.createHash('sha256').update(`ribaunt-calibration:${index}`).digest('hex');
  }

  return {
    iterations: normalizedIterations,
    durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
  };
}

export const calibrateClient = calibrateNode;

function generateChallenge(length = 8): string {
  return crypto.randomBytes(length).toString('base64url').slice(0, length);
}

function hashContext(context: string, jti: string): string {
  return crypto
    .createHmac('sha256', getSecret())
    .update(jti, 'utf8')
    .update('\0')
    .update(context, 'utf8')
    .digest('hex');
}

let cachedSecret: string | undefined;
function getSecret(): string {
  const secret = process.env.RIBAUNT_SECRET;
  if (!secret) {
    cachedSecret = undefined;
    throw new Error('RIBAUNT_SECRET environment variable is not set!');
  }
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    cachedSecret = undefined;
    throw new Error('RIBAUNT_SECRET must be at least 32 bytes');
  }
  if (cachedSecret !== secret) cachedSecret = secret;
  return cachedSecret;
}

function createSingleChallenge(
  difficulty: number,
  ttlSeconds: number,
  context?: string
): ChallengeToken {
  const jti = crypto.randomUUID();
  const payload: ChallengeTokenPayload = {
    challenge: generateChallenge(),
    difficulty,
    expires: Math.floor(Date.now() / 1000) + ttlSeconds,
    jti,
  };
  if (context !== undefined) payload.contextHash = hashContext(context, jti);
  return jwt.sign(payload, getSecret());
}

export function createChallenge(
  difficulty?: number,
  amount?: number,
  ttlSeconds?: number
): ChallengeToken[];
export function createChallenge(options: ChallengeOptions): ChallengeToken[];
export function createChallenge(
  difficultyOrOptions: number | ChallengeOptions = 5,
  amount = 4,
  ttlSeconds = 30
): ChallengeToken[] {
  const options = typeof difficultyOrOptions === 'object' ? difficultyOrOptions : undefined;
  const selectedWorkload = options?.workload
    ?? (options?.difficulty === 'auto' ? selectWorkload(options) : undefined);
  const configuredDifficulty = options?.difficulty === 'auto' ? undefined : options?.difficulty;
  const difficulty = assertFiniteInteger(
    selectedWorkload?.difficulty ?? configuredDifficulty
      ?? (typeof difficultyOrOptions === 'number' ? difficultyOrOptions : 5),
    'Challenge difficulty',
    1
  );
  if (difficulty > 64) throw new Error('Challenge difficulty must be at most 64');
  const normalizedAmount = assertFiniteInteger(
    selectedWorkload?.amount ?? options?.amount ?? (options ? 1 : amount),
    'Challenge amount',
    1
  );
  const ttlValue = options?.ttlSeconds ?? (options ? 30 : ttlSeconds);
  if (Number.isFinite(ttlValue) && Math.floor(ttlValue) < 1) {
    throw new Error('Challenge TTL must be at least 1 second');
  }
  const normalizedTtl = assertFiniteInteger(ttlValue, 'Challenge TTL', 1);

  return Array.from(
    { length: normalizedAmount },
    () => createSingleChallenge(difficulty, normalizedTtl, options?.context)
  );
}

function normalizeMaxIterations(options?: SolveChallengeOptions): number | undefined {
  if (options?.maxIterations === undefined || !Number.isFinite(options.maxIterations)) return undefined;
  return Math.max(0, Math.floor(options.maxIterations));
}

function normalizeMaxDurationMs(options?: SolveChallengeOptions): number {
  if (options?.maxDurationMs === undefined || !Number.isFinite(options.maxDurationMs)) {
    return DEFAULT_SOLVE_MAX_DURATION_MS;
  }
  return Math.max(0, Math.floor(options.maxDurationMs));
}

function solveSingleChallenge(
  token: ChallengeToken,
  options?: SolveChallengeOptions
): ChallengeSolution | undefined {
  try {
    const payload = jwt.decode(token) as ChallengeTokenPayload | null;
    if (!payload) return undefined;
    const prefix = '0'.repeat(payload.difficulty);
    const maxIterations = normalizeMaxIterations(options);
    const maxDurationMs = normalizeMaxDurationMs(options);
    const startedAt = Date.now();

    for (let nonce = 0; ; nonce++) {
      if (maxIterations !== undefined && nonce >= maxIterations) return undefined;
      if (Date.now() - startedAt >= maxDurationMs) return undefined;
      const hash = crypto.createHash('sha256').update(`${payload.challenge}${nonce}`).digest('hex');
      if (hash.startsWith(prefix)) return { nonce: String(nonce), hash };
    }
  } catch {
    return undefined;
  }
}

export function solveChallenge(token: ChallengeToken, options?: SolveChallengeOptions): ChallengeSolution | undefined;
export function solveChallenge(token: ChallengeToken[], options?: SolveChallengeOptions): ChallengeSolution[] | undefined;
export function solveChallenge(
  token: ChallengeToken | ChallengeToken[],
  options?: SolveChallengeOptions
): ChallengeSolution | ChallengeSolution[] | undefined {
  if (Array.isArray(token)) {
    const solutions: ChallengeSolution[] = [];
    for (const item of token) {
      const solution = solveSingleChallenge(item, options);
      if (!solution) return undefined;
      solutions.push(solution);
    }
    return solutions;
  }
  return solveSingleChallenge(token, options);
}

function shouldDebug(options?: VerifySolutionOptions): boolean {
  return options?.debug ?? process.env.NODE_ENV === 'development';
}

function warn(
  reason: VerifyFailureReason,
  message: string,
  options?: VerifySolutionOptions,
  error?: unknown
): VerifySolutionResult {
  const warning: VerifyWarning = error === undefined
    ? { reason, message }
    : { reason, message, error };
  options?.onWarning?.(warning);
  if (shouldDebug(options)) {
    const details = error instanceof Error ? error.message : error;
    console.warn(`[ribaunt] ${message}`, details ?? '');
  }
  return { valid: false, reason, message };
}

function classifyTokenError(error: unknown): VerifyFailureReason {
  if (error && typeof error === 'object' && 'name' in error) {
    const name = String((error as { name?: unknown }).name);
    if (name === 'TokenExpiredError') return 'expired-token';
  }
  if (error instanceof Error && error.message.includes('replayStore')) return 'configuration-error';
  return 'invalid-token';
}

function getReplayStore(options?: VerifySolutionOptions): ReplayStore | undefined {
  const mode = options?.replayPrevention ?? 'local';
  if (mode === 'disabled') return undefined;
  if (mode === 'local') return defaultLocalReplayStore;
  if (!options?.replayStore) {
    throw new Error('A replayStore is required when replayPrevention is set to "remote"');
  }
  return options.replayStore;
}

function extractNonces(
  tokens: ChallengeToken[],
  input: number | string | Array<number | string> | ChallengeSolution | ChallengeSolution[]
): Array<number | string> | undefined {
  if (!Array.isArray(input) || input.length !== tokens.length) return undefined;
  return input.map((entry) => (
    typeof entry === 'object' && entry !== null && 'nonce' in entry ? entry.nonce : entry
  )) as Array<number | string>;
}

function contextMatches(payload: ChallengeTokenPayload, suppliedContext: string | undefined): boolean {
  if (payload.contextHash === undefined) return suppliedContext === undefined;
  if (suppliedContext === undefined) return false;
  const expected = Buffer.from(payload.contextHash, 'hex');
  const actual = Buffer.from(hashContext(suppliedContext, payload.jti!), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export async function verifySolution(
  token: ChallengeToken | ChallengeToken[],
  nonce: number | string | Array<number | string> | ChallengeSolution | ChallengeSolution[],
  options?: VerifySolutionOptions
): Promise<VerifySolutionResult> {
  const tokens = Array.isArray(token) ? token : [token];
  if (tokens.length === 0) {
    return warn('invalid-solution', 'verifySolution requires at least one challenge token', options);
  }
  let nonces: Array<number | string>;

  if (Array.isArray(token)) {
    const extracted = extractNonces(tokens, nonce);
    if (!extracted) return warn('invalid-solution', 'verifySolution received mismatched solutions', options);
    nonces = extracted;
  } else if (Array.isArray(nonce)) {
    if (nonce.length === 0) return warn('invalid-solution', 'verifySolution received an empty nonce', options);
    const first = nonce[0];
    if (first === undefined) {
      return warn('invalid-solution', 'verifySolution received an empty nonce', options);
    }
    nonces = [typeof first === 'object' && first !== null && 'nonce' in first ? first.nonce : first];
  } else {
    nonces = [typeof nonce === 'object' && nonce !== null && 'nonce' in nonce ? nonce.nonce : nonce];
  }

  const validated: ChallengeTokenPayload[] = [];
  try {
    for (let index = 0; index < tokens.length; index++) {
      const currentToken = tokens[index];
      const currentNonce = nonces[index];
      if (!currentToken || currentNonce === undefined || currentNonce === null || currentNonce === '') {
        return warn('invalid-solution', 'verifySolution received an empty nonce', options);
      }

      const decoded = jwt.verify(currentToken, getSecret());
      if (!isValidPayload(decoded)) throw new Error('Invalid challenge token payload');
      const payload = decoded;
      if (payload.expires < Math.floor(Date.now() / 1000)) {
        return warn('expired-token', 'verifySolution rejected an expired challenge token', options);
      }
      if (!contextMatches(payload, options?.context)) {
        return warn('context-mismatch', 'verifySolution rejected a mismatched challenge context', options);
      }

      const hash = crypto
        .createHash('sha256')
        .update(`${payload.challenge}${String(currentNonce)}`)
        .digest('hex');
      if (!hash.startsWith('0'.repeat(payload.difficulty))) {
        return warn('invalid-solution', 'verifySolution rejected an invalid nonce', options);
      }
      validated.push(payload);
    }

    const replayStore = getReplayStore(options);
    const jtis = validated.flatMap((payload) => payload.jti ? [payload.jti] : []);
    if (replayStore && jtis.length > 0) {
      const expiresAt = Math.max(...validated.map((payload) => payload.expires));
      let consumed: boolean;
      if (jtis.length > 1) {
        if (!replayStore.consumeMany) {
          return warn(
            'configuration-error',
            'A replayStore with consumeMany is required for atomic batch verification',
            options
          );
        }
        consumed = await replayStore.consumeMany(jtis, expiresAt);
      } else {
        consumed = await replayStore.consume(jtis[0]!, expiresAt);
      }
      if (!consumed) return warn('replay-detected', 'verifySolution rejected a replayed token', options);
    }

    return { valid: true };
  } catch (error) {
    const reason = classifyTokenError(error);
    return warn(reason, 'verifySolution rejected a token or nonce', options, error);
  }
}
