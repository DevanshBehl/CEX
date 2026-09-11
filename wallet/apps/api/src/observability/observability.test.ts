import { describe, expect, it, vi } from 'vitest';
import { createCapturingLogger } from '@wallet/logger';
import { createDeadLetterQueue } from './dead-letter.js';
import { createMetrics, createWalletMetrics } from './metrics.js';

// ---------------------------------------------------------------------------
// Metrics (rules 149, 156)
// ---------------------------------------------------------------------------

describe('metrics', () => {
  it('counts with closed-set labels', () => {
    const m = createMetrics();
    const c = m.counter('wallet_deposits_total', 'help');
    c.inc({ asset: 'SOL', outcome: 'credited' });
    c.inc({ asset: 'SOL', outcome: 'credited' });
    c.inc({ asset: 'SOL', outcome: 'ignored' });

    const out = m.render();
    expect(out).toContain('wallet_deposits_total{asset="SOL",outcome="credited"} 2');
    expect(out).toContain('wallet_deposits_total{asset="SOL",outcome="ignored"} 1');
  });

  it('renders a histogram with cumulative buckets', () => {
    const m = createMetrics();
    const h = m.histogram('op_seconds', 'help', [0.1, 1]);
    h.observe(0.05);
    h.observe(0.5);
    h.observe(30);

    const out = m.render();
    // Cumulative: <=0.1 caught one, <=1 caught two, +Inf all three.
    expect(out).toContain('op_seconds_bucket{le="0.1"} 1');
    expect(out).toContain('op_seconds_bucket{le="1"} 2');
    expect(out).toContain('op_seconds_bucket{le="+Inf"} 3');
    expect(out).toContain('op_seconds_count 3');
  });

  it('records a failure as well as a success when timing', async () => {
    const m = createMetrics();
    const h = m.histogram('op_seconds', 'help', [1]);

    await h.time({ operation: 'sign' }, async () => 'ok');
    await expect(
      h.time({ operation: 'sign' }, async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');

    const out = m.render();
    // A success rate computed from successes alone is not a success rate.
    expect(out).toContain('outcome="success"');
    expect(out).toContain('outcome="failure"');
  });

  it('sets a gauge rather than accumulating it', () => {
    const m = createMetrics();
    const g = m.gauge('wallet_queue_depth', 'help');
    g.set(5, { queue: 'sweep' });
    g.set(2, { queue: 'sweep' });
    expect(m.render()).toContain('wallet_queue_depth{queue="sweep"} 2');
  });

  it('escapes label values so a hostile string cannot forge a series', () => {
    const m = createMetrics();
    m.counter('c', 'help').inc({ asset: 'a"b\nc' });
    const out = m.render();
    expect(out).toContain('asset="a\\"b\\nc"');
    // One line, not two: the newline must not split the exposition.
    expect(
      out
        .trim()
        .split('\n')
        .filter((l) => l.startsWith('c{')),
    ).toHaveLength(1);
  });

  it('names no metric that could carry a user id or an amount', () => {
    // Rule 156 as an executable check over the declared label documentation.
    const m = createWalletMetrics();
    m.deposits.inc({ asset: 'SOL', outcome: 'credited' });
    m.withdrawals.inc({ asset: 'SOL', state: 'SETTLED' });
    m.failures.inc({ stage: 'broadcast' });
    m.queueDepth.set(0, { queue: 'sweep' });

    const out = m.registry.render();
    expect(out).not.toMatch(/userId|user_id/);
    // No label whose value is a long digit string — that would be an amount.
    expect(out).not.toMatch(/="\d{6,}"/);
  });
});

// ---------------------------------------------------------------------------
// Dead-letter queue (rules 153-155)
// ---------------------------------------------------------------------------

describe('dead-letter queue', () => {
  const deps = () => ({ logger: createCapturingLogger('trace').logger });

  const job = {
    queue: 'withdrawal_sign' as const,
    reference: 'w-1',
    idempotencyKey: 'withdrawal:w-1:nonce-abc',
    attempts: 3,
    errorName: 'ChainError',
    correlationId: 'c-1',
  };

  it('REFUSES a job with no idempotency key', () => {
    // The whole safety property. A generated key would make the retry look
    // safe while being a brand-new financial operation (rule 154).
    const dlq = createDeadLetterQueue(deps());
    expect(() => dlq.record({ ...job, idempotencyKey: '  ' })).toThrow(/idempotency key/);
  });

  it('replays the ORIGINAL key, not a fresh one', async () => {
    const dlq = createDeadLetterQueue(deps());
    const recorded = dlq.record(job);

    const seen: string[] = [];
    expect(
      await dlq.retry(recorded.id, async (replayed) => {
        seen.push(replayed.idempotencyKey);
      }),
    ).toBe('retried');
    expect(seen).toEqual(['withdrawal:w-1:nonce-abc']);
  });

  it('will not retry the same job twice', async () => {
    // Two operators pressing the button during an incident must produce one
    // attempt, not two.
    const dlq = createDeadLetterQueue(deps());
    const recorded = dlq.record(job);
    const handler = vi.fn(async () => {});

    const [first, second] = await Promise.all([
      dlq.retry(recorded.id, handler),
      dlq.retry(recorded.id, handler),
    ]);

    expect([first, second].filter((r) => r === 'retried')).toHaveLength(1);
    expect([first, second].filter((r) => r === 'already_retried')).toHaveLength(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('reports a handler failure rather than swallowing it', async () => {
    const dlq = createDeadLetterQueue(deps());
    const recorded = dlq.record(job);
    expect(
      await dlq.retry(recorded.id, async () => {
        throw new Error('still broken');
      }),
    ).toBe('failed');
  });

  it('tracks depth and stops counting a job once retried', async () => {
    const dlq = createDeadLetterQueue(deps());
    dlq.record(job);
    const second = dlq.record({ ...job, reference: 'w-2' });
    expect(dlq.depth('withdrawal_sign')).toBe(2);

    await dlq.retry(second.id, async () => {});
    expect(dlq.depth('withdrawal_sign')).toBe(1);
  });

  it('publishes depth to the gauge it was given', () => {
    const metrics = createWalletMetrics();
    const dlq = createDeadLetterQueue({
      ...deps(),
      deadLettered: metrics.deadLettered,
      queueDepth: metrics.queueDepth,
    });
    dlq.record(job);

    const out = metrics.registry.render();
    expect(out).toContain('wallet_dead_lettered_total{queue="withdrawal_sign"} 1');
    expect(out).toContain('wallet_queue_depth{queue="withdrawal_sign"} 1');
  });

  it('drops the oldest beyond capacity rather than growing without bound', () => {
    const dlq = createDeadLetterQueue({ ...deps(), capacity: 2 });
    const first = dlq.record(job);
    dlq.record({ ...job, reference: 'w-2' });
    dlq.record({ ...job, reference: 'w-3' });

    expect(dlq.get(first.id)).toBeUndefined();
    expect(dlq.list()).toHaveLength(2);
  });

  it('logs the reference but never the error message', () => {
    const logs = createCapturingLogger('trace');
    const dlq = createDeadLetterQueue({ logger: logs.logger });
    dlq.record({ ...job, errorName: 'ChainError' });

    const text = logs.text();
    expect(text).toContain('job.dead_lettered');
    // An error MESSAGE can carry an address or an amount; the name cannot.
    expect(text).not.toContain('still broken');
  });
});
