'use client';

import { useEffect, useState } from 'react';
import { emailSchema } from '@wallet/types';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/hooks/use-session';
import { Button, Card, ErrorNotice, Field, Input, PageHeader } from '@/components/ui';

export default function ProfilePage() {
  const { state, refresh } = useSession();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; correlationId: string | null } | null>(
    null,
  );
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (state.status === 'authenticated') {
      setDisplayName(state.data.user.displayName ?? '');
      setEmail(state.data.user.email ?? '');
    }
  }, [state]);

  if (state.status !== 'authenticated') return null;

  async function onSave(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);

    if (email.length > 0 && !emailSchema.safeParse(email).success) {
      setError({ message: 'That does not look like an email address.', correlationId: null });
      return;
    }

    setSaving(true);
    try {
      await api.updateMe({
        ...(displayName.length > 0 ? { displayName } : {}),
        ...(email.length > 0 ? { email } : {}),
      });
      await refresh();
      setSaved(true);
    } catch (e) {
      setError({
        message: e instanceof Error ? e.message : 'Could not save your profile.',
        correlationId: e instanceof ApiError ? e.correlationId : null,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-xl animate-fade-up">
      <PageHeader title="Profile" />
      <Card>
        <form onSubmit={onSave} className="space-y-4">
          <Field label="Display name">
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>

          {error !== null && (
            <ErrorNotice message={error.message} correlationId={error.correlationId} />
          )}
          {saved && <p className="text-sm text-success">Saved.</p>}

          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
