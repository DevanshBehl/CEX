import {
  currentSessionResponseSchema,
  listCredentialsResponseSchema,
  listSessionsResponseSchema,
  loginOptionsResponseSchema,
  meResponseSchema,
  okSchema,
  registerOptionsResponseSchema,
  stepUpOptionsResponseSchema,
  stepUpVerifyResponseSchema,
  totpEnrollResponseSchema,
  totpVerifyResponseSchema,
  type AuthenticationResponse,
  type CurrentSessionResponse,
  type ListCredentialsResponse,
  type ListSessionsResponse,
  type MeResponse,
  type RegistrationResponse,
  type TotpEnrollResponse,
  type TotpVerifyResponse,
} from '@wallet/types';
import { request } from './client';

/**
 * The typed surface every component uses (rules 161-162).
 *
 * Request and response types come from the same Zod schemas the API validates
 * against — one definition, two consumers, so a contract change is a
 * compile error on this side rather than a runtime surprise.
 */
export const api = {
  // --- registration ---
  beginRegistration: (body: { email?: string; displayName?: string }) =>
    request({
      method: 'POST',
      path: '/auth/register/options',
      body,
      schema: registerOptionsResponseSchema,
    }),

  finishRegistration: (body: {
    ceremonyId: string;
    credential: RegistrationResponse;
    deviceName?: string;
  }): Promise<CurrentSessionResponse> =>
    request({
      method: 'POST',
      path: '/auth/register/verify',
      body,
      schema: currentSessionResponseSchema,
    }),

  // --- login ---
  beginLogin: (body: { email?: string } = {}) =>
    request({
      method: 'POST',
      path: '/auth/login/options',
      body,
      schema: loginOptionsResponseSchema,
    }),

  finishLogin: (body: {
    ceremonyId: string;
    credential: AuthenticationResponse;
  }): Promise<CurrentSessionResponse> =>
    request({
      method: 'POST',
      path: '/auth/login/verify',
      body,
      schema: currentSessionResponseSchema,
    }),

  logout: () => request({ method: 'POST', path: '/auth/logout', body: {}, schema: okSchema }),

  currentSession: (): Promise<CurrentSessionResponse> =>
    request({ method: 'GET', path: '/auth/session', schema: currentSessionResponseSchema }),

  // --- step-up ---
  beginStepUp: () =>
    request({
      method: 'POST',
      path: '/auth/step-up/options',
      body: {},
      schema: stepUpOptionsResponseSchema,
    }),

  finishStepUp: (body: { ceremonyId: string; credential: AuthenticationResponse }) =>
    request({
      method: 'POST',
      path: '/auth/step-up/verify',
      body,
      schema: stepUpVerifyResponseSchema,
    }),

  // --- credentials ---
  listCredentials: (): Promise<ListCredentialsResponse> =>
    request({ method: 'GET', path: '/auth/credentials', schema: listCredentialsResponseSchema }),

  revokeCredential: (id: string) =>
    request({ method: 'DELETE', path: `/auth/credentials/${id}`, schema: okSchema }),

  // --- sessions ---
  listSessions: (): Promise<ListSessionsResponse> =>
    request({ method: 'GET', path: '/auth/sessions', schema: listSessionsResponseSchema }),

  revokeSession: (id: string) =>
    request({ method: 'DELETE', path: `/auth/sessions/${id}`, schema: okSchema }),

  // --- 2fa ---
  enrollTotp: (): Promise<TotpEnrollResponse> =>
    request({
      method: 'POST',
      path: '/auth/2fa/enroll',
      body: {},
      schema: totpEnrollResponseSchema,
    }),

  verifyTotp: (body: { enrollmentId: string; code: string }): Promise<TotpVerifyResponse> =>
    request({ method: 'POST', path: '/auth/2fa/verify', body, schema: totpVerifyResponseSchema }),

  disableTotp: () => request({ method: 'DELETE', path: '/auth/2fa', schema: okSchema }),

  // --- profile ---
  me: (): Promise<MeResponse> => request({ method: 'GET', path: '/me', schema: meResponseSchema }),

  updateMe: (body: { displayName?: string; email?: string }): Promise<MeResponse> =>
    request({ method: 'PATCH', path: '/me', body, schema: meResponseSchema }),
};
