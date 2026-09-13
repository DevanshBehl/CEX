import { describe, expect, it } from 'vitest';
import type { ParsedTransactionWithMeta } from '@solana/web3.js';
import {
  buildFeeFundingTransaction,
  buildTokenTransferTransaction,
  deriveAssociatedTokenAddress,
  parseTokenTransfers,
  planNativeSweep,
  TOKEN_PROGRAM_ID,
} from './token.js';

const OWNER = '4oQvM1c3wFJN8Twy9EFTvoKfcr5mWoEVTuAHRhoRxokA';
const OTHER = 'BWwVzPxw1AK6LgsSn7GSPj9Stv1o5ENkp4PCru9w3Hvr';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ---------------------------------------------------------------------------
// ATA derivation
// ---------------------------------------------------------------------------

describe('associated token address (rule 117)', () => {
  it('is deterministic', () => {
    expect(deriveAssociatedTokenAddress(OWNER, USDC)).toBe(
      deriveAssociatedTokenAddress(OWNER, USDC),
    );
  });

  it('differs per owner and per mint', () => {
    const a = deriveAssociatedTokenAddress(OWNER, USDC);
    expect(a).not.toBe(deriveAssociatedTokenAddress(OTHER, USDC));
    expect(a).not.toBe(deriveAssociatedTokenAddress(OWNER, OTHER));
  });

  it('is not the owner itself', () => {
    // Sending a token to the owner address rather than its ATA is a common way
    // to lose funds; the two must never be conflated.
    expect(deriveAssociatedTokenAddress(OWNER, USDC)).not.toBe(OWNER);
  });

  it('agrees with an independent implementation', () => {
    // Vector produced by the Rust `spl-token address` CLI, not by this code:
    //
    //   spl-token address \
    //     --owner 4oQvM1c3wFJN8Twy9EFTvoKfcr5mWoEVTuAHRhoRxokA \
    //     --token 5qtUNGVQ1e8jg8Rtpz5CbYFkkm4KbwndYgr17SrhA7vy
    //
    // A self-consistent derivation test proves nothing here: a wrong
    // derivation is deterministic too, and would send tokens to an address
    // nobody controls while every internal test stayed green. The vector has
    // to come from somewhere else.
    expect(
      deriveAssociatedTokenAddress(OWNER, '5qtUNGVQ1e8jg8Rtpz5CbYFkkm4KbwndYgr17SrhA7vy'),
    ).toBe('8925h9PDaW4Be79sdpWy3GGoou23vF6heLKuGdiN1pFZ');
  });
});

// ---------------------------------------------------------------------------
// Token transfer parsing
// ---------------------------------------------------------------------------

interface BalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number | null;
    uiAmountString: string;
  };
}

function amount(value: string, decimals = 6): BalanceEntry['uiTokenAmount'] {
  return { amount: value, decimals, uiAmount: null, uiAmountString: value };
}

function tx(input: {
  pre?: BalanceEntry[];
  post?: BalanceEntry[];
  err?: unknown;
  keys?: string[];
}): ParsedTransactionWithMeta {
  return {
    slot: 42,
    transaction: {
      message: {
        accountKeys: (input.keys ?? [OWNER, 'ata']).map((k) => ({
          pubkey: { toBase58: () => k },
        })),
      },
    },
    meta: {
      err: input.err ?? null,
      preTokenBalances: input.pre ?? [],
      postTokenBalances: input.post ?? [],
    },
  } as unknown as ParsedTransactionWithMeta;
}

const watched = {
  watchedOwners: new Set([OWNER]),
  txReference: 'sig-1',
  cluster: 'devnet' as const,
};

