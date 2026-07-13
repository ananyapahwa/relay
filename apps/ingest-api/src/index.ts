import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { sql, tenantRepo, endpointRepo, eventRepo, deliveryRepo } from '@relay/db';
import type { Delivery, Endpoint } from '@relay/db';
import { RedisStreamQueue } from '@relay/queue';
import { collectDefaultMetrics, Registry, Counter, Histogram } from 'prom-client';

// ─── Config ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

// ─── Metrics ──────────────────────────────────────────────────────────────────

const register = new Registry();
collectDefaultMetrics({ register });

const eventsIngestedTotal = new Counter({
  name: 'relay_events_ingested_total',
  help: 'Total events received by the ingest API',
  labelNames: ['tenant_id', 'event_type'],
  registers: [register],
});

const ingestDuration = new Histogram({
  name: 'relay_ingest_duration_ms',
  help: 'Duration of event ingest in milliseconds',
  buckets: [5, 10, 25, 50, 100, 250, 500],
  registers: [register],
});

// ─── Queue ────────────────────────────────────────────────────────────────────

const queue = new RedisStreamQueue(REDIS_URL);

// ─── Auth middleware ──────────────────────────────────────────────────────────

async function authenticate(req: any, reply: any) {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Missing Authorization header' });
  }
  const apiKey = auth.slice(7);
  const hash = createHash('sha256').update(apiKey).digest('hex');
  const tenant = await tenantRepo.findByApiKeyHash(hash);
  if (!tenant) {
    return reply.code(401).send({ error: 'Invalid API key' });
  }
  req.tenant = tenant;
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const IngestEventBody = z.object({
  event_type: z.string().min(1).max(200),
  payload: z.record(z.unknown()),
  idempotency_key: z.string().max(256).optional(),
});

const CreateEndpointBody = z.object({
  url: z.string().url(),
  secret: z.string().min(16),
  description: z.string().max(500).optional(),
});

// ─── Server ───────────────────────────────────────────────────────────────────

const app = Fastify({ logger: true });
await app.register(cors, { origin: '*' });

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', async () => ({ status: 'ok', service: 'ingest-api' }));

// ─── Prometheus metrics ───────────────────────────────────────────────────────

app.get('/metrics', async (req, reply) => {
  reply.header('Content-Type', register.contentType);
  return register.metrics();
});

// ─── POST /v1/events ─────────────────────────────────────────────────────────

app.post('/v1/events', {
  preHandler: authenticate,
}, async (req: any, reply) => {
  const end = ingestDuration.startTimer();

  const parsed = IngestEventBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'Invalid request', details: parsed.error.flatten() });
  }

  const { event_type, payload, idempotency_key } = parsed.data;
  const tenant = req.tenant;

  // Persist event (handles idempotency)
  const { event, duplicate } = await eventRepo.create({
    tenant_id: tenant.id,
    event_type,
    payload,
    idempotency_key,
  });

  if (duplicate) {
    // Idempotent — return the original event ID
    return reply.code(202).send({ event_id: event.id, duplicate: true });
  }

  // Fan-out: create one delivery per active endpoint
  const endpoints = await endpointRepo.findActiveByTenant(tenant.id);
  if (endpoints.length > 0) {
    const deliveries = await deliveryRepo.createMany(
      endpoints.map((ep: Endpoint) => ({
        event_id: event.id,
        endpoint_id: ep.id,
        tenant_id: tenant.id,
      }))
    );

    // Enqueue all delivery jobs
    await Promise.all(
      deliveries.map((d: Delivery) =>
        queue.publish({
          delivery_id: d.id,
          event_id: d.event_id,
          endpoint_id: d.endpoint_id,
          tenant_id: d.tenant_id,
        })
      )
    );
  }

  eventsIngestedTotal.inc({ tenant_id: tenant.id, event_type });
  end();

  return reply.code(202).send({ event_id: event.id, delivery_count: endpoints.length });
});

// ─── POST /v1/endpoints ──────────────────────────────────────────────────────

app.post('/v1/endpoints', { preHandler: authenticate }, async (req: any, reply) => {
  const parsed = CreateEndpointBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'Invalid request', details: parsed.error.flatten() });
  }
  const endpoint = await endpointRepo.create({
    tenant_id: req.tenant.id,
    ...parsed.data,
  });
  return reply.code(201).send(endpoint);
});

// ─── GET /v1/endpoints ───────────────────────────────────────────────────────

app.get('/v1/endpoints', { preHandler: authenticate }, async (req: any, reply) => {
  const endpoints = await endpointRepo.findAllByTenant(req.tenant.id);
  return reply.send({ endpoints });
});

// ─── DELETE /v1/endpoints/:id ────────────────────────────────────────────────

app.delete('/v1/endpoints/:id', { preHandler: authenticate }, async (req: any, reply) => {
  const { id } = req.params as { id: string };
  const ok = await endpointRepo.deactivate(id, req.tenant.id);
  if (!ok) return reply.code(404).send({ error: 'Endpoint not found' });
  return reply.code(204).send();
});

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function start() {
  await queue.connect();
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`✅ ingest-api listening on :${PORT}`);
}

start().catch((err) => {
  console.error('❌ ingest-api failed to start:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await app.close();
  await queue.stop();
  await sql.end();
  process.exit(0);
});
