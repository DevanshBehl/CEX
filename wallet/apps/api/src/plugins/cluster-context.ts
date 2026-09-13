import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { ValidationError } from '@wallet/errors';
import { CLUSTERS, type Cluster } from '@wallet/types';

declare module 'fastify' {
  interface FastifyRequest {
    /** Which cluster this request is about (ADR-0021). Never undefined. */
    cluster: Cluster;
  }
}

export const CLUSTER_HEADER = 'x-solana-cluster';

export interface ClusterContextOptions {
  /** Clusters this deployment serves. */
  readonly served: readonly Cluster[];
  /** What a request naming no cluster gets. */
  readonly defaultCluster: Cluster;
}

/**
 * Resolve the request's cluster from `X-Solana-Cluster` (ADR-0021).
 *
 * # Why a header and not a path prefix or a query parameter
 *
 * The cluster is not part of any resource's identity — a user, a wallet and a
 * withdrawal exist independently of which chain they are being viewed
 * against — so putting it in the path would duplicate every route four times
 * for something that is really a viewing context. A query parameter would be
 * dropped by the first client that forgot it, and dropping it must NOT silently
 * mean "mainnet".
 *
 * # Why an unknown value is refused rather than defaulted
 *
 * A default on a MALFORMED header is the dangerous case: a client sending
 * `mainnet` (not `mainnet-beta`) would silently be answered for devnet, and the
 * balances it rendered would be play money labelled as real. An absent header
 * is a different thing — it means the client has no opinion — and that is what
 * the default is for.
 */
const plugin: FastifyPluginAsync<ClusterContextOptions> = async (app, options) => {
  const served = new Set<Cluster>(options.served);

  app.decorateRequest('cluster', options.defaultCluster);

  app.addHook('onRequest', (request, _reply, done) => {
    const raw = request.headers[CLUSTER_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;

    if (value === undefined || value.trim() === '') {
      request.cluster = options.defaultCluster;
      done();
      return;
    }

    const candidate = value.trim();
    if (!(CLUSTERS as readonly string[]).includes(candidate)) {
      done(
        new ValidationError(
          [{ path: CLUSTER_HEADER, message: 'unknown_cluster' }],
          'Unknown Solana cluster',
        ),
      );
      return;
    }

    if (!served.has(candidate as Cluster)) {
      // Distinguished from "unknown" on purpose: the cluster is real, this
      // deployment simply does not serve it, and the fix is configuration
      // rather than a corrected request.
      done(
        new ValidationError(
          [{ path: CLUSTER_HEADER, message: 'cluster_not_served' }],
          'This deployment does not serve that Solana cluster',
        ),
      );
      return;
    }

    request.cluster = candidate as Cluster;
    done();
  });
};

export const clusterContextPlugin = fp(plugin, { name: 'cluster-context' });