describe('token transfer parsing (rules 122-123)', () => {
  it('credits an increase to a watched owner, keyed on the mint', () => {
    const events = parseTokenTransfers(
      tx({
        pre: [{ accountIndex: 1, mint: USDC, owner: OWNER, uiTokenAmount: amount('100') }],
        post: [{ accountIndex: 1, mint: USDC, owner: OWNER, uiTokenAmount: amount('350') }],
      }),
      watched,
    );

    expect(events).toHaveLength(1);
    // The mint is the asset, qualified by cluster: the same mint address on
    // two clusters is two assets with two different values (ADR-0021).
    expect(events[0]).toMatchObject({
      asset: `devnet:${USDC}`,
      chain: 'solana:devnet',
      amount: '250',
      to: OWNER,
    });
  });

  it('treats an account absent from preTokenBalances as starting at zero', () => {
    // A user's FIRST deposit of a mint has no prior balance entry at all.
    // Reading that as "no change" would silently drop every first deposit.
    const events = parseTokenTransfers(
      tx({ post: [{ accountIndex: 1, mint: USDC, owner: OWNER, uiTokenAmount: amount('500') }] }),
      watched,
    );
    expect(events[0]).toMatchObject({ amount: '500' });
  });

  it('ignores an owner nobody is watching', () => {
    expect(
      parseTokenTransfers(
        tx({ post: [{ accountIndex: 1, mint: USDC, owner: OTHER, uiTokenAmount: amount('500') }] }),
        watched,
      ),
    ).toEqual([]);
  });

  it('ignores a decrease', () => {
    expect(
      parseTokenTransfers(
        tx({
          pre: [{ accountIndex: 1, mint: USDC, owner: OWNER, uiTokenAmount: amount('500') }],
          post: [{ accountIndex: 1, mint: USDC, owner: OWNER, uiTokenAmount: amount('100') }],
        }),
        watched,
      ),
    ).toEqual([]);
  });

  it('credits nothing from a failed transaction', () => {
    expect(
      parseTokenTransfers(
        tx({
          err: { InstructionError: [0, 'Custom'] },
          post: [{ accountIndex: 1, mint: USDC, owner: OWNER, uiTokenAmount: amount('500') }],
        }),
        watched,
      ),
    ).toEqual([]);
  });

  it('ignores a non-canonical token program', () => {
    expect(
      parseTokenTransfers(
        tx({
          post: [
            {
              accountIndex: 1,
              mint: USDC,
              owner: OWNER,
              programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
              uiTokenAmount: amount('500'),
            },
          ],
        }),
        watched,
      ),
    ).toEqual([]);
  });

  it('survives amounts beyond 2^53 without precision loss', () => {
    // The RPC sends token amounts as STRINGS, unlike lamport balances. An
    // 18-decimal token makes this reachable, and Number() would silently
    // round it.
    const huge = '123456789012345678901234567890';
    const events = parseTokenTransfers(
      tx({
        post: [{ accountIndex: 1, mint: USDC, owner: OWNER, uiTokenAmount: amount(huge, 18) }],
      }),
      watched,
    );
    expect(events[0]?.amount).toBe(huge);
  });

  it('separates two mints arriving in one transaction', () => {
    const events = parseTokenTransfers(
      tx({
        post: [
          { accountIndex: 1, mint: USDC, owner: OWNER, uiTokenAmount: amount('100') },
          { accountIndex: 2, mint: OTHER, owner: OWNER, uiTokenAmount: amount('200') },
        ],
      }),
      watched,
    );

    expect(events).toHaveLength(2);
    // Distinct discriminators, so the (chain, tx, index) uniqueness key does
    // not collapse them into one deposit (rule 123).
    expect(new Set(events.map((e) => e.instructionIndex)).size).toBe(2);
  });

  it('carries decimals as metadata, never as an amount', () => {
    const events = parseTokenTransfers(
      tx({
        post: [{ accountIndex: 1, mint: USDC, owner: OWNER, uiTokenAmount: amount('1000000') }],
      }),
      watched,
    );
    expect(events[0]?.metadata?.decimals).toBe('6');
    // 1000000 base units, NOT 1.
    expect(events[0]?.amount).toBe('1000000');
  });

  it('names the canonical token program', () => {
    expect(TOKEN_PROGRAM_ID.toBase58()).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  });
});

