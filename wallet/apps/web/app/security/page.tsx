'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CredentialSummary, SessionSummary } from '@wallet/types';
import { api, ApiError } from '@/lib/api';
import { usePasskey } from '@/hooks/use-passkey';
import { useSession } from '@/hooks/use-session';
import { useStepUpAction } from '@/features/security/use-step-up';
import {
  Button,
  Section,
  ErrorNotice,
  Field,
  Input,
  Modal,
  Spinner,
  StatusBadge,
  PageHeader,
} from '@/components/ui';

/**
 * The security page is fully functional in Phase 1 (rule 158) — it is the one
 * screen where everything Phase 1 built is actually usable: passkeys, sessions,
 * step-up, and 2FA.
 */
export default function SecurityPage() {
  const { state, refresh } = useSession();
  const { register, state: passkeyState } = usePasskey();
  const stepUpAction = useStepUpAction();

  const [credentials, setCredentials] = useState<CredentialSummary[] | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([api.listCredentials(), api.listSessions()]);
      setCredentials(c.credentials);
      setSessions(s.sessions);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your security settings.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status !== 'authenticated') return null;

  const hasTotp = state.data.factors.includes('totp');

  return (
    <div className="max-w-3xl animate-fade-up space-y-3">
      <PageHeader
        title="Security"
        description="Passkeys, two-factor authentication, and the devices signed in to this account."
      />

      {loadError !== null && <ErrorNotice message={loadError} />}
      {stepUpAction.error !== null && (
        <ErrorNotice
          message={stepUpAction.error.message}
          correlationId={stepUpAction.error.correlationId}
        />
      )}

      {/* --- Passkeys --- */}
      <Section
        title="Passkeys"
        description="Keep at least two. A single passkey on a single device is one lost device away from losing access."
      >
        {credentials === null ? (
          <Spinner label="Loading passkeys…" />
        ) : (
          <ul className="divide-y divide-line">
            {credentials
              .filter((c) => c.type === 'webauthn')
              .map((credential) => (
                <li
                  key={credential.id}
                  className="flex items-center justify-between gap-4 py-3 first:pt-0"
                >
                  <div>
                    <p className="text-sm font-semibold">{credential.deviceName ?? 'Passkey'}</p>
                    <p className="text-xs text-ink-muted">
                      Added {new Date(credential.createdAt).toLocaleDateString()}
                      {credential.lastUsedAt !== null &&
                        ` · last used ${new Date(credential.lastUsedAt).toLocaleDateString()}`}
                      {credential.backedUp === true && ' · synced'}
                    </p>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={stepUpAction.busy}
                    onClick={async () => {
                      const ok = await stepUpAction.run(() => api.revokeCredential(credential.id));
                      if (ok) await load();
                    }}
                  >
                    Remove
                  </Button>
                </li>
              ))}
          </ul>
        )}

        <div className="mt-4">
          <Button
            variant="secondary"
            size="sm"
            disabled={passkeyState.busy}
            onClick={async () => {
              const result = await register({ deviceName: 'This device' });
              if (result) {
                await load();
                await refresh();
              }
            }}
          >
            {passkeyState.busy ? 'Waiting for your passkey…' : 'Add a passkey'}
          </Button>
          {passkeyState.error !== null && (
            <div className="mt-3">
              <ErrorNotice
                message={passkeyState.error}
                correlationId={passkeyState.correlationId}
              />
            </div>
          )}
        </div>
      </Section>

      {/* --- Two-factor --- */}
      <TwoFactorCard
        enabled={hasTotp}
        onChanged={async () => {
          await load();
          await refresh();
        }}
      />

      {/* --- Sessions --- */}
      <Section
        title="Active sessions"
        description="Revoking a session signs that device out immediately."
      >
        {sessions === null ? (
          <Spinner label="Loading sessions…" />
        ) : (
          <ul className="divide-y divide-line">
            {sessions.map((session) => (
              <li
                key={session.id}
                className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
              >
                <div>
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    {session.ip ?? 'unknown address'}
                    {session.current && <StatusBadge tone="good">This device</StatusBadge>}
                  </p>
                  <p className="text-xs text-ink-muted">
                    Last seen {new Date(session.lastSeenAt).toLocaleString()}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    await api.revokeSession(session.id);
                    if (session.current) {
                      window.location.href = '/login';
                    } else {
                      await load();
                    }
                  }}
                >
                  {session.current ? 'Sign out' : 'Revoke'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function TwoFactorCard({
  enabled,
  onChanged,
}: {
  enabled: boolean;
  onChanged: () => Promise<void>;
}) {
  const stepUpAction = useStepUpAction();
  const [enrollment, setEnrollment] = useState<{
    secret: string;
    enrollmentId: string;
    uri: string;
  } | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <Section
      title="Two-factor authentication"
      description="An authenticator app as a second factor, on top of your passkey."
    >
      <div className="flex items-center gap-3">
        <StatusBadge tone={enabled ? 'good' : 'neutral'}>
          {enabled ? 'Enabled' : 'Not enabled'}
        </StatusBadge>

        {enabled ? (
          <Button
            variant="danger"
            size="sm"
            disabled={stepUpAction.busy}
            onClick={async () => {
              const ok = await stepUpAction.run(() => api.disableTotp());
              if (ok) await onChanged();
            }}
          >
            Turn off
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            disabled={stepUpAction.busy}
            onClick={async () => {
              setError(null);
              await stepUpAction.run(async () => {
                const result = await api.enrollTotp();
                setEnrollment({
                  secret: result.secret,
                  enrollmentId: result.enrollmentId,
                  uri: result.otpauthUri,
                });
              });
            }}
          >
            Set up
          </Button>
        )}
      </div>

      {stepUpAction.error !== null && (
        <div className="mt-3">
          <ErrorNotice
            message={stepUpAction.error.message}
            correlationId={stepUpAction.error.correlationId}
          />
        </div>
      )}

      <Modal
        open={enrollment !== null && recoveryCodes === null}
        title="Set up two-factor"
        onClose={() => setEnrollment(null)}
      >
        {enrollment !== null && (
          <div className="space-y-4">
            <p className="text-sm text-ink-muted">
              Add this secret to your authenticator app, then enter the code it shows.
            </p>
            <code className="block break-all rounded-md border border-line bg-background-subtle p-3 font-mono text-xs">
              {enrollment.secret}
            </code>

            <Field label="Six-digit code">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                maxLength={6}
              />
            </Field>

            {error !== null && <ErrorNotice message={error} />}

            <Button
              disabled={code.length !== 6}
              onClick={async () => {
                try {
                  const result = await api.verifyTotp({
                    enrollmentId: enrollment.enrollmentId,
                    code,
                  });
                  setRecoveryCodes(result.recoveryCodes);
                  await onChanged();
                } catch (e) {
                  setError(e instanceof ApiError ? e.message : 'That code was not accepted.');
                }
              }}
            >
              Confirm
            </Button>
          </div>
        )}
      </Modal>

      {/* Shown exactly once — there is no endpoint that returns these again. */}
      <Modal
        open={recoveryCodes !== null}
        title="Save your recovery codes"
        onClose={() => {
          setRecoveryCodes(null);
          setEnrollment(null);
          setCode('');
        }}
      >
        <p className="text-sm text-ink-muted">
          These are shown once and cannot be retrieved later. Store them somewhere safe — each one
          works a single time.
        </p>
        <ul className="mt-4 grid grid-cols-2 gap-2 font-mono text-xs">
          {recoveryCodes?.map((rc) => (
            <li key={rc} className="rounded-md border border-line bg-background-subtle px-2 py-1.5">
              {rc}
            </li>
          ))}
        </ul>
      </Modal>
    </Section>
  );
}
