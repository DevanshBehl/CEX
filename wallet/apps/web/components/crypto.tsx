'use client';

import { useState } from 'react';

/**
 * Crypto-specific primitives (design.md §16, §47).
 *
 * These exist because a wallet has vocabulary a generic component library does
 * not: an asset has a glyph, an address is a 44-character string a user must
 * verify by shape, and a network is a fact that changes what an address means.
 * Rendering those as plain text is what makes a crypto product feel unfinished.
 */

/**
 * An asset glyph.
 *
 * No logo files: an asset is identified by its mint (ADR-0016), so a fetched
 * logo is a network dependency keyed on something attacker-supplied. The
 * monogram is derived from the symbol and is always correct for whatever the
 * allowlist holds.
 */
export function AssetMark({ symbol, size = 'md' }: { symbol: string; size?: 'sm' | 'md' | 'lg' }) {
  const sizes = {
    sm: 'h-7 w-7 text-[10px]',
    md: 'h-9 w-9 text-xs',
    lg: 'h-11 w-11 text-sm',
  } as const;

  return (
    <span
      aria-hidden="true"
      className={`${sizes[size]} atlas-raised inline-flex shrink-0 items-center justify-center rounded-full font-semibold uppercase tracking-wider text-ink-secondary`}
    >
      {symbol.slice(0, 3)}
    </span>
  );
}

/**
 * The network an address belongs to.
 *
 * Prominent by design (rule 172): sending an asset on the wrong network is the
 * most common way users lose funds, and a vague label is a contributing cause.
 */
export function NetworkBadge({ network }: { network: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2 py-1 text-2xs font-medium uppercase tracking-wider text-ink-secondary">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent-strong" />
      {network}
    </span>
  );
}

/**
 * An address, with copying built in.
 *
 * Monospace and unbroken: a user verifies an address by its SHAPE, and
 * proportional type destroys the shape. The copy affordance is part of the
 * component because "select 44 characters by hand" is how a transposition
 * error happens.
 */
export function AddressDisplay({
  address,
  testId,
  label,
}: {
  address: string;
  testId?: string | undefined;
  label?: string | undefined;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="atlas-raised overflow-hidden rounded-lg">
      {label !== undefined && (
        <div className="border-b border-line px-4 py-2.5">
          <p className="text-2xs font-medium uppercase tracking-wider text-ink-muted">{label}</p>
        </div>
      )}
      <div className="flex items-center gap-3 p-4">
        <code
          data-testid={testId}
          className="min-w-0 flex-1 break-all font-mono text-sm leading-relaxed text-ink"
        >
          {address}
        </code>
        <button
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(address);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          }}
          aria-label="Copy address"
          className="shrink-0 rounded-md border border-line-strong bg-surface px-2.5 py-2 text-ink-muted transition-all duration-micro ease-atlas hover:border-line-emphasis hover:text-ink active:translate-y-px"
        >
          {copied ? (
            <svg
              viewBox="0 0 16 16"
              className="h-4 w-4 text-success"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
            >
              <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 16 16"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
              <path d="M10.5 5.5v-1a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5V9A1.5 1.5 0 0 0 4 10.5h1" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

/**
 * A lifecycle rail.
 *
 * A withdrawal passes through a 15-state machine, and a user who has just sent
 * money wants to know where in it they are. A list of statuses answers "what
 * happened"; a rail answers "how far along am I", which is the actual question.
 *
 * `failed` is rendered as a stopped rail rather than a red step, because a
 * failed withdrawal has its funds returned — it is an ending, not damage.
 */
export function ProgressRail({
  steps,
  current,
  failed = false,
}: {
  steps: readonly string[];
  /** Index of the active step; steps before it are complete. */
  current: number;
  failed?: boolean;
}) {
  return (
    <ol className="flex items-center gap-1.5">
      {steps.map((step, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={step} className="flex flex-1 flex-col gap-1.5">
            <span
              className={[
                'h-0.5 w-full rounded-full transition-colors duration-slow ease-atlas',
                failed && active
                  ? 'bg-danger'
                  : done
                    ? 'bg-accent-strong'
                    : active
                      ? 'animate-pulse-soft bg-accent-strong'
                      : 'bg-line-strong',
              ].join(' ')}
            />
            <span
              className={`text-2xs uppercase tracking-wider ${
                done || active ? 'text-ink-secondary' : 'text-ink-disabled'
              }`}
            >
              {step}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