// ---------------------------------------------------------------------------
// Building token transactions (rules 117-121, 126, 133)
// ---------------------------------------------------------------------------

describe('token transfer transactions', () => {
  const base = {
    owner: OWNER,
    ownerTokenAccount: deriveAssociatedTokenAddress(OWNER, USDC),
    destinationOwner: OTHER,
    mint: USDC,
    amount: '1000000',
    nonceAccount: 'HrbPdTp1Ry2c3Sgi4F4sp6RQcWzDQqUymPBmNKvXVjML',
    nonceAuthority: OWNER,
    nonce: '9e2oDZvuGB5ZrEtQ8YF2BZZFLCu2Qeu8iF42D3SWXiBQ',
    createDestinationAccount: false,
  };

  it('puts nonceAdvance first in the COMPILED message, as the runtime requires', () => {
    // `nonceInfo` is not stored in `transaction.instructions`; web3.js
    // prepends it when the message is compiled. Asserting on `instructions`
    // would be asserting on the wrong array, and would pass whether or not the
    // nonce instruction ever reached the chain.
    const message = buildTokenTransferTransaction(base).transaction.compileMessage();
    expect(message.accountKeys[message.instructions[0]!.programIdIndex]?.toBase58()).toBe(
      '11111111111111111111111111111111',
    );
  });

  it('sends to the destination OWNER via its derived ATA, not to the owner address', () => {
    const { destinationTokenAccount, transaction } = buildTokenTransferTransaction(base);
    expect(destinationTokenAccount).toBe(deriveAssociatedTokenAddress(OTHER, USDC));

    const transfer = transaction.instructions.at(-1);
    expect(transfer?.keys[1]?.pubkey.toBase58()).toBe(destinationTokenAccount);
    // Sending to the owner address rather than its ATA is a common way to
    // lose tokens permanently.
    expect(transfer?.keys[1]?.pubkey.toBase58()).not.toBe(OTHER);
  });

  it('encodes Transfer (3) with a little-endian u64 amount', () => {
    const { transaction } = buildTokenTransferTransaction({ ...base, amount: '1000000' });
    const data = transaction.instructions.at(-1)?.data as Buffer;
    expect(data).toHaveLength(9);
    expect(data.readUInt8(0)).toBe(3);
    expect(data.readBigUInt64LE(1)).toBe(1_000_000n);
  });

  it('carries a u64 amount that a JS number could not represent', () => {
    // Encoded as bytes, never through a number — unlike lamports, which the
    // SDK takes as a JS number and which therefore has a 2^53 ceiling.
    const huge = '18446744073709551615';
    const { transaction } = buildTokenTransferTransaction({ ...base, amount: huge });
    const data = transaction.instructions.at(-1)?.data as Buffer;
    expect(data.readBigUInt64LE(1).toString()).toBe(huge);
  });

  it('refuses an amount above u64', () => {
    expect(() =>
      buildTokenTransferTransaction({ ...base, amount: '18446744073709551616' }),
    ).toThrow(/u64/);
  });

  it('refuses a zero or negative amount', () => {
    expect(() => buildTokenTransferTransaction({ ...base, amount: '0' })).toThrow();
    expect(() => buildTokenTransferTransaction({ ...base, amount: '-1' })).toThrow();
  });

  it('adds an ATA-creation instruction only when asked', () => {
    const without = buildTokenTransferTransaction(base);
    const with_ = buildTokenTransferTransaction({ ...base, createDestinationAccount: true });
    // Creating an account that exists fails the transaction; not creating one
    // that is missing fails it too. The caller reads the chain to decide.
    expect(with_.transaction.compileMessage().instructions).toHaveLength(
      without.transaction.compileMessage().instructions.length + 1,
    );
  });

  it('makes the owner the fee payer and the only signer', () => {
    const { transaction } = buildTokenTransferTransaction(base);
    expect(transaction.feePayer?.toBase58()).toBe(OWNER);
    const transfer = transaction.instructions.at(-1);
    expect(transfer?.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([
      OWNER,
    ]);
  });

  it('does not pass decimals to the chain', () => {
    // TransferChecked would take the mint and its decimals. Decimals are
    // display metadata and must never enter arithmetic — handing them to the
    // chain invites treating them as significant.
    const { transaction } = buildTokenTransferTransaction(base);
    const transfer = transaction.instructions.at(-1);
    expect(transfer?.keys.map((k) => k.pubkey.toBase58())).not.toContain(USDC);
  });
});

describe('fee funding (rules 119-121)', () => {
  const base = {
    from: OWNER,
    to: OTHER,
    lamports: '5000',
    nonceAccount: 'HrbPdTp1Ry2c3Sgi4F4sp6RQcWzDQqUymPBmNKvXVjML',
    nonceAuthority: OWNER,
    nonce: '9e2oDZvuGB5ZrEtQ8YF2BZZFLCu2Qeu8iF42D3SWXiBQ',
  };

  it('is a plain SOL transfer on a durable nonce', () => {
    const { transaction } = buildFeeFundingTransaction(base);
    // nonceAdvance + transfer, once compiled — see the note above.
    expect(transaction.compileMessage().instructions).toHaveLength(2);
    expect(transaction.feePayer?.toBase58()).toBe(OWNER);
  });

  it('is a SEPARATE transaction from the transfer it enables', () => {
    // Combining them would make the hot wallet sign a transaction that also
    // moves a deposit address's tokens — two key classes, one signature.
    const funding = buildFeeFundingTransaction(base);
    const transfer = buildTokenTransferTransaction({
      owner: OTHER,
      ownerTokenAccount: deriveAssociatedTokenAddress(OTHER, USDC),
      destinationOwner: OWNER,
      mint: USDC,
      amount: '1',
      nonceAccount: base.nonceAccount,
      nonceAuthority: OWNER,
      nonce: base.nonce,
      createDestinationAccount: false,
    });
    expect(funding.message).not.toEqual(transfer.message);
  });

  it('refuses a non-positive amount', () => {
    expect(() => buildFeeFundingTransaction({ ...base, lamports: '0' })).toThrow();
  });
});

describe('sweep planning (rule 133)', () => {
  const rent = '890880';

  it('NEVER sweeps the rent-exempt minimum', () => {
    // A swept-to-zero account ceases to exist, and the next deposit pays to
    // recreate it.
    const plan = planNativeSweep({
      balance: '1890880',
      rentExemptMinimum: rent,
      feeReserve: '0',
      threshold: '0',
    });
    expect(plan.amount).toBe('1000000');
    expect(BigInt(plan.amount)).toBeLessThan(BigInt('1890880'));
  });

  it('does not sweep an account sitting exactly at the minimum', () => {
    expect(
      planNativeSweep({
        balance: rent,
        rentExemptMinimum: rent,
        feeReserve: '0',
        threshold: '0',
      }),
    ).toMatchObject({ shouldSweep: false, reason: 'balance_at_or_below_reserved_minimum' });
  });

  it('does not sweep dust', () => {
    // Sweeping dust costs more in fees than it consolidates, and lets anyone
    // make the platform pay fees on demand by sending it.
    expect(
      planNativeSweep({
        balance: '891880',
        rentExemptMinimum: rent,
        feeReserve: '0',
        threshold: '1000000',
      }),
    ).toMatchObject({ shouldSweep: false, reason: 'below_sweep_threshold' });
  });

  it('reserves the fee as well as the rent', () => {
    const plan = planNativeSweep({
      balance: '2890880',
      rentExemptMinimum: rent,
      feeReserve: '5000',
      threshold: '0',
    });
    expect(plan.amount).toBe('1995000');
  });

  it('sweeps once the balance clears both reserves and the threshold', () => {
    expect(
      planNativeSweep({
        balance: '10000000',
        rentExemptMinimum: rent,
        feeReserve: '5000',
        threshold: '1000000',
      }),
    ).toMatchObject({ shouldSweep: true, reason: 'sweepable' });
  });
});
