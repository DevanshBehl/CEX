import { describe, expect, it } from 'vitest';
import { sanitizeMetadata } from './repositories/audit-log.repository.js';

describe('audit metadata allowlist', () => {
  it('keeps allowlisted primitives', () => {
    expect(sanitizeMetadata({ reason: 'clone_suspected', statusCode: 401 })).toEqual({
      reason: 'clone_suspected',
      statusCode: 401,
    });
  });

  it('drops anything not allowlisted — audit rows can never be corrected', () => {
    expect(
      sanitizeMetadata({
        reason: 'ok',
        totpSecret: 'JBSWY3DPEHPK3PXP',
        password: 'hunter2',
        someNewFieldNobodyConsidered: 'oops',
      }),
    ).toEqual({ reason: 'ok' });
  });

  it('flattens string arrays and drops other structures', () => {
    expect(sanitizeMetadata({ transports: ['usb', 'nfc'], method: { nested: 1 } })).toEqual({
      transports: 'usb,nfc',
    });
  });

  it('handles absent metadata', () => {
    expect(sanitizeMetadata(undefined)).toEqual({});
  });
});
