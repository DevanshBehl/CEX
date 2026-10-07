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
  bookResponseSchema,
  cancelAllResponseSchema,
  listCandlesResponseSchema,
  listFillsResponseSchema,
  listMarketsResponseSchema,
  listOrdersResponseSchema,
  listTradesResponseSchema,
  listTradingBalancesResponseSchema,
  orderResponseSchema,
  type BookResponse,
  type CancelAllResponse,
  type CandleInterval,
  type ListCandlesResponse,
  type ListFillsResponse,
  type ListMarketsResponse,
  type ListOrdersResponse,
  type ListTradesResponse,
  type ListTradingBalancesResponse,
  type OrderResponse,
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

  // --- trading (S3-S5) ---
  // The cluster is never in a path or a body: it is the request's context
  // (ADR-0021), set once, in ./cluster.ts.
  listMarkets: (): Promise<ListMarketsResponse> =>
    request({ method: 'GET', path: '/markets', schema: listMarketsResponseSchema }),

  listTradingBalances: (): Promise<ListTradingBalancesResponse> =>
    request({
      method: 'GET',
      path: '/trading/balances',
      schema: listTradingBalancesResponseSchema,
    }),

  placeOrder: (body: {
    market: string;
    side: 'buy' | 'sell';
    type: 'limit' | 'market';
    timeInForce: 'GTC' | 'IOC' | 'FOK';
    price: string | null;
    qty: string;
    postOnly: boolean;
    /** ONE per intent, reused on every retry of it (rule 152). */
    clientOrderId: string;
  }): Promise<OrderResponse> =>
    request({ method: 'POST', path: '/orders', body, schema: orderResponseSchema }),

  listOrders: (query: {
    market?: string;
    status?: 'open' | 'all';
    limit?: number;
    before?: string;
  }): Promise<ListOrdersResponse> =>
    request({
      method: 'GET',
      path: `/orders${toQuery(query)}`,
      schema: listOrdersResponseSchema,
    }),

  cancelOrder: (id: string): Promise<OrderResponse> =>
    request({ method: 'DELETE', path: `/orders/${id}`, schema: orderResponseSchema }),

  cancelAllOrders: (market: string): Promise<CancelAllResponse> =>
    request({
      method: 'DELETE',
      path: `/orders${toQuery({ market })}`,
      schema: cancelAllResponseSchema,
    }),

  /** Cancel-replace: the response is the REPLACEMENT, a new order. */
  amendOrder: (
    id: string,
    body: { clientOrderId: string; price: string; qty: string },
  ): Promise<OrderResponse> =>
    request({ method: 'PATCH', path: `/orders/${id}`, body, schema: orderResponseSchema }),

  listFills: (query: {
    market?: string;
    limit?: number;
    before?: string;
  }): Promise<ListFillsResponse> =>
    request({ method: 'GET', path: `/fills${toQuery(query)}`, schema: listFillsResponseSchema }),

  /** Moves funds ON-CHAIN, behind a step-up. The response is the transfer itself. */
  allocate: (body: {
    asset: string;
    amount: string;
    idempotencyKey: string;
  }): Promise<WithdrawalResponse> =>
    request({ method: 'POST', path: '/allocations', body, schema: withdrawalResponseSchema }),

  deallocate: (body: {
    asset: string;
    amount: string;
    idempotencyKey: string;
  }): Promise<WithdrawalResponse> =>
    request({ method: 'POST', path: '/deallocations', body, schema: withdrawalResponseSchema }),

  // --- market data (S5) ---
  getBook: (market: string): Promise<BookResponse> =>
    request({ method: 'GET', path: `/markets/${market}/book`, schema: bookResponseSchema }),

  listTrades: (
    market: string,
    query: { limit?: number; before?: string } = {},
  ): Promise<ListTradesResponse> =>
    request({
      method: 'GET',
      path: `/markets/${market}/trades${toQuery(query)}`,
      schema: listTradesResponseSchema,
    }),

  listCandles: (
    market: string,
    query: { interval: CandleInterval; limit?: number },
  ): Promise<ListCandlesResponse> =>
    request({
      method: 'GET',
      path: `/markets/${market}/candles${toQuery(query)}`,
      schema: listCandlesResponseSchema,
    }),
};

/** `{ a: 1, b: undefined }` -> `?a=1`. Absent values are omitted, never sent as text. */
function toQuery(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) params.set(name, String(value));
  }
  const text = params.toString();
  return text.length > 0 ? `?${text}` : '';
}
