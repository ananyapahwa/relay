import { Redis } from 'ioredis';

/**
 * Adaptive Token Bucket rate limiter backed by Redis.
 *
 * Uses Lua scripts for atomic operations so no race conditions are possible
 * even across many worker replicas hitting the same endpoint bucket.
 *
 * Key layout (per endpoint):
 *   ratelimit:{endpoint_id}         → Redis Hash
 *     tokens    : current token count (float)
 *     ts        : last refill timestamp (ms)
 *     rate      : LEARNED rate — adjusted dynamically based on server responses
 *
 * Algorithm: Token Bucket + Adaptive Rate Control
 *   - Each endpoint starts at a conservative DEFAULT_START_RATE (5 req/sec).
 *   - On each successful delivery the learned rate probes upward by +1, capped
 *     at the endpoint's hard ceiling (rate_limit_per_sec from Postgres).
 *   - On each failure (429 / 5xx / timeout) the learned rate is halved.
 *   - burst is always auto-calculated as 3 × current learned rate.
 *   - When a customer's server returns Retry-After, the Worker pauses delivery
 *     and calls recordRetryAfter() which also halves the learned rate.
 */

const DEFAULT_START_RATE = 5;  // conservative start for a brand-new endpoint

// ─── Lua: atomically refill + consume one token ───────────────────────────────
// KEYS[1] = hash key
// ARGV[1] = hard ceiling (rate_limit_per_sec from DB)
// ARGV[2] = now (ms)
const ALLOW_SCRIPT = `
local key     = KEYS[1]
local ceiling = tonumber(ARGV[1])
local now     = tonumber(ARGV[2])
local default = 5

-- Load stored state (or initialise)
local data   = redis.call('HMGET', key, 'tokens', 'ts', 'rate')
local rate   = math.min(tonumber(data[3]) or default, ceiling)
local burst  = math.max(1, rate * 3)
local tokens = tonumber(data[1]) or burst
local last   = tonumber(data[2]) or now

-- Refill based on elapsed time
local elapsed = math.max(0, now - last) / 1000
tokens = math.min(burst, tokens + elapsed * rate)

if tokens < 1 then
  return 0  -- rate limited
end

tokens = tokens - 1
local ttl = math.ceil(burst / math.max(rate, 1)) + 2
redis.call('HMSET', key, 'tokens', tokens, 'ts', now, 'rate', rate)
redis.call('EXPIRE', key, ttl)
return 1  -- allowed
`;

// ─── Lua: probe the learned rate upward on success ────────────────────────────
// ARGV[1] = hard ceiling
const RECORD_SUCCESS_SCRIPT = `
local key     = KEYS[1]
local ceiling = tonumber(ARGV[1])
local default = 5

local current = tonumber(redis.call('HGET', key, 'rate')) or default
local newRate = math.min(ceiling, current + 1)
redis.call('HSET', key, 'rate', newRate)
return newRate
`;

// ─── Lua: halve the learned rate on failure ───────────────────────────────────
const RECORD_FAILURE_SCRIPT = `
local key     = KEYS[1]
local default = 5

local current = tonumber(redis.call('HGET', key, 'rate')) or default
local newRate = math.max(1, math.floor(current / 2))
redis.call('HSET', key, 'rate', newRate)
return newRate
`;

export class RateLimiter {
  private redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
  }

  /**
   * Returns true if the request is allowed, false if rate limited.
   * Uses the learned rate stored in Redis, capped at hardCeiling.
   *
   * @param endpointId  - Unique endpoint identifier (used as Redis key prefix)
   * @param hardCeiling - Maximum req/sec this endpoint should ever receive
   *                      (comes from endpoint.rate_limit_per_sec in Postgres)
   */
  async allow(endpointId: string, hardCeiling: number): Promise<boolean> {
    const key    = `ratelimit:${endpointId}`;
    const result = await this.redis.eval(
      ALLOW_SCRIPT,
      1,
      key,
      hardCeiling,
      Date.now(),
    );
    return result === 1;
  }

  /**
   * Call after a successful (2xx) delivery.
   * Probes the learned rate upward by 1, up to hardCeiling.
   */
  async recordSuccess(endpointId: string, hardCeiling: number): Promise<void> {
    const key = `ratelimit:${endpointId}`;
    await this.redis.eval(RECORD_SUCCESS_SCRIPT, 1, key, hardCeiling);
  }

  /**
   * Call after a failed delivery (5xx, timeout, or 429 without Retry-After).
   * Halves the learned rate (minimum 1 req/sec).
   */
  async recordFailure(endpointId: string): Promise<void> {
    const key = `ratelimit:${endpointId}`;
    await this.redis.eval(RECORD_FAILURE_SCRIPT, 1, key);
  }

  /**
   * Call when the customer's server returns a 429 with a Retry-After header.
   * Halves the learned rate AND returns the number of ms the Worker should
   * wait before re-enqueueing the delivery.
   *
   * @param retryAfterSeconds - Value parsed from the Retry-After response header
   */
  async recordRetryAfter(endpointId: string, retryAfterSeconds: number): Promise<number> {
    await this.recordFailure(endpointId);
    return retryAfterSeconds * 1000; // return wait time in ms for Worker convenience
  }

  async quit() {
    await this.redis.quit();
  }
}
