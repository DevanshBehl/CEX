import type { Executor } from '../transaction.js';
import { newId } from '../ids.js';
import type { CredentialSummaryRecord, WebAuthnCredentialRecord } from './types.js';

export interface CreateWebAuthnCredentialInput {
  userId: string;
  credentialId: Uint8Array;
  publicKey: Uint8Array;
  signCount: bigint;
  transports: string[];
  aaguid?: string | undefined;
  backedUp?: boolean | undefined;
  deviceName?: string | undefined;
}

export interface CredentialRepository {
  createWebAuthn(
    input: CreateWebAuthnCredentialInput,
    tx?: Executor,
  ): Promise<WebAuthnCredentialRecord>;
  findWebAuthnByCredentialId(
    credentialId: Uint8Array,
    tx?: Executor,
  ): Promise<WebAuthnCredentialRecord | null>;
  listActiveByUser(userId: string, tx?: Executor): Promise<CredentialSummaryRecord[]>;
  countActiveAuthFactors(userId: string, tx?: Executor): Promise<number>;
  recordUse(id: string, signCount: bigint | null, tx?: Executor): Promise<void>;
  revoke(id: string, userId: string, tx?: Executor): Promise<boolean>;
  findById(id: string, tx?: Executor): Promise<CredentialSummaryRecord | null>;
  createTotp(
    input: { userId: string; secretEncrypted: Uint8Array },
    tx?: Executor,
  ): Promise<{ id: string }>;
  confirmTotp(id: string, tx?: Executor): Promise<void>;
  findUnconfirmedTotp(
    id: string,
    userId: string,
    tx?: Executor,
  ): Promise<{ id: string; totpSecretEncrypted: Uint8Array | null } | null>;
  findConfirmedTotp(
    userId: string,
    tx?: Executor,
  ): Promise<{ id: string; totpSecretEncrypted: Uint8Array | null } | null>;
}

const SUMMARY_SELECT = {
  id: true,
  userId: true,
  type: true,
  deviceName: true,
  transports: true,
  backedUp: true,
  createdAt: true,
  lastUsedAt: true,
} as const;

export function createCredentialRepository(db: Executor): CredentialRepository {
  const exec = (tx?: Executor): Executor => tx ?? db;

  return {
    async createWebAuthn(input, tx) {
      const row = await exec(tx).credential.create({
        data: {
          id: newId(),
          userId: input.userId,
          type: 'webauthn',
          credentialId: Buffer.from(input.credentialId),
          publicKey: Buffer.from(input.publicKey),
          signCount: input.signCount,
          transports: input.transports,
          ...(input.aaguid !== undefined ? { aaguid: input.aaguid } : {}),
          ...(input.backedUp !== undefined ? { backedUp: input.backedUp } : {}),
          ...(input.deviceName !== undefined ? { deviceName: input.deviceName } : {}),
        },
      });
      return toWebAuthnRecord(row);
    },

    async findWebAuthnByCredentialId(credentialId, tx) {
      const row = await exec(tx).credential.findUnique({
        where: { credentialId: Buffer.from(credentialId) },
      });
      if (!row || row.type !== 'webauthn' || row.revokedAt !== null) return null;
      return toWebAuthnRecord(row);
    },

    async listActiveByUser(userId, tx) {
      return exec(tx).credential.findMany({
        where: { userId, revokedAt: null },
        select: SUMMARY_SELECT,
        orderBy: { createdAt: 'asc' },
      });
    },

    /**
     * Used to refuse revoking a user's last way in (rule 118). TOTP is a
     * SECOND factor, never a way in on its own, so it does not count here.
     */
    async countActiveAuthFactors(userId, tx) {
      return exec(tx).credential.count({
        where: { userId, revokedAt: null, type: { in: ['webauthn', 'password'] } },
      });
    },

    async recordUse(id, signCount, tx) {
      await exec(tx).credential.update({
        where: { id },
        data: {
          lastUsedAt: new Date(),
          ...(signCount !== null ? { signCount } : {}),
        },
      });
    },

    async revoke(id, userId, tx) {
      // Scoped by userId so one user can never revoke another's credential
      // even if an id leaks (master-prompt rule 161).
      const result = await exec(tx).credential.updateMany({
        where: { id, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return result.count === 1;
    },

    async findById(id, tx) {
      return exec(tx).credential.findUnique({ where: { id }, select: SUMMARY_SELECT });
    },

    async createTotp(input, tx) {
      const row = await exec(tx).credential.create({
        data: {
          id: newId(),
          userId: input.userId,
          type: 'totp',
          totpSecretEncrypted: Buffer.from(input.secretEncrypted),
        },
        select: { id: true },
      });
      return row;
    },

    async confirmTotp(id, tx) {
      await exec(tx).credential.update({
        where: { id },
        data: { totpConfirmedAt: new Date() },
      });
    },

    async findUnconfirmedTotp(id, userId, tx) {
      return exec(tx).credential.findFirst({
        where: { id, userId, type: 'totp', totpConfirmedAt: null, revokedAt: null },
        select: { id: true, totpSecretEncrypted: true },
      });
    },

    async findConfirmedTotp(userId, tx) {
      return exec(tx).credential.findFirst({
        where: { userId, type: 'totp', totpConfirmedAt: { not: null }, revokedAt: null },
        select: { id: true, totpSecretEncrypted: true },
      });
    },
  };
}

function toWebAuthnRecord(row: {
  id: string;
  userId: string;
  credentialId: Uint8Array | null;
  publicKey: Uint8Array | null;
  signCount: bigint | null;
  transports: string[];
  aaguid: string | null;
  backedUp: boolean | null;
  deviceName: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}): WebAuthnCredentialRecord {
  if (row.credentialId === null || row.publicKey === null) {
    throw new Error(`credential ${row.id} is marked webauthn but has no key material`);
  }
  return {
    id: row.id,
    userId: row.userId,
    credentialId: row.credentialId,
    publicKey: row.publicKey,
    signCount: row.signCount ?? 0n,
    transports: row.transports,
    aaguid: row.aaguid,
    backedUp: row.backedUp,
    deviceName: row.deviceName,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}
