# Runbook: key ceremony

**Covers:** generating the treasury signing key, and the distributed key
generation that 3-of-5 FROST requires.

> **Implemented (ADR-0023).** Under `MPC_ROLE=coordinator` the house key and
> every per-user key come from interactive 3-of-5 DKG. No machine ever holds a
> group key. `MPC_ROLE=single-key` still creates one key in one process (§2). A
> DKG ceremony across five **independent hosts** with an audience, as §3
> describes, has not yet been performed on mainnet.

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

## 3. Distributed key generation (3-of-5, ADR-0015, ADR-0023)

The property that defines a correct DKG: **at no point does any single machine
hold the whole key.** If any step assembles a key and then splits it, the
ceremony has failed, whatever it produced. `services/mpc` has no code path that
does this. The dealer was deleted.

**Setup, once per deployment (before the first key):**

- [ ] On each participant host, with that host's `MPC_KEK` and
      `MPC_DATABASE_PATH`, run `wallet-mpc dkg-identity`. It generates the
      participant's X25519 transport key inside its store and prints **only**
      the public half.
- [ ] Assemble `MPC_DKG_PEERS` (`identifier_hex=base64_key` × 5) and distribute
      the **same value** to all five participants through a channel the
      coordinator's operators do not control. If one party can alter this list,
      that party can read shares.
- [ ] Check each participant's boot log. It must not report
      `participant_identifier_mismatch`, and it must not warn that
      `MPC_DKG_PEERS` is unset.

**The ceremony itself** runs automatically: at coordinator first boot for the
house key, and on `POST /v1/frost/dkg/init` for each user.

1. **Round 1.** Each participant samples its own polynomial on its own host,
   seals it under its KEK, and publishes commitments and a proof of knowledge.
2. **Round 2.** Each participant verifies every proof and checks that its own
   commitment was relayed unaltered. It then seals one share per peer, which
   only that peer can open, bound to the round-1 transcript.
3. **Round 3 (finalize).** Each participant opens its four shares, verifies
   each against the sender's commitments, and derives and seals its share as
   pending. **Any bad share aborts that participant and wipes its session.**
   The log names the culprit.
4. **Commit.** The coordinator checks that all five derived the group package
   implied by the public commitments. Only then does each participant install
   its share. The group public key is recorded. This is the address.

If a ceremony aborts, **do not force it**. Read the participant logs for
`culprit` and `dkg_transcript_mismatch`. A transcript mismatch means the
coordinator relayed different commitments to different participants. Treat
that as a coordinator compromise, not a network fault.

**After the ceremony, before funding:**

- [ ] Any 3 participants produce a valid signature.
- [ ] Any 2 fail cleanly — no partial signature, no usable output.
- [ ] A single participant cannot produce anything valid.
- [ ] Each participant refuses to reuse a nonce.
- [ ] **Exercise the repair path** (see [participant loss](./participant-loss.md))
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
