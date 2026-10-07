import websocket from '@fastify/websocket';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AuthorizationDeniedError, RateLimitError } from '@wallet/errors';
import { logSecurityEvent, type Logger } from '@wallet/logger';
import type { WalletMetrics } from '../observability/metrics.js';
import type { SocketHub } from './hub.js';

/**
 * `GET /ws` — the upgrade, and everything that must be true before it
 * (ADR-0037 §§1, 4).
 *
 * A WebSocket handshake is a `GET`, so the CSRF guard — which passes every
 * safe method — does not cover it, and browsers do not apply CORS to it
 * either. Without the check below, any site a signed-in user visits could
 * open a socket to this API with their cookie attached and read their orders.
 *
 * In order, and all BEFORE a socket exists:
 *
 *   1. `Origin` is exactly the configured web origin;
 *   2. the session cookie resolves to a live session;
 *   3. one more socket breaches neither the per-user nor the per-IP bound.
 *
 * A refusal is an ordinary HTTP error. No socket is opened to deliver it.
 */
export interface SocketPluginOptions {
  readonly hub: SocketHub;
  readonly webOrigin: string;
  readonly cookieName: string;
  readonly logger: Logger;
  readonly metrics?: WalletMetrics;
  readonly sessionGuard: (request: never, reply: never) => Promise<void>;
  /** The transport's hard ceiling. The hub enforces the configured, smaller one. */
  readonly maxPayloadBytes: number;
}

export const socketPlugin: FastifyPluginAsync<SocketPluginOptions> = async (app, options) => {
  await app.register(websocket, { options: { maxPayload: options.maxPayloadBytes } });

  const refuse = (reason: string): void => {
    options.metrics?.socketUpgradesRefused.inc({ reason });
    logSecurityEvent(options.logger, 'ws.upgrade_refused', { outcome: 'failure', reason });
  };

  async function originGuard(request: FastifyRequest): Promise<void> {
    const origin = request.headers.origin;
    // Missing is refused too: a browser always sends it on a handshake, and a
    // client that omits it is not one this endpoint is for.
    if (origin !== options.webOrigin) {
      refuse('origin');
      throw new AuthorizationDeniedError('Request origin is not allowed');
    }
  }

  async function sessionGuard(request: FastifyRequest): Promise<void> {
    try {
      await (options.sessionGuard as unknown as (r: FastifyRequest, p: unknown) => Promise<void>)(
        request,
        undefined,
      );
    } catch (error) {
      refuse('session');
      throw error;
    }
  }

  async function admissionGuard(request: FastifyRequest): Promise<void> {
    const verdict = options.hub.admit({ userId: request.userId ?? '', ip: request.ip });
    if (verdict !== 'ok') {
      refuse(verdict);
      throw new RateLimitError(5);
    }
  }

  app.get(
    '/ws',
    { websocket: true, preValidation: [originGuard, sessionGuard, admissionGuard] },
    (socket, request) => {
      const userId = request.userId;
      const sessionToken = request.cookies[options.cookieName];
      if (userId === undefined || sessionToken === undefined) {
        socket.close(1008, 'unauthenticated');
        return;
      }
      const connection = options.hub.attach({ userId, ip: request.ip, sessionToken }, socket);
      socket.on('message', (data, isBinary) => {
        // Text frames only: there is no binary message in the contract.
        connection.onMessage(isBinary ? Buffer.alloc(0) : (data as Buffer));
      });
      socket.on('close', () => connection.onClose());
      socket.on('error', () => connection.onClose());
    },
  );
};
