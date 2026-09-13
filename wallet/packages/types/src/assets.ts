import { z } from 'zod';
import { ledgerAssetKey, type Cluster } from './clusters.js';

/**
 * The asset allowlist (ADR-0016).
 *
 * WHY A MINT ADDRESS IS THE IDENTITY AND A SYMBOL IS NOT
 *
 * Symbols are not unique, not authoritative, and trivially spoofed — anyone can
 * mint a token calling itself `USDC`. Keying an allowlist on a symbol is the
 * single most likely way to credit a user with a worthless token that shares a
 * name with a valuable one. The address is the identity; the symbol is a label
 * for humans and nothing else.
 *
 * WHY DECIMALS ARE HERE BUT NEVER USED IN ARITHMETIC
 *
 * `decimals` exists so an interface can render `1000000` as `1.00 USDC`. It
 * never participates in a calculation (master-prompt rule 115,
 * prompt_phase4.md rule 115). Amounts are integer base units everywhere:
 * `NUMERIC(38,0)` in the database, decimal strings on the wire. This has been
 * the rule since Phase 2 for SOL, and tokens are where it becomes tempting to
 * break it — a six-decimal token looks small enough to "just divide".
 */

/** The native asset's key. Not a mint; the chain itself. */
export const NATIVE_ASSET_KEY = 'SOL';

export interface TokenAsset {
  /** A label for humans. Never used to look anything up. */
  readonly symbol: string;
  /** The mint address. THIS is the identity, and the ledger's asset key. */
  readonly mint: string;
  /** Display metadata only. */
  readonly decimals: number;
}

/**
 * `SYMBOL:MINT:DECIMALS`, comma-separated.
 *
 *   TOKEN_MINTS=USDC:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:6
 *
 * Parsed at boot and never re-read. An unparseable entry is a configuration
 * error, not a token that is quietly skipped (prompt_phase1.md rules 59-61).
 */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_DECIMALS = 18;

export const tokenAssetSchema = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .pipe(
    z.array(
      z.string().superRefine((entry, ctx) => {
        const parts = entry.split(':');
        if (parts.length !== 3) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"${entry}" must be SYMBOL:MINT:DECIMALS`,
          });
          return;
        }

        const [symbol, mint, decimals] = parts as [string, string, string];

        if (symbol.length === 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'symbol must not be empty' });
        }
        // The encoding only. That the mint EXISTS is the adapter's business;
        // this catches a typo at boot rather than at the first deposit.
        if (!BASE58_ADDRESS.test(mint)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"${symbol}" mint is not a base58 address`,
          });
        }
        if (!/^\d+$/.test(decimals) || Number(decimals) > MAX_DECIMALS) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"${symbol}" decimals must be an integer between 0 and ${String(MAX_DECIMALS)}`,
          });
        }
      }),
    ),
  )
  .transform((entries): TokenAsset[] =>
    entries.map((entry) => {
      const [symbol = '', mint = '', decimals = '0'] = entry.split(':');
      return { symbol, mint, decimals: Number(decimals) };
    }),
  );

/**
 * A resolved allowlist: SOL plus zero or more mints.
 *
 * Lookup is by asset key — `SOL`, or a mint address — because that is what the
 * ledger stores and what arrives on a withdrawal request.
 */
export interface AssetRegistry {
  /** Which cluster these keys belong to. */
  readonly cluster: Cluster;
  /** The native asset's key on this cluster — `devnet:SOL`. */
  readonly nativeKey: string;
  /** Every asset key the platform will credit, including the native asset. */
  readonly keys: readonly string[];
  readonly tokens: readonly TokenAsset[];
  isAllowed(assetKey: string): boolean;
  isToken(assetKey: string): boolean;
  /** The mint's metadata, or undefined for the native asset or an unknown key. */
  token(assetKey: string): TokenAsset | undefined;
  /** For display only. Falls back to the key itself. */
  symbolOf(assetKey: string): string;
  /** For display only. Never call this from accounting code. */
  decimalsOf(assetKey: string): number;
}

/**
 * One registry per cluster (ADR-0021).
 *
 * Every key it produces and every key it answers about is cluster-qualified,
 * because that is what the ledger stores. A registry that spoke in bare mints
 * would have to be translated at each call site, and the translation is
 * exactly where "which cluster was this?" gets lost.
 *
 * The same mint address can legitimately appear on two clusters — a devnet
 * USDC faucet mint and the real one — and they are different assets with
 * different values. Two registries, two keys, no shared state.
 */
export function createAssetRegistry(input: {
  readonly cluster: Cluster;
  readonly nativeDecimals: number;
  readonly tokens: readonly TokenAsset[];
}): AssetRegistry {
  const qualify = (asset: string): string => ledgerAssetKey(input.cluster, asset);

  const nativeKey = qualify(NATIVE_ASSET_KEY);
  const byKey = new Map(input.tokens.map((token) => [qualify(token.mint), token]));
  const keys = Object.freeze([nativeKey, ...input.tokens.map((token) => qualify(token.mint))]);

  return {
    cluster: input.cluster,
    nativeKey,
    keys,
    tokens: Object.freeze([...input.tokens]),
    isAllowed: (assetKey) => assetKey === nativeKey || byKey.has(assetKey),
    isToken: (assetKey) => byKey.has(assetKey),
    token: (assetKey) => byKey.get(assetKey),
    symbolOf: (assetKey) =>
      assetKey === nativeKey ? NATIVE_ASSET_KEY : (byKey.get(assetKey)?.symbol ?? assetKey),
    decimalsOf: (assetKey) =>
      assetKey === nativeKey
        ? input.nativeDecimals
        : (byKey.get(assetKey)?.decimals ?? input.nativeDecimals),
  };
}

/** Why a detected transfer was recorded but not credited (ADR-0016). */
export const IGNORED_REASONS = {
  mintNotAllowlisted: 'mint_not_allowlisted',
  assetNotAllowlisted: 'asset_not_allowlisted',
} as const;

export type IgnoredReason = (typeof IGNORED_REASONS)[keyof typeof IGNORED_REASONS];
