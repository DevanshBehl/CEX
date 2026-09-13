'use client';

import { useEffect, useState } from 'react';

/**
 * The hero illustration: one withdrawal walking through the real pipeline.
 *
 * Every step shown is a step the system actually takes — passkey step-up, the
 * risk engine, the ledger lock, two FROST rounds across three of five
 * participants, a durable-nonce broadcast, settlement at finality — and the
 * state names are the ones in `WithdrawalStatus`. It is labelled an
 * illustration because it is one: no request is made, and nothing here is
 * anyone's balance.
 */

type Step = {
  state: string;
  log: string;
  tone: 'run' | 'ok' | 'note';
};

const STEPS: readonly Step[] = [
  { state: 'REQUESTED', log: '> passkey step-up verified · bound to this request', tone: 'run' },
  { state: 'APPROVED', log: '✓ risk engine · every rule evaluated · within policy', tone: 'ok' },
  { state: 'FUNDS_LOCKED', log: '✓ ledger · user_available → user_locked · Σ = 0', tone: 'ok' },
  { state: 'SIGNING', log: '> round 1 · {signers} publish nonce commitments', tone: 'run' },
  { state: 'SIGNING', log: '> round 2 · signature shares from {signers}', tone: 'run' },
  { state: 'SIGNED', log: '✓ aggregate verifies · no private key reconstructed', tone: 'note' },
  { state: 'BROADCAST', log: '> broadcast · durable nonce advances exactly once', tone: 'run' },
  { state: 'CONFIRMED', log: '✓ transaction finalized on Solana', tone: 'ok' },
  { state: 'SETTLED', log: '✓ ledger posted · withdrawal settled', tone: 'ok' },
];

/** Which three of the five participants sign, rotated each cycle — any three suffice. */
const QUORUMS: readonly (readonly number[])[] = [
  [0, 2, 3],
  [1, 2, 4],
  [0, 1, 4],
  [0, 3, 4],
];

const STEP_MS = 950;
const HOLD_MS = 2600;

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

