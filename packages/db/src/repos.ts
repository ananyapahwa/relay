import sql from './client.js';
import type { Tenant, Endpoint, Event, Delivery, DeliveryAttempt, DeliveryStatus, DeliveryWithDetails } from './types.js';

// ─── Tenant Repository ────────────────────────────────────────────────────────

export const tenantRepo = {
  async findByApiKeyHash(hash: string): Promise<Tenant | null> {
    const rows = await sql<Tenant[]>`
      SELECT * FROM tenants WHERE api_key_hash = ${hash} LIMIT 1
    `;
    return rows[0] ?? null;
  },

  async create(data: { name: string; api_key_hash: string }): Promise<Tenant> {
    const rows = await sql<Tenant[]>`
      INSERT INTO tenants (name, api_key_hash)
      VALUES (${data.name}, ${data.api_key_hash})
      RETURNING *
    `;
    return rows[0]!;
  },

  async findById(id: string): Promise<Tenant | null> {
    const rows = await sql<Tenant[]>`SELECT * FROM tenants WHERE id = ${id} LIMIT 1`;
    return rows[0] ?? null;
  },
};

// ─── Endpoint Repository ──────────────────────────────────────────────────────

export const endpointRepo = {
  async create(data: {
    tenant_id: string;
    url: string;
    secret: string;
    description?: string;
    rate_limit_per_sec?: number;  // Hard ceiling for adaptive rate limiter (default: 10)
  }): Promise<Endpoint> {
    const rateLimit = data.rate_limit_per_sec ?? 10;

    const existing = await sql<Endpoint[]>`
      SELECT * FROM endpoints 
      WHERE tenant_id = ${data.tenant_id} AND url = ${data.url} 
      LIMIT 1
    `;
    
    if (existing[0]) {
      const updated = await sql<Endpoint[]>`
        UPDATE endpoints
        SET
          is_active = true,
          secret = ${data.secret},
          description = ${data.description ?? null},
          rate_limit_per_sec = ${rateLimit}
        WHERE id = ${existing[0].id}
        RETURNING *
      `;
      return updated[0]!;
    }

    const rows = await sql<Endpoint[]>`
      INSERT INTO endpoints (tenant_id, url, secret, description, rate_limit_per_sec)
      VALUES (${data.tenant_id}, ${data.url}, ${data.secret}, ${data.description ?? null}, ${rateLimit})
      RETURNING *
    `;
    return rows[0]!;
  },

  async findAllByTenant(tenant_id: string): Promise<Endpoint[]> {
    return sql<Endpoint[]>`
      SELECT * FROM endpoints WHERE tenant_id = ${tenant_id} ORDER BY created_at DESC
    `;
  },

  async findById(id: string): Promise<Endpoint | null> {
    const rows = await sql<Endpoint[]>`SELECT * FROM endpoints WHERE id = ${id} LIMIT 1`;
    return rows[0] ?? null;
  },

  async deactivate(id: string, tenant_id: string): Promise<boolean> {
    const rows = await sql`
      UPDATE endpoints SET is_active = false
      WHERE id = ${id} AND tenant_id = ${tenant_id}
      RETURNING id
    `;
    return rows.length > 0;
  },

  async findActiveByTenant(tenant_id: string): Promise<Endpoint[]> {
    return sql<Endpoint[]>`
      SELECT * FROM endpoints WHERE tenant_id = ${tenant_id} AND is_active = true
    `;
  },
};

// ─── Event Repository ─────────────────────────────────────────────────────────

export const eventRepo = {
  async create(data: {
    tenant_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    idempotency_key?: string;
  }): Promise<{ event: Event; duplicate: boolean }> {
    if (data.idempotency_key) {
      // Try to find existing event with same idempotency key
      const existing = await sql<Event[]>`
        SELECT * FROM events
        WHERE tenant_id = ${data.tenant_id} AND idempotency_key = ${data.idempotency_key}
        LIMIT 1
      `;
      if (existing[0]) return { event: existing[0], duplicate: true };
    }

    const rows = await sql<Event[]>`
      INSERT INTO events (tenant_id, event_type, payload, idempotency_key)
      VALUES (
        ${data.tenant_id},
        ${data.event_type},
        ${sql.json(data.payload as any)},
        ${data.idempotency_key ?? null}
      )
      RETURNING *
    `;
    return { event: rows[0]!, duplicate: false };
  },

  async findById(id: string): Promise<Event | null> {
    const rows = await sql<Event[]>`SELECT * FROM events WHERE id = ${id} LIMIT 1`;
    return rows[0] ?? null;
  },
};

// ─── Delivery Repository ──────────────────────────────────────────────────────

