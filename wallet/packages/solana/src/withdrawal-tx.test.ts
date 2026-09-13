import { Transaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { ChainError } from '@wallet/errors';
import { attachSignatures, buildWithdrawalTransaction } from './withdrawal-tx.js';
import { buildTokenTransferTransaction, ASSOCIATED_TOKEN_PROGRAM_ID } from './token.js';

/**
 * The two-signer withdrawal (ADR-0020 §3).
 *
 * Under segregated custody the funds leave the USER's address while the HOUSE
 * pays the fee. Both facts have to be true of the same transaction, and each
 * one is a place where a mistake produces bytes the network rejects only after
 * a nonce has been consumed.
 */

const HOUSE = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const USER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const DESTINATION = 'GDDMwNyyx8uB6zrqwBFHjLLG3TBYk2F8Az4yrQC5RzMp';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const NONCE_ACCOUNT = 'SysvarRecentB1ockHashes11111111111111111111';
const NONCE = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';

function base(overrides: Record<string, unknown> = {}) {
  return {
    from: USER,
    to: DESTINATION,
    lamports: '1000',
    nonceAccount: NONCE_ACCOUNT,
    nonceAuthority: HOUSE,
    nonce: NONCE,
    ...overrides,
  };
}

describe('withdrawal source and fee payer', () => {
  it('pays the fee from the house while the funds leave the user', () => {
    const unsigned = buildWithdrawalTransaction(base({ feePayer: HOUSE }));

    // The fee payer is the first signer of the message — that is what is
    // charged, regardless of which account the transfer debits.
    expect(unsigned.transaction.feePayer?.toBase58()).toBe(HOUSE);
    expect(unsigned.signers).toContain(USER);
    expect(unsigned.signers).toContain(HOUSE);
    expect(unsigned.signers).toHaveLength(2);
  });

  it('debits the USER, not the fee payer', () => {
    const unsigned = buildWithdrawalTransaction(base({ feePayer: HOUSE }));

    // The transfer instruction's first account is the source. If this were the
    // house, the platform would be paying every withdrawal out of its own
    // funds while the user's balance sat untouched — segregation inverted.
    // The nonce advance is prepended when the message is compiled, so the
    // transfer is the last instruction on the builder.
    const transfer = unsigned.transaction.instructions.at(-1);
    expect(transfer?.keys[0]?.pubkey.toBase58()).toBe(USER);
    expect(transfer?.keys[1]?.pubkey.toBase58()).toBe(DESTINATION);
  });

  it('stays a one-signer transaction without a fee payer (the omnibus model)', () => {
    const unsigned = buildWithdrawalTransaction(base({ from: HOUSE }));
    expect(unsigned.transaction.feePayer?.toBase58()).toBe(HOUSE);
    expect(unsigned.signers).toEqual([HOUSE]);
  });

  it('does not list the nonce authority twice when it is also the fee payer', () => {
    const unsigned = buildWithdrawalTransaction(base({ feePayer: HOUSE }));
    expect(new Set(unsigned.signers).size).toBe(unsigned.signers.length);
  });
});

describe('attaching two signatures', () => {
  const unsigned = buildWithdrawalTransaction(base({ feePayer: HOUSE }));

  it('carries both signatures through serialization', () => {
    const bytes = attachSignatures(unsigned, [
      { signer: HOUSE, signature: new Uint8Array(64).fill(1) },
      { signer: USER, signature: new Uint8Array(64).fill(2) },
    ]);

    // Reparsed from the wire, because attaching one signature at a time and
    // re-serializing is exactly how the first one gets lost.
    const parsed = Transaction.from(Buffer.from(bytes));
    const present = parsed.signatures.filter((entry) => entry.signature !== null);
    expect(present).toHaveLength(2);

    const byAddress = new Map(
      parsed.signatures.map((entry) => [entry.publicKey.toBase58(), entry.signature]),
    );
    expect(byAddress.get(HOUSE)?.[0]).toBe(1);
    expect(byAddress.get(USER)?.[0]).toBe(2);
  });

  it('refuses a signature for an address the message does not list as a signer', () => {
    // The failure this prevents: signing with the house key and attaching it
    // as though it were the user's. The bytes would serialize fine and be
    // refused at broadcast, after the nonce was spent.
    expect(() =>
      attachSignatures(unsigned, [{ signer: DESTINATION, signature: new Uint8Array(64).fill(3) }]),
    ).toThrow(ChainError);
  });

  it('refuses a signature of the wrong length', () => {
    expect(() =>
      attachSignatures(unsigned, [{ signer: HOUSE, signature: new Uint8Array(32) }]),
    ).toThrow(ChainError);
  });

  it('accepts a partially signed transaction', () => {
    // A legitimate intermediate state: the first round has returned and the
    // second has not. The check that every signature is present is the
    // network's, not this function's.
    expect(() =>
      attachSignatures(unsigned, [{ signer: HOUSE, signature: new Uint8Array(64).fill(1) }]),
    ).not.toThrow();
  });
});

describe('token withdrawal fee payer', () => {
  const built = buildTokenTransferTransaction({
    owner: USER,
    ownerTokenAccount: 'BXVzYyu5rJvJGLnFDNGqrPYJCBcEgfGtPsCLrHkVUXiF',
    feePayer: HOUSE,
    destinationOwner: DESTINATION,
    mint: MINT,
    amount: '1000000',
    nonceAccount: NONCE_ACCOUNT,
    nonceAuthority: HOUSE,
    nonce: NONCE,
    createDestinationAccount: true,
  });

  it('lets the house pay so a token-only balance is spendable', () => {
    expect(built.transaction.feePayer?.toBase58()).toBe(HOUSE);
    expect(built.signers).toContain(USER);
    expect(built.signers).toContain(HOUSE);
  });

  it('charges ATA rent to the house, never to the user whose tokens move', () => {
    const create = built.transaction.instructions.find((instruction) =>
      instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID),
    );
    // The first account of a create-ATA instruction is the FUNDING account: it
    // is debited the rent. `postTokenAccountRent` books that to house_rent, so
    // a user funding it here would mean the ledger and the chain disagree.
    expect(create?.keys[0]?.pubkey.toBase58()).toBe(HOUSE);
  });

  it('still moves the USER tokens', () => {
    const transfer = built.transaction.instructions.at(-1);
    // The token program's transfer takes (source, destination, authority), and
    // the authority is the owner whose tokens these are.
    expect(transfer?.keys[2]?.pubkey.toBase58()).toBe(USER);
  });
});
