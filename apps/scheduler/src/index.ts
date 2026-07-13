import { Redis } from 'ioredis';
import { sql, deliveryRepo } from '@relay/db';
import { RedisStreamQueue } from '@relay/queue';

// ─── Config ────────────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const SWEEP_INTERVAL_MS = parseInt(process.env.SWEEP_INTERVAL_MS ?? '5000', 10);
const SWEEP_BATCH_SIZE = parseInt(process.env.SWEEP_BATCH_SIZE ?? '500', 10);

// Leader election constants
const LOCK_KEY = 'relay:scheduler:leader';
const LOCK_TTL_MS = 15_000;       // 15s TTL
const HEARTBEAT_MS = 5_000;       // renew every 5s
const LOCK_VALUE = `scheduler-${process.pid}-${Date.now()}`;

// ─── Setup ────────────────────────────────────────────────────────────────────

const redis = new Redis(REDIS_URL);
const queue = new RedisStreamQueue(REDIS_URL);
let isLeader = false;
let running = true;

// ─── Leader Election ─────────────────────────────────────────────────────────

/**
 * Try to acquire the leader lock using SET NX PX (atomic).
 * Returns true if we are now the leader.
 */
async function tryAcquireLock(): Promise<boolean> {
  const result = await redis.set(LOCK_KEY, LOCK_VALUE, 'PX', LOCK_TTL_MS, 'NX');
  return result === 'OK';
}

/**
 * Renew the lock if we still hold it (compare value before extending).
 */
async function renewLock(): Promise<boolean> {
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      redis.call('PEXPIRE', KEYS[1], ARGV[2])
      return 1
    else
      return 0
    end
  `;
  const result = await redis.eval(script, 1, LOCK_KEY, LOCK_VALUE, LOCK_TTL_MS);
  return result === 1;
}

// ─── Retry Sweep ─────────────────────────────────────────────────────────────

async function sweep() {
  const due = await deliveryRepo.findDuePending(SWEEP_BATCH_SIZE);

  if (due.length > 0) {
    console.log(`[scheduler] Sweeping ${due.length} due deliveries`);
    await Promise.all(
      due.map((d) =>
        queue.publish({
          delivery_id: d.id,
          event_id: d.event_id,
          endpoint_id: d.endpoint_id,
          tenant_id: d.tenant_id,
        })
      )
    );
  }
}

// ─── Heartbeat loop ──────────────────────────────────────────────────────────

async function heartbeatLoop() {
  while (running) {
    await sleep(HEARTBEAT_MS);
    if (isLeader) {
      const renewed = await renewLock();
      if (!renewed) {
        console.warn('[scheduler] Lost leader lock — stepping down');
        isLeader = false;
      }
    } else {
      const acquired = await tryAcquireLock();
      if (acquired) {
        console.log('[scheduler] Acquired leader lock');
        isLeader = true;
      }
    }
  }
}

// ─── Sweep loop ───────────────────────────────────────────────────────────────

async function sweepLoop() {
  while (running) {
    if (isLeader) {
      try {
        await sweep();
      } catch (err) {
        console.error('[scheduler] Sweep error:', err);
      }
    }
    await sleep(SWEEP_INTERVAL_MS);
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function start() {
  await queue.connect();

  // Try to become leader immediately
  isLeader = await tryAcquireLock();
  console.log(`[scheduler] Started — leader: ${isLeader}`);

  // Run both loops concurrently
  await Promise.all([heartbeatLoop(), sweepLoop()]);
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

start().catch((err) => {
  console.error('❌ Scheduler failed:', err);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  running = false;
  // Release lock if we hold it
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      redis.call('DEL', KEYS[1])
    end
  `;
  await redis.eval(script, 1, LOCK_KEY, LOCK_VALUE);
  await queue.stop();
  await redis.quit();
  await sql.end();
  process.exit(0);
});
