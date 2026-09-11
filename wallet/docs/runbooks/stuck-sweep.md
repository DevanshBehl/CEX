# Runbook: a stuck sweep

**Symptom:** a deposit address holds a balance that is not being consolidated,
or a sweep sits in a non-terminal state.

## First: a stuck sweep is not missing money

The funds are at a deposit address the platform controls, and the user's
balance was credited when the deposit was **detected** — not when it was swept.
User liabilities are unchanged by a sweep (ADR-0017), so a sweep that never runs
is an operational inefficiency, not an accounting problem.

This is worth saying first because the instinct is to move funds by hand, and
hand-moved funds are how reconciliation stops matching.

## 1. Why is it not sweeping?

| Check                                | Meaning                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| Balance below the threshold          | working as intended — sweeping dust costs more in fees than it consolidates      |
| Balance ≈ rent-exempt minimum        | working as intended — the minimum is never swept, or the account ceases to exist |
| Token balance, no SOL at the address | **fee funding has not run** — see below                                          |
| Sweep exists but is stuck            | a lifecycle problem; see §3                                                      |

## 2. A token that cannot pay its own fee

The most common genuine cause, and the reason tokens were deferred to Phase 4.

An SPL transfer cannot pay its own fee: the account needs SOL before it can move
a token. If fee funding did not run, the sweep cannot be built.

- Confirm the deposit address's SOL balance is zero or below the fee.
- Confirm `house_fees` has a positive balance — fee funding draws from the
  prepaid house balance, never from pooled customer funds (ADR-0016, rule 121).
  A negative `house_fees` is a `liabilities_covered` violation and a different,
  worse incident.
- Fee funding and the token transfer are **separate transactions** by design.
  Combining them would make the hot wallet sign a transaction that also moves a
  deposit address's tokens, putting two key classes in one signature.

## 3. A sweep stuck in the lifecycle

A sweep uses the same state machine as a withdrawal (ADR-0017), so it has the
same recovery paths and the same runbooks apply:

- Stuck in `SIGNING` → [signing outage](./signing-outage.md)
- Stuck in `BROADCAST` → [ambiguous broadcast](./ambiguous-broadcast.md)
- Repeated `EXPIRED` → the nonce pool; see `nonce.pool_exhausted` in the logs

Check the dead-letter queue:

```
GET /operator/dead-letters?queue=sweep
```

## 4. If you must move funds by hand

Sometimes the right answer. If so:

1. **Send only to the configured sweep destination.** Sending anywhere else
   defeats the entire justification for holding deposit keys under weaker
   protection (ADR-0005).
2. **Leave the rent-exempt minimum.** A swept-to-zero account ceases to exist,
   and a closed token account loses its association — the next transfer to it
   can fail outright.
3. **Record it.** Reconciliation compares the chain against the ledger. A
   manual transfer between platform addresses changes neither side's total, so
   it should produce no drift — but the fee does. Post it as a house expense or
   expect a residual the size of the fee.

## 5. What NOT to do

- **Do not sweep the rent-exempt minimum**, even when it looks like recoverable
  value. It is what keeps the account alive.
- **Do not change the sweep destination to unblock something.** It is
  configuration of the signing service for a reason.
- **Do not credit the user again** because the funds "have not arrived". They
  were credited at detection. Crediting a sweep would double the liability.

## Afterwards

If the sweep threshold is repeatedly leaving value stranded, the threshold is
wrong — that is a configuration change, not an incident.
