'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useSession } from '@/hooks/use-session';
import { Button } from '@/components/ui';
import { useCapabilities } from '@/features/platform/use-capabilities';
import { SigningCeremony } from '@/features/landing/signing-ceremony';
import { Reveal } from '@/features/landing/reveal';

/**
 * The landing page.
 *
 * It reads like a product page and is held to the same rule as the console:
 * every claim on it is something the system actually does, sourced from the
 * README, the ADRs or the live /capabilities response. There are no customer
 * logos, no user counts and no volume figures, because there are none — and a
 * custody product that invents a number on its front page has told you how it
 * treats numbers.
 */

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

const HERO_FACTS = [
  { value: '3 of 5', label: 'threshold signers per key' },
  { value: '15', label: 'explicit withdrawal states' },
  { value: '0', label: 'seed phrases or passwords' },
] as const;

const STACK = [
  'Solana',
  'FROST · RFC 9591',
  'WebAuthn passkeys',
  'PostgreSQL 16',
  'Rust',
  'TypeScript',
] as const;

const FLOW = [
  {
    title: 'Request',
    body: 'A withdrawal is confirmed with a fresh passkey step-up. A stolen session alone cannot move funds.',
    icon: 'M4 8h16v11H4zM8 8V6a4 4 0 0 1 8 0v2',
  },
  {
    title: 'Evaluate',
    body: 'A pure risk engine runs every rule — limits, velocity, new destinations — and refers what needs a person.',
    icon: 'M12 3 4 6v6c0 4.4 3.4 8.2 8 9 4.6-.8 8-4.6 8-9V6l-8-3Z',
  },
  {
    title: 'Lock',
    body: 'Funds move from available to locked in one balanced ledger transfer, in the same database transaction.',
    icon: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
  },
  {
    title: 'Sign',
    body: 'Two FROST rounds, each across three of five participants. No machine ever holds a whole key.',
    icon: 'M7 7h10v10H7zM12 2v5M12 17v5M2 12h5M17 12h5',
  },
  {
    title: 'Settle',
    body: 'Broadcast with a durable nonce, confirmed at finality, then posted to the ledger exactly once.',
    icon: 'M20 6 9 17l-5-5',
  },
] as const;

const CUSTODY_POINTS = [
  {
    title: 'No commingling',
    body: 'Each user’s funds sit at their own on-chain address, not in a pooled hot wallet.',
  },
  {
    title: 'No shared blast radius',
    body: 'Compromising one user’s participants yields that user’s funds — not the platform’s.',
  },
  {
    title: 'No master seed',
    body: 'The address is the group public key. Nothing exists that could derive every user’s key.',
  },
] as const;

const DKG_DEFENCES = [
  {
    threat: 'Coordinator reads shares in transit',
    defence: 'Each share is sealed to its recipient’s pinned X25519 key.',
  },
  {
    threat: 'Coordinator injects a share',
    defence: 'Envelope keys mix a static–static DH only the two peers can compute.',
  },
  {
    threat: 'Participant sends a bad share',
    defence: 'Checked against the sender’s commitments; the ceremony aborts before storing.',
  },
  {
    threat: 'Partial failure splits a key',
    defence: 'Two-phase finish: installed only after all five participants agree.',
  },
] as const;

const SECURITY = [
  {
    title: 'Phishing-resistant sign-in',
    body: 'Passkeys bound to the origin, opaque server-side sessions, Origin-based CSRF checks and rate limits.',
    icon: 'M4 8h16v11H4zM8 8V6a4 4 0 0 1 8 0v2',
  },
  {
    title: 'Step-up for money movement',
    body: 'Withdrawals and credential changes require a fresh passkey assertion, not just a live session.',
    icon: 'M12 19V5M5 12l7-7 7 7',
  },
  {
    title: 'An API that cannot sign',
    body: 'A compromised API host cannot sign, reuse an approval on another transaction, or rewrite history.',
    icon: 'M18 6 6 18M6 6l12 12',
  },
  {
    title: 'Sealed key material',
    body: 'Shares, nonces and DKG state are AES-256-GCM ciphertext under a per-host key-encryption key.',
    icon: 'M7 7h10v10H7zM12 2v5M12 17v5M2 12h5M17 12h5',
  },
  {
    title: 'Append-only history',
    body: 'Ledger entries, audit log, risk decisions and state transitions cannot be updated or deleted.',
    icon: 'M4 6h16M4 12h16M4 18h10',
  },
  {
    title: 'Logs that cannot leak',
    body: 'An allowlist logger drops unknown fields, and a test throws every secret the system holds at it.',
    icon: 'M3 12h4l3-7 4 14 3-7h4',
  },
] as const;

