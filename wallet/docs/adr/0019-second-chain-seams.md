# ADR-0019: What a second chain would touch — and why none is being added

- **Status:** accepted
- **Date:** 2026-09-11
- **Phase:** 4

## Context

master-prompt rule 195 says multichain adapters come only after the Solana
system is stable, and rule 196 says that when chains are added, the ledger,
risk, authorization and custody abstractions must be preserved.

prompt_phase4.md rules 168–173 turn that into a Phase 4 deliverable that adds
**no chain**: read `packages/blockchain` against a genuinely different chain,
find what has quietly become Solana-shaped, write it down, and change nothing.

That last instruction is the valuable one. An interface nobody has tested
against a second chain is a hypothesis, and the cheapest time to discover it is
false is before there is a second implementation depending on it.

This ADR is the result of doing that reading against **an EVM chain**, with
Bitcoin as a secondary check. EVM is the right adversary: it has no rent, no
durable nonce accounts, a different address format, a different signature
scheme, and a fee model that Solana's near-constant fee let us ignore entirely.

## Decision

**No second chain is added.** The findings below are recorded and left
unfixed, because fixing an interface for a caller that does not exist is how
speculative generality gets in. They are the checklist for the phase that does
add one.

## What actually fits

Worth stating, because most of it does, and the seam is largely sound:

| Abstraction                             | Verdict                                                            |
| --------------------------------------- | ------------------------------------------------------------------ |
| `ChainPosition = bigint`                | fits — slot, block number, height                                  |
| `Confirmation = seen/probable/final`    | fits — the three-level shape is genuinely universal                |
| `Address = string` + `AddressValidator` | fits — EIP-55 checksums and bech32 are validator concerns          |
| `TxReference = string`                  | fits                                                               |
| Amounts as base-unit strings            | fits — 18-decimal wei needs `NUMERIC(38,0)`, which is what we have |
| `TransferPage` + opaque cursor          | fits — block ranges and log filters are expressible                |
| `SignRequest.payload: Uint8Array`       | fits — the signer does not parse, which is what saves it           |
| `packages/ledger`, `packages/risk`      | fit — zero chain imports, verified by `verify-boundaries.mjs`      |

The double-entry ledger, the account key `(owner, asset, type)`, the withdrawal
state machine and the risk engine are all chain-independent as designed. None of
them would change.

## What is Solana-shaped

### 1. `TransferEvent.instructionIndex` — leaked vocabulary

`packages/blockchain/src/chain.ts`. "Instruction" is Solana's word. EVM's
equivalent is a **log index**; Bitcoin's is an **output index**. The concept is
sound and necessary — one transaction can carry several transfers to one address
— but the name is not neutral.

It also slipped past the guard that exists to catch exactly this.
`packages/blockchain/test/no-chain-leak.test.ts` bans `slot`, `mint`,
`blockhash` and `nonce` as identifiers; `instruction` is not on the list. The
test worked as written and the list was incomplete, which is the ordinary way
this kind of thing survives.

Neutral name: `transferIndex`. Cost of changing it: 26 occurrences across
packages and apps, plus a column rename. **Deferred** — renaming it now
churns a working system for a caller that does not exist.

### 2. `getMinimumAccountBalance` — rent is not universal

`packages/blockchain/src/adapter.ts` asks every chain for "the minimum balance
an account needs in order to exist".

- **Solana:** rent-exempt minimum. Real, per-account, and load-bearing — it is
  why `house_rent` exists.
- **EVM:** no such concept. An adapter returns `"0"` and the abstraction holds,
  but the interface implies a universal that isn't.
- **Bitcoin:** the dust limit is per-**output**, not per-account, and it is a
  relay policy rather than a consensus rule. The shape does not match.

The method is honest for account-model chains and approximately meaningless for
UTXO ones. **Deferred**; noted as the place a UTXO chain would first push back.

### 3. There is no fee concept in the interface at all — the largest gap

`ChainAdapter` has no `estimateFee`, no fee parameters, and no way to express
that a fee changed between building a transaction and broadcasting it.

This is not an oversight so much as a Solana-shaped absence. Solana's fee is
about 5,000 lamports per signature and effectively constant, so Phase 3 could
treat fees as a house expense settled after the fact (`postHouseFunding`) and
never model them in the adapter.

On EVM that is not survivable:

