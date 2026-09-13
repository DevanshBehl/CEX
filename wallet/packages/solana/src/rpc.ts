import { Connection, PublicKey, type Commitment, type Finality } from '@solana/web3.js';
import { ChainError } from '@wallet/errors';
import type { Confirmation } from '@wallet/blockchain';
import type { Cluster } from '@wallet/types';

/**
 * The RPC boundary (prompt_phase2.md rules 103-104).
 *
 * Every call to the chain goes through here so timeouts, retries, and error
 * translation are decided once. Nothing outside this module may hold a
 * `Connection`, and no driver error may escape it — a caller that catches a
 * `SolanaJSONRPCError` has coupled itself to the SDK, which is the coupling
 * `packages/blockchain` exists to prevent.
 */

export interface RpcOptions {
  readonly endpoint: string;
  readonly commitment: Commitment;
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
}

export interface SolanaRpc {
  readonly connection: Connection;
  call<T>(operation: string, fn: (connection: Connection) => Promise<T>): Promise<T>;
}

/**
 * Retried only for transient conditions. A malformed request retried three
 * times is still malformed; retrying it wastes the budget that a genuinely
 * transient failure needs.
 */
const RETRYABLE_PATTERNS = [
  /429/,
  /timeout/i,
  /ETIMEDOUT/,
  /ECONNRESET/,
  /ENOTFOUND/,
  /fetch failed/i,
  /socket hang up/i,
  /Too Many Requests/i,
  /Service Unavailable/i,
  /502|503|504/,
];

function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return RETRYABLE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * One connection per cluster, resolved by cluster and never by accident.
 *
 * # Why a pool and not a parameter
 *
 * A single `SolanaRpc` that took a cluster per call would need every caller to
 * pass the right one, and the failure when someone forgot would be a devnet
 * transaction submitted to mainnet — accepted by the endpoint, signed with a
 * key that exists there too, against a nonce account that does not. The pool
 * makes the cluster part of *which object you are holding*, so a caller that
 * has the devnet RPC cannot reach mainnet at all.
 *
 * Connections are created eagerly, at construction: a lazily-created one would
 * make the first request of a cluster pay for the connection, and would hide a
 * misconfigured endpoint until traffic arrived.
 */
export interface SolanaRpcPool {
  readonly clusters: readonly Cluster[];
  /** Throws for a cluster this deployment does not serve. */
  get(cluster: Cluster): SolanaRpc;
  has(cluster: Cluster): boolean;
}

export function createSolanaRpcPool(configs: ReadonlyMap<Cluster, RpcOptions>): SolanaRpcPool {
  if (configs.size === 0) {
    throw new ChainError('an RPC pool needs at least one cluster');
  }

  const pool = new Map<Cluster, SolanaRpc>();
  for (const [cluster, options] of configs) {
    pool.set(cluster, createSolanaRpc(options));
  }

  return {
    clusters: Object.freeze([...pool.keys()]),
    has: (cluster) => pool.has(cluster),
    get(cluster) {
      const rpc = pool.get(cluster);
      if (!rpc) {
        // Naming what IS served, because the usual cause is a cluster missing
        // from configuration rather than a bad request.
        throw new ChainError(
          `no RPC configured for ${cluster}; this deployment serves ${[...pool.keys()].join(', ')}`,
        );
      }
      return rpc;
    },
  };
}

export function createSolanaRpc(options: RpcOptions): SolanaRpc {
  const connection = new Connection(options.endpoint, {
    commitment: options.commitment,
    confirmTransactionInitialTimeout: options.requestTimeoutMs,
  });

  return {
    connection,

    async call<T>(operation: string, fn: (c: Connection) => Promise<T>): Promise<T> {
      let lastError: unknown;

      for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
        try {
          return await withTimeout(fn(connection), options.requestTimeoutMs, operation);
        } catch (error) {
          lastError = error;
          if (!isRetryable(error) || attempt === options.maxRetries) break;
          // Exponential backoff with full jitter, so concurrent callers that
          // hit the same rate limit do not retry in lockstep and hit it again.
          const backoff = Math.random() * 100 * 2 ** attempt;
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      }

      // The message may carry the endpoint, which can contain an API key, so it
      // is deliberately not forwarded. `operation` says what failed; the cause
      // is attached for the logger, which redacts by allowlist anyway.
      throw new ChainError(`Solana RPC call failed: ${operation}`, lastError);
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${operation}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Maps Solana's commitment vocabulary onto the domain's three levels.
 *
 * The domain deliberately does not know the words `processed`, `confirmed`, or
 * `finalized`; it knows how settled something is. This function is the entire
 * translation, and ADR-0006 is why only `final` may be credited.
 */
export function toConfirmation(commitment: Commitment | null | undefined): Confirmation {
  switch (commitment) {
    case 'finalized':
    case 'max':
    case 'root':
      return 'final';
    case 'confirmed':
    case 'single':
    case 'singleGossip':
      return 'probable';
    default:
      return 'seen';
  }
}

export function toFinality(commitment: Commitment): Finality {
  return commitment === 'finalized' ? 'finalized' : 'confirmed';
}

export function toPublicKey(address: string): PublicKey {
  try {
    return new PublicKey(address);
  } catch (cause) {
    throw new ChainError('Invalid Solana address', cause);
  }
}
