import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Sign a webhook payload.
 *
 * Signature format (same as Stripe's):
 *   HMAC_SHA256(secret, `${timestamp}.${rawBody}`)
 *
 * Header sent to customer:
 *   X-Relay-Signature: t=<timestamp>,v1=<hex_signature>
 */
export function sign(secret: string, timestamp: number, rawBody: string): string {
  const signedPayload = `${timestamp}.${rawBody}`;
  const sig = createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

/**
 * Verify an incoming X-Relay-Signature header.
 *
 * @param secret        - The endpoint's signing secret
 * @param header        - The full "t=...,v1=..." header value
 * @param rawBody       - The raw request body string
 * @param toleranceSec  - Max age of the timestamp in seconds (default: 300)
 */
export function verify(
  secret: string,
  header: string,
  rawBody: string,
  toleranceSec: number = 300
): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const timestamp = parseInt(parts['t'] ?? '', 10);
  const signature = parts['v1'];

  if (!timestamp || !signature) return false;

  // Reject old signatures (replay attack prevention)
  const age = Math.floor(Date.now() / 1000) - timestamp;
  if (age > toleranceSec) return false;

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  // Use timingSafeEqual to prevent timing attacks
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
}

/**
 * Build the full set of headers to send with each webhook delivery.
 */
export function buildWebhookHeaders(
  deliveryId: string,
  secret: string,
  rawBody: string
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    'Content-Type': 'application/json',
    'X-Relay-Signature': sign(secret, timestamp, rawBody),
    'X-Relay-Delivery-Id': deliveryId,
    'X-Relay-Timestamp': String(timestamp),
  };
}
