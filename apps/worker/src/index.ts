import { fetch } from 'undici';
import { RedisStreamQueue } from '@relay/queue';
import type { DeliveryJob } from '@relay/queue';
import { RateLimiter } from '@relay/ratelimit';
import { buildWebhookHeaders } from '@relay/signing';
import { nextAttemptAt } from '@relay/backoff';
import {
  sql,
  deliveryRepo,
  endpointRepo,
  eventRepo,
  tenantRepo,
  attemptRepo,
} from '@relay/db';
import { collectDefaultMetrics, Registry, Counter, Histogram, Gauge } from 'prom-client';

// ─── Config ────────────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const HTTP_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS ?? '10000', 10);

// ─── Metrics ──────────────────────────────────────────────────────────────────

const register = new Registry();
collectDefaultMetrics({ register });

const deliverySuccess = new Counter({
  name: 'relay_delivery_success_total',
  help: 'Total successful webhook deliveries',
  labelNames: ['tenant_id'],
  registers: [register],
});

const deliveryFailure = new Counter({
  name: 'relay_delivery_failure_total',
  help: 'Total failed webhook delivery attempts',
  labelNames: ['tenant_id', 'reason'],
  registers: [register],
});

const deliveryDeadLetter = new Counter({
  name: 'relay_delivery_dead_letter_total',
  help: 'Total deliveries moved to dead letter queue',
  labelNames: ['tenant_id'],
  registers: [register],
});

const deliveryLatency = new Histogram({
  name: 'relay_delivery_latency_ms',
  help: 'HTTP delivery latency in milliseconds',
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
  labelNames: ['tenant_id'],
  registers: [register],
});

const rateLimitedTotal = new Counter({
  name: 'relay_rate_limited_total',
  help: 'Total deliveries delayed due to rate limiting',
  labelNames: ['endpoint_id'],
  registers: [register],
});

// ─── Queue + Rate Limiter ─────────────────────────────────────────────────────

const queue = new RedisStreamQueue(REDIS_URL);
const rateLimiter = new RateLimiter(REDIS_URL);

// ─── Worker ───────────────────────────────────────────────────────────────────

