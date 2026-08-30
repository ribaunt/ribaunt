import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import {
  DEFAULT_RISK_THRESHOLDS,
  defaultScorer,
  validateRiskThresholds,
  validateScorerOutput,
} from './risk.js';
import type {
  AssessOptions,
  AssessWorkloadOptions,
  RiskAssessment,
  RiskScorer,
  RiskSignals,
  RiskThresholds,
} from './risk.js';

// Re-export risk engine public API
export type { AssessOptions, AssessWorkloadOptions, RiskAssessment, RiskScorer, RiskSignals, RiskThresholds } from './risk.js';
export { DEFAULT_RISK_THRESHOLDS };

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
  rateLimiter?: RateLimiter;
  onEvent?: (event: RibauntEvent) => void;
}

export interface ReplayStore {
  consume(jti: string, expiresAt: number): Promise<boolean>;
  consumeMany?(jtis: string[], expiresAt: number): Promise<boolean>;
}

export interface RateLimiter {
  check(key?: string): Promise<boolean>;
}

export class RateLimitedError extends Error {
  readonly code = 'rate-limited';

  constructor(message = 'Rate limit exceeded') {
    super(message);
    this.name = 'RateLimitedError';
  }
}

export type ReplayPreventionMode = 'disabled' | 'local' | 'remote';

export interface VerifySolutionOptions {
  replayPrevention?: ReplayPreventionMode;
  replayStore?: ReplayStore;
  context?: string;
  debug?: boolean;
  onWarning?: (warning: VerifyWarning) => void;
  rateLimiter?: RateLimiter;
  onEvent?: (event: RibauntEvent) => void;
}

export type VerifyFailureReason =
  | 'invalid-token'
  | 'expired-token'
  | 'invalid-solution'
  | 'context-mismatch'
  | 'replay-detected'
  | 'replay-store-unavailable'
  | 'configuration-error';

export type VerifyWarningReason = VerifyFailureReason;

export interface VerifyWarning {
  reason: VerifyWarningReason;
  message: string;
  error?: unknown;
}

export type RibauntEvent =
  | { type: 'challenge-issued'; difficulty: number; amount: number }
  | { type: 'verify-success' }
  | { type: 'verify-failure'; reason: VerifyFailureReason; message: string };

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
} as const;
const MAX_WORKLOAD_DIFFICULTY = 64;
const MAX_WORKLOAD_AMOUNT = 64;
const MAX_WORKLOAD_CANDIDATES = 10_000;

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
  if (minDifficulty > MAX_WORKLOAD_DIFFICULTY) {
    throw new Error(`Minimum difficulty must be at most ${MAX_WORKLOAD_DIFFICULTY}`);
  }
  const maxDifficulty = assertFiniteInteger(
    options.maxDifficulty ?? DEFAULT_BOUNDS.maxDifficulty,
    'Maximum difficulty',
    minDifficulty
  );
  if (maxDifficulty > MAX_WORKLOAD_DIFFICULTY) {
    throw new Error(`Maximum difficulty must be at most ${MAX_WORKLOAD_DIFFICULTY}`);
  }
  const minAmount = assertFiniteInteger(options.minAmount ?? DEFAULT_BOUNDS.minAmount, 'Minimum amount', 1);
  if (minAmount > MAX_WORKLOAD_AMOUNT) {
    throw new Error(`Minimum amount must be at most ${MAX_WORKLOAD_AMOUNT}`);
  }
  const maxAmount = assertFiniteInteger(
    options.maxAmount ?? DEFAULT_BOUNDS.maxAmount,
    'Maximum amount',
    minAmount
  );
  if (maxAmount > MAX_WORKLOAD_AMOUNT) {
    throw new Error(`Maximum amount must be at most ${MAX_WORKLOAD_AMOUNT}`);
  }
  const candidateCount = (maxDifficulty - minDifficulty + 1) * (maxAmount - minAmount + 1);
  if (candidateCount > MAX_WORKLOAD_CANDIDATES) {
    throw new Error(`Workload bounds too large: candidate count ${candidateCount} exceeds ${MAX_WORKLOAD_CANDIDATES}`);
  }
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

