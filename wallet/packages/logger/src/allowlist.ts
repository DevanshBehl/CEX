/**
 * THE LOG FIELD ALLOWLIST (prompt_phase1.md rules 73-74).
 *
 * A field not named here is dropped before it reaches any output stream.
 *
 * This is an allowlist and not a denylist on purpose, and the purpose is worth
 * restating because the pressure to "just log the whole object" never goes
 * away: a denylist fails OPEN. The first time someone adds `totpSecret` to a
 * payload, a denylist logs it, because nobody remembered to add it to the list
 * of things not to log. An allowlist fails CLOSED — the new field is dropped,
 * the `droppedFields` counter goes up, and adding it requires editing this file,
 * which is a decision someone has to make on purpose.
 *
 * By Phase 4 the payloads flowing through this logger include signing requests.
 * That is what this file is defending (master-prompt rule 90).
 *
 * Adding a field here is a security decision. Justify it in the PR.
 */
export const LOGGABLE_FIELDS: ReadonlySet<string> = new Set([
  // Correlation (rules 69-71)
  'correlationId',
  'requestId',

  // Actors and subjects — identifiers only, never their contents
  'userId',
  'sessionId',
  'credentialId',
  'targetType',
  'targetId',
  'actorUserId',

  // HTTP
  'method',
  'route',
  'path',
  'statusCode',
  'durationMs',

  // Security events (rule 75)
  'event',
  'outcome',
  'reason',
  'factor',
  'credentialType',
  'deviceName',
  'transports',
  'backedUp',
  'signCountStored',
  'signCountReceived',

  // Client attribution — deliberately allowlisted: an audit trail without an
  // origin is not an audit trail. Treated as personal data downstream.
  'ip',
  'userAgent',

  // Errors — codes and class names only, never messages from drivers
  'errorCode',
  'errorName',
  'originalName',
  'isOperational',

  // Infrastructure
  'dependency',
  'latencyMs',
  'status',
  'queue',
  'attempt',
  'retryAfterSeconds',

  // Counters
  'count',
  'total',
]);

/**
 * Never loggable under any circumstances, even if someone adds the name to
 * LOGGABLE_FIELDS by mistake. A second lock on the same door (rule 77).
 */
export const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set([
  'password',
  'passwordHash',
  'token',
  'sessionToken',
  'secret',
  'sessionSecret',
  'totpSecret',
  'totpCode',
  'code',
  'recoveryCode',
  'recoveryCodes',
  'challenge',
  'privateKey',
  'publicKey',
  'keyShare',
  'share',
  'mnemonic',
  'seed',
  'signature',
  'authorization',
  'cookie',
  'setCookie',
  'body',
  'headers',
  'req',
  'res',
  'request',
  'response',
]);
