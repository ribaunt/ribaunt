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

export type PowAlgorithm = 'sha256' | 'argon2id';

export type ArgonProfile = 'mobile' | 'standard';

export const HARD_MAX = {
  m: 32 * 1024,
  t: 3,
  p: 1,
  hashLen: 32,
} as const;

export const ARGON_PROFILES: Record<ArgonProfile, { m: number; t: number; p: number; hashLen: number }> = {
  // NOTE: mobile and standard intentionally share the same conservative
  // first-cut tuning ({m:8192,t:1,p:1}). A heavier `high` profile
  // (m=32768 t=3, HARD_MAX) exists but is gated (Stage D, see bench/BROWSERSTACK.md)
  // pending broader device validation. Keep the two names so callers can
  // adopt the tier split now; retuning `standard` later won't break in-flight
  // tokens because each token embeds its own real m/t/p.
  mobile: { m: 8 * 1024, t: 1, p: 1, hashLen: 32 },
  standard: { m: 8 * 1024, t: 1, p: 1, hashLen: 32 },
};

interface ChallengeTokenPayload {
  challenge: string;
  difficulty: number;
  expires: number;
  jti?: string;
  contextHash?: string;
  alg?: PowAlgorithm;
  m?: number;
  t?: number;
  p?: number;
  hashLen?: number;
  // Construction version: 1 = challenge‖nonce password, salt = first 16 chars
  // of `challenge`, leading-zero hex difficulty. Absent = legacy v1 (accepted).
  v?: number;
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
  algorithm?: PowAlgorithm;
  argonProfile?: ArgonProfile;
}

export interface Workload {
  difficulty: number;
  amount: number;
  estimatedAttempts: number;
  algorithm: PowAlgorithm;
  argon?: { m: number; t: number; p: number; hashLen: number };
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
  algorithm?: PowAlgorithm;
  argonProfile?: ArgonProfile;
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
  | { type: 'challenge-issued'; difficulty: number; amount: number; algorithm?: PowAlgorithm }
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
const DEFAULT_BOUNDS_SHA = DEFAULT_BOUNDS;
const DEFAULT_BOUNDS_ARGON = {
  minDifficulty: 1,
  maxDifficulty: 2,
  minAmount: 1,
  maxAmount: 8,
} as const;
const MAX_WORKLOAD_DIFFICULTY = 64;
const MAX_WORKLOAD_ARGON_DIFFICULTY = 8;
const MAX_WORKLOAD_AMOUNT = 64;
const MAX_WORKLOAD_CANDIDATES = 10_000;

// Lazy argon2id provider (hash-wasm)
type Argon2idFn = (opts: { password: string; salt: string; parallelism: number; iterations: number; memorySize: number; hashLength: number; outputType: 'hex' | 'binary' | 'encoded' }) => Promise<string>;
let cachedArgon2id: Argon2idFn | null = null;
let argon2idLoadPromise: Promise<Argon2idFn> | null = null;

async function getArgon2idFn(): Promise<Argon2idFn> {
  if (cachedArgon2id) return cachedArgon2id;
  if (argon2idLoadPromise) return argon2idLoadPromise;
  argon2idLoadPromise = (async () => {
    // hash-wasm is CJS; handle both default and named interop
    const mod: unknown = await import('hash-wasm');
    const pkg = (mod as { default?: unknown }).default ?? mod;
    const fn = (pkg as { argon2id?: Argon2idFn }).argon2id;
    if (typeof fn !== 'function') throw new Error('hash-wasm argon2id not available');
    cachedArgon2id = fn;
    return fn;
  })();
  return argon2idLoadPromise;
}

function padSalt(challenge: string): string {
  // New challenges are always >= 16 chars of real entropy (see
  // generateChallenge), so this is a straight slice. The padEnd branch only
  // exists to keep verifying legacy 8-char challenges issued before the
  // entropy fix — its salt is weaker (8 random chars + '0' padding) but still
  // provides per-challenge domain separation.
  if (challenge.length >= 16) return challenge.slice(0, 16);
  return challenge.padEnd(16, '0');
}

function resolveArgonParams(profile?: ArgonProfile): { m: number; t: number; p: number; hashLen: number } {
  const normalized: ArgonProfile = profile ?? 'mobile';
  if (normalized !== 'mobile' && normalized !== 'standard') {
    throw new Error('argonProfile must be "mobile" or "standard"');
  }
  return ARGON_PROFILES[normalized];
}

async function argon2idHash(challenge: string, nonce: number | string, params: { m: number; t: number; p: number; hashLen: number }): Promise<string> {
  const argon2id = await getArgon2idFn();
  const salt = padSalt(challenge);
  const password = `${challenge}${String(nonce)}`;
  return argon2id({
    password,
    salt,
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m,
    hashLength: params.hashLen,
    outputType: 'hex',
  });
}

function assertAlgorithm(value: unknown): PowAlgorithm {
  if (value === undefined) return 'sha256';
  if (value === 'sha256' || value === 'argon2id') return value;
  throw new Error('algorithm must be "sha256" or "argon2id"');
}

function assertFiniteInteger(value: number, name: string, minimum: number): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  const normalized = Math.floor(value);
  if (normalized < minimum) throw new Error(`${name} must be at least ${minimum}`);
  return normalized;
}

