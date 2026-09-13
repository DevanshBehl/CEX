import {
  capabilitiesResponseSchema,
  type CapabilitiesResponse,
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
  depositAddressResponseSchema,
  depositResponseSchema,
  listAddressesResponseSchema,
  listBalancesResponseSchema,
  listDepositsResponseSchema,
  portfolioHistoryResponseSchema,
  portfolioSummaryResponseSchema,
  type DepositAddressResponse,
  type DepositResponse,
  type ListAddressesResponse,
  type ListBalancesResponse,
  type ListDepositsResponse,
  type PortfolioHistoryResponse,
  type PortfolioSummaryResponse,
  listWithdrawalsResponseSchema,
  withdrawalResponseSchema,
  listReviewQueueResponseSchema,
  type ListWithdrawalsResponse,
  type WithdrawalResponse,
  type ListReviewQueueResponse,
} from '@wallet/types';
import { request } from './client';

/** The ranges the chart offers. Mirrors the server's `PortfolioRange`. */
export type PortfolioRangeName = '24h' | '7d' | '30d' | 'all';

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

  /**
   * What this deployment can actually do (rules 236-237).
   *
   * Asked rather than assumed: hardcoded copy about custody goes stale
   * silently, and stale copy about custody is worse than none.
   */
  getCapabilities: (): Promise<CapabilitiesResponse> =>
    request({ method: 'GET', path: '/capabilities', schema: capabilitiesResponseSchema }),

  // --- custody (Phase 2) ---
  getDepositAddress: (): Promise<DepositAddressResponse> =>
    request({
      method: 'POST',
      path: '/wallets/addresses',
      body: {},
      schema: depositAddressResponseSchema,
    }),

  listAddresses: (walletId: string): Promise<ListAddressesResponse> =>
    request({
      method: 'GET',
      path: `/wallets/${walletId}/addresses`,
      schema: listAddressesResponseSchema,
    }),

  listBalances: (): Promise<ListBalancesResponse> =>
    request({ method: 'GET', path: '/balances', schema: listBalancesResponseSchema }),

  // --- portfolio valuation (Task 3) ---
  getPortfolioSummary: (): Promise<PortfolioSummaryResponse> =>
    request({
      method: 'GET',
      path: '/portfolio/summary',
      schema: portfolioSummaryResponseSchema,
    }),

  getPortfolioHistory: (range: PortfolioRangeName): Promise<PortfolioHistoryResponse> =>
    request({
      method: 'GET',
      path: `/portfolio/history?range=${range}`,
      schema: portfolioHistoryResponseSchema,
    }),

  listDeposits: (): Promise<ListDepositsResponse> =>
    request({ method: 'GET', path: '/deposits', schema: listDepositsResponseSchema }),

  getDeposit: (id: string): Promise<DepositResponse> =>
    request({ method: 'GET', path: `/deposits/${id}`, schema: depositResponseSchema }),

  // --- withdrawals (Phase 3) ---
  requestWithdrawal: (body: {
    asset: string;
    amount: string;
    destination: string;
    idempotencyKey: string;
  }): Promise<WithdrawalResponse> =>
    request({ method: 'POST', path: '/withdrawals', body, schema: withdrawalResponseSchema }),

  listWithdrawals: (): Promise<ListWithdrawalsResponse> =>
    request({ method: 'GET', path: '/withdrawals', schema: listWithdrawalsResponseSchema }),

  getWithdrawal: (id: string): Promise<WithdrawalResponse> =>
    request({ method: 'GET', path: `/withdrawals/${id}`, schema: withdrawalResponseSchema }),

  // --- operator ---
  reviewQueue: (): Promise<ListReviewQueueResponse> =>
    request({
      method: 'GET',
      path: '/operator/review-queue',
      schema: listReviewQueueResponseSchema,
    }),

  approveWithdrawal: (id: string, note: string): Promise<WithdrawalResponse> =>
    request({
      method: 'POST',
      path: `/operator/withdrawals/${id}/approve`,
      body: { note },
      schema: withdrawalResponseSchema,
    }),

  rejectWithdrawal: (id: string, note: string): Promise<WithdrawalResponse> =>
    request({
      method: 'POST',
      path: `/operator/withdrawals/${id}/reject`,
      body: { note },
      schema: withdrawalResponseSchema,
    }),
};
