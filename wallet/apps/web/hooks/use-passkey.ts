'use client';

import { useCallback, useState } from 'react';
import {
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import type { AuthenticationResponse, RegistrationResponse } from '@wallet/types';
import { api, ApiError, TransportError } from '@/lib/api';

export interface PasskeyState {
  readonly busy: boolean;
  readonly error: string | null;
  readonly correlationId: string | null;
}

const IDLE: PasskeyState = { busy: false, error: null, correlationId: null };

/**
 * Reusable client-side behaviour for the three WebAuthn ceremonies (rule 60).
 *
 * The components that use this render buttons and messages; none of them know
 * what a ceremony is. Ceremony state lives here so registration, login, and
 * step-up do not each grow their own copy of the same try/catch.
 */
export function usePasskey() {
  const [state, setState] = useState<PasskeyState>(IDLE);

  const run = useCallback(async <T>(work: () => Promise<T>): Promise<T | null> => {
    setState({ busy: true, error: null, correlationId: null });
    try {
      const result = await work();
      setState(IDLE);
      return result;
    } catch (error) {
      setState({
        busy: false,
        error: describe(error),
        // Shown on the error surface so a user can quote it (rule 167).
        correlationId: error instanceof ApiError ? error.correlationId : null,
      });
      return null;
    }
  }, []);

  const register = useCallback(
    (input: { email?: string; displayName?: string; deviceName?: string }) =>
      run(async () => {
        const { options, ceremonyId } = await api.beginRegistration({
          ...(input.email !== undefined ? { email: input.email } : {}),
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        });
        const credential = (await startRegistration({
          optionsJSON: options as never,
        })) as RegistrationResponseJSON;
        return api.finishRegistration({
          ceremonyId,
          credential: credential as unknown as RegistrationResponse,
          ...(input.deviceName !== undefined ? { deviceName: input.deviceName } : {}),
        });
      }),
    [run],
  );

  const login = useCallback(
    () =>
      run(async () => {
        const { options, ceremonyId } = await api.beginLogin();
        const credential = (await startAuthentication({
          optionsJSON: options as never,
        })) as AuthenticationResponseJSON;
        return api.finishLogin({
          ceremonyId,
          credential: credential as unknown as AuthenticationResponse,
        });
      }),
    [run],
  );

  const stepUp = useCallback(
    () =>
      run(async () => {
        const { options, ceremonyId } = await api.beginStepUp();
        const credential = (await startAuthentication({
          optionsJSON: options as never,
        })) as AuthenticationResponseJSON;
        return api.finishStepUp({
          ceremonyId,
          credential: credential as unknown as AuthenticationResponse,
        });
      }),
    [run],
  );

  return { state, register, login, stepUp, reset: () => setState(IDLE) };
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TransportError) return error.message;
  if (error instanceof Error) {
    // WebAuthn surfaces user cancellation as NotAllowedError; saying "failed"
    // for something the user deliberately dismissed is just noise.
    if (error.name === 'NotAllowedError') return 'The passkey prompt was dismissed.';
    if (error.name === 'InvalidStateError') {
      return 'This device already has a passkey for this account.';
    }
  }
  return 'Something went wrong. Please try again.';
}
