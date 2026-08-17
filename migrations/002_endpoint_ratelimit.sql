-- Migration: 002_endpoint_ratelimit.sql
-- Adds a per-endpoint hard ceiling for the adaptive rate limiter.
-- The Worker uses this as the maximum rate it will ever send to this endpoint.
-- The actual rate is learned dynamically and stored in Redis.

ALTER TABLE endpoints
  ADD COLUMN rate_limit_per_sec INT NOT NULL DEFAULT 10;
