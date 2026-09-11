import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  createSolanaAddressDeriver,
  createSolanaAddressValidator,
  derivationPathForIndex,
  parseTransfers,
  toConfirmation,
} from './index.js';

const SEED = new Uint8Array(64).fill(7);

describe('address validation (rules 108-110, 187)', () => {
  const validator = createSolanaAddressValidator();

  it('accepts real mainnet addresses', () => {
    const known = [
      '11111111111111111111111111111111', // System Program
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token Program
      'So11111111111111111111111111111111111111112', // Wrapped SOL mint
    ];
    for (const address of known) {
      expect(validator.isWellFormed(address), address).toEqual({ ok: true });
    }
  });

  it('rejects malformed strings', () => {
    const bad = [
      '',
      'not-an-address',
      '0x0000000000000000000000000000000000000000', // an Ethereum address
      'IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII', // base58 excludes I
      '1111111111111111111111111111111', // 31 chars, too short
      `${'1'.repeat(45)}`, // too long
    ];
    for (const address of bad) {
      expect(validator.isWellFormed(address).ok, address).toBe(false);
    }
  });

  it('reports wrong_length separately from malformed', () => {
    expect(validator.isWellFormed('abc')).toEqual({ ok: false, reason: 'wrong_length' });
  });

  it('accepts an on-curve address as a safe destination', () => {
    const deriver = createSolanaAddressDeriver(SEED);
    const { address } = deriver.derive(0);
    expect(validator.isSafeDestination(address)).toEqual({ ok: true });
  });

  it('REJECTS a Program Derived Address as a destination (rule 109)', () => {
    // A PDA is a valid 32-byte address that is deliberately off-curve, so no
    // private key exists for it. Funds sent to one may be unrecoverable.
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('any-seed')],
      new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    );

    // Well-formed...
    expect(validator.isWellFormed(pda.toBase58())).toEqual({ ok: true });
    // ...but not somewhere funds can be sent.
    expect(validator.isSafeDestination(pda.toBase58())).toEqual({
      ok: false,
      reason: 'not_signable',
    });
  });

  it('normalizes to the canonical base58 encoding', () => {
    const address = 'So11111111111111111111111111111111111111112';
    expect(validator.normalize(address)).toBe(address);
  });
});

describe('address derivation (rules 105-107, 186)', () => {
  it('is deterministic for the same seed and index', () => {
    const a = createSolanaAddressDeriver(SEED).derive(0);
    const b = createSolanaAddressDeriver(SEED).derive(0);
    expect(a.address).toBe(b.address);
    expect(a.derivationPath).toBe(b.derivationPath);
  });

  it('produces a different address per index', () => {
    const deriver = createSolanaAddressDeriver(SEED);
    const addresses = new Set(Array.from({ length: 100 }, (_, i) => deriver.derive(i).address));
    expect(addresses.size).toBe(100);
  });

  it('produces different addresses for different seeds', () => {
    const a = createSolanaAddressDeriver(new Uint8Array(64).fill(1)).derive(0).address;
    const b = createSolanaAddressDeriver(new Uint8Array(64).fill(2)).derive(0).address;
    expect(a).not.toBe(b);
  });

  it('derives addresses that are valid and spendable', () => {
    const validator = createSolanaAddressValidator();
    const deriver = createSolanaAddressDeriver(SEED);
    for (let i = 0; i < 20; i += 1) {
      const { address } = deriver.derive(i);
      expect(validator.isWellFormed(address), address).toEqual({ ok: true });
      expect(validator.isSafeDestination(address), address).toEqual({ ok: true });
    }
  });

  it('records a derivation path that identifies the index', () => {
    expect(createSolanaAddressDeriver(SEED).derive(42).derivationPath).toBe(
      derivationPathForIndex(42),
    );
    expect(derivationPathForIndex(42)).toBe("m/44'/501'/42'/0'");
  });

  it('rejects a non-integer or negative index', () => {
    const deriver = createSolanaAddressDeriver(SEED);
    for (const index of [-1, 1.5, Number.NaN]) {
      expect(() => deriver.derive(index), String(index)).toThrow();
    }
  });

  it('refuses a seed that is too short to be safe', () => {
    expect(() => createSolanaAddressDeriver(new Uint8Array(16))).toThrow(/at least 32 bytes/);
  });
});

describe('commitment mapping (ADR-0006)', () => {
  it('maps only finalized-equivalents to final', () => {
    expect(toConfirmation('finalized')).toBe('final');
    expect(toConfirmation('max')).toBe('final');
    expect(toConfirmation('root')).toBe('final');
  });

  it('maps confirmed to probable — NOT final', () => {
    // The whole point of ADR-0006: `confirmed` can still be rolled back on a
    // fork, so it must never be treated as creditable.
    expect(toConfirmation('confirmed')).toBe('probable');
    expect(toConfirmation('singleGossip')).toBe('probable');
  });

  it('maps anything else to seen', () => {
    expect(toConfirmation('processed')).toBe('seen');
    expect(toConfirmation(null)).toBe('seen');
    expect(toConfirmation(undefined)).toBe('seen');
  });
});

