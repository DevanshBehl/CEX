/**
 * Grant or revoke an operator role (prompt_phase4.md rule 166).
 *
 *   pnpm --filter @wallet/api grant-role -- grant <userId> approver "on-call rotation"
 *   pnpm --filter @wallet/api grant-role -- revoke <userId> approver
 *   pnpm --filter @wallet/api grant-role -- list approver
 *   pnpm --filter @wallet/api grant-role -- history <userId>
 *
 * A CLI rather than an endpoint, deliberately. Granting operator authority is
 * the most privileged action in the system, and it should require shell access
 * to the host rather than a session on the web application — otherwise a
 * compromised operator session can mint more operators, and the role model
 * bounds nothing.
 */
import { loadApiConfigOrExit } from '@wallet/config';
import { createLogger, logSecurityEvent } from '@wallet/logger';
import {
  createPrismaClient,
  createOperatorRepository,
  OPERATOR_ROLES,
  type OperatorRoleName,
} from '@wallet/db';

const config = loadApiConfigOrExit();
const logger = createLogger({ level: config.shared.logLevel });

function usage(): never {
  process.stderr.write(
    [
      '',
      'Usage:',
      '  grant-role grant   <userId> <role> [reason]',
      '  grant-role revoke  <userId> <role>',
      '  grant-role list    <role>',
      '  grant-role history <userId>',
      '',
      `Roles: ${OPERATOR_ROLES.join(', ')}`,
      '',
      'custodian implies approver implies viewer.',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

function parseRole(value: string | undefined): OperatorRoleName {
  if (value === undefined || !OPERATOR_ROLES.includes(value as OperatorRoleName)) {
    process.stderr.write(`\nUnknown role: ${value ?? '(none)'}\n`);
    usage();
  }
  return value as OperatorRoleName;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const db = createPrismaClient({ url: config.database.url });
  const operators = createOperatorRepository(db);
  const out = process.stdout;

  switch (command) {
    case 'grant': {
      const [userId, roleArg, reason] = rest;
      if (userId === undefined) usage();
      const role = parseRole(roleArg);

      // The user must exist. Granting a role to a typo'd id would create a
      // live grant nobody holds, which reads as an operator who cannot sign in.
      const user = await db.user.findUnique({ where: { id: userId } });
      if (!user) {
        process.stderr.write(`\nNo such user: ${userId}\n\n`);
        process.exit(1);
      }

      await operators.grant({
        userId,
        role,
        // Null: this grant was made from a shell, not by another operator.
        // The bootstrap grant is the one with no human behind it, and the
        // record says so rather than attributing it to someone.
        grantedByUserId: null,
        ...(reason !== undefined ? { reason } : {}),
      });

      logSecurityEvent(logger, 'operator.role_granted', {
        outcome: 'success',
        userId,
        targetType: 'operator_role',
        targetId: role,
      });
      out.write(`\n  granted ${role} to ${userId}\n\n`);
      break;
    }

    case 'revoke': {
      const [userId, roleArg] = rest;
      if (userId === undefined) usage();
      const role = parseRole(roleArg);

      const revoked = await operators.revoke(userId, role);
      logSecurityEvent(logger, 'operator.role_revoked', {
        outcome: revoked ? 'success' : 'failure',
        userId,
        targetType: 'operator_role',
        targetId: role,
      });
      out.write(revoked ? `\n  revoked ${role} from ${userId}\n\n` : '\n  no live grant\n\n');
      break;
    }

    case 'list': {
      const role = parseRole(rest[0]);
      const holders = await operators.holders(role);
      out.write(`\n  ${role} (${String(holders.length)})\n`);
      for (const holder of holders) {
        out.write(`    ${holder.userId}  since ${holder.grantedAt.toISOString()}`);
        out.write(holder.reason !== null ? `  — ${holder.reason}\n` : '\n');
      }
      out.write('\n');
      break;
    }

    case 'history': {
      const [userId] = rest;
      if (userId === undefined) usage();
      const history = await operators.history(userId);
      out.write(`\n  ${userId}\n`);
      for (const grant of history) {
        const state =
          grant.revokedAt === null ? 'live' : `revoked ${grant.revokedAt.toISOString()}`;
        out.write(`    ${grant.role.padEnd(10)} ${grant.grantedAt.toISOString()}  ${state}\n`);
      }
      out.write('\n');
      break;
    }

    default:
      usage();
  }

  await db.$disconnect();
}

main().catch((error: unknown) => {
  logger.error('grant-role failed', {
    errorName: error instanceof Error ? error.name : typeof error,
  });
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exitCode = 1;
});
