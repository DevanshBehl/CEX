import { Connection, PublicKey, type Commitment, type Finality } from '@solana/web3.js';
import { ChainError } from '@wallet/errors';
import type { Confirmation } from '@wallet/blockchain';

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
