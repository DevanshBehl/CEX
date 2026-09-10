export { createPrismaClient, type DbOptions, type PrismaClient } from './client.js';
export { newId } from './ids.js';
export { Prisma, withTransaction, type Executor, type TransactionOptions } from './transaction.js';

export * from './repositories/types.js';
export {
  createUserRepository,
  type CreateUserInput,
  type UserRepository,
} from './repositories/user.repository.js';
export {
  createCredentialRepository,
  type CreateWebAuthnCredentialInput,
  type CredentialRepository,
} from './repositories/credential.repository.js';
export {
  createSessionRepository,
  type CreateSessionInput,
  type SessionRepository,
} from './repositories/session.repository.js';
export {
  createRecoveryCodeRepository,
  type RecoveryCodeRepository,
} from './repositories/recovery-code.repository.js';
export {
  createAuditLogRepository,
  sanitizeMetadata,
  type AuditLogRepository,
} from './repositories/audit-log.repository.js';
