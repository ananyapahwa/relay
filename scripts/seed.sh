#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Relay — Seed Script
# Creates a test tenant + endpoint + sends a first test event
#
# Usage: ./scripts/seed.sh [TARGET_WEBHOOK_URL]
# Example: ./scripts/seed.sh https://webhook.site/your-uuid
# ─────────────────────────────────────────────────────────────────────────────

set -e

INGEST_URL="${INGEST_URL:-http://localhost:3001}"
DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:3002}"
TARGET_URL="${1:-https://webhook.site/00000000-replace-with-yours}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[seed]${NC} $1"; }
info() { echo -e "${CYAN}[seed]${NC} $1"; }

# Generate a random API key + its SHA-256 hash
API_KEY="relay_sk_$(openssl rand -hex 20)"
API_KEY_HASH=$(echo -n "$API_KEY" | openssl dgst -sha256 | awk '{print $2}')

log "Creating test tenant..."

# Run SQL inside the postgres container — no local psql needed
docker compose exec -T postgres psql -U relay -d relay -c \
  "INSERT INTO tenants (name, api_key_hash) VALUES ('Test Tenant', '$API_KEY_HASH') ON CONFLICT DO NOTHING;" \
  > /dev/null

echo ""
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  API Key: ${YELLOW}${API_KEY}${NC}"
log "  Save this — it is never stored in plaintext."
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Wait briefly for ingest-api to be ready
log "Waiting for ingest-api to be ready..."
for i in $(seq 1 20); do
  if curl -sf "$INGEST_URL/health" > /dev/null 2>&1; then
    break
  fi
  sleep 1
  if [ "$i" -eq 20 ]; then
    echo "ERROR: ingest-api not reachable at $INGEST_URL after 20s"
    exit 1
  fi
done

# Register a destination endpoint
log "Registering test endpoint: $TARGET_URL"
ENDPOINT_RESP=$(curl -s -X POST "$INGEST_URL/v1/endpoints" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"$TARGET_URL\",
    \"secret\": \"whsec_test_secret_abcdefgh12345678\",
    \"description\": \"Test endpoint (seed)\"
  }")

echo "$ENDPOINT_RESP"
ENDPOINT_ID=$(echo "$ENDPOINT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id','?'))" 2>/dev/null || echo "?")
log "Endpoint ID: $ENDPOINT_ID"
echo ""

# Send a test event
log "Sending test event..."
EVENT_RESP=$(curl -s -X POST "$INGEST_URL/v1/events" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "test.hello_world",
    "payload": {"message": "Hello from Relay! 🚀"},
    "idempotency_key": "seed-001"
  }')
echo "$EVENT_RESP"
echo ""

log "✅ Done! Open the dashboard at: $DASHBOARD_URL"
info "   API Key for login: $API_KEY"
info "   Target URL: $TARGET_URL"
info "   Tip: sign up at https://webhook.site to get a free test URL"
