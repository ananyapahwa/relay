import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@relay/db';
import { createHash } from 'node:crypto';
import { app } from './index.js';

describe('Ingest API Integration Tests', () => {
  let tenantId: string;
  let apiKey = 'test_api_key_123';

  beforeAll(async () => {
    // Seed a tenant for testing
    const hash = createHash('sha256').update(apiKey).digest('hex');
    
    await sql`DELETE FROM tenants WHERE name = 'Test Tenant'`;
    
    const [tenant] = await sql`
      INSERT INTO tenants (name, api_key_hash)
      VALUES ('Test Tenant', ${hash})
      RETURNING id
    `;
    tenantId = tenant.id;
    
    // Fastify needs to be ready before injecting
    await app.ready();
  });

  afterAll(async () => {
    // Cleanup
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`;
    await sql.end();
    await app.close();
  });

  it('GET /health should return ok', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health'
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('POST /v1/events should reject unauthorized requests', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      payload: { event_type: 'test', payload: {} }
    });
    
    expect(res.statusCode).toBe(401);
  });

  it('POST /v1/events should accept valid events', async () => {
    const idempotencyKey = `test-idem-${Date.now()}`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: {
        authorization: `Bearer ${apiKey}`
      },
      payload: {
        event_type: 'test.event',
        payload: { test: true },
        idempotency_key: idempotencyKey
      }
    });
    
    expect(res.statusCode).toBe(202);
    expect(res.json().event_id).toBeDefined();
    
    // Idempotency check
    const duplicateRes = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: {
        authorization: `Bearer ${apiKey}`
      },
      payload: {
        event_type: 'test.event',
        payload: { test: true },
        idempotency_key: idempotencyKey
      }
    });
      
    expect(duplicateRes.statusCode).toBe(202);
    expect(duplicateRes.json().event_id).toBe(res.json().event_id);
    expect(duplicateRes.json().duplicate).toBe(true);
  });
});
