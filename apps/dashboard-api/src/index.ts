import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import type { DeliveryStatus } from '@relay/db';
import {
  sql,
  tenantRepo,
  endpointRepo,
  deliveryRepo,
  attemptRepo,
} from '@relay/db';
import { RedisStreamQueue } from '@relay/queue';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3002', 10);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const queue = new RedisStreamQueue(REDIS_URL);

// ─── SSE subscriber registry ─────────────────────────────────────────────────

// Maps tenant_id → Set of SSE response writers
const sseClients = new Map<string, Set<(data: string) => void>>();

export function broadcastToTenant(tenantId: string, event: object) {
  const clients = sseClients.get(tenantId);
  if (!clients) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  clients.forEach((write) => write(data));
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function authenticate(req: any, reply: any) {
  const auth = req.headers['authorization'];
  if (!auth?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Missing Authorization header' });
  }
  const hash = createHash('sha256').update(auth.slice(7)).digest('hex');
  const tenant = await tenantRepo.findByApiKeyHash(hash);
  if (!tenant) return reply.code(401).send({ error: 'Invalid API key' });
  req.tenant = tenant;
}

// ─── Server ───────────────────────────────────────────────────────────────────

const app = Fastify({ logger: true });
await app.register(cors, { origin: '*' });

// Serve React build
const dashboardDist = path.resolve(__dirname, '../../../dashboard/dist');
await app.register(staticFiles, {
  root: dashboardDist,
  prefix: '/',
  decorateReply: false,
});

app.get('/health', async () => ({ status: 'ok', service: 'dashboard-api' }));

// ─── GET /v1/deliveries ───────────────────────────────────────────────────────

const DeliveriesQuery = z.object({
  endpoint_id: z.string().uuid().optional(),
  status: z.enum(['pending', 'success', 'failed', 'dead_letter']).optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

app.get('/v1/deliveries', { preHandler: authenticate }, async (req: any, reply) => {
  const parsed = DeliveriesQuery.safeParse(req.query);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

  const { endpoint_id, status, since, limit, offset } = parsed.data;
  const opts = {
    endpoint_id,
    status: status as DeliveryStatus | undefined,
    since: since ? new Date(since) : undefined,
    limit,
    offset,
  };

  const [deliveries, total] = await Promise.all([
    deliveryRepo.findByTenant(req.tenant.id, opts),
    deliveryRepo.countByTenant(req.tenant.id, opts),
  ]);

  return reply.send({ deliveries, total, limit, offset });
});

// ─── GET /v1/deliveries/:id/attempts ─────────────────────────────────────────

app.get('/v1/deliveries/:id/attempts', { preHandler: authenticate }, async (req: any, reply) => {
  const { id } = req.params as { id: string };
  const delivery = await deliveryRepo.findById(id);

  if (!delivery || delivery.tenant_id !== req.tenant.id) {
    return reply.code(404).send({ error: 'Delivery not found' });
  }

  const attempts = await attemptRepo.findByDelivery(id);
  return reply.send({ delivery, attempts });
});

// ─── POST /v1/deliveries/:id/replay ──────────────────────────────────────────

app.post('/v1/deliveries/:id/replay', { preHandler: authenticate }, async (req: any, reply) => {
  const { id } = req.params as { id: string };
  const delivery = await deliveryRepo.findById(id);

  if (!delivery || delivery.tenant_id !== req.tenant.id) {
    return reply.code(404).send({ error: 'Delivery not found' });
  }

  const updated = await deliveryRepo.requeueForReplay(id);
  if (!updated) return reply.code(500).send({ error: 'Failed to requeue delivery' });

  await queue.publish({
    delivery_id: updated.id,
    event_id: updated.event_id,
    endpoint_id: updated.endpoint_id,
    tenant_id: updated.tenant_id,
  });

  return reply.send({ message: 'Delivery re-queued', delivery: updated });
});

// ─── GET /v1/stream/deliveries (SSE) ─────────────────────────────────────────

app.get('/v1/stream/deliveries', { preHandler: authenticate }, async (req: any, reply) => {
  const tenantId: string = req.tenant.id;

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const write = (data: string) => reply.raw.write(data);

  // Register client
  if (!sseClients.has(tenantId)) sseClients.set(tenantId, new Set());
  sseClients.get(tenantId)!.add(write);

  // Send heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => write(': heartbeat\n\n'), 30_000);

  req.raw.on('close', () => {
    clearInterval(heartbeat);
    sseClients.get(tenantId)?.delete(write);
  });

  // Don't resolve — keep the connection open
  return new Promise<void>(() => {});
});

// ─── Endpoints ───────────────────────────────────────────────────────────────

const CreateEndpointBody = z.object({
  url: z.string().url(),
  secret: z.string().min(16),
  description: z.string().max(500).optional(),
});

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

app.get('/v1/endpoints', { preHandler: authenticate }, async (req: any, reply) => {
  const endpoints = await endpointRepo.findAllByTenant(req.tenant.id);
  return reply.send({ endpoints });
});

app.delete('/v1/endpoints/:id', { preHandler: authenticate }, async (req: any, reply) => {
  const { id } = req.params as { id: string };
  const ok = await endpointRepo.deactivate(id, req.tenant.id);
  if (!ok) return reply.code(404).send({ error: 'Endpoint not found' });
  return reply.code(204).send();
});

// ─── GET /v1/stats ───────────────────────────────────────────────────────────

app.get('/v1/stats', { preHandler: authenticate }, async (req: any, reply) => {
  const tenantId = req.tenant.id;
  const [total, success, failed, deadLetter, pending] = await Promise.all([
    deliveryRepo.countByTenant(tenantId, {}),
    deliveryRepo.countByTenant(tenantId, { status: 'success' }),
    deliveryRepo.countByTenant(tenantId, { status: 'failed' }),
    deliveryRepo.countByTenant(tenantId, { status: 'dead_letter' }),
    deliveryRepo.countByTenant(tenantId, { status: 'pending' }),
  ]);

  return reply.send({ total, success, failed, dead_letter: deadLetter, pending });
});

// ─── Serve SPA fallback ───────────────────────────────────────────────────────

app.setNotFoundHandler(async (req, reply) => {
  if (!req.url.startsWith('/v1') && !req.url.startsWith('/health')) {
    return reply.sendFile('index.html', dashboardDist);
  }
  return reply.code(404).send({ error: 'Not found' });
});

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function start() {
  await queue.connect();
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`✅ dashboard-api listening on :${PORT}`);
}

start().catch((err) => {
  console.error('❌ dashboard-api failed to start:', err);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  await app.close();
  await queue.stop();
  await sql.end();
  process.exit(0);
});
