import { describe, expect, it } from 'vitest';
import { attachIdentity, createCapturingLogger, runWithContext, sanitizeFields } from './index.js';

describe('sanitizeFields', () => {
  it('keeps allowlisted primitives', () => {
    const { fields, droppedFields } = sanitizeFields({
      userId: 'u1',
      statusCode: 200,
      backedUp: true,
      transports: ['usb', 'nfc'],
    });
    expect(fields).toEqual({
      userId: 'u1',
      statusCode: 200,
      backedUp: true,
      transports: ['usb', 'nfc'],
    });
    expect(droppedFields).toBe(0);
  });

  it('drops any field that is not allowlisted — fails closed (rules 73-74)', () => {
    const { fields, droppedFields } = sanitizeFields({
      userId: 'u1',
      // A field a developer added next sprint and never considered logging.
      unexpectedNewField: 'sensitive-by-accident',
    });
    expect(fields).toEqual({ userId: 'u1' });
    expect(droppedFields).toBe(1);
  });

  it('drops explicitly forbidden fields even if someone allowlists them', () => {
    const { fields } = sanitizeFields({
      password: 'hunter2',
      totpSecret: 'JBSWY3DPEHPK3PXP',
      sessionToken: 'abc',
      challenge: 'xyz',
      keyShare: 'share-1',
    });
    expect(fields).toEqual({});
  });

  it('refuses non-primitive values, so nothing tunnels through an allowed key', () => {
    const { fields, droppedFields } = sanitizeFields({
      // `event` is allowlisted, but the value is an object hiding a secret.
      event: { nested: { password: 'hunter2' } },
    });
    expect(fields).toEqual({});
    expect(droppedFields).toBe(1);
  });
});

describe('correlation context', () => {
  it('stamps every line without the call site passing anything (rules 69-70)', () => {
    const cap = createCapturingLogger();
    runWithContext({ correlationId: 'cid-1', method: 'POST', route: '/auth/login/verify' }, () => {
      cap.logger.info('something happened');
    });
    const [entry] = cap.entries();
    expect(entry?.correlationId).toBe('cid-1');
    expect(entry?.route).toBe('/auth/login/verify');
  });

  it('picks up identity attached mid-request', () => {
    const cap = createCapturingLogger();
    runWithContext({ correlationId: 'cid-2' }, () => {
      cap.logger.info('before auth');
      attachIdentity({ userId: 'u-9', sessionId: 's-9' });
      cap.logger.info('after auth');
    });
    const entries = cap.entries();
    expect(entries[0]?.userId).toBeUndefined();
    expect(entries[1]?.userId).toBe('u-9');
    expect(entries[1]?.sessionId).toBe('s-9');
  });

  it('does not let a call site spoof the correlation id or user', () => {
    const cap = createCapturingLogger();
    runWithContext({ correlationId: 'real' }, () => {
      cap.logger.info('attempt', { correlationId: 'forged', userId: 'someone-else' });
    });
    expect(cap.entries()[0]?.correlationId).toBe('real');
  });

  it('works outside a request context', () => {
    const cap = createCapturingLogger();
    cap.logger.info('background job');
    expect(cap.entries()[0]?.correlationId).toBeUndefined();
  });
});

describe('levels and output shape', () => {
  it('suppresses lines below the configured level', () => {
    const cap = createCapturingLogger('warn');
    cap.logger.debug('noise');
    cap.logger.info('noise');
    cap.logger.warn('signal');
    expect(cap.entries()).toHaveLength(1);
    expect(cap.entries()[0]?.msg).toBe('signal');
  });

  it('emits one JSON object per line (rule 68)', () => {
    const cap = createCapturingLogger();
    cap.logger.info('a');
    cap.logger.info('b');
    for (const line of cap.text().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('merges child fields', () => {
    const cap = createCapturingLogger();
    cap.logger.child({ dependency: 'postgres' }).info('connected', { latencyMs: 3 });
    const [entry] = cap.entries();
    expect(entry?.dependency).toBe('postgres');
    expect(entry?.latencyMs).toBe(3);
  });
});
