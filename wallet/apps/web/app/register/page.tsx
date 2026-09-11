'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { emailSchema } from '@wallet/types';
import { usePasskey } from '@/hooks/use-passkey';
import { useSession } from '@/hooks/use-session';
import { Button, ErrorNotice, Field, Input } from '@/components/ui';
import { AuthPanel } from '@/components/auth-panel';

export default function RegisterPage() {
  const router = useRouter();
  const { setSession } = useSession();
  const { state, register } = usePasskey();

  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [emailError, setEmailError] = useState<string | undefined>();

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();

    // Client-side validation is for the user's benefit only. The server
    // validates the same schema again, and that is the one that counts
    // (rule 164, master-prompt rule 76).
    if (email.length > 0) {
      const parsed = emailSchema.safeParse(email);
      if (!parsed.success) {
        setEmailError('That does not look like an email address.');
        return;
      }
    }
    setEmailError(undefined);

    const session = await register({
      ...(email.length > 0 ? { email } : {}),
      ...(displayName.length > 0 ? { displayName } : {}),
      deviceName: 'This device',
    });

    if (session) {
      setSession(session);
      router.push('/dashboard');
    }
  }

  return (
    <AuthPanel
      title="Create your account"
      description="You will sign in with a passkey. There is no password and no seed phrase to write down."
      footer={
        <>
          Already have an account?{' '}
          <Link
            href="/login"
            className="text-accent transition-colors duration-micro ease-atlas hover:text-accent-strong"
          >
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-5">
        <Field
          label="Email (optional)"
          hint="Used to identify your account. You can add it later."
          error={emailError}
        >
          <Input
            type="email"
            value={email}
            autoComplete="username webauthn"
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </Field>

        <Field label="Display name (optional)">
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your name"
          />
        </Field>

        {state.error !== null && (
          <ErrorNotice message={state.error} correlationId={state.correlationId} />
        )}

        <Button type="submit" disabled={state.busy} size="lg" className="w-full">
          {state.busy ? 'Waiting for your passkey…' : 'Create account with a passkey'}
        </Button>
      </form>
    </AuthPanel>
  );
}
