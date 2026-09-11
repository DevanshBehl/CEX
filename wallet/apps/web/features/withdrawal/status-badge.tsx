'use client';

import type { WithdrawalStatus } from '@wallet/types';
import { StatusBadge } from '@/components/ui';

/**
 * Every lifecycle state, shown explicitly (master-prompt rules 78-79,
 * prompt_phase3.md rules 155-156).
 *
 * NEVER collapsed into "pending". A user whose withdrawal is in manual review
 * is owed a different message than one whose broadcast failed — the first needs
 * patience, the second is being retried, and a single word for both tells them
 * neither.
 */
const PRESENTATION: Readonly<
  Record<WithdrawalStatus, { label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' }>
> = {
  REQUESTED: { label: 'Received', tone: 'neutral' },
  RISK_EVALUATING: { label: 'Checking', tone: 'neutral' },
  MANUAL_REVIEW: { label: 'In review', tone: 'warn' },
  APPROVED: { label: 'Approved', tone: 'neutral' },
  FUNDS_LOCKED: { label: 'Reserved', tone: 'neutral' },
  SIGNING: { label: 'Authorising', tone: 'neutral' },
  SIGNED: { label: 'Authorised', tone: 'neutral' },
  BROADCAST: { label: 'Sent — confirming', tone: 'neutral' },
  CONFIRMED: { label: 'Confirmed', tone: 'good' },
  SETTLED: { label: 'Complete', tone: 'good' },
  SIGN_FAILED: { label: 'Retrying', tone: 'warn' },
  BROADCAST_FAILED: { label: 'Retrying', tone: 'warn' },
  EXPIRED: { label: 'Retrying', tone: 'warn' },
  REJECTED: { label: 'Declined', tone: 'bad' },
  FAILED: { label: 'Failed — funds returned', tone: 'bad' },
};

export function WithdrawalStatusBadge({ status }: { status: WithdrawalStatus }) {
  const { label, tone } = PRESENTATION[status];
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}
