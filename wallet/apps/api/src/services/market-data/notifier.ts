import type { Redis } from 'ioredis';
import type { Logger } from '@wallet/logger';

/**
 * "Look again" — across API instances (ADR-0037 §7).
 *
 * The instance that settles a fill is not necessarily the one holding that
 * user's socket, so a change is announced on Redis pub/sub and every instance
 * hears it. The payload is a user id, or a market id, and NOTHING ELSE: no
 * order, no amount, no price. Whoever hears it reads PostgreSQL.
 *
 * Pub/sub is fire-and-forget, and that is acceptable here by design: a lost
 * message costs latency, never data, because the client refetches over REST on
 * every connect and the private channel is only a hint.
 */

const USERS = 'atlas:changes:users';
const TAPE = 'atlas:changes:tape';

export interface ChangeNotifier {
  /** These users' orders, fills or balances changed. Called AFTER the commit. */
  usersChanged(userIds: readonly string[]): void;
  /** A trade was recorded for this market: its ticker changed. */
  tapeChanged(marketId: string): void;
  onUsers(listener: (userIds: readonly string[]) => void): void;
  onTape(listener: (marketId: string) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createChangeNotifier(deps: {
  /** Publishes. May be the shared connection: PUBLISH does not block. */
  readonly redis: Redis;
  readonly logger: Logger;
}): ChangeNotifier {
  // A connection in subscriber mode can do nothing else, so it is its own.
  const subscriber = deps.redis.duplicate();
  const userListeners: Array<(userIds: readonly string[]) => void> = [];
  const tapeListeners: Array<(marketId: string) => void> = [];

  const publish = (channel: string, payload: string): void => {
    deps.redis.publish(channel, payload).catch(() => {
      // A hint that was not delivered. The client's refetch covers it.
      deps.logger.warn('change notification was not published', { targetType: 'channel' });
    });
  };

  return {
    usersChanged(userIds) {
      if (userIds.length > 0) publish(USERS, userIds.join(','));
    },
    tapeChanged(marketId) {
      publish(TAPE, marketId);
    },
    onUsers(listener) {
      userListeners.push(listener);
    },
    onTape(listener) {
      tapeListeners.push(listener);
    },

    async start() {
      subscriber.on('message', (channel: string, payload: string) => {
        if (channel === USERS) {
          const ids = payload.split(',').filter((id) => id.length > 0);
          for (const listener of userListeners) listener(ids);
        } else if (channel === TAPE) {
          for (const listener of tapeListeners) listener(payload);
        }
      });
      await subscriber.subscribe(USERS, TAPE);
    },

    async stop() {
      subscriber.disconnect();
    },
  };
}
