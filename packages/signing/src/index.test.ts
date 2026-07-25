import { describe, it, expect, vi } from 'vitest';
import { sign, verify, buildWebhookHeaders } from './index.js';

describe('signing', () => {
  const secret = 'whsec_test_secret';
  const rawBody = JSON.stringify({ event: 'test.event' });

  it('should sign and verify successfully', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const header = sign(secret, timestamp, rawBody);
    
    expect(verify(secret, header, rawBody)).toBe(true);
  });

  it('should fail verification for incorrect body', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const header = sign(secret, timestamp, rawBody);
    
    expect(verify(secret, header, 'wrong_body')).toBe(false);
  });

  it('should fail verification for incorrect secret', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const header = sign('wrong_secret', timestamp, rawBody);
    
    expect(verify(secret, header, rawBody)).toBe(false);
  });

  it('should fail verification if signature is too old', () => {
    // 6 minutes ago (tolerance is 5 mins)
    const oldTimestamp = Math.floor(Date.now() / 1000) - 360; 
    const header = sign(secret, oldTimestamp, rawBody);
    
    expect(verify(secret, header, rawBody)).toBe(false);
  });

  it('should build proper headers', () => {
    const headers = buildWebhookHeaders('test_id', secret, rawBody);
    
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Relay-Delivery-Id']).toBe('test_id');
    expect(headers['X-Relay-Timestamp']).toBeDefined();
    
    const isValid = verify(secret, headers['X-Relay-Signature'], rawBody);
    expect(isValid).toBe(true);
  });
});
