/**
 * Exponential backoff with full jitter.
 *
 * Schedule (approx):
 *   attempt 1:  ~10s
 *   attempt 2:  ~1m
 *   attempt 3:  ~5m
 *   attempt 4:  ~30m
 *   attempt 5:  ~2h
 *   attempt 6:  ~6h
 *   attempt 7:  ~12h
 *   attempt 8:  ~24h
 */

const BASE_MS = 10_000;       // 10s
const CAP_MS  = 86_400_000;   // 24h
const JITTER_MS = 5_000;      // up to 5s jitter

/**
 * Returns the delay in milliseconds for a given attempt number (1-indexed).
 * Uses exponential backoff with capped jitter to spread retries.
 */
export function backoffMs(attempt: number): number {
  const exp = Math.min(CAP_MS, BASE_MS * Math.pow(2, attempt - 1));
  const jitter = Math.random() * JITTER_MS;
  return Math.floor(exp + jitter);
}

/**
 * Returns the absolute Date at which the next attempt should be made.
 */
export function nextAttemptAt(attempt: number): Date {
  return new Date(Date.now() + backoffMs(attempt));
}

/**
 * Human-readable schedule for documentation purposes.
 */
export const BACKOFF_SCHEDULE_LABELS = [
  '~10 seconds',
  '~1 minute',
  '~5 minutes',
  '~30 minutes',
  '~2 hours',
  '~6 hours',
  '~12 hours',
  '~24 hours',
];