function isValidPayload(payload: unknown): payload is ChallengeTokenPayload {
  if (!payload || typeof payload !== 'object') return false;
  const value = payload as Partial<ChallengeTokenPayload>;
  if (typeof value.challenge !== 'string' || value.challenge.length === 0) return false;
  if (typeof value.difficulty !== 'number' || !Number.isInteger(value.difficulty) || value.difficulty < 1) return false;
  // Construction version: absent = legacy v1, present must be 1. Rejects
  // unknown future constructions rather than solving under wrong assumptions.
  if (value.v !== undefined && value.v !== 1) return false;
  const alg = (value.alg ?? 'sha256') as PowAlgorithm;
  if (alg === 'argon2id') {
    if (value.difficulty > MAX_WORKLOAD_ARGON_DIFFICULTY) return false;
    if (typeof value.m !== 'number' || !Number.isInteger(value.m) || value.m < 8 || value.m > HARD_MAX.m) return false;
    if (typeof value.t !== 'number' || !Number.isInteger(value.t) || value.t < 1 || value.t > HARD_MAX.t) return false;
    if (typeof value.p !== 'number' || !Number.isInteger(value.p) || value.p < 1 || value.p > HARD_MAX.p) return false;
    if (value.hashLen !== undefined && value.hashLen !== 32) return false;
    // enforce at least pow of two? not needed
  } else if (alg === 'sha256') {
    if (value.difficulty > MAX_WORKLOAD_DIFFICULTY) return false;
    if (value.m !== undefined || value.t !== undefined || value.p !== undefined || value.hashLen !== undefined) return false;
  } else {
    return false;
  }
  if (typeof value.expires !== 'number' || !Number.isInteger(value.expires)) return false;
  if (typeof value.jti !== 'string' || value.jti.length === 0) return false;
  if (value.contextHash !== undefined && !/^[a-f0-9]{64}$/.test(value.contextHash)) return false;
  return true;
}

