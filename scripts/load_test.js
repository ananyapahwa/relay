/**
 * Relay — k6 Load Test
 *
 * Simulates realistic webhook ingest load:
 *   - Ramp up to 50 VUs over 30s
 *   - Hold at 50 VUs for 2 minutes
 *   - Ramp down
 *
 * Usage: k6 run scripts/load_test.js -e API_KEY=your_key -e INGEST_URL=http://localhost:3001
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const ingestSuccess = new Counter('relay_ingest_success');
const ingestErrors  = new Counter('relay_ingest_errors');
const ingestRate    = new Rate('relay_ingest_success_rate');
const ingestLatency = new Trend('relay_ingest_latency_ms', true);

export const options = {
  stages: [
    { duration: '30s', target: 50 },   // ramp up
    { duration: '2m',  target: 50 },   // steady state
    { duration: '15s', target: 0 },    // ramp down
  ],
  thresholds: {
    relay_ingest_success_rate: ['rate>0.99'],      // 99% success
    relay_ingest_latency_ms:   ['p(95)<200'],      // p95 < 200ms
    http_req_failed:           ['rate<0.01'],
  },
};

const BASE_URL = __ENV.INGEST_URL || 'http://localhost:3001';
const API_KEY  = __ENV.API_KEY    || 'test_key_replace_me';

const EVENT_TYPES = ['invoice.paid', 'user.created', 'subscription.cancelled', 'order.shipped', 'payment.failed'];

export default function () {
  const eventType  = EVENT_TYPES[Math.floor(Math.random() * EVENT_TYPES.length)];
  const idempotencyKey = `k6-${__VU}-${__ITER}`;

  const payload = JSON.stringify({
    event_type: eventType,
    idempotency_key: idempotencyKey,
    payload: {
      id: `item_${Math.floor(Math.random() * 1_000_000)}`,
      amount: Math.floor(Math.random() * 10000),
      currency: 'USD',
      timestamp: Date.now(),
    },
  });

  const start = Date.now();
  const res = http.post(`${BASE_URL}/v1/events`, payload, {
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    timeout: '5s',
  });

  const latency = Date.now() - start;
  ingestLatency.add(latency);

  const ok = check(res, {
    'status is 202': (r) => r.status === 202,
    'has event_id':  (r) => r.json('event_id') !== undefined,
  });

  if (ok) {
    ingestSuccess.add(1);
    ingestRate.add(true);
  } else {
    ingestErrors.add(1);
    ingestRate.add(false);
    console.error(`Failed: ${res.status} ${res.body}`);
  }

  sleep(Math.random() * 0.1); // 0-100ms think time
}

export function handleSummary(data) {
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
  };
}

function textSummary(data, opts) {
  return JSON.stringify(data.metrics, null, 2);
}
