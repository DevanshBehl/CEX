# ADR-0024: What a person reviews, and what code approves

**Status:** accepted · **Supersedes:** part of ADR-0010 · **Relates to:** ADR-0011, ADR-0016, ADR-0021, ADR-0022

## Context

Every withdrawal waited for an operator.

Not by decision — by accumulation. ADR-0010 introduced two rules that each
looked prudent alone: a base-unit review threshold per asset, and
`RISK_NEW_DESTINATION_REVIEW`, which refers any first-time destination. A
normal user's first withdrawal goes to an address they have never used before,
because every address is new the first time. So the second rule referred
essentially all of them, and the first one caught whatever the second missed.
The review queue was not a queue of unusual withdrawals; it was the withdrawal
pipeline, with a human in it.

That is worse than slow. A queue that contains everything cannot be read. An
operator working through hundreds of routine $40 transfers is not exercising
judgement on any of them, and the one withdrawal that deserved a second look
arrives in the same undifferentiated list as the rest. Manual review is a
scarce resource and it was being spent uniformly, which is the same as not
spending it.

The base-unit threshold had a second problem that tokens made visible. It is
denominated in the asset's own base units — `25000000000` means 25 SOL at nine
decimals, and the same number means 25,000 USDC at six. One figure cannot be
written that is correct for both, so each asset got its own, and the two drift
apart the moment the SOL price moves. "Review anything over 25 SOL" was a
sentence about dollars that could only be written in lamports.

## Decision

### 1. A person reviews a withdrawal because of what it is WORTH

One threshold, in US dollars, across every asset:
`RISK_MANUAL_REVIEW_ABOVE_USD`. A withdrawal worth more than it goes to an
operator. A withdrawal worth less, that passes every hard check, is approved by
code and its funds are locked immediately.

Dollars because that is the unit the policy is actually expressed in. An
institution's appetite is "a person looks at anything over five thousand
dollars", and that sentence should appear in configuration as it is spoken,
not re-derived into lamports and token base units that need re-deriving every
time a price moves.

The USD threshold **supersedes** the per-asset base-unit review thresholds
while it is set. `manualReviewThresholdRule` abstains rather than being
deleted, so a decision recorded under the old policy still replays to what it
said at the time. `POLICY_VERSION` moves to `2`.

### 2. STRICTLY GREATER THAN

A threshold of $5,000 means $5,000.00 exactly is approved automatically and
$5,000.01 is reviewed. Stated because a boundary that is not stated is a
boundary that is implemented twice, differently.

### 3. What code checks before it approves anything

The rule above only decides whether a **person** is also needed. It cannot
approve anything on its own, and it never softens a denial. Every hard check
still runs on every withdrawal, and any of them still denies outright:

- **The account is active.** A suspended or closed account withdraws nothing,
  at any value.
- **The requester owns the funds.** The session cookie establishes the user,
  and the withdrawal is created against `session.userId` — never against a
  user id in the request body, which is why the body has no such field. The
  ledger accounts debited are that user's own. There is no code path by which
  one user's request moves another user's balance, and `get`/`list` answer
  `404` rather than `403` for someone else's withdrawal so the id is not even
  confirmed to exist.
- **A fresh passkey assertion.** Submitting a withdrawal requires a step-up
  within a freshness window that shortens as the amount grows (ADR-0011) — so
  the signer is not merely someone holding a session cookie, but someone who
  proved possession of the authenticator seconds ago.
- **The funds are actually there.** The sufficient-funds check is the ledger
  lock itself, inside one `SERIALIZABLE` transaction that reads the available
  balance and posts the reservation together. It is deliberately **not** a risk
  rule: two concurrent withdrawals can each pass a balance check and both
  proceed, whereas only one can win the ledger write. A rule that read the
  balance would be a rule that can be raced.
- **The destination is a valid external address** on this chain, and is not
  platform-owned.
- **The per-transaction and rolling daily limits, and velocity.** Unchanged.
- **The asset has configured limits.** An allowlisted mint with no entry in
  `RISK_ASSET_LIMITS` is denied, not defaulted (ADR-0016).

Auto-approval is therefore not "approve if small". It is "this withdrawal
already passed every check that a person would not add anything to, and it is
small enough that a person would not be asked to add anything."

### 4. An unpriced withdrawal is REVIEWED, never auto-approved

If the price feed is down, or the asset has no tick inside
`RISK_PRICE_MAX_AGE_SECONDS`, the value is unknown — and an unknown value
cannot be shown to be under the threshold. Those withdrawals go to review with
`VALUE_UNPRICED`.

This is the direction that matters. Failing the other way would mean an outage
silently switched every withdrawal to automatic approval, at exactly the moment
nobody is confident what anything is worth. Reviewing a small withdrawal during
an outage costs an operator a minute; auto-approving a large one costs the
withdrawal.

A stale tick is treated as no tick for the same reason: a price that happened
to be low is how a large withdrawal slips under a threshold.

### 5. Pricing happens OUTSIDE the engine

`packages/risk` reads no database and makes no network call; it is a pure
function of the input it is handed, which is what makes a decision replayable.
So `withdrawal-valuation.ts` prices the withdrawal in the service, before the
engine runs, and passes `valueUsdMicros` in like every other input.

A pricing failure is a `null` value, not a thrown exception. An exception would
block the withdrawal on a price feed, and the price feed is not on the path of
whether someone may have their money.

### 6. First-time destinations are no longer reviewed by default

`RISK_NEW_DESTINATION_REVIEW` defaults to `false`. Its stated purpose — catch
a withdrawal going somewhere unusual — is not something it ever achieved, since
every destination is unusual once. Value is the better proxy, and the setting
remains for a deployment that wants the stricter posture.

## Consequences

**What this gives up.** A small withdrawal to an attacker-controlled address
now completes without a human seeing it. That is the real cost, and the
mitigations are the ones already in place and now load-bearing: the step-up
assertion on submission, the per-transaction and daily limits that cap what a
sequence of small withdrawals can extract, and velocity. An attacker with a
live session and an authenticator can drain up to the daily limit without
tripping review. That is the trade the threshold is: the number is the
statement of how much the platform is willing to lose to automation.

**It depends on the price feed's integrity.** A feed that reports SOL at $1
would put every SOL withdrawal under the threshold. The freshness window limits
the blast radius in time but not in value, and this is the strongest new
dependency the decision creates. `PRICE_SOURCE=static` in a deployment that
forgot to configure a real one is the realistic version of this failure.

**The queue becomes readable.** Which is the point. What reaches an operator is
now withdrawals above the threshold and withdrawals nobody could price — both
of which are worth a person's attention, which is the only defensible reason to
ask for one.