export function SigningCeremony() {
  const reduced = usePrefersReducedMotion();
  const [cycle, setCycle] = useState(0);
  const [step, setStep] = useState(0);

  useEffect(() => {
    // Reduced motion: show the finished ceremony and stop.
    if (reduced) {
      setStep(STEPS.length - 1);
      return;
    }
    const last = step >= STEPS.length - 1;
    const timer = setTimeout(
      () => {
        if (last) {
          setStep(0);
          setCycle((current) => current + 1);
        } else {
          setStep((current) => current + 1);
        }
      },
      last ? HOLD_MS : STEP_MS,
    );
    return () => clearTimeout(timer);
  }, [step, reduced]);

  const quorum = QUORUMS[cycle % QUORUMS.length] ?? [0, 2, 3];
  const signerNames = quorum.map((index) => `P${index + 1}`).join(' ');
  const current = STEPS[step] ?? STEPS[0]!;
  const settled = step === STEPS.length - 1;
  const progress = Math.round(((step + 1) / STEPS.length) * 100);

  const nodeState = (index: number) => {
    if (!quorum.includes(index)) return step >= 3 ? 'standby' : 'idle';
    if (step >= 5) return 'signed';
    if (step >= 3) return 'active';
    return 'idle';
  };

  const visibleLog = STEPS.slice(Math.max(0, step - 4), step + 1).map((entry, offset) => ({
    key: `${cycle}-${Math.max(0, step - 4) + offset}`,
    text: entry.log.replace('{signers}', signerNames),
    tone: entry.tone,
  }));

  return (
    <div className="relative">
      {/* A soft plate behind the card so it sits above the page, not on it. */}
      <div
        aria-hidden="true"
        className="absolute -inset-6 rounded-[20px] bg-accent-glow/[0.06] blur-2xl"
      />

      <div
        className="relative overflow-hidden rounded-xl border border-line bg-surface shadow-lg"
        role="img"
        aria-label="Illustration: a withdrawal is approved, locked in the ledger, signed by three of five threshold participants, broadcast and settled."
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="flex gap-1" aria-hidden="true">
              <span className="h-2 w-2 rounded-full bg-line-strong" />
              <span className="h-2 w-2 rounded-full bg-line-strong" />
              <span className="h-2 w-2 rounded-full bg-line-strong" />
            </span>
            <span className="ml-1.5 text-xs font-semibold text-ink">Withdrawal</span>
            <span className="rounded-sm bg-surface-active px-1.5 py-px text-[10px] font-semibold text-ink-muted">
              Illustration
            </span>
          </div>
          <span className="font-mono text-[11px] text-ink-muted">FROST-Ed25519 · 3-of-5</span>
        </div>

        <div className="px-4 pb-4 pt-4">
          <div className="flex items-baseline justify-between gap-3">
            <div>
              <p className="font-mono text-[22px] font-semibold tracking-[-0.01em] text-ink">
                −1.5000 <span className="text-sm text-ink-muted">SOL</span>
              </p>
              <p className="mt-0.5 font-mono text-[11px] text-ink-muted">to 7xKX…9fQa · devnet</p>
            </div>
            <span
              className={[
                'rounded-sm border px-2 py-0.5 font-mono text-[10.5px] font-semibold transition-colors duration-base',
                settled
                  ? 'border-success/30 bg-success-dim text-success'
                  : 'border-accent-strong/30 bg-accent-dim text-accent',
              ].join(' ')}
            >
              {current.state}
            </span>
          </div>

          <div className="mt-3 h-[3px] overflow-hidden rounded-full bg-surface-active">
            <div
              className={`h-full rounded-full transition-[width] duration-slow ease-atlas ${settled ? 'bg-success' : 'bg-accent-strong'}`}
              style={{ width: `${progress}%` }}
            />
          </div>

          {/* The five participants. Three sign; two are never needed. */}
          <div className="mt-5 grid grid-cols-5 gap-2">
            {[0, 1, 2, 3, 4].map((index) => {
              const state = nodeState(index);
              return (
                <div key={index} className="flex flex-col items-center gap-1.5">
                  <span
                    className={[
                      'relative grid h-10 w-10 place-items-center rounded-full border-2 font-mono text-[11px] font-semibold transition-all duration-slow',
                      state === 'signed'
                        ? 'border-success bg-success-dim text-success'
                        : state === 'active'
                          ? 'border-accent-strong bg-accent-dim text-accent'
                          : state === 'standby'
                            ? 'border-line bg-surface text-ink-disabled opacity-60'
                            : 'border-line-strong bg-surface text-ink-muted',
                    ].join(' ')}
                  >
                    P{index + 1}
                    {state === 'active' && !reduced && (
                      <span
                        aria-hidden="true"
                        className="absolute -inset-[2px] animate-ring rounded-full border-2 border-accent-strong"
                      />
                    )}
                  </span>
                  <span className="font-mono text-[10px] text-ink-muted">
                    {state === 'signed'
                      ? 'signed'
                      : state === 'active'
                        ? 'signing'
                        : state === 'standby'
                          ? 'standby'
                          : 'sealed'}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="mt-4 min-h-[118px] rounded-md bg-term px-3 py-2.5 font-mono text-[11px] leading-[1.9]">
            {visibleLog.map((line) => (
              <div
                key={line.key}
                className={`animate-fade-up truncate ${
                  line.tone === 'ok'
                    ? 'text-term-ok'
                    : line.tone === 'note'
                      ? 'text-term-note'
                      : 'text-term-text'
                }`}
              >
                {line.text}
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line bg-background-subtle px-4 py-2.5 font-mono text-[11px] text-ink-muted">
          <span>coordinator sees ciphertext only</span>
          <span className={settled ? 'text-success' : ''}>
            {settled ? 'settled' : `step ${step + 1}/${STEPS.length}`}
          </span>
        </div>
      </div>
    </div>
  );
}
