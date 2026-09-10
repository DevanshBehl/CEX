'use client';

import Link from 'next/link';
import { useSession } from '@/hooks/use-session';
import { Button, Card } from '@/components/ui';

export default function HomePage() {
  const { state } = useSession();

  return (
    <div className="space-y-6">
      <Card
        title="MPC custodial wallet"
        description="Phase 1 — identity and foundations. No wallets, balances, or transfers exist yet."
      >
        <div className="flex gap-3">
          {state.status === 'authenticated' ? (
            <Link href="/dashboard">
              <Button>Go to dashboard</Button>
            </Link>
          ) : (
            <>
              <Link href="/register">
                <Button>Create an account</Button>
              </Link>
              <Link href="/login">
                <Button variant="secondary">Sign in</Button>
              </Link>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
