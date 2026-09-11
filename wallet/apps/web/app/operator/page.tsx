'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReviewItem } from '@wallet/types';
import { api, ApiError } from '@/lib/api';
import { WithdrawalStatusBadge } from '@/features/withdrawal/status-badge';
import { formatAmount, shortenAddress } from '@/lib/format';
import { useStepUpAction } from '@/features/security/use-step-up';
import { Button, Card, EmptyState, ErrorNotice, Field, Input, Spinner } from '@/components/ui';

/**
 * The operator review queue (prompt_phase3.md rules 160-162).
 *
 * Deliberately minimal: a list, approve, deny, and a required note. It is not a
 * general admin console (rule 54), and Phase 3 has no role model — access is
 * configuration plus a step-up, and a real one is Phase 4 (ADR-0011).
 */
export default function OperatorPage() {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const stepUp = useStepUpAction();

  const refresh = useCallback(async () => {
    try {
      const { items: queue } = await api.reviewQueue();
      setItems(queue);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        setForbidden(true);
        return;
      }
      setError(e instanceof Error ? e.message : 'Could not load the review queue.');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (forbidden) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <p className="text-sm text-muted">Not found.</p>
      </div>
    );
  }

  async function decide(id: string, approve: boolean) {
    const note = (notes[id] ?? '').trim();
    if (note.length < 3) {
      setError('A note is required — a decision without a stated reason is not auditable.');
      return;
    }
    const ok = await stepUp.run(() =>
      approve ? api.approveWithdrawal(id, note) : api.rejectWithdrawal(id, note),
    );
    if (ok) await refresh();
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Review queue</h1>
        <p className="mt-1 text-sm text-muted">Withdrawals the risk engine referred to a person.</p>
      </div>

      {error !== null && <ErrorNotice message={error} />}
      {stepUp.error !== null && (
        <ErrorNotice message={stepUp.error.message} correlationId={stepUp.error.correlationId} />
      )}

      {items === null ? (
        <Spinner label="Loading the queue…" />
      ) : items.length === 0 ? (
        <EmptyState title="Nothing to review" body="Referred withdrawals appear here." />
      ) : (
        items.map((item) => (
          <Card key={item.withdrawal.id}>
            <div className="flex items-baseline justify-between gap-4">
              <span className="font-mono text-sm tabular-nums">
                {formatAmount(item.withdrawal.amount, item.withdrawal.decimals)}{' '}
                {item.withdrawal.asset}
              </span>
              <WithdrawalStatusBadge status={item.withdrawal.status} />
            </div>

            <dl className="mt-3 space-y-1 text-xs text-muted">
              <div>
                To{' '}
                <span className="font-mono">{shortenAddress(item.withdrawal.destination, 10)}</span>
              </div>
              <div>
                User <span className="font-mono">{shortenAddress(item.userId, 8)}</span>
              </div>
              <div>Requested {new Date(item.withdrawal.createdAt).toLocaleString()}</div>
            </dl>

            {/*
              The FULL reason codes. An operator resolving a review needs to see
              what the engine saw rather than re-derive it (rule 79) — this is
              the one surface where the codes are shown.
            */}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {item.riskCodes.map((code) => (
                <span
                  key={code}
                  className="rounded bg-line/50 px-2 py-0.5 font-mono text-xs text-muted"
                >
                  {code}
                </span>
              ))}
            </div>

            <div className="mt-4 space-y-3">
              <Field label="Decision note" hint="Recorded against the withdrawal, permanently.">
                <Input
                  value={notes[item.withdrawal.id] ?? ''}
                  onChange={(e) =>
                    setNotes((prior) => ({ ...prior, [item.withdrawal.id]: e.target.value }))
                  }
                  placeholder="Why you are approving or declining"
                />
              </Field>

              <div className="flex gap-3">
                <Button
                  disabled={stepUp.busy}
                  onClick={() => void decide(item.withdrawal.id, true)}
                >
                  Approve
                </Button>
                <Button
                  variant="danger"
                  disabled={stepUp.busy}
                  onClick={() => void decide(item.withdrawal.id, false)}
                >
                  Decline
                </Button>
              </div>
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
