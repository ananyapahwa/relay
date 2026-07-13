// Shared TypeScript types matching the API response shapes

export type DeliveryStatus = 'pending' | 'success' | 'failed' | 'dead_letter';

export interface Endpoint {
  id: string;
  tenant_id: string;
  url: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
}

export interface DeliveryWithDetails {
  id: string;
  event_id: string;
  endpoint_id: string;
  tenant_id: string;
  status: DeliveryStatus;
  attempt_count: number;
  next_attempt_at: string | null;
  last_response_code: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  // joined fields
  event_type: string;
  endpoint_url: string;
  payload: Record<string, unknown>;
}

export interface DeliveryAttempt {
  id: string;
  delivery_id: string;
  attempt_number: number;
  response_code: number | null;
  response_body_snippet: string | null;
  latency_ms: number | null;
  error_message: string | null;
  attempted_at: string;
}

export interface Stats {
  total: number;
  success: number;
  failed: number;
  dead_letter: number;
  pending: number;
}
