import type { CredentialType, UserStatus } from '@prisma/client';

export type { CredentialType, UserStatus };

export interface UserRecord {
  id: string;
  email: string | null;
  displayName: string | null;
  emailVerifiedAt: Date | null;
  status: UserStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebAuthnCredentialRecord {
  id: string;
  userId: string;
  credentialId: Uint8Array;
  publicKey: Uint8Array;
  signCount: bigint;
  transports: string[];
  aaguid: string | null;
  backedUp: boolean | null;
  deviceName: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface CredentialSummaryRecord {
  id: string;
  userId: string;
  type: CredentialType;
  deviceName: string | null;
  transports: string[];
  backedUp: boolean | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export interface SessionRecord {
  id: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  ip: string | null;
  userAgent: string | null;
  stepUpAt: Date | null;
}

/**
 * `| undefined` is spelled out on every optional field because the monorepo
 * runs with `exactOptionalPropertyTypes`. Under that flag `field?: string`
 * means "absent or a string" and explicitly NOT "undefined", so passing an
 * `ip` that happens to be undefined would be a type error at every call site.
 */
export interface AuditEntry {
  actorUserId?: string | null | undefined;
  event: string;
  targetType?: string | null | undefined;
  targetId?: string | null | undefined;
  metadata?: Record<string, string | number | boolean | string[] | null> | undefined;
  correlationId?: string | null | undefined;
  ip?: string | null | undefined;
}
