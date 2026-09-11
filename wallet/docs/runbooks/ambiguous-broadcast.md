# Runbook: the ambiguous broadcast

**Applies to:** Phase 3 · **Audience:** whoever is on call
**Read this before touching any withdrawal in `BROADCAST`.**

## The situation

A transaction was signed and submitted, and nobody can say whether it landed.
It may be in a validator's queue about to be included; it may have been
dropped.

Both instinctive responses are wrong:

- **Re-sign and re-broadcast.** If the original did land, the account is
  debited twice. That is a double-spend, and it is the most expensive bug this
  system can have.
- **Do nothing.** If the original did not land, the user's funds stay locked
  indefinitely with no path to release that does not risk the first case.

## Why this is recoverable here

ADR-0009 builds every withdrawal on a **durable nonce account** rather than a
recent blockhash. That gives one property nothing else does:

> **The nonce advancing exactly once is proof the transaction landed exactly
> once.**

So the question has an answer, and it is one account read.

## The procedure

The confirmation worker does all of this automatically, every cycle. This is
what it does, so you can verify it or do it by hand if it is not running.

### 1. Get the nonce the transaction was built on

```sql
SELECT w.tx_signature, w.nonce_value, n.address
FROM withdrawals w JOIN nonce_accounts n ON n.id = w.nonce_account_id
WHERE w.id = '<ID>';
```

### 2. Read the nonce on-chain

```bash
solana nonce-account <ADDRESS> --url <RPC_URL>
```

### 3. Compare

| On-chain nonce       | Meaning                                             | Action                              |
| -------------------- | --------------------------------------------------- | ----------------------------------- |
| equals `nonce_value` | the transaction has **not** landed, and cannot have | re-broadcast the **existing** bytes |
| differs              | something consumed the nonce                        | check the signature (step 4)        |

### 4. When the nonce has advanced

```bash
solana confirm -v <TX_SIGNATURE> --url <RPC_URL>
```

- **Confirmed** → our transaction landed. The worker moves it to `CONFIRMED`
  and settles. Nothing to do.
- **Not found** → a competing transaction won the nonce. Ours can never land
  now, and that is _provable_ rather than assumed. The worker moves it to
  `EXPIRED` and retries on a fresh nonce.

## The rule

**Re-broadcasting identical bytes is always safe.** The same signature is
either already on-chain, in which case the network deduplicates it, or still
valid.

**Re-signing is safe only after step 3 shows the nonce advanced and step 4 shows
the transaction is absent.** There is no other circumstance, and no amount of
elapsed time substitutes for that check.

## What would make this unrecoverable

If someone changes the transaction builder to use a recent blockhash, this
procedure stops working — a dead blockhash carries no evidence, and "did it
land?" becomes genuinely unanswerable. That is the whole argument of ADR-0009,
and it is why durable nonces are not an implementation detail.