function validateAssessWorkloadOptions(workload: AssessWorkloadOptions): void {
  // Reuse same validation messages as normalizeBounds / selectWorkload for regression safety
  if (workload.minDifficulty !== undefined) {
    assertFiniteInteger(workload.minDifficulty, 'Minimum difficulty', 1);
  }
  if (workload.maxDifficulty !== undefined) {
    // Need to ensure we validate max >= min (using resolved min)
    const min = workload.minDifficulty !== undefined ? Math.floor(workload.minDifficulty) : DEFAULT_BOUNDS.minDifficulty;
    assertFiniteInteger(workload.maxDifficulty, 'Maximum difficulty', min);
  } else if (workload.minDifficulty !== undefined) {
    // If only minDifficulty provided, still need to ensure default max >= min
    if (DEFAULT_BOUNDS.maxDifficulty < Math.floor(workload.minDifficulty)) {
      throw new Error(`Maximum difficulty must be at least ${Math.floor(workload.minDifficulty)}`);
    }
  }
  if (workload.minAmount !== undefined) {
    assertFiniteInteger(workload.minAmount, 'Minimum amount', 1);
  }
  if (workload.maxAmount !== undefined) {
    const minAmt = workload.minAmount !== undefined ? Math.floor(workload.minAmount) : DEFAULT_BOUNDS.minAmount;
    assertFiniteInteger(workload.maxAmount, 'Maximum amount', minAmt);
  } else if (workload.minAmount !== undefined) {
    if (DEFAULT_BOUNDS.maxAmount < Math.floor(workload.minAmount)) {
      throw new Error(`Maximum amount must be at least ${Math.floor(workload.minAmount)}`);
    }
  }
  // Cross-check when both are provided, normalizeBounds already checks but we also check explicit ordering
  // Also need to handle case where both provided but max < min — already caught above with min as floor.
  // For completeness, if both undefined, no check needed.

  // Validate targetDurationMs
  if (workload.targetDurationMs !== undefined) {
    assertFiniteInteger(workload.targetDurationMs, 'Target duration', 1);
  }
  // Validate calibration
  if (workload.calibration !== undefined) {
    if (!workload.calibration || typeof workload.calibration !== 'object' || Array.isArray(workload.calibration)) {
      throw new Error('Calibration must be an object');
    }
    const cal = workload.calibration as ClientCalibration;
    assertFiniteInteger(cal.iterations, 'Calibration iterations', 1);
    assertFiniteInteger(cal.durationMs, 'Calibration duration', 1);
  }
  // If any of min/max are provided, also run through normalizeBounds to ensure combined validation matches selectWorkload exactly
  // This catches edge cases like non-finite values already handled, but ensures parity
  if (
    workload.minDifficulty !== undefined ||
    workload.maxDifficulty !== undefined ||
    workload.minAmount !== undefined ||
    workload.maxAmount !== undefined
  ) {
    normalizeBounds(workload);
  }
}

/**
 * Programmable risk-assessment subsystem.
 *
 * All signals are caller-supplied and treated as untrusted inputs.
 * The default scorer is a transparent heuristic (not an ML model).
 * The returned `risk` is a bounded heuristic score, not a probability
 * or identity confidence. The caller is responsible for obtaining
 * trustworthy inputs.
 *
 * Flow:
 *   validate AssessOptions
 *     -> resolve scorer (custom or default)
 *     -> await scorer.score(signals)
 *     -> validate risk 0..100
 *     -> resolve thresholds (custom or DEFAULT_RISK_THRESHOLDS)
 *     -> apply policy (allow / challenge / block)
 *     -> if challenge, delegate to existing selectWorkload() with riskScore
 */
