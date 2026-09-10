import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Ambient request context (prompt_phase1.md rules 69-70).
 *
 * Every log line picks the correlation ID up from here, so no call site has to
 * thread it through. Phase 2 onward this is what ties a deposit credit, its
 * ledger entries, and its audit rows to one traceable request.
 */
export interface RequestContext {
  readonly correlationId: string;
  userId?: string;
  sessionId?: string;
  readonly method?: string;
  readonly route?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Attaches identity to the in-flight context once authentication resolves it,
 * so log lines emitted after the auth guard carry the user without the guard
 * having to re-log anything.
 */
export function attachIdentity(identity: { userId?: string; sessionId?: string }): void {
  const context = storage.getStore();
  if (!context) return;
  if (identity.userId !== undefined) context.userId = identity.userId;
  if (identity.sessionId !== undefined) context.sessionId = identity.sessionId;
}
