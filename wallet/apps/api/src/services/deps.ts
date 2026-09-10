import type { ChallengeStore, SessionManager, TotpService, WebAuthnService } from '@wallet/auth';
import type {
  AuditLogRepository,
  CredentialRepository,
  PrismaClient,
  RecoveryCodeRepository,
  SessionRepository,
  UserRepository,
} from '@wallet/db';
import type { Logger } from '@wallet/logger';

/**
 * Everything a use case can reach, handed to it explicitly (rule 84/146).
 *
 * Nothing here is imported as a module-level singleton, which is what lets
 * Phase 3 inject a mock signer and Phase 4 a real one without editing a single
 * call site.
 */
export interface AppDeps {
  readonly db: PrismaClient;
  readonly users: UserRepository;
  readonly credentials: CredentialRepository;
  readonly sessionsRepo: SessionRepository;
  readonly recoveryCodes: RecoveryCodeRepository;
  readonly audit: AuditLogRepository;
  readonly sessions: SessionManager;
  readonly webauthn: WebAuthnService;
  readonly totp: TotpService;
  readonly challenges: ChallengeStore;
  readonly logger: Logger;
}

export interface RequestMeta {
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly correlationId: string;
  /**
   * The caller's own session, when there is one. Rule 128 revokes every OTHER
   * session on a credential change, so the one to keep has to be named — and
   * naming it with an empty string means Postgres tries to parse '' as a UUID.
   */
  readonly sessionId?: string | undefined;
}
