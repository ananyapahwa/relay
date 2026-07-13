import { Redis } from 'ioredis';

/**
 * Token bucket rate limiter backed by Redis.
 *
 * Uses a Lua script for atomic check-and-decrement so no race conditions
 * are possible even across many workers hitting the same endpoint bucket.
 *
 * Key: ratelimit:{endpoint_id}
 * Algorithm: sliding window counter (tokens reset every second)
 */

// Lua script: atomically check + decrement the bucket
const TOKEN_BUCKET_SCRIPT = `
local key     = KEYS[1]
local limit   = tonumber(ARGV[1])
local window  = tonumber(ARGV[2])

local current = redis.call('GET', key)
if current and tonumber(current) >= limit then
  return 0  -- rate limited
end

local new_val = redis.call('INCR', key)
if new_val == 1 then
  redis.call('EXPIRE', key, window)
end

return 1  -- allowed
`;

export class RateLimiter {
  private redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
  }

  /**
   * Returns true if the request is allowed, false if rate limited.
   * @param endpointId   - The endpoint being rate limited
   * @param limitPerSec  - Max requests per second for this endpoint
   */
  async allow(endpointId: string, limitPerSec: number): Promise<boolean> {
    const key = `ratelimit:${endpointId}`;
    const result = await this.redis.eval(
      TOKEN_BUCKET_SCRIPT,
      1,   // number of keys
      key,
      limitPerSec,
      1,   // window in seconds
    );
    return result === 1;
  }

  async quit() {
    await this.redis.quit();
  }
}