export const deliveryRepo = {
  async createMany(
    entries: Array<{ event_id: string; endpoint_id: string; tenant_id: string }>
  ): Promise<Delivery[]> {
    if (entries.length === 0) return [];
    return sql<Delivery[]>`
      INSERT INTO deliveries (event_id, endpoint_id, tenant_id, next_attempt_at)
      SELECT
        (v->>'event_id')::uuid,
        (v->>'endpoint_id')::uuid,
        (v->>'tenant_id')::uuid,
        now()
      FROM jsonb_array_elements(${sql.json(entries)}::jsonb) AS v
      RETURNING *
    `;
  },

  async findById(id: string): Promise<Delivery | null> {
    const rows = await sql<Delivery[]>`SELECT * FROM deliveries WHERE id = ${id} LIMIT 1`;
    return rows[0] ?? null;
  },

  // For the retry scheduler sweep
  async findDuePending(limit: number = 500): Promise<Delivery[]> {
    return sql<Delivery[]>`
      SELECT * FROM deliveries
      WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY next_attempt_at ASC
      LIMIT ${limit}
    `;
  },

  async markSuccess(id: string, response_code: number): Promise<void> {
    await sql`
      UPDATE deliveries
      SET status = 'success', last_response_code = ${response_code}, attempt_count = attempt_count + 1
      WHERE id = ${id}
    `;
  },

  async markRetry(
    id: string,
    data: { next_attempt_at: Date; last_response_code: number | null; last_error: string | null }
  ): Promise<void> {
    await sql`
      UPDATE deliveries
      SET
        status = 'pending',
        attempt_count = attempt_count + 1,
        next_attempt_at = ${data.next_attempt_at},
        last_response_code = ${data.last_response_code},
        last_error = ${data.last_error}
      WHERE id = ${id}
    `;
  },

  async markDeadLetter(
    id: string,
    data: { last_response_code: number | null; last_error: string | null }
  ): Promise<void> {
    await sql`
      UPDATE deliveries
      SET
        status = 'dead_letter',
        attempt_count = attempt_count + 1,
        last_response_code = ${data.last_response_code},
        last_error = ${data.last_error}
      WHERE id = ${id}
    `;
  },

  async requeueForReplay(id: string): Promise<Delivery | null> {
    const rows = await sql<Delivery[]>`
      UPDATE deliveries
      SET status = 'pending', next_attempt_at = now(), last_error = null
      WHERE id = ${id}
      RETURNING *
    `;
    return rows[0] ?? null;
  },

  // Dashboard paginated log
  async findByTenant(
    tenant_id: string,
    opts: {
      endpoint_id?: string;
      status?: DeliveryStatus;
      since?: Date;
      limit?: number;
      offset?: number;
    }
  ): Promise<DeliveryWithDetails[]> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    return sql<DeliveryWithDetails[]>`
      SELECT
        d.*,
        e.event_type,
        ep.url AS endpoint_url,
        e.payload
      FROM deliveries d
      JOIN events e ON e.id = d.event_id
      JOIN endpoints ep ON ep.id = d.endpoint_id
      WHERE d.tenant_id = ${tenant_id}
        ${opts.endpoint_id ? sql`AND d.endpoint_id = ${opts.endpoint_id}` : sql``}
        ${opts.status ? sql`AND d.status = ${opts.status}` : sql``}
        ${opts.since ? sql`AND d.created_at >= ${opts.since}` : sql``}
      ORDER BY d.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  },

  async countByTenant(
    tenant_id: string,
    opts: { endpoint_id?: string; status?: DeliveryStatus; since?: Date }
  ): Promise<number> {
    const rows = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM deliveries d
      WHERE d.tenant_id = ${tenant_id}
        ${opts.endpoint_id ? sql`AND d.endpoint_id = ${opts.endpoint_id}` : sql``}
        ${opts.status ? sql`AND d.status = ${opts.status}` : sql``}
        ${opts.since ? sql`AND d.created_at >= ${opts.since}` : sql``}
    `;
    return parseInt(rows[0]!.count, 10);
  },
};

// ─── Delivery Attempt Repository ──────────────────────────────────────────────

export const attemptRepo = {
  async create(data: {
    delivery_id: string;
    attempt_number: number;
    response_code?: number | null;
    response_body_snippet?: string | null;
    latency_ms?: number | null;
    error_message?: string | null;
  }): Promise<DeliveryAttempt> {
    const rows = await sql<DeliveryAttempt[]>`
      INSERT INTO delivery_attempts
        (delivery_id, attempt_number, response_code, response_body_snippet, latency_ms, error_message)
      VALUES (
        ${data.delivery_id},
        ${data.attempt_number},
        ${data.response_code ?? null},
        ${data.response_body_snippet ?? null},
        ${data.latency_ms ?? null},
        ${data.error_message ?? null}
      )
      RETURNING *
    `;
    return rows[0]!;
  },

  async findByDelivery(delivery_id: string): Promise<DeliveryAttempt[]> {
    return sql<DeliveryAttempt[]>`
      SELECT * FROM delivery_attempts
      WHERE delivery_id = ${delivery_id}
      ORDER BY attempt_number ASC
    `;
  },
};