function assertRange(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function getDefaultBounds(algorithm: PowAlgorithm): { minDifficulty: number; maxDifficulty: number; minAmount: number; maxAmount: number } {
  return algorithm === 'argon2id' ? DEFAULT_BOUNDS_ARGON : DEFAULT_BOUNDS_SHA;
}

function getMaxDifficulty(algorithm: PowAlgorithm): number {
  return algorithm === 'argon2id' ? MAX_WORKLOAD_ARGON_DIFFICULTY : MAX_WORKLOAD_DIFFICULTY;
}

function normalizeBounds(options: WorkloadBounds): ReturnType<typeof normalizeBoundsInternal>;
function normalizeBounds(options: WorkloadBounds & { algorithm?: PowAlgorithm }): ReturnType<typeof normalizeBoundsInternal>;
function normalizeBounds(options: WorkloadBounds & { algorithm?: PowAlgorithm }) {
  const algorithm = assertAlgorithm((options as { algorithm?: unknown }).algorithm);
  return normalizeBoundsInternal(options, algorithm);
}

function normalizeBoundsInternal(options: WorkloadBounds, algorithm: PowAlgorithm = 'sha256') {
  const defaults = getDefaultBounds(algorithm);
  const maxDiff = getMaxDifficulty(algorithm);
  const minDifficulty = assertFiniteInteger(
    options.minDifficulty ?? defaults.minDifficulty,
    'Minimum difficulty',
    1
  );
  if (minDifficulty > maxDiff) {
    throw new Error(`Minimum difficulty must be at most ${maxDiff}`);
  }
  const maxDifficulty = assertFiniteInteger(
    options.maxDifficulty ?? defaults.maxDifficulty,
    'Maximum difficulty',
    minDifficulty
  );
  if (maxDifficulty > maxDiff) {
    throw new Error(`Maximum difficulty must be at most ${maxDiff}`);
  }
  const minAmount = assertFiniteInteger(options.minAmount ?? defaults.minAmount, 'Minimum amount', 1);
  if (minAmount > MAX_WORKLOAD_AMOUNT) {
    throw new Error(`Minimum amount must be at most ${MAX_WORKLOAD_AMOUNT}`);
  }
  const maxAmount = assertFiniteInteger(
    options.maxAmount ?? defaults.maxAmount,
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
  return { minDifficulty, maxDifficulty, minAmount, maxAmount, algorithm };
}

function closestWorkload(targetAttempts: number, bounds: ReturnType<typeof normalizeBoundsInternal>): Workload {
  let best: Workload | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  const algorithm = (bounds as { algorithm?: PowAlgorithm }).algorithm ?? 'sha256';
  const argon = algorithm === 'argon2id' ? resolveArgonParams((bounds as unknown as { argonProfile?: ArgonProfile }).argonProfile) : undefined;

  for (let difficulty = bounds.minDifficulty; difficulty <= bounds.maxDifficulty; difficulty++) {
    for (let amount = bounds.minAmount; amount <= bounds.maxAmount; amount++) {
      const estimatedAttempts = (16 ** difficulty) * amount;
      const distance = Math.abs(Math.log(estimatedAttempts / targetAttempts));
      if (distance < bestDistance) {
        bestDistance = distance;
        if (algorithm === 'argon2id') {
          best = { difficulty, amount, estimatedAttempts, algorithm, argon: argon! };
        } else {
          best = { difficulty, amount, estimatedAttempts, algorithm };
        }
      }
    }
  }

  return best!;
}

/**
 * Selects bounded proof-of-work using a server-owned risk floor and untrusted timing calibration.
 * For `algorithm:'argon2id'` difficulty is capped to the argon max (default 2) and the returned
 * workload carries `argon:{m,t,p}` derived from `argonProfile` so the device can comfortably solve it.
 */
export function selectWorkload(options: AdaptiveWorkloadOptions = {}): Workload {
  const algorithm = assertAlgorithm((options as { algorithm?: unknown }).algorithm);
  if (options.argonProfile !== undefined) {
    if (algorithm !== 'argon2id') throw new Error('argonProfile is only valid when algorithm is "argon2id"');
    if (options.argonProfile !== 'mobile' && options.argonProfile !== 'standard') {
      throw new Error('argonProfile must be "mobile" or "standard"');
    }
  }
  // Validate argonProfile early
  if (algorithm === 'argon2id') {
    // Trigger validation (defaults to mobile when undefined)
    resolveArgonParams(options.argonProfile);
  }
  const bounds = normalizeBounds({ ...options, algorithm } as WorkloadBounds & { algorithm?: PowAlgorithm }) as ReturnType<typeof normalizeBoundsInternal> & { argonProfile?: ArgonProfile };
  // Carry argonProfile through bounds object for closestWorkload to consume (without polluting validation)
  if (algorithm === 'argon2id' && options.argonProfile !== undefined) {
    (bounds as unknown as { argonProfile?: ArgonProfile }).argonProfile = options.argonProfile;
  }
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
  const workload = closestWorkload(Math.min(targetAttempts, maximumAttempts), bounds);
  // Ensure argon carries profile-resolved params if not already via closestWorkload
  if (algorithm === 'argon2id' && !workload.argon) {
    workload.argon = resolveArgonParams(options.argonProfile);
  }
  return workload;
}

function validateAssessWorkloadOptions(workload: AssessWorkloadOptions): void {
  const alg = assertAlgorithm((workload as { algorithm?: unknown }).algorithm);
  const defaults = getDefaultBounds(alg);
  const maxDiffForAlg = getMaxDifficulty(alg);
  // Reuse same validation messages as normalizeBounds / selectWorkload for regression safety
  if (workload.minDifficulty !== undefined) {
    assertFiniteInteger(workload.minDifficulty, 'Minimum difficulty', 1);
    if (Math.floor(workload.minDifficulty) > maxDiffForAlg) {
      throw new Error(`Minimum difficulty must be at most ${maxDiffForAlg}`);
    }
  }
  if (workload.maxDifficulty !== undefined) {
    // Need to ensure we validate max >= min (using resolved min)
    const min = workload.minDifficulty !== undefined ? Math.floor(workload.minDifficulty) : defaults.minDifficulty;
    assertFiniteInteger(workload.maxDifficulty, 'Maximum difficulty', min);
    if (Math.floor(workload.maxDifficulty) > maxDiffForAlg) {
      throw new Error(`Maximum difficulty must be at most ${maxDiffForAlg}`);
    }
  } else if (workload.minDifficulty !== undefined) {
    // If only minDifficulty provided, still need to ensure default max >= min
    if (defaults.maxDifficulty < Math.floor(workload.minDifficulty)) {
      throw new Error(`Maximum difficulty must be at least ${Math.floor(workload.minDifficulty)}`);
    }
  }
  if ((workload as { argonProfile?: unknown }).argonProfile !== undefined) {
    const p = (workload as { argonProfile?: unknown }).argonProfile;
    if (alg !== 'argon2id') throw new Error('argonProfile is only valid when algorithm is "argon2id"');
    if (p !== 'mobile' && p !== 'standard') throw new Error('argonProfile must be "mobile" or "standard"');
  }
  if (workload.minAmount !== undefined) {
    assertFiniteInteger(workload.minAmount, 'Minimum amount', 1);
  }
  if (workload.maxAmount !== undefined) {
    const minAmt = workload.minAmount !== undefined ? Math.floor(workload.minAmount) : defaults.minAmount;
    assertFiniteInteger(workload.maxAmount, 'Maximum amount', minAmt);
  } else if (workload.minAmount !== undefined) {
    if (defaults.maxAmount < Math.floor(workload.minAmount)) {
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
    workload.maxAmount !== undefined ||
    (workload as { algorithm?: unknown }).algorithm !== undefined ||
    (workload as { argonProfile?: unknown }).argonProfile !== undefined
  ) {
    normalizeBounds(workload as WorkloadBounds & { algorithm?: PowAlgorithm });
  }
  if ((workload as { algorithm?: unknown }).algorithm !== undefined) {
    assertAlgorithm((workload as { algorithm?: unknown }).algorithm);
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

/**
 * Measures SHA-256 hashing speed on Node.js to calibrate adaptive workload selection.
 * Runs a small benchmark to estimate device performance.
 *
 * @param iterations - Number of SHA-256 hashes to run (default: 128)
 * @returns Calibration object with iterations and measured duration
 */
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

/**
 * Alias for calibrateNode - measures device hashing speed for adaptive workload.
 */
export const calibrateClient = calibrateNode;

let cachedArgonCalibrationWarmup: Promise<void> | null = null;
async function ensureArgonWarmup(): Promise<void> {
  if (cachedArgonCalibrationWarmup) return cachedArgonCalibrationWarmup;
  // Warm up WASM once (first argon hash triggers compilation)
  cachedArgonCalibrationWarmup = (async () => {
    try {
      await getArgon2idFn();
      // tiny probe to force WASM compile — one hash at mobile params
      const argon = await getArgon2idFn();
      await argon({
        password: 'ribaunt-warmup',
        salt: 'ribaunt-warmup-16b',
        parallelism: 1,
        iterations: 1,
        memorySize: 8 * 1024,
        hashLength: 32,
        outputType: 'hex',
      });
    } catch {
      // warmup best-effort; calibration will still surface errors
    }
  })();
  return cachedArgonCalibrationWarmup;
}

/**
 * Calibrate Argon2id on Node — measures device speed for the memory-hard algorithm.
 * Uses a smaller iteration default (16) because each hash is ~6ms (mobile) vs microseconds for SHA.
 * The returned shape is identical to `calibrateNode()` so `selectWorkload({calibration, algorithm:'argon2id'})` can consume it.
 * Keep SHA `calibrateNode()` for `algorithm:'sha256'` — mismatched calibration will over/under-estimate.
 */
export async function calibrateArgonNode(iterations = 16): Promise<ClientCalibration> {
  if (!Number.isFinite(iterations) || iterations < 1) {
    throw new Error('Calibration iterations must be at least 1');
  }
  const normalizedIterations = Math.floor(iterations);
  await ensureArgonWarmup();
  const profile = resolveArgonParams('mobile');
  const startedAt = performance.now();
  for (let index = 0; index < normalizedIterations; index++) {
    await argon2idHash(`ribaunt-calibration:${index}`, '0', profile);
  }
  return {
    iterations: normalizedIterations,
    durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
  };
}

/**
 * Alias for calibrateArgonNode - measures Argon2id performance for adaptive workload.
 */
export const calibrateArgonClient = calibrateArgonNode;

/**
 * Resets Argon2id module cache for testing purposes.
 * Should not be called in production code.
 */
export function __resetArgonForTesting(): void {
  cachedArgon2id = null;
  argon2idLoadPromise = null;
  cachedArgonCalibrationWarmup = null;
}

function generateChallenge(): string {
  // 16 random bytes (128-bit) encoded as 22 base64url chars. The Argon2id salt
  // is the first 16 chars of this string, so it always carries ~96 bits of
  // real entropy — never zero-padding. (Pre-fix challenges were 8 chars, hence
  // the padEnd legacy branch in padSalt.)
  return crypto.randomBytes(16).toString('base64url');
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
  context?: string,
  algorithm: PowAlgorithm = 'sha256',
  argonParams?: { m: number; t: number; p: number; hashLen: number }
): ChallengeToken {
  const jti = crypto.randomUUID();
  const payload: ChallengeTokenPayload = {
    challenge: generateChallenge(),
    difficulty,
    expires: Math.floor(Date.now() / 1000) + ttlSeconds,
    jti,
    v: 1,
  };
  if (algorithm === 'argon2id') {
    payload.alg = 'argon2id';
    const p = argonParams ?? resolveArgonParams('mobile');
    payload.m = p.m;
    payload.t = p.t;
    payload.p = p.p;
    payload.hashLen = p.hashLen;
    if (difficulty < 1 || difficulty > MAX_WORKLOAD_ARGON_DIFFICULTY) {
      throw new Error(`Challenge difficulty must be between 1 and ${MAX_WORKLOAD_ARGON_DIFFICULTY} for argon2id`);
    }
  } else {
    if (difficulty < 1 || difficulty > MAX_WORKLOAD_DIFFICULTY) {
      throw new Error(`Challenge difficulty must be at most ${MAX_WORKLOAD_DIFFICULTY}`);
    }
  }
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

/**
 * Creates cryptographically-signed challenge tokens for proof-of-work verification.
 *
 * Supports two call signatures:
 * 1. `createChallenge(difficulty, amount, ttlSeconds)` - simple numeric params
 * 2. `createChallenge(options)` - full options object with adaptive workload, rate limiting, etc.
 *
 * When `difficulty: 'auto'` is used, workload is selected based on risk score and calibration.
 * Supports both SHA-256 and Argon2id algorithms (via `algorithm` option).
 *
 * @param difficultyOrOptions - Difficulty level (1-64) or options object
 * @param amount - Number of challenges to create (default: 4)
 * @param ttlSeconds - Token expiration in seconds (default: 30)
 * @returns Array of signed challenge tokens
 */
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
  const algorithm: PowAlgorithm = assertAlgorithm(options?.algorithm);
  if (options?.argonProfile !== undefined && algorithm !== 'argon2id') {
    throw new Error('argonProfile is only valid when algorithm is "argon2id"');
  }
  let selectedWorkload: Workload | undefined;
  if (options?.workload) {
    const w = options.workload as { difficulty: number; amount: number };
    const wDiff = assertFiniteInteger(w.difficulty, 'Challenge difficulty', 1);
    const maxForAlg = getMaxDifficulty(algorithm);
    if (wDiff > maxForAlg) throw new Error(`Challenge difficulty must be at most ${maxForAlg} for ${algorithm}`);
    const wAmount = assertFiniteInteger(w.amount, 'Challenge amount', 1);
    selectedWorkload = {
      difficulty: wDiff,
      amount: wAmount,
      estimatedAttempts: (16 ** wDiff) * wAmount,
      algorithm,
      ...(algorithm === 'argon2id' ? { argon: resolveArgonParams(options.argonProfile) } : {}),
    } as Workload;
  } else if (options?.difficulty === 'auto') {
    const workloadInput: AdaptiveWorkloadOptions = {
      ...(options as AdaptiveWorkloadOptions),
      algorithm,
      ...(options.argonProfile !== undefined ? { argonProfile: options.argonProfile } : {}),
    };
    selectedWorkload = selectWorkload(workloadInput);
  }
  // When algorithm is argon2id and workload was explicit or auto, resolve argon params for token
  let workloadArgon: { m: number; t: number; p: number; hashLen: number } | undefined;
  if (algorithm === 'argon2id') {
    if (selectedWorkload?.argon) {
      workloadArgon = selectedWorkload.argon;
    } else {
      workloadArgon = resolveArgonParams(options?.argonProfile);
    }
  }
  const configuredDifficulty = options?.difficulty === 'auto' ? undefined : options?.difficulty;
  const difficultyRaw = selectedWorkload?.difficulty ?? configuredDifficulty
      ?? (typeof difficultyOrOptions === 'number' ? difficultyOrOptions : 5);
  const difficulty = assertFiniteInteger(
    difficultyRaw,
    'Challenge difficulty',
    1
  );
  const maxForAlg = getMaxDifficulty(algorithm);
  if (difficulty > maxForAlg) throw new Error(`Challenge difficulty must be at most ${maxForAlg} for ${algorithm}`);
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
    () => createSingleChallenge(difficulty, normalizedTtl, options?.context, algorithm, workloadArgon)
  );
  if (algorithm === 'argon2id') {
    emitEvent(options, { type: 'challenge-issued', difficulty, amount: normalizedAmount, algorithm });
  } else {
    emitEvent(options, { type: 'challenge-issued', difficulty, amount: normalizedAmount });
  }
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
    if (payload.v !== undefined && payload.v !== 1) return undefined;
    // Sync solver only supports sha256; argon2id requires async path
    const alg = (payload as ChallengeTokenPayload).alg ?? 'sha256';
    if (alg === 'argon2id') return undefined;
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

/**
 * Solves SHA-256 proof-of-work challenge(s) synchronously on Node.js.
 * Does not support Argon2id challenges (use solveChallengeAsync for those).
 *
 * @param token - Single challenge token or array of tokens
 * @param options - Optional constraints (maxIterations, maxDurationMs)
 * @returns Solution(s) with nonce and hash, or undefined if unsolvable
 */
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

async function solveSingleChallengeAsync(
  token: ChallengeToken,
  options?: SolveChallengeOptions
): Promise<ChallengeSolution | undefined> {
  try {
    const payload = jwt.decode(token) as ChallengeTokenPayload | null;
    if (!payload) return undefined;
    if (payload.v !== undefined && payload.v !== 1) return undefined;
    const alg = payload.alg ?? 'sha256';
    const prefix = '0'.repeat(payload.difficulty);
    const maxIterations = normalizeMaxIterations(options);
    const maxDurationMs = normalizeMaxDurationMs(options);
    const startedAt = Date.now();

    if (alg === 'argon2id') {
      const params = {
        m: payload.m ?? HARD_MAX.m,
        t: payload.t ?? 1,
        p: payload.p ?? 1,
        hashLen: payload.hashLen ?? 32,
      };
      // Validate params match token (already validated by isValidPayload, but double-check)
      if (params.m > HARD_MAX.m || params.t > HARD_MAX.t || params.p > HARD_MAX.p) return undefined;
      for (let nonce = 0; ; nonce++) {
        if (maxIterations !== undefined && nonce >= maxIterations) return undefined;
        if (Date.now() - startedAt >= maxDurationMs) return undefined;
        const hash = await argon2idHash(payload.challenge, nonce, params);
        if (hash.startsWith(prefix)) return { nonce: String(nonce), hash };
        // Cooperative yield every 1 iteration for argon (hash is already ~6ms, but allow abort checks)
        if (nonce % 1 === 0) await new Promise<void>(r => setTimeout(r, 0));
      }
    } else {
      for (let nonce = 0; ; nonce++) {
        if (maxIterations !== undefined && nonce >= maxIterations) return undefined;
        if (Date.now() - startedAt >= maxDurationMs) return undefined;
        const hash = crypto.createHash('sha256').update(`${payload.challenge}${nonce}`).digest('hex');
        if (hash.startsWith(prefix)) return { nonce: String(nonce), hash };
      }
    }
  } catch {
    return undefined;
  }
}

/**
 * Solves proof-of-work challenge(s) asynchronously on Node.js.
 * Supports both SHA-256 and Argon2id challenges.
 *
 * @param token - Single challenge token or array of tokens
 * @param options - Optional constraints (maxIterations, maxDurationMs)
 * @returns Promise resolving to solution(s) with nonce and hash, or undefined if unsolvable
 */
export async function solveChallengeAsync(token: ChallengeToken, options?: SolveChallengeOptions): Promise<ChallengeSolution | undefined>;
export async function solveChallengeAsync(token: ChallengeToken[], options?: SolveChallengeOptions): Promise<ChallengeSolution[] | undefined>;
export async function solveChallengeAsync(
  token: ChallengeToken | ChallengeToken[],
  options?: SolveChallengeOptions
): Promise<ChallengeSolution | ChallengeSolution[] | undefined> {
  if (Array.isArray(token)) {
    const solutions: ChallengeSolution[] = [];
    for (const item of token) {
      const solution = await solveSingleChallengeAsync(item, options);
      if (!solution) return undefined;
      solutions.push(solution);
    }
    return solutions;
  }
  return solveSingleChallengeAsync(token, options);
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

/**
 * Verifies that a proof-of-work solution correctly solves the challenge token(s).
 *
 * Validation steps:
 * 1. JWT signature and expiration check
 * 2. Hash verification (recomputed hash matches difficulty)
 * 3. Context binding check (if context was provided)
 * 4. Replay prevention (via ReplayStore if configured)
 *
 * Supports batch verification with atomic replay detection.
 *
 * @param token - Challenge token(s) to verify
 * @param nonce - Solution nonce(s) or ChallengeSolution object(s)
 * @param options - Verification options (replay prevention, context, rate limiting)
 * @returns Result indicating validity or specific failure reason
 */
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

      const alg = payload.alg ?? 'sha256';
      let hash: string;
      if (alg === 'argon2id') {
        const params = {
          m: payload.m ?? HARD_MAX.m,
          t: payload.t ?? 1,
          p: payload.p ?? 1,
          hashLen: payload.hashLen ?? 32,
        };
        // Strict validation — tokens with out-of-bounds params already rejected by isValidPayload, but double-check for safety
        if (params.m < 8 || params.m > HARD_MAX.m || params.t < 1 || params.t > HARD_MAX.t || params.p < 1 || params.p > HARD_MAX.p) {
          return warn('invalid-token', 'verifySolution rejected an invalid argon2id token', options);
        }
        hash = await argon2idHash(payload.challenge, currentNonce, params);
      } else {
        hash = crypto
          .createHash('sha256')
          .update(`${payload.challenge}${String(currentNonce)}`)
          .digest('hex');
      }
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
