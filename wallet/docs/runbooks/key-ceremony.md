# Runbook: key ceremony

**Covers:** generating the treasury signing key, and the distributed key
generation that 3-of-5 FROST requires.

> **Partially implemented.** Phase 4a generates a **single key** inside
> `services/mpc` on first boot. The DKG procedure in §3 describes ADR-0015's
> intended 3-of-5 ceremony and has **not been performed**. It is written now
> because a ceremony improvised with a live treasury and an audience is how
> ceremonies go wrong.

## Why a ceremony at all

A signing key's security is decided once, at the moment it comes into
existence. Everything afterwards — encryption at rest, thresholds, tiers —
protects a key that was either well-born or was not. There is no later step that
fixes entropy from a compromised host, or a key that was written to a terminal
scrollback.

## 1. Before the day

- [ ] Hosts provisioned, each with its own datastore and its own credentials
      (ADR-0015). Five processes on one machine is five copies of one blast
      radius.
- [ ] Each host's entropy source verified.
- [ ] `MPC_KEK` generated **per host**, stored where it is recoverable
      independently of the host. Losing the KEK loses the key it protects, and
      a KEK stored on the machine it protects is not a protection.
- [ ] The approval authority keypair generated, with its public half destined
      for the participants and its private half for the API.
- [ ] A scribe named. Ceremonies produce a record or they did not happen.
- [ ] This runbook read end to end by everyone attending.

## 2. Single-key generation (what 4a does today)

On first boot with `MPC_BOOTSTRAP_KEY_REF` set, the service generates a keypair,
encrypts the private half under the KEK, and stores it. The private half is
never returned by any endpoint, never logged, and has no accessor in the type
that holds it.

Record:

- [ ] The **public key**, in base58 — this is the treasury address.
- [ ] The `key_ref`.
- [ ] The date, the host, and who was present.

Verify before funding it:

```bash
# The service's public key, as the chain will see it
curl -s 'http://127.0.0.1:7070/v1/public-key?keyRef=treasury-hot-1'
```

- [ ] Confirm `TREASURY_ADDRESS` equals this key's base58 encoding. A mismatch
      means withdrawals will build transactions the treasury cannot pay for,
      and the failure appears only at broadcast.
- [ ] Fund it with a **small** amount first. Withdraw that amount end to end
      before funding it properly. A ceremony that has not produced a settled
      withdrawal has not been verified.

## 3. Distributed key generation (3-of-5, ADR-0015)

The property that defines a correct DKG: **at no point does any single machine
hold the whole key.** If any step involves assembling one and splitting it, the
ceremony has failed regardless of what it produced.

1. **Each participant generates its own secret independently**, on its own host.
2. **Participants exchange commitments** over authenticated channels. An
   unauthenticated exchange lets an attacker substitute a commitment and bias
   the group key.
3. **Each participant computes and stores its own share.** Encrypted under that
   host's KEK before it is written.
4. **The group public key is derived and recorded.** This is the treasury
   address.
5. **Verify the threshold empirically, before funding:**
   - [ ] Any 3 participants produce a valid signature.
   - [ ] Any 2 fail cleanly — no partial signature, no usable output.
   - [ ] A single participant cannot produce anything valid.
   - [ ] Each participant refuses to reuse a nonce.
6. **Exercise the repair path** (see [participant loss](./participant-loss.md))
   while there is nothing at stake. ADR-0015 requires resharing to exist before
   it is needed, and an untested path does not exist.

## 4. What must never happen

- **Never reconstruct the whole key** to check it, to back it up, or to make a
  transfer convenient. Master-prompt rule 99, and the temptation is always
  framed as temporary.
- **Never write a share or a KEK to a terminal, a log, a chat, or a ticket.**
- **Never reuse a KEK across participants.** One disclosure would then decrypt
  every share.
- **Never photograph a screen showing key material.**
- **Never continue a ceremony that went wrong.** Abandon the key and start
  again. An abandoned key costs a ceremony; a doubtful key costs the treasury.

## 5. Afterwards

- [ ] The scribe's record is filed: date, participants, hosts, public key, and
      anything that deviated from this document.
- [ ] Verification results from §2 or §3 recorded — not "it worked", but which
      checks ran.
- [ ] Every attendee's access reviewed: the ceremony is over, and standing
      access to participant hosts should not outlive it.
- [ ] An audit-log entry exists for the ceremony (master-prompt rule 166).
- [ ] This runbook updated wherever reality differed from it.

## Rotation

Resharing rotates shares **without changing the group public key**, so the
treasury address survives it. That is the routine path, and it should be
exercised on a schedule rather than only in response to a loss.

Changing the group key is a different and much larger operation: it means a new
treasury address and moving every balance to it. Do not reach for it when
resharing is what is needed.
