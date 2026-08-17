// TypeScript types matching the Postgres schema exactly

export type DeliveryStatus = 'pending' | 'success' | 'failed' | 'dead_letter';

export interface Tenant {
  id: string;
  name: string;
  api_key_hash: string;
  max_attempts: number;
  rate_limit_per_sec: number;
  created_at: Date;
}

export interface Endpoint {
  id: string;
  tenant_id: string;
  url: string;
  secret: string;
  description: string | null;
  is_active: boolean;
  rate_limit_per_sec: number;  // Hard ceiling — adaptive rate in Redis never exceeds this
  created_at: Date;
}

export interface Event {
  id: string;
  tenant_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  idempotency_key: string | null;
  created_at: Date;
}

export interface Delivery {
  id: string;
  event_id: string;
  endpoint_id: string;
  tenant_id: string;
  status: DeliveryStatus;
  attempt_count: number;
  next_attempt_at: Date | null;
  last_response_code: number | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DeliveryAttempt {
  id: string;
  delivery_id: string;
  attempt_number: number;
  response_code: number | null;
  response_body_snippet: string | null;
  latency_ms: number | null;
  error_message: string | null;
  attempted_at: Date;
}

// Enriched delivery with event + endpoint info (for dashboard)
export interface DeliveryWithDetails extends Delivery {
  event_type: string;
  endpoint_url: string;
  payload: Record<string, unknown>;
}
