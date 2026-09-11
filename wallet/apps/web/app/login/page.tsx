'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { usePasskey } from '@/hooks/use-passkey';
import { useSession } from '@/hooks/use-session';
import { Button, ErrorNotice } from '@/components/ui';
import { AuthPanel } from '@/components/auth-panel';

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
    <AuthPanel
      title="Sign in"
      description="Your passkey identifies you — there is nothing to type."
      footer={
        <>
          No account yet?{' '}
          <Link
            href="/register"
            className="text-accent transition-colors duration-micro ease-atlas hover:text-accent-strong"
          >
            Create one
          </Link>
        </>
      }
    >
      {state.error !== null && (
        <div className="mb-4">
          <ErrorNotice message={state.error} correlationId={state.correlationId} />
        </div>
      )}

      <Button onClick={onSignIn} disabled={state.busy} size="lg" className="w-full">
        {state.busy ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
      </Button>
    </AuthPanel>
  );
}