// ---------------------------------------------------------------------------
// Transfer parsing (rules 111-112)
// ---------------------------------------------------------------------------

const WATCHED = 'So11111111111111111111111111111111111111112';
const OTHER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function fakeTransaction(input: {
  keys: string[];
  pre: number[];
  post: number[];
  err?: unknown;
  slot?: number;
}): never {
  return {
    slot: input.slot ?? 1000,
    transaction: {
      message: {
        accountKeys: input.keys.map((k) => ({ pubkey: new PublicKey(k) })),
      },
    },
    meta: {
      err: input.err ?? null,
      preBalances: input.pre,
      postBalances: input.post,
    },
  } as never;
}

describe('transfer parsing', () => {
  const options = { watchedAddresses: new Set([WATCHED]), txReference: 'sig1' };

  it('emits an event when a watched address gains lamports', () => {
    const events = parseTransfers(
      fakeTransaction({ keys: [OTHER, WATCHED], pre: [5_000, 0], post: [4_000, 1_000] }),
      options,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      asset: 'SOL',
      amount: '1000',
      to: WATCHED,
      from: OTHER,
      txReference: 'sig1',
      confirmation: 'final',
    });
  });

  it('ignores addresses that are not watched', () => {
    expect(
      parseTransfers(
        fakeTransaction({ keys: [WATCHED, OTHER], pre: [0, 0], post: [0, 1_000] }),
        options,
      ),
    ).toEqual([]);
  });

  it('ignores a decrease', () => {
    expect(
      parseTransfers(
        fakeTransaction({ keys: [WATCHED, OTHER], pre: [1_000, 0], post: [0, 1_000] }),
        options,
      ),
    ).toEqual([]);
  });

  it('ignores a failed transaction', () => {
    // A failed transaction moves nothing; crediting it would credit money that
    // was never sent.
    expect(
      parseTransfers(
        fakeTransaction({
          keys: [OTHER, WATCHED],
          pre: [5_000, 0],
          post: [4_000, 1_000],
          err: { InstructionError: [0, 'Custom'] },
        }),
        options,
      ),
    ).toEqual([]);
  });

  it('captures the NET credit, whatever mechanism produced it', () => {
    // Balance deltas catch CPI transfers, rent refunds, and createAccount
    // funding — all of which an instruction-parsing indexer would miss.
    const events = parseTransfers(
      fakeTransaction({ keys: [OTHER, WATCHED], pre: [10_000, 500], post: [7_000, 3_500] }),
      options,
    );
    expect(events[0]?.amount).toBe('3000');
  });

  it('gives each watched address in one transaction a distinct index', () => {
    const second = '11111111111111111111111111111111';
    const events = parseTransfers(
      fakeTransaction({
        keys: [OTHER, WATCHED, second],
        pre: [10_000, 0, 0],
        post: [8_000, 1_000, 1_000],
      }),
      { watchedAddresses: new Set([WATCHED, second]), txReference: 'sig1' },
    );
    expect(events).toHaveLength(2);
    // The uniqueness key is (chain, signature, instructionIndex), so two
    // credits in one transaction must not collide.
    expect(new Set(events.map((e) => e.instructionIndex)).size).toBe(2);
  });

  it('documents the SDK precision ceiling above 2^53', () => {
    // The RPC delivers balances as JavaScript numbers, so a value above 2^53
    // has already been rounded before this function sees it. 9007199254740993
    // is not representable and arrives as ...992.
    //
    // This test exists to make the limitation visible rather than to endorse
    // it. It does not affect Phase 2 — a single user's deposit address will
    // not hold 9 million SOL — but it would affect a hot wallet, and the fix
    // is a bigint-aware RPC transport. See the note in ./transfers.ts.
    // The loss IS the subject of this test: the RPC hands us numbers, and this
    // is what happens to one above 2^53 before any of our code runs.
    // eslint-disable-next-line no-loss-of-precision
    const post = 9_007_199_254_740_993;
    expect(post.toString()).toBe('9007199254740992');

    const events = parseTransfers(
      fakeTransaction({ keys: [OTHER, WATCHED], pre: [post, 0], post: [0, post] }),
      options,
    );
    expect(events[0]?.amount).toBe('9007199254740992');
  });

  it('preserves full precision for any realistic balance', () => {
    // 1,000,000 SOL in lamports — comfortably below the ceiling and exact.
    const lamports = 1_000_000_000_000_000;
    const events = parseTransfers(
      fakeTransaction({ keys: [OTHER, WATCHED], pre: [lamports, 0], post: [0, lamports] }),
      options,
    );
    expect(events[0]?.amount).toBe('1000000000000000');
  });

  it('returns nothing when meta is absent', () => {
    expect(
      parseTransfers({ slot: 1, transaction: { message: { accountKeys: [] } } } as never, options),
    ).toEqual([]);
  });
});
