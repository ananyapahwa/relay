import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from './api';
import type { DeliveryWithDetails, DeliveryAttempt, Endpoint, Stats, DeliveryStatus } from './types';
import { formatDistanceToNow, format } from 'date-fns';

// ─── Auth Context ─────────────────────────────────────────────────────────────

const STORAGE_KEY = 'relay_api_key';

function useAuth() {
  const [apiKey, setApiKeyState] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY));

  const setApiKey = (key: string) => {
    localStorage.setItem(STORAGE_KEY, key);
    setApiKeyState(key);
  };

  const logout = () => {
    localStorage.removeItem(STORAGE_KEY);
    setApiKeyState(null);
  };

  return { apiKey, setApiKey, logout };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: DeliveryStatus }) {
  const icons: Record<DeliveryStatus, string> = {
    success: '✓',
    failed: '✕',
    pending: '◷',
    dead_letter: '☠',
  };
  return (
    <span className={`badge badge-${status}`}>
      {icons[status]} {status.replace('_', ' ')}
    </span>
  );
}

function TimeAgo({ date }: { date: string }) {
  return (
    <span
      className="text-muted"
      data-tooltip={format(new Date(date), 'MMM d, yyyy HH:mm:ss')}
      style={{ fontSize: 12 }}
    >
      {formatDistanceToNow(new Date(date), { addSuffix: true })}
    </span>
  );
}

// ─── Login Screen ─────────────────────────────────────────────────────────────

