/**
 * "Something of this user's changed" — after the commit that changed it
 * (ADR-0037 §7).
 *
 * The private WebSocket channel is notify-then-read: this carries USER IDS and
 * nothing else — no order id, no amount, no price — and whoever hears it reads
 * the current rows from PostgreSQL. A lost notification therefore loses
 * nothing but latency.
 *
 * Process-wide on purpose. Repositories are created per transaction, in a
 * dozen places; a listener passed to each would be a listener some call site
 * forgets. The write paths publish here, through `afterCommit`, and one
 * subscriber forwards to every API instance.
 */
export type UserChangeListener = (userIds: readonly string[]) => void;

const listeners = new Set<UserChangeListener>();

export const userChanges = {
  subscribe(listener: UserChangeListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  publish(userIds: readonly string[]): void {
    if (userIds.length === 0) return;
    for (const listener of listeners) {
      try {
        listener(userIds);
      } catch {
        // One listener failing must not stop the others, or the commit path.
      }
    }
  },
};
