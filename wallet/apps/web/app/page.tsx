'use client';

import Link from 'next/link';
import { useSession } from '@/hooks/use-session';
import { Button } from '@/components/ui';
import { useCapabilities } from '@/features/platform/use-capabilities';

/**
 * The landing view.
 *
 * §1: "expensive because of composition and detail, not excessive decoration."
 * So: one column of type at a deliberate measure, a single accent on one CTA,
 * and a row of technical facts underneath — the things an institutional reader
 * actually wants, stated plainly rather than sold.
 *
 * No feature grid, no illustration, no testimonial. There is nothing to sell
 * here and pretending otherwise is what makes a project look like a project.
 */

const PROPERTIES = [
  {
    label: 'Custody',
    value: 'Threshold-ready',
    detail: 'Keys live in a separate signing service. No seed phrase ever reaches the browser.',
  },
  {
    label: 'Accounting',
    value: 'Double-entry',
    detail: 'Every balance is a projection over immutable entries. No mutable balance column.',
  },
  {
    label: 'Settlement',
    value: 'Finalized only',
    detail: 'Deposits credit at finality. Withdrawals settle after the chain agrees they landed.',
  },
] as const;

export default function HomePage() {
  const { state } = useSession();
  const capabilities = useCapabilities();

  return (
    <div className="relative">
      <div className="atlas-glow" aria-hidden="true" />

      <div className="relative py-16 sm:py-24">
        {/* The measure is the point: ~60 characters reads, 90 does not. */}
        <div className="max-w-2xl">
          <p className="inline-flex items-center gap-2 rounded-full border border-line-strong px-3 py-1 text-2xs font-medium uppercase tracking-wider text-ink-muted">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-accent-strong"
            />
            Atlas Wallet · Solana
          </p>

          <h1 className="mt-6 text-4xl font-semibold tracking-[-0.03em] text-ink sm:text-[3.5rem] sm:leading-[1.04]">
            Custodial infrastructure
            <br />
            <span className="bg-gradient-to-br from-ink via-ink-secondary to-ink-muted bg-clip-text text-transparent">
              for digital assets.
            </span>
          </h1>

          <p className="mt-6 max-w-xl text-base leading-relaxed text-ink-secondary">
            Atlas Wallet holds, receives and sends SOL without a seed phrase. Signing happens behind
            a process boundary, every movement is double-entry accounted, and the interface tells
            you what is actually true about both.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            {state.status === 'authenticated' ? (
              <Link href="/dashboard">
                <Button size="lg">Go to dashboard</Button>
              </Link>
            ) : (
              <>
                <Link href="/register">
                  <Button size="lg">Create an account</Button>
                </Link>
                <Link href="/login">
                  <Button size="lg" variant="secondary">
                    Sign in
                  </Button>
                </Link>
              </>
            )}
          </div>

          <p className="mt-5 text-xs text-ink-muted">
            Passkey sign-in. No password to steal, nothing to write down.
          </p>
        </div>

        {/* §8: a 12-column grid the properties align to, not three floating cards. */}
        <div className="mt-20 border-t border-line pt-10">
          <dl className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3 lg:gap-12">
            {PROPERTIES.map((property) => (
              <div key={property.label} className="atlas-raised atlas-raised-hover rounded-lg p-5">
                <dt className="text-2xs font-medium uppercase tracking-wider text-ink-muted">
                  {property.label}
                </dt>
                <dd className="mt-2 text-sm font-medium text-ink">{property.value}</dd>
                <dd className="mt-1.5 text-xs leading-relaxed text-ink-muted">{property.detail}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/*
          The disclosure, on the public page, above the fold-ish — not buried in
          a footer. master-prompt rule 8: nobody should be able to assume this
          is production custody, and the first place someone forms that
          assumption is here.
        */}
        <p className="mt-10 max-w-2xl text-xs leading-relaxed text-ink-muted">
          <span className="text-ink-secondary">This is an educational project.</span> It has not
          been independently audited and is not production custody.
          {capabilities?.signing.thresholdProtected === false &&
            ' Signing currently uses a single key held in a separate service, not threshold signing.'}
        </p>
      </div>
    </div>
  );
}
