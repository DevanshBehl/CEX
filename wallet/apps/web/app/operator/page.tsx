'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReviewItem } from '@wallet/types';
import { api, ApiError } from '@/lib/api';
import { WithdrawalStatusBadge } from '@/features/withdrawal/status-badge';
import { formatAmount, shortenAddress } from '@/lib/format';
import { useStepUpAction } from '@/features/security/use-step-up';
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  PageHeader,
  Spinner,
} from '@/components/ui';

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
  const [needsStepUp, setNeedsStepUp] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const stepUp = useStepUpAction();

  const load = useCallback(async () => {
    const { items: queue } = await api.reviewQueue();
    setItems(queue);
    setError(null);
    setNeedsStepUp(false);
  }, []);

  const refresh = useCallback(async () => {
    try {
      await load();
    } catch (e) {
      /*
       * STEP_UP_REQUIRED is a 403 too, and it is NOT "you are not an operator".
       * Treating it as forbidden rendered "Not found." to a genuine approver
       * whose passkey assertion had simply aged out. The queue is shown behind
       * an explicit confirm button rather than an automatic prompt: browsers
       * may refuse a WebAuthn ceremony that no user gesture started.
       */
      if (e instanceof ApiError && e.needsStepUp) {
        setNeedsStepUp(true);
        return;
      }
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        setForbidden(true);
        return;
      }
      setError(e instanceof Error ? e.message : 'Could not load the review queue.');
    }
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (forbidden) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <p className="text-sm text-ink-muted">Not found.</p>
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
    <div className="max-w-3xl animate-fade-up space-y-3">
      <PageHeader
        title="Review queue"
        description="Withdrawals the risk engine referred to a person."
      />

      {error !== null && <ErrorNotice message={error} />}
      {stepUp.error !== null && (
        <ErrorNotice message={stepUp.error.message} correlationId={stepUp.error.correlationId} />
      )}

      {needsStepUp ? (
        <Card>
          <p className="text-sm text-ink-muted">
            The review queue needs a fresh passkey confirmation.
          </p>
          <div className="mt-4">
            <Button disabled={stepUp.busy} onClick={() => void stepUp.run(load)}>
              Confirm with passkey
            </Button>
          </div>
        </Card>
      ) : items === null ? (
        <Spinner label="Loading the queue…" />
      ) : items.length === 0 ? (
        <EmptyState title="Nothing to review" body="Referred withdrawals appear here." />
      ) : (
        items.map((item) => (
          <Card key={item.withdrawal.id}>
            <div className="flex items-baseline justify-between gap-4">
              <span className="font-mono text-sm font-semibold tabular-nums">
                {formatAmount(item.withdrawal.amount, item.withdrawal.decimals)}{' '}
                {item.withdrawal.symbol}
              </span>
              <WithdrawalStatusBadge status={item.withdrawal.status} />
            </div>

            <dl className="mt-3 space-y-1 text-xs text-ink-muted">
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
                  className="rounded-sm border border-line bg-surface-active px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary"
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

              <div className="flex gap-2">
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
