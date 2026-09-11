/**
 * The dead-letter queue (master-prompt rules 173-174, prompt_phase4.md
 * rules 153-155).
 *
 * WHAT A DLQ IS FOR HERE
 *
 * A background job that fails its retry budget must not vanish. Phase 3 already
 * refuses to retry forever — `WITHDRAWAL_SIGN_MAX_ATTEMPTS` and friends exist
 * so a poisoned job cannot spin — but "gave up" and "nobody knows" are
 * different outcomes, and only the first is acceptable for a financial
 * operation.
 *
 * THE RULE THAT CONSTRAINS RETRY
 *
 * Master-prompt rule 174: never silently retry a financial operation without
 * idempotency. So a job may only enter this queue WITH an idempotency key, and
 * the retry surface replays that exact key. A DLQ whose retry button creates a
 * second withdrawal is worse than no DLQ, because an operator will press it
 * during an incident and the incident will get bigger.
 *
 * The key is not generated here. It is the one the original operation used —
 * `withdrawal:{id}:{nonce}` for signing, for instance — so a replay collides
 * with the original in the service that enforces idempotency, rather than
 * relying on this module to be careful.
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from '@wallet/logger';
import { logSecurityEvent } from '@wallet/logger';
import type { Counter, Gauge } from './metrics.js';

export type JobQueue = 'withdrawal_sign' | 'withdrawal_broadcast' | 'withdrawal_expiry' | 'sweep';

export interface DeadLetter {
  readonly id: string;
  readonly queue: JobQueue;
  /** The reference the job was about — a withdrawal id, a sweep id. */
  readonly reference: string;
  /**
   * The idempotency key the original attempt used. Required, because a retry
   * without one is a duplicate financial operation waiting to happen.
   */
  readonly idempotencyKey: string;
  readonly attempts: number;
  readonly failedAt: Date;
  /** Error NAME only. A message can carry values the log allowlist excludes. */
  readonly errorName: string;
  /**
   * Kept on the record but NOT passed to `logSecurityEvent`: the logger binds
   * correlation ids on a child logger, and `SecurityEventFields` is a closed
   * allowlist that deliberately does not accept arbitrary extras.
   */
  readonly correlationId: string;
  retriedAt?: Date;
}

export interface DeadLetterQueue {
  /** Record a job that exhausted its budget. */
  record(input: Omit<DeadLetter, 'id' | 'failedAt'>): DeadLetter;
  list(queue?: JobQueue): readonly DeadLetter[];
  get(id: string): DeadLetter | undefined;
  /**
   * Hand a job back to its handler, replaying the ORIGINAL idempotency key.
   *
   * Returns `retried` when the handler ran, `not_found` when the id is unknown,
   * and `already_retried` when someone has pressed it before — an operator
   * clicking twice during an incident must not produce two attempts.
   */
  retry(
    id: string,
    handler: (job: DeadLetter) => Promise<void>,
  ): Promise<'retried' | 'not_found' | 'already_retried' | 'failed'>;
  depth(queue: JobQueue): number;
}

export interface DeadLetterDeps {
  readonly logger: Logger;
  readonly deadLettered?: Counter;
  readonly queueDepth?: Gauge;
  /** Bound so a failing worker cannot exhaust memory. Oldest are dropped. */
  readonly capacity?: number;
}

const DEFAULT_CAPACITY = 1000;

/**
 * In-memory, deliberately.
 *
 * A durable DLQ belongs in PostgreSQL alongside the rest of the operational
 * record, and this interface is shaped so that swap is a repository change
 * rather than a redesign. What must NOT happen is a half-durable version whose
 * retry semantics differ from the real one — so this is honestly ephemeral,
 * and the runbook says a restart loses the queue while the underlying
 * withdrawal rows survive in their terminal state, which is where recovery
 * actually starts.
 */
export function createDeadLetterQueue(deps: DeadLetterDeps): DeadLetterQueue {
  const capacity = deps.capacity ?? DEFAULT_CAPACITY;
  const jobs = new Map<string, DeadLetter>();

  const depthOf = (queue: JobQueue): number =>
    [...jobs.values()].filter((j) => j.queue === queue && j.retriedAt === undefined).length;

  const publishDepth = (queue: JobQueue): void => {
    deps.queueDepth?.set(depthOf(queue), { queue });
  };

  return {
    record(input) {
      if (input.idempotencyKey.trim() === '') {
        // Refused rather than defaulted. A generated key would make the retry
        // look safe while being a fresh operation (rule 154).
        throw new Error('a dead-lettered job must carry the idempotency key it used');
      }

      const job: DeadLetter = { ...input, id: randomUUID(), failedAt: new Date() };
      jobs.set(job.id, job);

      // Oldest first, so a flood of new failures does not hide the original.
      if (jobs.size > capacity) {
        const oldest = jobs.keys().next().value;
        if (oldest !== undefined) jobs.delete(oldest);
      }

      deps.deadLettered?.inc({ queue: job.queue });
      publishDepth(job.queue);

      logSecurityEvent(deps.logger, 'job.dead_lettered', {
        outcome: 'failure',
        targetType: 'job',
        targetId: job.reference,
      });

      return job;
    },

    list(queue) {
      const all = [...jobs.values()];
      return queue === undefined ? all : all.filter((j) => j.queue === queue);
    },

    get(id) {
      return jobs.get(id);
    },

    async retry(id, handler) {
      const job = jobs.get(id);
      if (!job) return 'not_found';
      if (job.retriedAt !== undefined) return 'already_retried';

      // Marked BEFORE the handler runs. If it were marked after, two operators
      // pressing retry at the same moment would both see an unretried job.
      job.retriedAt = new Date();
      publishDepth(job.queue);

      try {
        await handler(job);
        logSecurityEvent(deps.logger, 'job.retried', {
          outcome: 'success',
          targetType: 'job',
          targetId: job.reference,
        });
        return 'retried';
      } catch {
        logSecurityEvent(deps.logger, 'job.retry_failed', {
          outcome: 'failure',
          targetType: 'job',
          targetId: job.reference,
        });
        return 'failed';
      }
    },

    depth: depthOf,
  };
}
