'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { usePasskey } from '@/hooks/use-passkey';
import { useSession } from '@/hooks/use-session';
import { Button, Card, ErrorNotice } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const { setSession } = useSession();
  const { state, login } = usePasskey();

  async function onSignIn() {
    const session = await login();
    if (session) {
      setSession(session);
      router.push('/dashboard');
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <Card title="Sign in" description="Your passkey identifies you — there is nothing to type.">
        {state.error !== null && (
          <div className="mb-4">
            <ErrorNotice message={state.error} correlationId={state.correlationId} />
          </div>
        )}

        <Button onClick={onSignIn} disabled={state.busy} className="w-full">
          {state.busy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
        </Button>

        <p className="mt-4 text-sm text-muted">
          No account yet?{' '}
          <Link href="/register" className="text-accent underline">
            Create one
          </Link>
        </p>
      </Card>
    </div>
  );
}
