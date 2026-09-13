'use client';

import { useState } from 'react';
import { CLUSTER_DISPLAY, type Cluster } from '@wallet/types';
import { useNetwork } from './network-context';

/**
 * Getting test SOL onto a test cluster (ADR-0021).
 *
 * Shown ONLY on a test cluster. On mainnet there is nothing to offer and a
 * greyed-out faucet button would be an invitation to look for one.
 *
 * # Why the address is copied from here rather than typed
 *
 * The faucet is a web form that takes a base58 address. A user reading 44
 * characters off one page and typing them into another transposes two of them
 * eventually, and on Solana that either fails outright or funds an address
 * nobody controls. One click, one clipboard write, no retyping.
 */
const FAUCETS: Partial<Record<Cluster, { readonly url: string; readonly label: string }>> = {
  devnet: { url: 'https://faucet.solana.com/', label: 'Solana Devnet Faucet' },
  testnet: { url: 'https://faucet.solana.com/', label: 'Solana Testnet Faucet' },
  // `localnet` has no faucet: `solana airdrop 2 <address> --url localhost` is
  // the equivalent, and it is shown as a command rather than a link.
};

export function FaucetPanel({ address }: { address: string }) {
  const { cluster } = useNetwork();
  const [copied, setCopied] = useState(false);

  if (cluster === undefined) return null;
  if (CLUSTER_DISPLAY[cluster].intent === 'live') return null;

  const faucet = FAUCETS[cluster];
  const display = CLUSTER_DISPLAY[cluster];

  async function copy() {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div
      data-testid="faucet-panel"
      className="rounded-lg border border-warning/30 bg-warning-dim p-4"
    >
      <p className="flex items-center gap-2 text-xs font-semibold text-warning">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-warning" />
        {display.label} — test funds only
      </p>

      <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-secondary">
        {/*
          Said plainly. Someone who believes a devnet balance is worth
          something will eventually try to withdraw it to an exchange.
        */}
        SOL on {display.label} has no value and exists only for testing. Fund this address from a
        faucet rather than sending real SOL to it.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void copy()}
          data-testid="faucet-copy-address"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-warning/40 bg-surface px-3 text-xs font-semibold text-warning transition-colors duration-micro ease-atlas hover:border-warning"
        >
          {copied ? 'Address copied' : 'Copy my address'}
        </button>

        {faucet ? (
          <a
            href={faucet.url}
            target="_blank"
            // `noreferrer` as well as `noopener`: the faucet has no business
            // knowing which custodian sent the user.
            rel="noopener noreferrer"
            data-testid="faucet-link"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-xs font-semibold text-ink-secondary transition-colors duration-micro ease-atlas hover:border-line-emphasis hover:text-ink"
          >
            {faucet.label}
            <svg
              viewBox="0 0 16 16"
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M6 3h7v7M13 3 6.5 9.5M11 9.5V13H3V5h3.5" strokeLinecap="round" />
            </svg>
          </a>
        ) : (
          <code className="rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-2xs text-ink-secondary">
            solana airdrop 2 {address.slice(0, 6)}… --url localhost
          </code>
        )}
      </div>
    </div>
  );
}