const NOT_YET = [
  'No independent security audit',
  'The local 3-of-5 cluster runs on one host',
  'No managed secret store or key rotation',
  'No separation of duties for approvers',
] as const;

const ROADMAP = [
  {
    phase: 'Now',
    title: 'Atlas Custody',
    status: 'Shipped',
    tone: 'good' as const,
    items: [
      'Per-user 3-of-5 FROST keys via DKG',
      'SOL and allowlisted SPL deposits',
      '15-state withdrawal lifecycle',
      'Operator review queue and reconciliation',
    ],
  },
  {
    phase: 'Next',
    title: 'Atlas Spot Exchange',
    status: 'In design',
    tone: 'accent' as const,
    items: [
      'Trading accounts and order holds in the same ledger',
      'Deterministic Rust matching engine, price-time priority',
      'Trades settled as balanced multi-leg postings',
      'WebSocket order book, trades and candles',
    ],
  },
  {
    phase: 'Later',
    title: 'Derivatives & institutions',
    status: 'Planned',
    tone: 'neutral' as const,
    items: [
      'Perpetuals with funding and mark price',
      'Liquidation engine and portfolio margin',
      'FIX / REST APIs and sub-accounts',
      'Independent audits before any real funds',
    ],
  },
] as const;

const FAQ = [
  {
    q: 'Can I use Atlas with real money?',
    a: 'No. Atlas is an educational project running on Solana devnet and localnet. It has not been independently audited and is not production custody. Test funds only.',
  },
  {
    q: 'What does “3-of-5 threshold” actually mean?',
    a: 'Your deposit address is the public key of a group of five signing participants, created by distributed key generation. Any three of them can jointly produce a signature; no single participant — and no coordinator — ever holds the complete private key.',
  },
  {
    q: 'Why is there no seed phrase?',
    a: 'Atlas is custodial: keys are held as threshold shares by the signing service, and you prove who you are with a passkey. There is nothing for you to write down, and nothing for a phishing page to ask for.',
  },
  {
    q: 'When is a deposit credited?',
    a: 'Only once the Solana transaction is finalized, because anything earlier can still be rolled back. Tokens are credited only for allowlisted mint addresses — never by symbol, since anyone can mint a token called “USDC”.',
  },
  {
    q: 'How does the exchange fit in?',
    a: 'The spot exchange is being built on top of the same double-entry ledger, so trading can never become a second source of truth for balances. Moving between custody and trading will be an internal ledger transfer, with no chain involved.',
  },
] as const;

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Icon({ d, className = 'h-4 w-4' }: { d: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-[11.5px] font-semibold text-accent">{children}</p>;
}

function SectionHeading({
  eyebrow,
  title,
  body,
  center = false,
}: {
  eyebrow: string;
  title: string;
  body?: string;
  center?: boolean;
}) {
  return (
    <div className={center ? 'mx-auto max-w-2xl text-center' : 'max-w-2xl'}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="mt-2 text-[28px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink sm:text-[34px]">
        {title}
      </h2>
      {body !== undefined && (
        <p className="mt-3 text-[15px] leading-relaxed text-ink-secondary">{body}</p>
      )}
    </div>
  );
}

function Check({ className = 'text-success' }: { className?: string }) {
  return <Icon d="M20 6 9 17l-5-5" className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${className}`} />;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function HomePage() {
  const { state } = useSession();
  const capabilities = useCapabilities();
  const signedIn = state.status === 'authenticated';

  const signingLabel =
    capabilities?.signing.mode === 'threshold-mpc'
      ? '3-of-5 threshold signing'
      : capabilities?.signing.mode === 'single-key-mpc'
        ? 'Single-key MPC signing'
        : capabilities?.signing.mode === 'mock'
          ? 'Mock signer'
          : null;
  const clusters = capabilities?.clusters.served ?? [];
  const networkLabel =
    clusters.length === 0
      ? 'Solana'
      : clusters.includes('mainnet-beta')
        ? 'Solana'
        : `Solana ${clusters.filter((c) => c !== 'localnet').join(' · ') || 'localnet'}`;

  const primaryCta = signedIn ? (
    <Link href="/dashboard">
      <Button size="lg">Open dashboard</Button>
    </Link>
  ) : (
    <Link href="/register">
      <Button size="lg">Create an account</Button>
    </Link>
  );

  return (
    <div className="relative overflow-x-clip">
      {/* ------------------------------------------------------------------ */}
      {/* Hero                                                               */}
      {/* ------------------------------------------------------------------ */}
      <section className="relative grid grid-cols-1 items-center gap-14 pb-20 pt-14 sm:pt-20 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-12">
        <div className="atlas-glow" aria-hidden="true" />

        <div className="relative min-w-0 animate-fade-up">
          <Link
            href="#roadmap"
            className="group inline-flex items-center gap-2 rounded-full border border-accent-strong/25 bg-accent-dim py-1 pl-1 pr-3 text-[11.5px] font-semibold text-accent"
          >
            <span className="rounded-full bg-accent-strong px-2 py-0.5 text-[10.5px] text-on-accent">
              New
            </span>
            Segregated custody · spot exchange next
            <Icon
              d="M9 6l6 6-6 6"
              className="h-3 w-3 transition-transform duration-base group-hover:translate-x-0.5"
            />
          </Link>

          <h1 className="mt-6 text-[40px] font-bold leading-[1.05] tracking-[-0.035em] text-ink sm:text-[56px]">
            Custody you can inspect.{' '}
            <span className="text-ink-muted">Keys no one can steal whole.</span>
          </h1>

          <p className="mt-5 max-w-[54ch] text-[16px] leading-relaxed text-ink-secondary">
            Atlas is the custody layer of a crypto exchange, built in the order a real one has to
            be. Every deposit address is its own 3-of-5 threshold key, every movement of funds is
            double-entry accounted, and sign-in is a passkey — no seed phrase, no password.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-2.5">
            {primaryCta}
            {signedIn ? null : (
              <Link href="/login">
                <Button size="lg" variant="secondary">
                  Sign in
                </Button>
              </Link>
            )}
            <Link
              href="#how-it-works"
              className="ml-1 inline-flex items-center gap-1.5 text-sm font-semibold text-ink-secondary transition-colors duration-micro hover:text-ink"
            >
              How it works
              <Icon d="M12 5v14M5 12l7 7 7-7" className="h-3.5 w-3.5" />
            </Link>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-muted">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />
              {networkLabel} · test funds only
            </span>
            {signingLabel !== null && (
              <span className="inline-flex items-center gap-1.5">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${capabilities?.signing.thresholdProtected ? 'bg-success' : 'bg-warning'}`}
                  aria-hidden="true"
                />
                {signingLabel} running
              </span>
            )}
          </div>

          <dl className="mt-10 grid max-w-lg grid-cols-3 gap-6 border-t border-line pt-6">
            {HERO_FACTS.map((fact) => (
              <div key={fact.label}>
                <dt className="sr-only">{fact.label}</dt>
                <dd className="font-mono text-[24px] font-semibold tracking-[-0.02em] text-ink">
                  {fact.value}
                </dd>
                <dd className="mt-1 text-xs leading-snug text-ink-muted">{fact.label}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="relative min-w-0 animate-fade-up [animation-delay:120ms]">
          <SigningCeremony />
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Stack strip                                                        */}
      {/* ------------------------------------------------------------------ */}
      <section className="border-y border-line py-6">
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-between">
          <p className="shrink-0 text-xs font-medium text-ink-muted">Built on open standards</p>
          <ul className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
            {STACK.map((item) => (
              <li
                key={item}
                className="font-mono text-[13px] font-medium text-ink-disabled transition-colors duration-base hover:text-ink-secondary"
              >
                {item}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Products                                                           */}
      {/* ------------------------------------------------------------------ */}
      <section id="product" className="py-24">
        <Reveal>
          <SectionHeading
            eyebrow="One balance sheet"
            title="Custody first. Trading on top of it."
            body="An exchange is only as trustworthy as the layer that holds its money. Atlas builds that layer first, then puts the exchange on the same ledger — so there is never a second source of truth for a balance."
          />
        </Reveal>

        <div className="mt-12 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Reveal>
            <article className="group relative h-full overflow-hidden rounded-xl border border-line bg-surface p-7 transition-colors duration-base hover:border-accent-strong/60">
              <div className="flex items-center justify-between">
                <span className="grid grid-cols-1 h-9 w-9 place-items-center rounded-lg bg-accent-strong text-on-accent">
                  <Icon d="M7 7h10v10H7zM12 2v5M12 17v5M2 12h5M17 12h5" />
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-sm border border-success/30 bg-success-dim px-2 py-0.5 text-[10.5px] font-semibold text-success">
                  <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
                  Live on devnet
                </span>
              </div>
              <p className="mt-6 text-[11.5px] font-semibold text-accent">Atlas Custody</p>
              <h3 className="mt-1.5 text-[22px] font-semibold tracking-[-0.02em] text-ink">
                A wallet with no whole key to steal
              </h3>
              <p className="mt-2.5 leading-relaxed text-ink-secondary">
                Hold, receive and send SOL and allowlisted SPL tokens. Your address is generated by
                a distributed key ceremony across five participants, and any three co-sign.
              </p>
              <ul className="mt-6 space-y-2.5 text-[13px] text-ink-secondary">
                {[
                  'Passkey sign-in with TOTP as a second factor',
                  'Deposits credited only at finality',
                  'Risk engine with operator review',
                  'Portfolio valued from a recorded price feed',
                ].map((item) => (
                  <li key={item} className="flex gap-2.5">
                    <Check />
                    {item}
                  </li>
                ))}
              </ul>
              <Link
                href={signedIn ? '/dashboard' : '/register'}
                className="mt-7 inline-flex items-center gap-1.5 text-sm font-semibold text-accent"
              >
                {signedIn ? 'Go to your wallet' : 'Open a wallet'}
                <Icon
                  d="M9 6l6 6-6 6"
                  className="h-3.5 w-3.5 transition-transform duration-base group-hover:translate-x-0.5"
                />
              </Link>
            </article>
          </Reveal>

          <Reveal delay={100}>
            <article className="relative h-full overflow-hidden rounded-xl border border-line bg-surface p-7">
              <div className="flex items-center justify-between">
                <span className="grid grid-cols-1 h-9 w-9 place-items-center rounded-lg bg-surface-active text-ink-secondary">
                  <Icon d="M3 17l6-6 4 4 8-8M21 7h-5M21 7v5" />
                </span>
                <span className="rounded-sm border border-accent-strong/30 bg-accent-dim px-2 py-0.5 text-[10.5px] font-semibold text-accent">
                  In development
                </span>
              </div>
              <p className="mt-6 text-[11.5px] font-semibold text-accent">Atlas Exchange</p>
              <h3 className="mt-1.5 text-[22px] font-semibold tracking-[-0.02em] text-ink">
                Spot trading, settled in the same ledger
              </h3>
              <p className="mt-2.5 leading-relaxed text-ink-secondary">
                Funding a trade will be an internal transfer — one balanced ledger transaction, no
                chain, no confirmations to wait for. Order holds use the same pattern withdrawals
                already do.
              </p>
              <ul className="mt-6 space-y-2.5 text-[13px] text-ink-secondary">
                {[
                  'Deterministic, event-sourced matching engine in Rust',
                  'Limit, market, IOC, FOK and post-only orders',
                  'Pre-trade risk and self-trade prevention',
                  'Real-time order book and trade feeds',
                ].map((item) => (
                  <li key={item} className="flex gap-2.5">
                    <Check className="text-ink-disabled" />
                    {item}
                  </li>
                ))}
              </ul>
              <Link
                href="#roadmap"
                className="mt-7 inline-flex items-center gap-1.5 text-sm font-semibold text-ink-secondary transition-colors hover:text-ink"
              >
                See the roadmap
                <Icon d="M9 6l6 6-6 6" className="h-3.5 w-3.5" />
              </Link>
            </article>
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* How a withdrawal moves                                             */}
      {/* ------------------------------------------------------------------ */}
      <section id="how-it-works" className="border-t border-line py-24">
        <Reveal>
          <SectionHeading
            eyebrow="How it works"
            title="Five steps between a request and the chain."
            body="Every failure along the way is a named state, not an exception — declared once, enforced by a generated database constraint, and written to an append-only history."
          />
        </Reveal>

        <ol className="relative mt-14 grid grid-cols-1 gap-4 md:grid-cols-5 md:gap-3">
          {/* The rail joining the steps, behind the numbered markers. */}
          <span
            aria-hidden="true"
            className="absolute left-[10%] right-[10%] top-[18px] hidden h-px bg-gradient-to-r from-line via-accent-strong/50 to-line md:block"
          />
          {FLOW.map((step, index) => (
            <li key={step.title}>
              <Reveal delay={index * 80} className="relative h-full">
                <div className="flex items-center gap-3 md:flex-col md:items-center">
                  <span className="relative z-10 grid grid-cols-1 h-9 w-9 shrink-0 place-items-center rounded-full border border-line-strong bg-background text-accent">
                    <Icon d={step.icon} className="h-4 w-4" />
                  </span>
                  <span className="font-mono text-[11px] text-ink-muted md:mt-1">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                </div>
                <div className="mt-3 rounded-lg border border-line bg-surface p-4 md:mt-4 md:min-h-[150px]">
                  <p className="text-sm font-semibold text-ink">{step.title}</p>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-secondary">
                    {step.body}
                  </p>
                </div>
              </Reveal>
            </li>
          ))}
        </ol>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Custody deep dive                                                  */}
      {/* ------------------------------------------------------------------ */}
      <section className="border-t border-line py-24">
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-16">
          <Reveal>
            <SectionHeading
              eyebrow="Segregated custody"
              title="One threshold key per user. No trusted dealer."
              body="Keys are created by Pedersen DKG with Feldman verifiable secret sharing across five participants. The coordinator in the middle routes messages and never sees a key."
            />
            <ul className="mt-8 space-y-5">
              {CUSTODY_POINTS.map((point) => (
                <li key={point.title} className="flex gap-3.5">
                  <span className="mt-0.5 grid grid-cols-1 h-6 w-6 shrink-0 place-items-center rounded-md bg-accent-dim text-accent">
                    <Icon d="M20 6 9 17l-5-5" className="h-3.5 w-3.5" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-ink">{point.title}</p>
                    <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
                      {point.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </Reveal>

          <Reveal delay={100}>
            <div className="overflow-hidden rounded-xl border border-line bg-surface">
              <div className="flex items-center justify-between border-b border-line px-5 py-3">
                <p className="text-sm font-semibold text-ink">
                  A coordinator you don’t have to trust
                </p>
                <span className="font-mono text-[11px] text-ink-muted">t = 3 · n = 5</span>
              </div>

              {/* The topology: five sealed participants around a keyless coordinator. */}
              <div className="flex items-center justify-center gap-3 border-b border-line bg-background-subtle px-5 py-7 sm:gap-5">
                {[1, 2].map((n) => (
                  <span
                    key={n}
                    className="grid grid-cols-1 h-10 w-10 place-items-center rounded-full border border-line-strong bg-surface font-mono text-[11px] font-semibold text-ink-secondary"
                  >
                    P{n}
                  </span>
                ))}
                <span className="flex flex-col items-center gap-1.5">
                  <span className="grid grid-cols-1 h-14 w-14 place-items-center rounded-xl border border-dashed border-accent-strong/60 bg-accent-dim text-accent">
                    <Icon d="M12 3v18M3 12h18" className="h-5 w-5" />
                  </span>
                  <span className="font-mono text-[10px] text-ink-muted">no key</span>
                </span>
                {[3, 4, 5].map((n) => (
                  <span
                    key={n}
                    className="grid grid-cols-1 h-10 w-10 place-items-center rounded-full border border-line-strong bg-surface font-mono text-[11px] font-semibold text-ink-secondary"
                  >
                    P{n}
                  </span>
                ))}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[30rem] text-left">
                  <thead>
                    <tr className="border-b border-line">
                      <th scope="col" className="atlas-th px-5 py-2.5">
                        Threat
                      </th>
                      <th scope="col" className="atlas-th px-5 py-2.5">
                        Defence
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {DKG_DEFENCES.map((row) => (
                      <tr key={row.threat} className="border-b border-line last:border-0">
                        <td className="px-5 py-3 align-top text-[13px] font-medium text-ink">
                          {row.threat}
                        </td>
                        <td className="px-5 py-3 align-top text-[13px] leading-relaxed text-ink-secondary">
                          {row.defence}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Ledger                                                             */}
      {/* ------------------------------------------------------------------ */}
      <section className="border-t border-line py-24">
        <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-16">
          <Reveal className="order-2 lg:order-1">
            <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
              <div className="flex items-center justify-between border-b border-line px-5 py-3">
                <p className="text-sm font-semibold text-ink">ledger_transactions</p>
                <span className="rounded-sm border border-success/30 bg-success-dim px-2 py-0.5 font-mono text-[10.5px] font-semibold text-success">
                  balanced
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[28rem] font-mono text-[12.5px]">
                  <thead>
                    <tr className="border-b border-line bg-background-subtle text-left">
                      <th scope="col" className="atlas-th px-5 py-2">
                        Account
                      </th>
                      <th scope="col" className="atlas-th px-5 py-2 text-right">
                        Debit
                      </th>
                      <th scope="col" className="atlas-th px-5 py-2 text-right">
                        Credit
                      </th>
                    </tr>
                  </thead>
                  <tbody className="text-ink-secondary">
                    <tr>
                      <td
                        colSpan={3}
                        className="px-5 pb-1 pt-3 font-sans text-[11px] text-ink-muted"
                      >
                        Deposit finalized
                      </td>
                    </tr>
                    <tr>
                      <td className="px-5 py-1.5 text-ink">chain_assets</td>
                      <td className="px-5 py-1.5 text-right">2.000000</td>
                      <td className="px-5 py-1.5 text-right text-ink-disabled">—</td>
                    </tr>
                    <tr className="border-b border-line">
                      <td className="px-5 py-1.5 pb-3 text-ink">user_custody_available</td>
                      <td className="px-5 py-1.5 pb-3 text-right text-ink-disabled">—</td>
                      <td className="px-5 py-1.5 pb-3 text-right">2.000000</td>
                    </tr>
                    <tr>
                      <td
                        colSpan={3}
                        className="px-5 pb-1 pt-3 font-sans text-[11px] text-ink-muted"
                      >
                        Withdrawal funds locked
                      </td>
                    </tr>
                    <tr>
                      <td className="px-5 py-1.5 text-ink">user_custody_available</td>
                      <td className="px-5 py-1.5 text-right">1.500000</td>
                      <td className="px-5 py-1.5 text-right text-ink-disabled">—</td>
                    </tr>
                    <tr className="border-b border-line">
                      <td className="px-5 py-1.5 pb-3 text-ink">user_custody_locked</td>
                      <td className="px-5 py-1.5 pb-3 text-right text-ink-disabled">—</td>
                      <td className="px-5 py-1.5 pb-3 text-right">1.500000</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between bg-background-subtle px-5 py-3 font-mono text-[11.5px]">
                <span className="text-ink-muted">Σ debits − Σ credits</span>
                <span className="font-semibold text-success">0 · enforced at commit</span>
              </div>
            </div>
          </Reveal>

          <Reveal delay={100} className="order-1 lg:order-2">
            <SectionHeading
              eyebrow="Double-entry ledger"
              title="Balances are never stored. They are proven."
              body="A balance is always a projection over immutable ledger entries. PostgreSQL rejects any transaction that does not balance, and the application’s database role has no UPDATE or DELETE on history."
            />
            <dl className="mt-8 grid grid-cols-2 gap-4">
              {[
                ['Idempotent', 'A replayed page or a restart cannot credit twice.'],
                ['Cluster-scoped', 'devnet:SOL can never be added to mainnet:SOL.'],
                ['Atomic locks', 'Two concurrent withdrawals cannot both win.'],
                ['Reconciled', 'The ledger is checked against the chain on a schedule.'],
              ].map(([title, body]) => (
                <div key={title} className="rounded-lg border border-line bg-surface p-4">
                  <dt className="text-sm font-semibold text-ink">{title}</dt>
                  <dd className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{body}</dd>
                </div>
              ))}
            </dl>
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Security                                                           */}
      {/* ------------------------------------------------------------------ */}
      <section id="security" className="border-t border-line py-24">
        <Reveal>
          <SectionHeading
            center
            eyebrow="Security model"
            title="Designed for the host that gets compromised."
            body="The question isn’t whether a server is ever breached — it’s what an attacker holding it can do. At Atlas, the answer for the API host is: not sign."
          />
        </Reveal>

        <div className="mt-14 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {SECURITY.map((item, index) => (
            <Reveal key={item.title} delay={index * 60} className="h-full">
              <div className="h-full bg-surface p-6 transition-colors duration-base hover:bg-surface-hover">
                <span className="grid grid-cols-1 h-8 w-8 place-items-center rounded-md bg-accent-dim text-accent">
                  <Icon d={item.icon} />
                </span>
                <p className="mt-4 text-sm font-semibold text-ink">{item.title}</p>
                <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">{item.body}</p>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal>
          <div className="mt-4 flex flex-col gap-4 rounded-xl border border-warning/30 bg-warning-dim p-6 md:flex-row md:items-start md:gap-8">
            <div className="md:w-72 md:shrink-0">
              <p className="flex items-center gap-2 text-sm font-semibold text-warning">
                <Icon d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
                What we don’t claim yet
              </p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">
                Stated plainly, because a custody product should be judged on its gaps too.
              </p>
            </div>
            <ul className="grid grid-cols-1 flex-1 gap-2.5 sm:grid-cols-2">
              {NOT_YET.map((item) => (
                <li key={item} className="flex gap-2.5 text-[13px] text-ink-secondary">
                  <span
                    aria-hidden="true"
                    className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-warning"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Roadmap                                                            */}
      {/* ------------------------------------------------------------------ */}
      <section id="roadmap" className="border-t border-line py-24">
        <Reveal>
          <SectionHeading
            eyebrow="Roadmap"
            title="Built in the order a real exchange has to be."
            body="Custody first, because every later product moves money the custody layer is responsible for. Then spot. Then derivatives."
          />
        </Reveal>

        <div className="mt-12 grid grid-cols-1 gap-4 lg:grid-cols-3">
          {ROADMAP.map((stage, index) => (
            <Reveal key={stage.title} delay={index * 100} className="h-full">
              <div
                className={[
                  'relative h-full rounded-xl border bg-surface p-6',
                  stage.tone === 'good' ? 'border-accent-strong/50' : 'border-line',
                ].join(' ')}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] text-ink-muted">{stage.phase}</span>
                  <span
                    className={[
                      'rounded-sm border px-2 py-0.5 text-[10.5px] font-semibold',
                      stage.tone === 'good'
                        ? 'border-success/30 bg-success-dim text-success'
                        : stage.tone === 'accent'
                          ? 'border-accent-strong/30 bg-accent-dim text-accent'
                          : 'border-line bg-surface-active text-ink-muted',
                    ].join(' ')}
                  >
                    {stage.status}
                  </span>
                </div>
                <h3 className="mt-4 text-lg font-semibold tracking-[-0.01em] text-ink">
                  {stage.title}
                </h3>
                <ul className="mt-4 space-y-2.5">
                  {stage.items.map((item) => (
                    <li key={item} className="flex gap-2.5 text-[13px] text-ink-secondary">
                      <Check
                        className={stage.tone === 'good' ? 'text-success' : 'text-ink-disabled'}
                      />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* FAQ                                                                */}
      {/* ------------------------------------------------------------------ */}
      <section id="faq" className="border-t border-line py-24">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-16">
          <Reveal>
            <SectionHeading
              eyebrow="FAQ"
              title="Questions worth asking a custodian."
              body="If yours isn’t here, the README and the architecture decision records answer it in full."
            />
          </Reveal>
          <Reveal delay={100}>
            <div className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {FAQ.map((item) => (
                <details key={item.q} className="group">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-semibold text-ink transition-colors hover:bg-surface-hover [&::-webkit-details-marker]:hidden">
                    {item.q}
                    <Icon
                      d="M12 5v14M5 12h14"
                      className="h-4 w-4 shrink-0 text-ink-muted transition-transform duration-base group-open:rotate-45"
                    />
                  </summary>
                  <p className="px-5 pb-5 text-[13.5px] leading-relaxed text-ink-secondary">
                    {item.a}
                  </p>
                </details>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Closing CTA                                                        */}
      {/* ------------------------------------------------------------------ */}
      <section className="pb-24">
        <Reveal>
          <div className="relative overflow-hidden rounded-2xl border border-line bg-gradient-to-br from-accent-dim via-surface to-surface px-8 py-14 sm:px-14">
            <div
              aria-hidden="true"
              className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-accent-glow/20 blur-3xl"
            />
            <div className="relative flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between">
              <div className="max-w-xl">
                <h2 className="text-[28px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink sm:text-[34px]">
                  See threshold custody working, end to end.
                </h2>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-secondary">
                  Create an account with a passkey, get your own 3-of-5 address, fund it from the
                  devnet faucet and send a withdrawal through the full lifecycle.
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2.5">
                {primaryCta}
                {!signedIn && (
                  <Link href="/login">
                    <Button size="lg" variant="secondary">
                      Sign in
                    </Button>
                  </Link>
                )}
              </div>
            </div>
          </div>
        </Reveal>

        {/*
          The disclosure, stated on the page itself, not only in the footer.
          master-prompt rule 8: nobody should be able to assume this is
          production custody, and the first place someone forms that assumption
          is here. The signing sentence is read from /capabilities.
        */}
        <p className="mx-auto mt-8 max-w-3xl text-center text-xs leading-relaxed text-ink-muted">
          <span className="text-ink-secondary">Atlas is an educational project.</span> It has not
          been independently audited, is not production custody, and must never be used with real
          funds.
          {capabilities?.signing.mode === 'mock' &&
            ' This deployment is running a clearly-labelled mock signer.'}
          {capabilities?.signing.mode === 'single-key-mpc' &&
            ' Signing currently uses a single key held in a separate service, not threshold signing.'}
          {capabilities?.signing.thresholdProtected === true &&
            ' Signing is 3-of-5 threshold, but the participants are five processes rather than five hosts.'}
        </p>
      </section>
    </div>
  );
}
