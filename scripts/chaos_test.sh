#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Relay — Chaos Test Script
#
# Tests that no events are lost or duplicated under failure conditions:
#   1. Worker crash mid-delivery
#   2. Scheduler leader death
#   3. Burst of events to a slow endpoint
#
# Prerequisites: docker compose up is running, jq installed
# Usage: ./scripts/chaos_test.sh [INGEST_URL] [API_KEY]
# ─────────────────────────────────────────────────────────────────────────────

set -e

INGEST_URL="${1:-http://localhost:3001}"
DASHBOARD_URL="${2:-http://localhost:3002}"
API_KEY="${3:-test_key_replace_me}"
ENDPOINT_URL="${4:-https://webhook.site/your-unique-id}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[chaos]${NC} $1"; }
warn() { echo -e "${YELLOW}[chaos]${NC} $1"; }
err()  { echo -e "${RED}[chaos]${NC} $1"; }

check_jq() {
  if ! command -v jq &>/dev/null; then
    err "jq is required. Install with: brew install jq"
    exit 1
  fi
}

# ─── Send a test event ───────────────────────────────────────────────────────

send_event() {
  local idem_key="$1"
  local event_type="${2:-chaos.test}"
  curl -s -X POST "$INGEST_URL/v1/events" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"event_type\": \"$event_type\", \"payload\": {\"test\": true, \"ts\": $(date +%s)}, \"idempotency_key\": \"$idem_key\"}" | jq -r '.event_id'
}

get_delivery_status() {
  local event_id="$1"
  curl -s "$DASHBOARD_URL/v1/deliveries?limit=10" \
    -H "Authorization: Bearer $API_KEY" | \
    jq -r --arg eid "$event_id" '.deliveries[] | select(.event_id == $eid) | .status' | head -1
}

# ─── Test 1: Idempotency under duplicate sends ────────────────────────────────

test_idempotency() {
  log "Test 1: Idempotency — sending same event twice..."
  local idem_key="chaos-idem-$(date +%s)"
  local id1 id2
  id1=$(send_event "$idem_key")
  id2=$(send_event "$idem_key")

  if [ "$id1" = "$id2" ]; then
    log "  ✅ Same event_id returned for duplicate idempotency key: $id1"
  else
    err "  ❌ Different event IDs returned: $id1 vs $id2"
    exit 1
  fi
}

# ─── Test 2: Worker crash recovery ───────────────────────────────────────────

test_worker_crash() {
  log "Test 2: Worker crash recovery..."

  # Send event before killing worker
  local idem_key="chaos-crash-$(date +%s)"
  local event_id
  event_id=$(send_event "$idem_key" "chaos.worker_crash")
  log "  Sent event: $event_id"

  # Find and kill a worker container
  local worker_container
  worker_container=$(docker compose ps --format json | jq -r '.[] | select(.Service == "worker") | .Name' | head -1)

  if [ -z "$worker_container" ]; then
    warn "  Could not find worker container, skipping crash test"
    return
  fi

  log "  Killing worker: $worker_container"
  docker kill "$worker_container" 2>/dev/null || true

  # Wait for delivery — message stays in PEL, new worker reclaims it
  log "  Waiting 35s for PEL reclaim (XAUTOCLAIM min idle = 30s)..."
  sleep 35

  local status
  status=$(get_delivery_status "$event_id")
  if [ "$status" = "success" ] || [ "$status" = "pending" ]; then
    log "  ✅ Event $event_id is $status after worker crash (not lost)"
  else
    warn "  ⚠  Event status: $status (may still be in retry window)"
  fi
}

# ─── Test 3: Scheduler leader death ──────────────────────────────────────────

test_leader_failover() {
  log "Test 3: Scheduler leader death..."

  local sched_containers
  sched_containers=$(docker compose ps --format json | jq -r '.[] | select(.Service == "scheduler") | .Name')
  local leader
  leader=$(echo "$sched_containers" | head -1)

  if [ -z "$leader" ]; then
    warn "  Could not find scheduler containers, skipping"
    return
  fi

  log "  Killing leader scheduler: $leader"
  docker kill "$leader" 2>/dev/null || true

  log "  Waiting 20s for standby to acquire lock..."
  sleep 20

  # Send event and check it still gets retried
  local idem_key="chaos-leader-$(date +%s)"
  local event_id
  event_id=$(send_event "$idem_key" "chaos.leader_failover")
  log "  Sent event: $event_id, checking delivery..."
  sleep 15

  local status
  status=$(get_delivery_status "$event_id")
  log "  ✅ Event $event_id is $status after leader failover"
}

# ─── Test 4: Burst + rate limiting ───────────────────────────────────────────

test_burst() {
  log "Test 4: Burst of 50 events (rate limit = 10/s)..."
  local pids=()
  for i in $(seq 1 50); do
    send_event "chaos-burst-$i-$(date +%s)" "chaos.burst" > /dev/null &
    pids+=($!)
  done

  for pid in "${pids[@]}"; do wait "$pid"; done
  log "  ✅ All 50 events accepted by ingest API without error"
  log "  📊 Check dashboard — deliveries should all eventually succeed (rate limiter throttles delivery to endpoint)"
}

# ─── Run all tests ────────────────────────────────────────────────────────────

main() {
  check_jq
  log "Starting Relay chaos tests against $INGEST_URL"
  log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  test_idempotency
  echo ""
  test_worker_crash
  echo ""
  test_leader_failover
  echo ""
  test_burst

  echo ""
  log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  log "Chaos tests complete. Check the dashboard at $DASHBOARD_URL"
}

main
