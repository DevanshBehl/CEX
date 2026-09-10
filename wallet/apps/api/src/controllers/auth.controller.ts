import type { FastifyRequest } from 'fastify';
import type {
  CurrentSessionResponse,
  ListCredentialsResponse,
  ListSessionsResponse,
  LoginOptionsResponse,
  RegisterOptionsResponse,
  StepUpOptionsResponse,
  StepUpVerifyResponse,
  TotpEnrollResponse,
  TotpVerifyResponse,
} from '@wallet/types';
import type { AppDeps, RequestMeta } from '../services/deps.js';
import { requireSessionRecord } from '../middleware/guards.js';
import type { AccountService } from '../services/account.service.js';
import { toUserSummary } from '../services/account.service.js';
import type { LoginService } from '../services/login.service.js';
import type { RegistrationService } from '../services/registration.service.js';
import type { StepUpService } from '../services/step-up.service.js';
import type { TotpEnrollmentService } from '../services/totp.service.js';

/**
 * Controllers translate a validated HTTP request into an application command
 * and the result back into a response body (rule 62).
 *
 * They hold no domain rules. If a rule appears here it belongs one layer down,
 * where it can be tested without constructing a request.
 */
export interface AuthControllers {
  beginRegistration(request: FastifyRequest): Promise<RegisterOptionsResponse>;
  finishRegistration(
    request: FastifyRequest,
  ): Promise<{ sessionToken: string | null; body: CurrentSessionResponse }>;
  beginLogin(): Promise<LoginOptionsResponse>;
  finishLogin(
    request: FastifyRequest,
  ): Promise<{ sessionToken: string; body: CurrentSessionResponse }>;
  logout(userId: string, sessionId: string, request: FastifyRequest): Promise<void>;
  currentSession(request: FastifyRequest): Promise<CurrentSessionResponse>;
  beginStepUp(request: FastifyRequest): Promise<StepUpOptionsResponse>;
  finishStepUp(request: FastifyRequest): Promise<StepUpVerifyResponse>;
  listCredentials(request: FastifyRequest): Promise<ListCredentialsResponse>;
  revokeCredential(request: FastifyRequest): Promise<void>;
  listSessions(request: FastifyRequest): Promise<ListSessionsResponse>;
  revokeSession(request: FastifyRequest): Promise<void>;
  enrollTotp(request: FastifyRequest): Promise<TotpEnrollResponse>;
  confirmTotp(request: FastifyRequest): Promise<TotpVerifyResponse>;
  disableTotp(request: FastifyRequest): Promise<void>;
}

export interface AuthControllerDeps {
  readonly app: AppDeps;
  readonly registration: RegistrationService;
  readonly login: LoginService;
  readonly stepUp: StepUpService;
  readonly account: AccountService;
  readonly totp: TotpEnrollmentService;
  readonly stepUpMaxAgeSeconds: number;
}

export function createAuthControllers(deps: AuthControllerDeps): AuthControllers {
  const meta = (request: FastifyRequest): RequestMeta => ({
    ip: request.ip,
    userAgent: headerOf(request, 'user-agent'),
    correlationId: request.correlationId,
    sessionId: request.session?.id,
  });

  async function sessionBody(userId: string, sessionId: string): Promise<CurrentSessionResponse> {
    const [user, credentials, sessions] = await Promise.all([
      deps.app.users.findById(userId),
      deps.app.credentials.listActiveByUser(userId),
      deps.app.sessions.list(userId),
    ]);
    if (!user) throw new Error(`session ${sessionId} outlived its user`);
    const session = sessions.find((s) => s.id === sessionId);

    return {
      user: toUserSummary(user),
      session: {
        id: sessionId,
        createdAt: (session?.createdAt ?? new Date()).toISOString(),
        lastSeenAt: (session?.lastSeenAt ?? new Date()).toISOString(),
        expiresAt: (session?.expiresAt ?? new Date()).toISOString(),
        stepUpAt: session?.stepUpAt?.toISOString() ?? null,
      },
      factors: [...new Set(credentials.map((c) => c.type))],
    };
  }

  return {
    async beginRegistration(request) {
      const body = request.body as { email?: string; displayName?: string };
      // An authenticated caller is adding another passkey to their own account
      // rather than creating one (rule 116).
      return deps.registration.begin({
        email: body.email,
        displayName: body.displayName,
        userId: request.userId,
      });
    },

    async finishRegistration(request) {
      const body = request.body as {
        ceremonyId: string;
        credential: never;
        deviceName?: string;
      };
      const result = await deps.registration.finish({
        ceremonyId: body.ceremonyId,
        credential: body.credential,
        deviceName: body.deviceName,
        userId: request.userId,
        meta: meta(request),
      });

      const sessions = await deps.app.sessions.list(result.userId);
      const sessionId = request.session?.id ?? sessions[0]?.id ?? '';
      return {
        sessionToken: result.sessionToken,
        body: await sessionBody(result.userId, sessionId),
      };
    },

    async beginLogin() {
      return deps.login.begin();
    },

    async finishLogin(request) {
      const body = request.body as { ceremonyId: string; credential: never };
      const result = await deps.login.finish({
        ceremonyId: body.ceremonyId,
        credential: body.credential,
        meta: meta(request),
      });
      const sessions = await deps.app.sessions.list(result.userId);
      const sessionId = sessions[0]?.id ?? '';
      return {
        sessionToken: result.sessionToken,
        body: await sessionBody(result.userId, sessionId),
      };
    },

    async logout(userId, sessionId, request) {
      await deps.account.revokeSession(userId, sessionId, meta(request));
    },

    async currentSession(request) {
      const { session, userId } = requireSessionRecord(request);
      return sessionBody(userId, session.id);
    },

    async beginStepUp(request) {
      const { userId } = requireSessionRecord(request);
      return deps.stepUp.begin(userId);
    },

    async finishStepUp(request) {
      const { session } = requireSessionRecord(request);
      const body = request.body as { ceremonyId: string; credential: never };
      const { steppedUpAt } = await deps.stepUp.finish({
        ceremonyId: body.ceremonyId,
        credential: body.credential,
        session,
        meta: meta(request),
      });
      return {
        ok: true,
        steppedUpAt: steppedUpAt.toISOString(),
        validForSeconds: deps.stepUpMaxAgeSeconds,
      };
    },

    async listCredentials(request) {
      const { userId } = requireSessionRecord(request);
      return deps.account.listCredentials(userId);
    },

    async revokeCredential(request) {
      const { userId } = requireSessionRecord(request);
      const { id } = request.params as { id: string };
      await deps.account.revokeCredential(userId, id, meta(request));
    },

    async listSessions(request) {
      const { session, userId } = requireSessionRecord(request);
      return deps.account.listSessions(userId, session.id);
    },

    async revokeSession(request) {
      const { userId } = requireSessionRecord(request);
      const { id } = request.params as { id: string };
      await deps.account.revokeSession(userId, id, meta(request));
    },

    async enrollTotp(request) {
      const { userId } = requireSessionRecord(request);
      const user = await deps.app.users.findById(userId);
      return deps.totp.enroll(userId, user?.email ?? user?.displayName ?? userId);
    },

    async confirmTotp(request) {
      const { userId } = requireSessionRecord(request);
      const body = request.body as { enrollmentId: string; code: string };
      return deps.totp.confirm({
        userId,
        enrollmentId: body.enrollmentId,
        code: body.code,
        meta: meta(request),
      });
    },

    async disableTotp(request) {
      const { userId } = requireSessionRecord(request);
      await deps.totp.disable(userId, meta(request));
    },
  };
}

function headerOf(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