- A transaction cannot be built without a gas limit and a fee cap.
- EIP-1559 splits the fee into base fee and priority fee, and the base fee moves
  per block.
- A fee estimated at build time can be too low by broadcast time, and the
  transaction sits unmined — which is a _state the withdrawal machine has no
  transition for_. `BROADCAST` assumes a transaction that will either land or
  provably fail; "valid, broadcast, and stuck until refeed" is neither.
- Replacement-by-fee means re-broadcasting **different bytes** for the same
  withdrawal, which collides with the rule that re-broadcast never signs new
  bytes (ADR-0009, prompt_phase3.md rules 140–143).

Adding EVM would require a fee abstraction in `packages/blockchain`, a fee
estimate persisted with the withdrawal, and at minimum one new withdrawal state.
**This is the finding that would cost the most, and it is the one the Solana-only
design hid most completely.**

### 4. The 64-byte signature assumption lives in application code

Two places assert an Ed25519 signature length:

- `packages/blockchain/src/signers/rust-single-key.ts:168` — acceptable; that
  file is the Ed25519 transport.
- `apps/api/src/workers/withdrawal-workers.ts:210` — **not** acceptable. This is
  application orchestration asserting a curve.

secp256k1 recoverable signatures are 65 bytes (r, s, v). A second chain breaks
that line, and it breaks it in the layer that is supposed to be chain-agnostic.

The `Signer` interface also carries no scheme identifier, so a `KeyRef` cannot
say what curve it is for. Adding a chain means adding a second key type, and the
interface has nowhere to put it.

**Deferred**, but this is a two-line fix (move the length check behind the
adapter) and the cheapest item on the list.

### 5. Durable nonce accounts reach the shared schema

`withdrawals.nonce_account_id` and `withdrawals.nonce_value`, plus the whole
`nonce_accounts` table and its lease protocol.

A durable nonce account is a Solana mechanism. EVM has an account nonce — a
per-sender counter — which shares the word and almost nothing else: it is
sequential, it is not an account, it cannot be leased, and a gap in the sequence
blocks every later transaction from that sender. That last property is a
_stronger_ constraint than anything the pool models, and the pool's design
(lease any available account, order irrelevant) is the wrong shape for it.

The columns are nullable, so an EVM withdrawal would leave them null and the
schema would survive. But the lease protocol, the pool, the provisioning script
and the ambiguity-resolution logic built on "the nonce advanced" are all
Solana-only, and an EVM adapter would need its own sequencing discipline rather
than a subset of this one.

**Deferred.** The right shape is probably a per-chain `sequencing` strategy
behind the adapter, and it cannot be designed properly without the second chain
in hand.

## What would have to change, by package

| Package / area        | Change                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/blockchain` | fee abstraction; scheme on `KeyRef`; rename `instructionIndex`; revisit `getMinimumAccountBalance` |
| `packages/ledger`     | **none** — verified                                                                                |
| `packages/risk`       | **none** — limits are already per-asset                                                            |
| `packages/types`      | withdrawal states: likely one new state for "broadcast, underpriced"                               |
| `packages/db`         | per-chain sequencing table; `chain` already a column on every relevant table                       |
| `packages/<newchain>` | new package, adapter + address validator + transaction builder                                     |
| `services/mpc`        | second key type and curve; FROST-Ed25519 does not sign for secp256k1                               |
| `apps/api`            | remove the 64-byte assertion; chain selection in withdrawal routing                                |
| config                | per-chain RPC, confirmation policy, asset allowlist                                                |

`services/mpc` is the entry that is easy to underestimate. Threshold signing for
secp256k1 is a different protocol from FROST-Ed25519 — and master-prompt rule
106 forbids inventing it.

## Consequences

- **Nothing is implemented.** This ADR is the deliverable.
- `no-chain-leak.test.ts` has a demonstrated gap in its identifier list. Adding
  `instruction` would fail the suite today, which is why the rename and the
  test change belong to the same commit — in the phase that does the rename.
- The seam is in better shape than the findings list suggests: the ledger, risk
  and state machine — the parts that would have been most expensive to get wrong
  — need no changes at all. The leaks are concentrated in the adapter layer,
  which is where they are supposed to be if the seam is working.
- The fee gap (finding 3) should be treated as the gate. A second chain is not a
  matter of writing a second adapter; it is a matter of the withdrawal lifecycle
  learning that a broadcast transaction can be _stuck_ rather than pending.
