import { describe, expect, it, vi } from 'vitest';
import { createCapturingLogger } from '@wallet/logger';
import { createReconciliationWorker } from './reconciliation-worker.js';
import type { ReconciliationReport } from '../services/reconciliation.service.js';

function report(residual: string): ReconciliationReport {
  return {
    runAt: new Date().toISOString(),
    healthy: residual === '0',
    addressesConsidered: 3,
    withdrawalsInFlight: 0,
    users: [],
    divergedUsers: 0,
    assets: [
      {
        asset: 'SOL',
        userLiabilities: '0',
        ledgerChainAssets: '0',
        observedChainAssets: residual,
        houseRent: '0',
        houseFees: '0',
        residual,
        addressesChecked: 3,
        explanation: 'test',
        unexplainedShortfall: false,
      },
    ],
  };
}

describe('scheduled reconciliation (rules 140, 144)', () => {
  it('does NOT alert on a single drifting cycle', async () => {
    // The normal steady state: a deposit landed but has not finalized.
    const logs = createCapturingLogger('trace');
    const worker = createReconciliationWorker({
      run: async () => report('500'),
      logger: logs.logger,
      consecutiveCyclesBeforeAlert: 3,
      intervalMs: 1000,
    });

    await worker.runOnce();
    expect(logs.text()).not.toContain('drift_persisted');
    expect(worker.streak('SOL')).toBe(1);
  });

  it('alerts once drift persists across the configured number of cycles', async () => {
    const logs = createCapturingLogger('trace');
    const worker = createReconciliationWorker({
      run: async () => report('500'),
      logger: logs.logger,
      consecutiveCyclesBeforeAlert: 3,
      intervalMs: 1000,
    });

    await worker.runOnce();
    await worker.runOnce();
    expect(logs.text()).not.toContain('drift_persisted');

    await worker.runOnce();
    expect(logs.text()).toContain('drift_persisted');
  });

  it('alerts exactly once, not on every cycle after the threshold', async () => {
    // An alert that repeats every cycle is a pager storm, and the second page
    // carries no information the first did not.
    const logs = createCapturingLogger('trace');
    const worker = createReconciliationWorker({
      run: async () => report('500'),
      logger: logs.logger,
      consecutiveCyclesBeforeAlert: 2,
      intervalMs: 1000,
    });

    for (let i = 0; i < 5; i += 1) await worker.runOnce();

    const alerts = logs
      .text()
      .split('\n')
      .filter((l) => l.includes('drift_persisted'));
    expect(alerts).toHaveLength(1);
  });

  it('resets the streak when the books come back into line', async () => {
    const logs = createCapturingLogger('trace');
    const results = ['500', '500', '0', '500'];
    let index = 0;
    const worker = createReconciliationWorker({
      run: async () => report(results[index++] ?? '0'),
      logger: logs.logger,
      consecutiveCyclesBeforeAlert: 3,
      intervalMs: 1000,
    });

    await worker.runOnce();
    await worker.runOnce();
    await worker.runOnce();
    expect(worker.streak('SOL')).toBe(0);

    await worker.runOnce();
    // Back to 1, not 3 — the earlier drift resolved and does not count.
    expect(worker.streak('SOL')).toBe(1);
    expect(logs.text()).not.toContain('drift_persisted');
  });

  it('never logs the residual amount', async () => {
    const logs = createCapturingLogger('trace');
    const worker = createReconciliationWorker({
      run: async () => report('123456789'),
      logger: logs.logger,
      consecutiveCyclesBeforeAlert: 1,
      intervalMs: 1000,
    });

    await worker.runOnce();
    expect(logs.text()).toContain('drift_persisted');
    // The amount belongs in the report, which a human reads deliberately.
    expect(logs.text()).not.toContain('123456789');
  });

  it('starts and stops idempotently', () => {
    const setTimer = vi.fn(() => ({ unref: vi.fn() })) as unknown as typeof setInterval;
    const clearTimer = vi.fn() as unknown as typeof clearInterval;
    const worker = createReconciliationWorker({
      run: async () => report('0'),
      logger: createCapturingLogger('trace').logger,
      consecutiveCyclesBeforeAlert: 3,
      intervalMs: 1000,
      setTimer,
      clearTimer,
    });

    worker.start();
    worker.start();
    expect(setTimer).toHaveBeenCalledTimes(1);

    worker.stop();
    worker.stop();
    expect(clearTimer).toHaveBeenCalledTimes(1);
  });
});