async function handleDelivery(job: DeliveryJob): Promise<void> {
  const { delivery_id, endpoint_id, tenant_id } = job;

  // Fetch delivery, endpoint, event, tenant
  const [delivery, endpoint, tenant] = await Promise.all([
    deliveryRepo.findById(delivery_id),
    endpointRepo.findById(endpoint_id),
    tenantRepo.findById(tenant_id),
  ]);

  if (!delivery || !endpoint || !tenant) {
    console.warn(`[worker] Skipping job ${delivery_id} — entity not found`);
    return; // ACK to remove from queue
  }

  // Skip already-completed deliveries (idempotency)
  if (delivery.status === 'success' || delivery.status === 'dead_letter') {
    console.log(`[worker] Skipping ${delivery_id} — already ${delivery.status}`);
    return;
  }

  // Rate limit check — uses endpoint's hard ceiling; actual rate is learned adaptively in Redis
  const allowed = await rateLimiter.allow(endpoint_id, endpoint.rate_limit_per_sec);
  if (!allowed) {
    rateLimitedTotal.inc({ endpoint_id });
    // Re-queue with a short delay by marking next_attempt_at 1s from now
    await deliveryRepo.markRetry(delivery_id, {
      next_attempt_at: new Date(Date.now() + 1000),
      last_response_code: null,
      last_error: 'Rate limited',
    });
    // ACK this message — scheduler will re-enqueue when the time comes
    return;
  }

  // Fetch the event payload
  const event = await eventRepo.findById(delivery.event_id);
  if (!event) {
    console.warn(`[worker] Event ${delivery.event_id} not found`);
    return;
  }

  // Build and sign the request body
  const rawBody = JSON.stringify({
    event_id: event.id,
    event_type: event.event_type,
    payload: event.payload,
    created_at: event.created_at,
  });
  const headers = buildWebhookHeaders(delivery_id, endpoint.secret, rawBody);

  // Execute HTTP delivery with timeout
  const start = Date.now();
  let responseCode: number | null = null;
  let responseBodySnippet: string | null = null;
  let errorMessage: string | null = null;
  let success = false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers,
      body: rawBody,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    responseCode = response.status;

    const bodyText = await response.text();
    responseBodySnippet = bodyText.slice(0, 500);

    success = response.status >= 200 && response.status < 300;
  } catch (err: unknown) {
    errorMessage = err instanceof Error ? err.message : String(err);
    if (errorMessage.includes('abort')) errorMessage = 'Request timed out';
  }

  const latencyMs = Date.now() - start;
  const attemptNumber = delivery.attempt_count + 1;

  // Write attempt record
  await attemptRepo.create({
    delivery_id,
    attempt_number: attemptNumber,
    response_code: responseCode,
    response_body_snippet: responseBodySnippet,
    latency_ms: latencyMs,
    error_message: errorMessage,
  });

  if (success) {
    await deliveryRepo.markSuccess(delivery_id, responseCode!);
    // Probe the learned rate upward — server handled this fine
    await rateLimiter.recordSuccess(endpoint_id, endpoint.rate_limit_per_sec);
    deliverySuccess.inc({ tenant_id });
    deliveryLatency.observe({ tenant_id }, latencyMs);
    console.log(`[worker] ✅ Delivered ${delivery_id} → ${endpoint.url} (${latencyMs}ms)`);
    return;
  }

  // Failed — check if server gave us an explicit Retry-After before falling back
  const isDeadLetter = attemptNumber >= tenant.max_attempts;

  // ── Retry-After: customer's server told us exactly how long to wait ──────────
  if (responseCode === 429) {
    const retryAfterHeader = response ? (response as any).headers?.get?.('retry-after') : null;
    if (retryAfterHeader) {
      const waitSeconds = parseInt(retryAfterHeader, 10);
      if (!isNaN(waitSeconds) && waitSeconds > 0) {
        const waitMs = await rateLimiter.recordRetryAfter(endpoint_id, waitSeconds);
        await deliveryRepo.markRetry(delivery_id, {
          next_attempt_at: new Date(Date.now() + waitMs),
          last_response_code: responseCode,
          last_error: `Rate limited by server (Retry-After: ${waitSeconds}s)`,
        });
        deliveryFailure.inc({ tenant_id, reason: 'retry_after' });
        console.warn(
          `[worker] ⏳ Retry-After ${waitSeconds}s for ${delivery_id} — ` +
          `learned rate halved for endpoint ${endpoint_id}`
        );
        return;
      }
    }
    // 429 without header — still halve the learned rate then fall through to normal retry
    await rateLimiter.recordFailure(endpoint_id);
  } else if (!success) {
    // Non-429 failure (5xx, timeout) — halve the learned rate
    await rateLimiter.recordFailure(endpoint_id);
  }

  // ── Normal retry / dead-letter path ──────────────────────────────────────────
  if (isDeadLetter) {
    await deliveryRepo.markDeadLetter(delivery_id, {
      last_response_code: responseCode,
      last_error: errorMessage ?? `HTTP ${responseCode}`,
    });
    deliveryDeadLetter.inc({ tenant_id });
    console.warn(`[worker] ☠️  Dead letter: ${delivery_id} after ${attemptNumber} attempts`);
  } else {
    const next = nextAttemptAt(attemptNumber);
    await deliveryRepo.markRetry(delivery_id, {
      next_attempt_at: next,
      last_response_code: responseCode,
      last_error: errorMessage ?? `HTTP ${responseCode}`,
    });
    deliveryFailure.inc({ tenant_id, reason: errorMessage ? 'network' : 'http_error' });
    console.warn(
      `[worker] ⚠️  Retry ${attemptNumber}/${tenant.max_attempts} for ${delivery_id}, ` +
      `next at ${next.toISOString()}`
    );
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function start() {
  await queue.connect();
  console.log(`✅ Worker started (PID ${process.pid})`);
  await queue.startConsuming(handleDelivery);
}

start().catch((err) => {
  console.error('❌ Worker failed to start:', err);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  await queue.stop();
  await rateLimiter.quit();
  await sql.end();
  process.exit(0);
});