function LoginScreen({ onLogin }: { onLogin: (key: string) => void }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!key.trim()) { setError('API key is required'); return; }
    setLoading(true);
    try {
      await api.getStats(key.trim());
      onLogin(key.trim());
    } catch {
      setError('Invalid API key. Please check and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">
          <div className="login-logo-icon">⚡</div>
          <div className="login-title">Relay</div>
          <div className="login-subtitle">Reliable Webhook Delivery</div>
        </div>
        <form onSubmit={handleSubmit}>
          {error && <div className="error-msg">{error}</div>}
          <div className="form-group">
            <label className="form-label" htmlFor="api-key-input">Tenant API Key</label>
            <input
              id="api-key-input"
              className="form-input"
              type="password"
              placeholder="relay_sk_..."
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoFocus
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
            disabled={loading}
          >
            {loading ? 'Authenticating...' : '→  Enter Dashboard'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Delivery Detail Drawer ───────────────────────────────────────────────────

function DeliveryDrawer({
  delivery,
  apiKey,
  onClose,
  onReplay,
}: {
  delivery: DeliveryWithDetails;
  apiKey: string;
  onClose: () => void;
  onReplay: (id: string) => void;
}) {
  const [attempts, setAttempts] = useState<DeliveryAttempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [replaying, setReplaying] = useState(false);

  useEffect(() => {
    api.getDeliveryAttempts(apiKey, delivery.id)
      .then((r) => setAttempts(r.attempts))
      .finally(() => setLoading(false));
  }, [apiKey, delivery.id]);

  const handleReplay = async () => {
    setReplaying(true);
    try {
      await onReplay(delivery.id);
      onClose();
    } finally {
      setReplaying(false);
    }
  };

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-header">
          <div>
            <div className="drawer-title">Delivery Detail</div>
            <div className="mono" style={{ fontSize: 11, marginTop: 3, color: 'var(--text-muted)' }}>
              {delivery.id}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {delivery.status !== 'success' && (
              <button
                className="btn btn-primary btn-sm"
                onClick={handleReplay}
                disabled={replaying}
              >
                {replaying ? '…' : '↺ Replay'}
              </button>
            )}
            <button className="close-btn" onClick={onClose}>×</button>
          </div>
        </div>

        <div className="drawer-body">
          {/* Status + event info */}
          <div className="detail-grid">
            <div className="detail-field">
              <div className="detail-field-label">Status</div>
              <div className="detail-field-value"><StatusBadge status={delivery.status} /></div>
            </div>
            <div className="detail-field">
              <div className="detail-field-label">Attempts</div>
              <div className="detail-field-value" style={{ fontSize: 18, fontWeight: 700 }}>
                {delivery.attempt_count}
              </div>
            </div>
            <div className="detail-field" style={{ gridColumn: '1 / -1' }}>
              <div className="detail-field-label">Endpoint URL</div>
              <div className="detail-field-value mono" style={{ fontSize: 12 }}>{delivery.endpoint_url}</div>
            </div>
            <div className="detail-field">
              <div className="detail-field-label">Event Type</div>
              <div className="detail-field-value mono">{delivery.event_type}</div>
            </div>
            <div className="detail-field">
              <div className="detail-field-label">Created</div>
              <div className="detail-field-value" style={{ fontSize: 12 }}>
                {format(new Date(delivery.created_at), 'MMM d, HH:mm:ss')}
              </div>
            </div>
            {delivery.last_error && (
              <div className="detail-field" style={{ gridColumn: '1 / -1' }}>
                <div className="detail-field-label">Last Error</div>
                <div className="detail-field-value" style={{ color: 'var(--danger)', fontSize: 12 }}>
                  {delivery.last_error}
                </div>
              </div>
            )}
          </div>

          {/* Payload */}
          <div className="section-title">Event Payload</div>
          <div className="response-snippet" style={{ maxHeight: 150, marginBottom: 20 }}>
            {JSON.stringify(delivery.payload, null, 2)}
          </div>

          {/* Attempt timeline */}
          <div className="section-title">Attempt History ({attempts.length})</div>
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[...Array(3)].map((_, i) => (
                <div key={i} className="skeleton" style={{ height: 70 }} />
              ))}
            </div>
          ) : attempts.length === 0 ? (
            <div className="text-muted" style={{ fontSize: 13, padding: '16px 0' }}>
              No attempts recorded yet.
            </div>
          ) : (
            <div className="timeline">
              {attempts.map((a) => {
                const isSuccess = a.response_code !== null && a.response_code >= 200 && a.response_code < 300;
                return (
                  <div key={a.id} className="timeline-item">
                    <div className={`timeline-dot ${isSuccess ? 'success' : 'failure'}`}>
                      {a.attempt_number}
                    </div>
                    <div className="timeline-content">
                      <div className="timeline-meta">
                        <span>{format(new Date(a.attempted_at), 'HH:mm:ss.SSS')}</span>
                        {a.response_code && (
                          <span style={{ color: isSuccess ? 'var(--success)' : 'var(--danger)' }}>
                            HTTP {a.response_code}
                          </span>
                        )}
                        {a.latency_ms != null && <span>{a.latency_ms}ms</span>}
                      </div>
                      {a.error_message && (
                        <div style={{ color: 'var(--danger)', fontSize: 12 }}>{a.error_message}</div>
                      )}
                      {a.response_body_snippet && (
                        <div className="response-snippet">{a.response_body_snippet}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Deliveries Page ──────────────────────────────────────────────────────────

function DeliveriesPage({
  apiKey,
  endpoints,
  liveUpdates,
}: {
  apiKey: string;
  endpoints: Endpoint[];
  liveUpdates: DeliveryWithDetails[];
}) {
  const [deliveries, setDeliveries] = useState<DeliveryWithDetails[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<DeliveryWithDetails | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());

  // Filters
  const [endpointFilter, setEndpointFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<DeliveryStatus | ''>('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 20;

  const fetchDeliveries = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.getDeliveries(apiKey, {
        endpoint_id: endpointFilter || undefined,
        status: statusFilter || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setDeliveries(result.deliveries);
      setTotal(result.total);
    } finally {
      setLoading(false);
    }
  }, [apiKey, endpointFilter, statusFilter, page]);

  useEffect(() => { fetchDeliveries(); }, [fetchDeliveries]);

  // Merge live updates at the top of the list
  useEffect(() => {
    if (liveUpdates.length === 0) return;
    const latest = liveUpdates[liveUpdates.length - 1]!;
    setDeliveries((prev) => {
      const exists = prev.find((d) => d.id === latest.id);
      if (exists) {
        return prev.map((d) => (d.id === latest.id ? latest : d));
      }
      setNewIds((s) => new Set([...s, latest.id]));
      setTimeout(() => setNewIds((s) => { const n = new Set(s); n.delete(latest.id); return n; }), 2000);
      return [latest, ...prev.slice(0, PAGE_SIZE - 1)];
    });
  }, [liveUpdates]);

  const handleReplay = async (id: string) => {
    await api.replayDelivery(apiKey, id);
    await fetchDeliveries();
  };

  return (
    <div className="page">
      {/* Filters */}
      <div className="filters-bar">
        <select
          className="filter-select"
          value={endpointFilter}
          onChange={(e) => { setEndpointFilter(e.target.value); setPage(0); }}
          id="endpoint-filter"
        >
          <option value="">All Endpoints</option>
          {endpoints.map((ep) => (
            <option key={ep.id} value={ep.id}>{ep.url}</option>
          ))}
        </select>
        <select
          className="filter-select"
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value as any); setPage(0); }}
          id="status-filter"
        >
          <option value="">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
          <option value="dead_letter">Dead Letter</option>
        </select>
        <button className="btn btn-ghost btn-sm" onClick={fetchDeliveries}>↻ Refresh</button>
      </div>

      {/* Table */}
      <div className="table-container">
        <div className="table-header-row">
          <span className="table-title">Deliveries</span>
          <span className="text-muted" style={{ fontSize: 12 }}>{total} total</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Event Type</th>
              <th>Endpoint</th>
              <th>Attempts</th>
              <th>Last Code</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? [...Array(8)].map((_, i) => (
                  <tr key={i}>
                    {[...Array(7)].map((_, j) => (
                      <td key={j}>
                        <div className="skeleton" style={{ height: 16, width: '70%' }} />
                      </td>
                    ))}
                  </tr>
                ))
              : deliveries.length === 0
              ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-state">
                        <div className="empty-icon">📭</div>
                        <div className="empty-title">No deliveries yet</div>
                        <div className="empty-desc">Send a test event to your ingest API to see deliveries appear here.</div>
                      </div>
                    </td>
                  </tr>
                )
              : deliveries.map((d) => (
                  <tr
                    key={d.id}
                    className={newIds.has(d.id) ? 'new-item-flash' : ''}
                    onClick={() => setSelected(d)}
                  >
                    <td><StatusBadge status={d.status} /></td>
                    <td><span className="mono">{d.event_type}</span></td>
                    <td>
                      <span
                        className="text-secondary"
                        style={{ fontSize: 12, maxWidth: 200, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={d.endpoint_url}
                      >
                        {d.endpoint_url}
                      </span>
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>{d.attempt_count}</td>
                    <td>
                      {d.last_response_code ? (
                        <span
                          className="mono"
                          style={{ color: d.last_response_code < 300 ? 'var(--success)' : 'var(--danger)' }}
                        >
                          {d.last_response_code}
                        </span>
                      ) : <span className="text-muted">—</span>}
                    </td>
                    <td><TimeAgo date={d.created_at} /></td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {d.status !== 'success' && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => handleReplay(d.id)}
                          id={`replay-${d.id}`}
                        >
                          ↺ Replay
                        </button>
                      )}
                    </td>
                  </tr>
                ))
            }
          </tbody>
        </table>

        {/* Pagination */}
        <div className="pagination">
          <span className="pagination-info">
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </span>
          <div className="pagination-buttons">
            <button
              className="btn btn-ghost btn-sm"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              id="prev-page-btn"
            >
              ← Prev
            </button>
            <button
              className="btn btn-ghost btn-sm"
              disabled={(page + 1) * PAGE_SIZE >= total}
              onClick={() => setPage((p) => p + 1)}
              id="next-page-btn"
            >
              Next →
            </button>
          </div>
        </div>
      </div>

      {/* Detail drawer */}
      {selected && (
        <DeliveryDrawer
          delivery={selected}
          apiKey={apiKey}
          onClose={() => setSelected(null)}
          onReplay={handleReplay}
        />
      )}
    </div>
  );
}

// ─── Endpoints Page ───────────────────────────────────────────────────────────

function EndpointsPage({ apiKey }: { apiKey: string }) {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ url: '', secret: '', description: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const fetchEndpoints = useCallback(async () => {
    setLoading(true);
    const result = await api.getEndpoints(apiKey).finally(() => setLoading(false));
    setEndpoints(result.endpoints);
  }, [apiKey]);

  useEffect(() => { fetchEndpoints(); }, [fetchEndpoints]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await api.createEndpoint(apiKey, {
        url: form.url,
        secret: form.secret,
        description: form.description || undefined,
      });
      setForm({ url: '', secret: '', description: '' });
      setShowForm(false);
      fetchEndpoints();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create endpoint');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Deactivate this endpoint? Pending deliveries will still be attempted.')) return;
    await api.deleteEndpoint(apiKey, id);
    fetchEndpoints();
  };

  return (
    <div className="page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Endpoints</h1>
          <div className="text-muted" style={{ fontSize: 13 }}>
            Manage your webhook destination URLs
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm((v) => !v)} id="add-endpoint-btn">
          + Add Endpoint
        </button>
      </div>

      {showForm && (
        <div className="table-container" style={{ marginBottom: 20, padding: 24 }}>
          <div className="section-title">New Endpoint</div>
          {error && <div className="error-msg">{error}</div>}
          <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label" htmlFor="ep-url">Destination URL *</label>
              <input
                id="ep-url"
                className="form-input"
                style={{ fontFamily: 'var(--font-mono)' }}
                type="url"
                placeholder="https://your-server.com/webhook"
                value={form.url}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                required
              />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label" htmlFor="ep-secret">Signing Secret * (min 16 chars)</label>
              <input
                id="ep-secret"
                className="form-input"
                style={{ fontFamily: 'var(--font-mono)' }}
                type="password"
                placeholder="whsec_..."
                value={form.secret}
                onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))}
                required
                minLength={16}
              />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label" htmlFor="ep-description">Description (optional)</label>
              <input
                id="ep-description"
                className="form-input"
                type="text"
                placeholder="Production webhook"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={submitting} id="create-endpoint-submit">
                {submitting ? 'Creating...' : 'Create Endpoint'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <div className="endpoints-list">
        {loading
          ? [...Array(3)].map((_, i) => (
              <div key={i} className="endpoint-card">
                <div className="skeleton" style={{ height: 40, flex: 1 }} />
              </div>
            ))
          : endpoints.length === 0
          ? (
              <div className="empty-state">
                <div className="empty-icon">🔗</div>
                <div className="empty-title">No endpoints yet</div>
                <div className="empty-desc">Add a destination URL to start receiving webhooks.</div>
              </div>
            )
          : endpoints.map((ep) => (
              <div key={ep.id} className="endpoint-card">
                <div className="endpoint-info">
                  <div className="endpoint-url">{ep.url}</div>
                  <div className="endpoint-meta">
                    {ep.description && <span>{ep.description} · </span>}
                    Added <TimeAgo date={ep.created_at} />
                    {!ep.is_active && (
                      <span style={{ color: 'var(--warning)', marginLeft: 8 }}>⚠ Inactive</span>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className={`badge ${ep.is_active ? 'badge-success' : 'badge-failed'}`}>
                    {ep.is_active ? 'Active' : 'Inactive'}
                  </span>
                  {ep.is_active && (
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => handleDelete(ep.id)}
                      id={`deactivate-${ep.id}`}
                    >
                      Deactivate
                    </button>
                  )}
                </div>
              </div>
            ))
        }
      </div>
    </div>
  );
}

// ─── Stats Cards ──────────────────────────────────────────────────────────────

function StatsCards({ apiKey }: { apiKey: string }) {
  const [stats, setStats] = useState<{ total: number; success: number; failed: number; dead_letter: number; pending: number } | null>(null);

  useEffect(() => {
    const load = () => api.getStats(apiKey).then(setStats).catch(() => {});
    load();
    const interval = setInterval(load, 15_000);
    return () => clearInterval(interval);
  }, [apiKey]);

  const cards = [
    { label: 'Total', value: stats?.total, cls: 'default' },
    { label: 'Success', value: stats?.success, cls: 'success' },
    { label: 'Failed', value: stats?.failed, cls: 'danger' },
    { label: 'Pending', value: stats?.pending, cls: 'pending' },
    { label: 'Dead Letter', value: stats?.dead_letter, cls: 'warning' },
  ];

  return (
    <div className="stats-grid">
      {cards.map(({ label, value, cls }) => (
        <div key={label} className="stat-card">
          <div className="stat-label">{label}</div>
          <div className={`stat-value ${cls}`}>
            {value != null ? value.toLocaleString() : <div className="skeleton" style={{ height: 28, width: 60 }} />}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── App Shell ────────────────────────────────────────────────────────────────

export default function App() {
  const { apiKey, setApiKey, logout } = useAuth();
  const [page, setPage] = useState<'deliveries' | 'endpoints'>('deliveries');
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [liveUpdates, setLiveUpdates] = useState<DeliveryWithDetails[]>([]);
  const [liveConnected, setLiveConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Fetch endpoints once authenticated (needed for the filter dropdown)
  useEffect(() => {
    if (!apiKey) return;
    api.getEndpoints(apiKey).then((r) => setEndpoints(r.endpoints)).catch(() => {});
  }, [apiKey]);

  // SSE live feed
  useEffect(() => {
    if (!apiKey) return;

    const es = new EventSource(`/v1/stream/deliveries`, {
      // Polyfill doesn't support headers, so we pass the key via a custom workaround.
      // In production, proxy or use a token cookie. Here we use an EventSource
      // that does support headers via a small fetch-based wrapper.
    });

    eventSourceRef.current = es;

    es.onopen = () => setLiveConnected(true);
    es.onerror = () => setLiveConnected(false);
    es.onmessage = (e) => {
      try {
        const update = JSON.parse(e.data);
        setLiveUpdates((prev) => [...prev.slice(-99), update]);
      } catch {}
    };

    return () => {
      es.close();
      setLiveConnected(false);
    };
  }, [apiKey]);

  if (!apiKey) {
    return <LoginScreen onLogin={setApiKey} />;
  }

  const navItems = [
    { id: 'deliveries', label: 'Deliveries', icon: '📬' },
    { id: 'endpoints', label: 'Endpoints', icon: '🔗' },
  ] as const;

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-mark">
            <div className="logo-icon">⚡</div>
            <div className="logo-text">Relay</div>
          </div>
        </div>
        <nav className="sidebar-nav">
          {navItems.map(({ id, label, icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? 'active' : ''}`}
              onClick={() => setPage(id)}
              id={`nav-${id}`}
            >
              <span className="nav-icon">{icon}</span>
              {label}
            </button>
          ))}
        </nav>
        <div style={{ padding: '16px 12px', borderTop: '1px solid var(--border-subtle)' }}>
          <button className="nav-item" onClick={logout} style={{ color: 'var(--danger)' }} id="logout-btn">
            <span className="nav-icon">→</span> Sign Out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="main-content">
        <div className="topbar">
          <span className="topbar-title">
            {page === 'deliveries' ? 'Delivery Log' : 'Endpoint Management'}
          </span>
          <div className="topbar-right">
            {liveConnected && (
              <div className="live-badge">
                <div className="live-dot" /> Live
              </div>
            )}
          </div>
        </div>

        {/* Stats always visible */}
        <div style={{ padding: '24px 24px 0' }}>
          <StatsCards apiKey={apiKey} />
        </div>

        {page === 'deliveries' && (
          <DeliveriesPage
            apiKey={apiKey}
            endpoints={endpoints}
            liveUpdates={liveUpdates}
          />
        )}
        {page === 'endpoints' && <EndpointsPage apiKey={apiKey} />}
      </main>
    </div>
  );
}
