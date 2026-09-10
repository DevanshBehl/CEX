import { describe, expect, it } from 'vitest';
import { createCapturingLogger, logSecurityEvent, runWithContext } from './index.js';

/**
 * prompt_phase1.md rule 175 / master-prompt rule 90.
 *
 * The premise: throw every kind of secret this system will ever hold at the
 * logger, through every entry point, and assert none of it reaches the output.
 * This test is the executable form of the redaction guarantee — if it goes
 * green while the allowlist is weakened to a denylist, the weakening was
 * a mistake.
 */
const SECRETS = {
  password: 'correct-horse-battery-staple',
  passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$hash',
  sessionToken: 'sess_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c',
  sessionSecret: 'signing-secret-do-not-log-me-ever',
  totpSecret: 'JBSWY3DPEHPK3PXP',
  totpCode: '123456',
  recoveryCode: 'RC-AAAA-BBBB-CCCC',
  challenge: 'Y2hhbGxlbmdlLWJ5dGVz',
  privateKey: '-----BEGIN PRIVATE KEY-----MIIEvQ',
  // Phase 4 shapes, guarded from day one.
  keyShare: 'share:2:9a8b7c6d',
  mnemonic: 'abandon abandon abandon abandon about',
  cookie: 'wallet_session=sess_9f8a7b6c',
  authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9',
} as const;

describe('secret leakage', () => {
  it('leaks nothing when secrets are passed as fields', () => {
    const cap = createCapturingLogger();
    cap.logger.info('login attempt', { ...SECRETS, userId: 'u-1' });
    cap.logger.error('failure', SECRETS);
    cap.logger.child(SECRETS).warn('child logger');

    const output = cap.text();
    for (const [name, value] of Object.entries(SECRETS)) {
      expect(output, `field "${name}" leaked`).not.toContain(value);
    }
    // The safe field still made it through, so this is not passing by silence.
    expect(output).toContain('u-1');
  });

  it('leaks nothing when secrets are nested inside an allowlisted key', () => {
    const cap = createCapturingLogger();
    cap.logger.info('nested', {
      event: { user: { password: SECRETS.password } },
      reason: { totpSecret: SECRETS.totpSecret },
    });
    for (const value of [SECRETS.password, SECRETS.totpSecret]) {
      expect(cap.text()).not.toContain(value);
    }
  });

  it('leaks nothing through the security-event helper', () => {
    const cap = createCapturingLogger();
    runWithContext({ correlationId: 'cid' }, () => {
      logSecurityEvent(cap.logger, 'auth.login.failed', {
        outcome: 'failure',
        userId: 'u-1',
        reason: 'bad_signature',
        ...(SECRETS as unknown as Record<string, string>),
      });
    });
    for (const value of Object.values(SECRETS)) {
      expect(cap.text()).not.toContain(value);
    }
    expect(cap.text()).toContain('auth.login.failed');
    expect(cap.text()).toContain('bad_signature');
  });

  it('leaks nothing when a whole request-like object is handed over', () => {
    const cap = createCapturingLogger();
    cap.logger.info('inbound', {
      req: {
        headers: { cookie: SECRETS.cookie, authorization: SECRETS.authorization },
        body: { password: SECRETS.password },
      },
    });
    const output = cap.text();
    for (const value of [SECRETS.cookie, SECRETS.authorization, SECRETS.password]) {
      expect(output).not.toContain(value);
    }
    // Everything was dropped, and the line says so rather than hiding it.
    expect(cap.entries()[0]?.droppedFields).toBe(1);
  });
});
