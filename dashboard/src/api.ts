// Typed API client for the dashboard

const BASE = '/v1';

function getHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

async function request<T>(path: string, apiKey: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      ...getHeaders(apiKey),
      ...(opts.headers as Record<string, string> ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  // ─── Stats ───────────────────────────────────────────────────────────────────
  getStats(apiKey: string) {
    return request<{ total: number; success: number; failed: number; dead_letter: number; pending: number }>(
      '/stats', apiKey
    );
  },

  // ─── Deliveries ───────────────────────────────────────────────────────────────
  getDeliveries(
    apiKey: string,
    params: { endpoint_id?: string; status?: string; since?: string; limit?: number; offset?: number }
  ) {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') q.set(k, String(v)); });
    return request<{ deliveries: any[]; total: number; limit: number; offset: number }>(
      `/deliveries?${q}`, apiKey
    );
  },

  getDeliveryAttempts(apiKey: string, deliveryId: string) {
    return request<{ delivery: any; attempts: any[] }>(`/deliveries/${deliveryId}/attempts`, apiKey);
  },

  replayDelivery(apiKey: string, deliveryId: string) {
    return request<{ message: string; delivery: any }>(`/deliveries/${deliveryId}/replay`, apiKey, { method: 'POST' });
  },

  // ─── Endpoints ─────────────────────────────────────────────────────────────────
  getEndpoints(apiKey: string) {
    return request<{ endpoints: any[] }>('/endpoints', apiKey);
  },

  createEndpoint(apiKey: string, data: { url: string; secret: string; description?: string }) {
    return request<any>('/endpoints', apiKey, { method: 'POST', body: JSON.stringify(data) });
  },

  deleteEndpoint(apiKey: string, id: string) {
    return request<void>(`/endpoints/${id}`, apiKey, { method: 'DELETE' });
  },
};
