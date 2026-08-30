/**
 * Ribaunt Risk Engine — programmable risk-assessment subsystem.
 *
 * This module is intentionally small, stateless, and caller-driven.
 * All incoming signals are caller-supplied and treated as untrusted
 * inputs. The default scorer is a transparent, deterministic heuristic
 * (not an ML/fraud probability model) that can be inspected and replaced.
 *
 * Scoring is CPU-only, O(1) over the small set of known signals, and
 * performs no I/O.
 */

import type { ClientCalibration, Workload, WorkloadBounds } from './index.js';

// ── Public types ────────────────────────────────────────────────────────────

export interface RiskSignals {
  ip?: string;
  userAgent?: string;
  accountAgeSeconds?: number;
  requestVelocity?: number;
  [key: string]: unknown;
}

export interface RiskScorer {
  score(signals: RiskSignals): Promise<number>;
}

export interface RiskThresholds {
  challenge: number;
  block: number;
}

export interface AssessWorkloadOptions extends WorkloadBounds {
  targetDurationMs?: number;
  calibration?: ClientCalibration;
}

export interface AssessOptions {
  signals: RiskSignals;
  scorer?: RiskScorer;
  thresholds?: RiskThresholds;
  workload?: AssessWorkloadOptions;
}

export interface RiskAssessment {
  risk: number;
  action: 'allow' | 'challenge' | 'block';
  workload?: Workload;
}

// ── Default policy values ──────────────────────────────────────────────────

/**
 * Sensible v1 defaults. These numbers are policy defaults, not claims
 * about a statistically calibrated fraud model. Consumers should tune
 * them to their application.
 *
 * Semantics:
 *   risk < challenge               -> allow
 *   challenge <= risk < block      -> challenge
 *   risk >= block                 -> block
 */
export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
  challenge: 40,
  block: 80,
} as const;

// ── Validation helpers ─────────────────────────────────────────────────────

/**
 * Validate thresholds. Throws if invalid rather than silently repairing.
 * Requires 0 <= challenge < block <= 100
 */
export function validateRiskThresholds(thresholds: RiskThresholds): void {
  if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds)) {
    throw new Error('Risk thresholds must be an object');
  }
  const c = (thresholds as RiskThresholds).challenge;
  const b = (thresholds as RiskThresholds).block;

  if (typeof c !== 'number' || !Number.isFinite(c)) {
    throw new Error('Challenge threshold must be a finite number');
  }
  if (typeof b !== 'number' || !Number.isFinite(b)) {
    throw new Error('Block threshold must be a finite number');
  }
  if (c < 0 || c > 100) {
    throw new Error('Challenge threshold must be between 0 and 100');
  }
  if (b < 0 || b > 100) {
    throw new Error('Block threshold must be between 0 and 100');
  }
  if (c >= b) {
    throw new Error('Challenge threshold must be less than block threshold');
  }
}

/**
 * Validate scorer output. Custom scorers must return a finite number
 * between 0 and 100 inclusive. Do not silently clamp — reject as a
 * configuration/programming error so broken policies are visible.
 */
export function validateScorerOutput(value: unknown): number {
  if (typeof value !== 'number') {
    throw new Error('Scorer must return a finite number between 0 and 100');
  }
  if (!Number.isFinite(value)) {
    throw new Error('Scorer must return a finite number between 0 and 100');
  }
  if (value < 0 || value > 100) {
    throw new Error('Scorer must return a number between 0 and 100');
  }
  return value;
}

export function clampRisk(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

// ── Normalizer / rule helpers (default scorer pipeline) ───────────────────

/**
 * Normalize account age to a bounded risk contribution (0..30).
 *
 * Younger accounts contribute more risk than older accounts.
 * - Negative ages are invalid/ignored (0)
 * - NaN / Infinity are ignored (0)
 * - Very large values saturate to 0 rather than overflow (no dominance)
 *
 * Buckets are documented and deterministic:
 *   < 60s        -> 30
 *   < 1h         -> 25
 *   < 1d         -> 20
 *   < 7d         -> 15
 *   < 30d        -> 10
 *   < 90d        -> 5
 *   >= 90d       -> 0
 */
export function normalizeAccountAge(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  if (value < 60) return 30;
  if (value < 3600) return 25;
  if (value < 86400) return 20;
  if (value < 604800) return 15;
  if (value < 2592000) return 10;
  if (value < 7776000) return 5;
  return 0;
}

/**
 * Normalize caller-derived request velocity to a bounded contribution (0..40).
 *
 * Higher velocity contributes more risk.
 * - Negative values are invalid/ignored
 * - Non-finite values are ignored
 * - Saturates rather than growing without bound
 *
 * Buckets:
 *   < 1          -> 0
 *   < 5          -> 10
 *   < 20         -> 20
 *   < 60         -> 30
 *   < 200        -> 35
 *   >= 200       -> 40
 *
 * The caller-derived velocity is not assumed to be authoritative; it is
 * a weak heuristic contributed to the total score.
 */
export function normalizeRequestVelocity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  if (value < 1) return 0;
  if (value < 5) return 10;
  if (value < 20) return 20;
  if (value < 60) return 30;
  if (value < 200) return 35;
  return 40;
}

/**
 * Inspect user-agent signal as a weak signal only.
 *
 * - Missing or non-string UA -> 0 (not treated as strong signal)
 * - Empty / whitespace-only UA -> 5
 * - Very short UA (<10 chars) -> 10
 * - Otherwise -> 0
 *
 * No fragile substring bans (e.g. `ua.includes('bot')`) are used.
 * UA classification is not treated as trustworthy.
 */
export function scoreUserAgent(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const trimmed = value.trim();
  if (trimmed.length === 0) return 5;
  if (trimmed.length < 10) return 10;
  return 0;
}

/**
 * IP is accepted for custom scorers but the default scorer does not
 * pretend to know whether an IP is malicious. The safest v1 choice is
 * to return 0 and let custom scorers handle IP reputation if needed.
 */
export function scoreIp(_value: unknown): number {
  return 0;
}

// ── Default scorer ─────────────────────────────────────────────────────────

/**
 * Deterministic default scorer. Transparent heuristic:
 *   signals -> normalizeAccountAge + normalizeRequestVelocity + scoreUserAgent + scoreIp -> clamp 0..100
 *
 * Unknown properties on RiskSignals are ignored by the default scorer;
 * custom scorers may use them.
 *
 * This scorer is synchronous internally but exposed as async via the
 * RiskScorer interface so callers can supply remote/model-based scorers
 * without changing the API.
 */
export function defaultScore(signals: RiskSignals): number {
  const age = normalizeAccountAge(signals.accountAgeSeconds);
  const velocity = normalizeRequestVelocity(signals.requestVelocity);
  const ua = scoreUserAgent(signals.userAgent);
  const ip = scoreIp(signals.ip);
  const raw = age + velocity + ua + ip;
  return clampRisk(raw);
}

export const defaultScorer: RiskScorer = {
  async score(signals: RiskSignals): Promise<number> {
    return defaultScore(signals);
  },
};