export async function assess(options: AssessOptions): Promise<RiskAssessment> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('AssessOptions must be an object');
  }

  const { signals, scorer, thresholds, workload } = options as AssessOptions;

  if (!signals || typeof signals !== 'object' || Array.isArray(signals)) {
    throw new Error('signals must be an object');
  }

  if (scorer !== undefined) {
    if (!scorer || typeof scorer !== 'object' || typeof (scorer as RiskScorer).score !== 'function') {
      throw new Error('scorer must be an object with a score function');
    }
  }

  if (thresholds !== undefined) {
    validateRiskThresholds(thresholds as RiskThresholds);
  }
  // Use a private immutable default via copy so consumer mutation of the exported
  // DEFAULT_RISK_THRESHOLDS cannot change library behavior
  const resolvedThresholds: RiskThresholds = thresholds
    ? { challenge: thresholds.challenge, block: thresholds.block }
    : { challenge: DEFAULT_RISK_THRESHOLDS.challenge, block: DEFAULT_RISK_THRESHOLDS.block };
  // Validate resolved copy as well (defensive)
  validateRiskThresholds(resolvedThresholds);

  if (workload !== undefined) {
    if (!workload || typeof workload !== 'object' || Array.isArray(workload)) {
      throw new Error('workload must be an object');
    }
    validateAssessWorkloadOptions(workload as AssessWorkloadOptions);
  }

  const activeScorer: RiskScorer = scorer ?? defaultScorer;
  const rawRisk = await activeScorer.score(signals as RiskSignals);
  const risk = validateScorerOutput(rawRisk);

  const { challenge, block } = resolvedThresholds;
  let action: RiskAssessment['action'];
  if (risk < challenge) action = 'allow';
  else if (risk < block) action = 'challenge';
  else action = 'block';

  if (action === 'challenge') {
    // Reuse existing adaptive workload selection. Do not duplicate logic.
    // Ensure assessed risk overrides any riskScore that might be present in workload (defensive copy).
    const workloadOptions: AdaptiveWorkloadOptions = {
      ...(workload as AdaptiveWorkloadOptions),
      riskScore: risk,
    };
    // Ensure workload's riskScore is overridden even if spread included one
    workloadOptions.riskScore = risk;
    const resultWorkload = selectWorkload(workloadOptions);
    return { risk, action, workload: resultWorkload };
  }

  return { risk, action };
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

function getSecret(): string {
  const secret = process.env.RIBAUNT_SECRET;
  if (!secret) {
    throw new Error('RIBAUNT_SECRET environment variable is not set!');
  }
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('RIBAUNT_SECRET must be at least 32 bytes');
  }
  return secret;
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
  return jwt.sign(payload, getSecret(), { algorithm: 'HS256' });
}

function emitEvent(
  options: { onEvent?: (event: RibauntEvent) => void } | undefined,
  event: RibauntEvent
): void {
  if (!options?.onEvent) return;
  try {
    options.onEvent(event);
  } catch {
    // telemetry must never break challenge issuance or verification
  }
}

export async function createChallenge(
  difficulty?: number,
  amount?: number,
  ttlSeconds?: number
): Promise<ChallengeToken[]>;
export async function createChallenge(options: ChallengeOptions): Promise<ChallengeToken[]>;
export async function createChallenge(
  difficultyOrOptions: number | ChallengeOptions = 5,
  amount = 4,
  ttlSeconds = 30
): Promise<ChallengeToken[]> {
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

  if (options?.rateLimiter) {
    const allowed = await options.rateLimiter.check(options?.context);
    if (!allowed) throw new RateLimitedError('Challenge issuance rate limited');
  }

  const challenges = Array.from(
    { length: normalizedAmount },
    () => createSingleChallenge(difficulty, normalizedTtl, options?.context)
  );
  emitEvent(options, { type: 'challenge-issued', difficulty, amount: normalizedAmount });
  return challenges;
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
  emitEvent(options, { type: 'verify-failure', reason, message });
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
  if (options?.rateLimiter) {
    const allowed = await options.rateLimiter.check(options?.context);
    if (!allowed) throw new RateLimitedError('Challenge verification rate limited');
  }
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

      const decoded = jwt.verify(currentToken, getSecret(), { algorithms: ['HS256'] });
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
      try {
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
      } catch (error) {
        return warn(
          'replay-store-unavailable',
          'verifySolution failed because the replay store could not be reached',
          options,
          error
        );
      }
      if (!consumed) return warn('replay-detected', 'verifySolution rejected a replayed token', options);
    }

    emitEvent(options, { type: 'verify-success' });
    return { valid: true };
  } catch (error) {
    const reason = classifyTokenError(error);
    return warn(reason, 'verifySolution rejected a token or nonce', options, error);
  }
}
