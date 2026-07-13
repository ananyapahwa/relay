import { Redis } from 'ioredis';
import type { Queue, DeliveryJob, JobHandler } from './types.js';

const STREAM_KEY = 'relay:deliveries';
const CONSUMER_GROUP = 'relay-workers';
const CONSUMER_NAME = `worker-${process.pid}`;
const BLOCK_MS = 5000;
const BATCH_SIZE = 10;

/**
 * Redis Streams Queue implementation.
 *
 * - Partitioning: we use a single stream with endpoint_id in the payload.
 *   For true isolation, you could use one stream per endpoint_id.
 * - Consumer groups: each worker in the pool belongs to CONSUMER_GROUP.
 *   Redis assigns each message to exactly one consumer.
 * - XACK: sent only after successful handler return → at-least-once guarantee.
 */
export class RedisStreamQueue implements Queue {
  private publisher: Redis;
  private consumer: Redis;
  private running = false;

  constructor(redisUrl: string) {
    this.publisher = new Redis(redisUrl, { lazyConnect: true });
    this.consumer = new Redis(redisUrl, { lazyConnect: true });
  }

  async connect() {
    await this.publisher.connect();
    await this.consumer.connect();

    // Create consumer group (idempotent)
    try {
      await this.consumer.xgroup('CREATE', STREAM_KEY, CONSUMER_GROUP, '$', 'MKSTREAM');
    } catch (err: unknown) {
      // Group already exists — expected on restart
      if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) {
        throw err;
      }
    }
  }

  async publish(job: DeliveryJob): Promise<void> {
    await this.publisher.xadd(
      STREAM_KEY,
      '*',              // auto-generate message ID
      'delivery_id', job.delivery_id,
      'event_id', job.event_id,
      'endpoint_id', job.endpoint_id,
      'tenant_id', job.tenant_id,
    );
  }

  async startConsuming(handler: JobHandler): Promise<void> {
    this.running = true;

    // First, re-claim any pending messages from crashed workers (PEL)
    await this.reclaimPending(handler);

    // Main consume loop
    while (this.running) {
      try {
        const results = await this.consumer.xreadgroup(
          'GROUP', CONSUMER_GROUP, CONSUMER_NAME,
          'COUNT', BATCH_SIZE,
          'BLOCK', BLOCK_MS,
          'STREAMS', STREAM_KEY, '>'
        ) as Array<[string, Array<[string, string[]]>]> | null;

        if (!results) continue; // Timeout — loop again

        for (const [, messages] of results) {
          for (const [msgId, fields] of messages) {
            const job = parseFields(fields);
            try {
              await handler(job);
              await this.consumer.xack(STREAM_KEY, CONSUMER_GROUP, msgId);
            } catch (err) {
              console.error(`[queue] Handler failed for ${job.delivery_id}, message stays in PEL:`, err);
              // Don't ACK — message stays in PEL, will be re-claimed on restart
            }
          }
        }
      } catch (err) {
        if (this.running) {
          console.error('[queue] Consumer error, retrying in 2s:', err);
          await sleep(2000);
        }
      }
    }
  }

  /**
   * Reclaim messages that have been pending >30s (worker probably crashed).
   */
  private async reclaimPending(handler: JobHandler): Promise<void> {
    const MIN_IDLE_MS = 30_000;
    try {
      const pending = await this.consumer.xautoclaim(
        STREAM_KEY, CONSUMER_GROUP, CONSUMER_NAME,
        MIN_IDLE_MS, '0-0', 'COUNT', 50
      ) as [string, Array<[string, string[]]>];

      const [, messages] = pending;
      for (const [msgId, fields] of messages) {
        if (!fields || fields.length === 0) continue;
        const job = parseFields(fields);
        try {
          await handler(job);
          await this.consumer.xack(STREAM_KEY, CONSUMER_GROUP, msgId);
        } catch {
          // Will be reclaimed again next restart
        }
      }
    } catch {
      // XAUTOCLAIM not available on older Redis, skip gracefully
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.publisher.quit();
    await this.consumer.quit();
  }
}

function parseFields(fields: string[]): DeliveryJob {
  const map: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    map[fields[i]!] = fields[i + 1]!;
  }
  return {
    delivery_id: map['delivery_id']!,
    event_id: map['event_id']!,
    endpoint_id: map['endpoint_id']!,
    tenant_id: map['tenant_id']!,
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
