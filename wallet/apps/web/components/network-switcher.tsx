'use client';

import { useEffect, useRef, useState } from 'react';
import { CLUSTER_DISPLAY, type Cluster } from '@wallet/types';
import { useNetwork } from '@/features/network/network-context';

/**
 * The network switcher and its status pill (ADR-0021).
 *
 * # Why this is loud
 *
 * Every other control in Atlas is restrained; this one is not. The cost of
 * mistaking devnet for mainnet is asymmetric and irreversible in one
 * direction: someone sends real SOL to an address that only exists on a test
 * cluster, and it is gone. A muted label would be read as decoration.
 *
 * So the colour is doing real work rather than decorating: amber for devnet,
 * blue for testnet, green for mainnet, grey for a local validator that is
 * wiped on every restart.
 */
const TONE: Record<Cluster, { dot: string; pill: string }> = {
  'mainnet-beta': {
    dot: 'bg-success',
    pill: 'border-success/30 bg-success-dim text-success',
  },
  devnet: {
    dot: 'bg-warning',
    pill: 'border-warning/30 bg-warning-dim text-warning',
  },
  testnet: {
    dot: 'bg-accent-strong',
    pill: 'border-accent-strong/30 bg-accent-dim text-accent',
  },
  localnet: {
    // Grey on purpose. A local validator's funds are not merely worthless,
    // they stop existing when someone restarts it.
    dot: 'bg-ink-disabled',
    pill: 'border-line-emphasis bg-surface text-ink-secondary',
  },
};

export function NetworkPill({ cluster }: { cluster: Cluster }) {
  const tone = TONE[cluster];
  const display = CLUSTER_DISPLAY[cluster];

  return (
    <span
      data-testid="network-pill"
      data-cluster={cluster}
      className={[
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1',
        'text-[11.5px] font-semibold',
        tone.pill,
      ].join(' ')}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      {display.label}
    </span>
  );
}

export function NetworkSwitcher() {
  const { cluster, served, switchTo, ready } = useNetwork();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onPointerDown(event: MouseEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Nothing until capabilities load. A pill that said "Mainnet" for a moment
  // and then corrected itself would be worse than no pill at all.
  if (!ready || cluster === undefined) return null;

  // One served cluster is not a choice. Still shown, because WHICH network
  // this is remains the thing worth knowing.
  if (served.length <= 1) return <NetworkPill cluster={cluster} />;

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Network: ${CLUSTER_DISPLAY[cluster].label}. Change network.`}
        data-testid="network-switcher"
        className="rounded-md transition-opacity duration-micro ease-atlas hover:opacity-80"
      >
        <NetworkPill cluster={cluster} />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Solana network"
          className="atlas-raised absolute right-0 z-50 mt-2 w-52 overflow-hidden rounded-lg p-1 shadow-md"
        >
          {served.map((option) => {
            const display = CLUSTER_DISPLAY[option];
            const selected = option === cluster;

            return (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={selected}
                data-testid={`network-option-${option}`}
                onClick={() => {
                  switchTo(option);
                  setOpen(false);
                }}
                className={[
                  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm',
                  'transition-colors duration-micro ease-atlas',
                  selected
                    ? 'bg-surface-active font-semibold text-ink'
                    : 'text-ink-secondary hover:bg-surface-hover',
                ].join(' ')}
              >
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 rounded-full ${TONE[option].dot}`}
                />
                <span className="flex-1">{display.label}</span>
                {/*
                  Said in words, not only in colour. Colour alone excludes
                  anyone who cannot distinguish these two, and this is the one
                  distinction in the product that must not be missed.
                */}
                <span className="font-mono text-2xs text-ink-muted">
                  {display.intent === 'live' ? 'Live' : 'Test'}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
