'use client';

import { useEffect, useState } from 'react';
import type { DepositAddress } from '@wallet/types';
import { api, ApiError } from '@/lib/api';
import { Button, Card, ErrorNotice, Spinner, StatusBadge } from '@/components/ui';

export default function DepositPage() {
  const [address, setAddress] = useState<DepositAddress | null>(null);
  const [error, setError] = useState<{ message: string; correlationId: string | null } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.getDepositAddress();
        if (!cancelled) setAddress(result.address);
      } catch (e) {
        if (!cancelled) {
          setError({
            message: e instanceof Error ? e.message : 'Could not get a deposit address.',
            correlationId: e instanceof ApiError ? e.correlationId : null,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h1 className="text-xl font-semibold">Deposit</h1>

      {error !== null && (
        <ErrorNotice message={error.message} correlationId={error.correlationId} />
      )}

      {address === null && error === null ? (
        <Spinner label="Preparing your deposit address…" />
      ) : address !== null ? (
        <>
          {/*
            Rule 172: the asset and the network are stated unambiguously and
            before the address. Sending an asset on the wrong network is the
            most common way users lose funds, and a vague label is a
            contributing cause.
          */}
          <Card title={`Send ${address.asset} only`}>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="warn">{address.asset}</StatusBadge>
              <StatusBadge tone="neutral">{address.network}</StatusBadge>
            </div>

            <p className="mt-4 text-sm text-muted">
              This address accepts <strong className="text-ink">{address.asset}</strong> on the{' '}
              <strong className="text-ink">{address.network}</strong> network only. Anything else
              sent here may be permanently lost.
            </p>

            <div className="mt-4 rounded-md border border-line bg-line/20 p-4">
              <p data-testid="deposit-address" className="break-all font-mono text-sm">
                {address.address}
              </p>
            </div>

            <div className="mt-3 flex items-center gap-3">
              <Button
                variant="secondary"
                onClick={async () => {
                  await navigator.clipboard.writeText(address.address);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? 'Copied' : 'Copy address'}
              </Button>
              <QrCode value={address.address} />
            </div>
          </Card>

          <Card title="What happens next">
            <ol className="space-y-2 text-sm text-muted">
              <li>1. Send {address.asset} to the address above from any wallet or exchange.</li>
              <li>
                2. The deposit appears as <strong className="text-ink">Confirming</strong> once the
                network has seen it.
              </li>
              <li>
                3. It is credited once the network has{' '}
                <strong className="text-ink">finalized</strong> it — usually within a minute. Until
                then it is not spendable, because a transaction below finality can still be
                reversed.
              </li>
            </ol>
            <p className="mt-4 text-xs text-muted">
              Your first deposit to this address holds back a small one-time network account
              minimum, which is shown separately on the Activity page.
            </p>
          </Card>
        </>
      ) : null}
    </div>
  );
}

/**
 * A QR code rendered as an SVG, with no dependency.
 *
 * A full QR encoder is a real library; this deliberately is not one. It renders
 * a placeholder that makes the address scannable-looking only when a proper
 * encoder is wired in. Rather than ship a fake that appears to work and does
 * not, it links out until then.
 */
function QrCode({ value }: { value: string }) {
  return (
    <a
      href={`https://solscan.io/account/${value}`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sm text-accent underline"
    >
      View on explorer
    </a>
  );
}
