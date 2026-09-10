'use client';

import { useCallback, useState } from 'react';
import { ApiError } from '@/lib/api';
import { usePasskey } from '@/hooks/use-passkey';

/**
 * Wraps any action that the server may answer with STEP_UP_REQUIRED (rule 137).
 *
 * The flow is: try the action; if the server says a fresher assertion is
 * needed, run the step-up ceremony and try once more. The component calling
 * this does not have to know that step-up exists.
 *
 * Phase 3 wraps withdrawal submission in exactly this.
 */
export function useStepUpAction() {
  const { stepUp, state: passkeyState } = usePasskey();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; correlationId: string | null } | null>(
    null,
  );

  const run = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await action();
        return true;
      } catch (first) {
        if (!(first instanceof ApiError) || !first.needsStepUp) {
          setError({
            message: first instanceof Error ? first.message : 'Something went wrong.',
            correlationId: first instanceof ApiError ? first.correlationId : null,
          });
          return false;
        }

        // The server told us how fresh the assertion has to be; prompt for one.
        const stepped = await stepUp();
        if (!stepped) {
          setError({ message: 'Re-authentication was not completed.', correlationId: null });
          return false;
        }

        try {
          await action();
          return true;
        } catch (second) {
          setError({
            message: second instanceof Error ? second.message : 'Something went wrong.',
            correlationId: second instanceof ApiError ? second.correlationId : null,
          });
          return false;
        }
      } finally {
        setBusy(false);
      }
    },
    [stepUp],
  );

  return { run, busy: busy || passkeyState.busy, error, clearError: () => setError(null) };
}
