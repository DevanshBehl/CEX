# Runbook: losing an MPC participant

**Applies to:** the 3-of-5 FROST deployment described in ADR-0015.

> **Not yet implemented.** Phase 4a ships a **single-key** signing service.
> There are no participants to lose: losing that host loses the treasury key.
> This runbook is written ahead of the implementation because a key-recovery
> procedure invented during an incident is a key-recovery procedure that goes
> wrong. Everything below is the intended procedure and is **untested against
> a real deployment**.

## The availability budget

3-of-5 tolerates **two** unavailable participants.

| Available | State                                             | Action             |
| --------- | ------------------------------------------------- | ------------------ |
| 5         | healthy                                           | none               |
| 4         | degraded, invisible to users                      | restore at leisure |
| 3         | **at the threshold** — the next loss is an outage | restore urgently   |
| 2         | withdrawals stop; funds locked and recoverable    | incident           |

Monitoring must alert at **3**, not at 2. At 2 the decision has been made for
you.

## 1. Distinguish unavailable from lost

| Symptom                               | Reading                                   |
| ------------------------------------- | ----------------------------------------- |
| Host unreachable, disk intact         | **unavailable** — restart, do not reshare |
| Host destroyed, datastore recoverable | **unavailable** — restore onto new host   |
| Datastore lost or corrupt             | **lost** — the share is gone; reshare     |
| Share possibly disclosed              | **compromised** — reshare AND rotate      |

Resharing an unavailable-but-intact participant is unnecessary work under
pressure. Treating a lost share as merely unavailable leaves you silently at
4-of-5 with no path back.

## 2. If a share is lost: repair from a threshold of the others

`frost-core` supports repairing one participant's share from a threshold of the
rest. The group public key — and therefore the treasury address — does not
change.

1. **Confirm three healthy participants** before starting. Repair needs a
   threshold; starting with two is how you discover that at the worst moment.
2. **Provision the replacement host** with its own datastore and its own
   credentials. Reusing the lost host's credentials reuses whatever compromised
   it.
3. **Run the repair**, with each contributing participant operating
   independently. No single machine assembles the whole key.
4. **Verify** by producing a signature with a set that includes the repaired
   participant and excludes at least one that helped repair it.
5. **Confirm the group public key is unchanged.** If it changed, the treasury
   address changed, and funds are at the old address. Stop and escalate.

## 3. If a share may have been disclosed

Repair is not enough: the disclosed share still exists. **Reshare all five.**
Resharing rotates every share while preserving the group public key, so an
attacker holding one old share holds something that no longer combines with
anything.

Then treat the host as compromised in the ordinary way: rotate its credentials,
review what else it could reach, and read the audit log for signing requests in
the exposure window.

## 4. While you are below threshold

- Withdrawals stop. Funds are **locked, not lost** — that is what the lock is
  for.
- Deposits continue. Nothing about crediting needs a signature.
- Do **not** lower the threshold to restore service. A 2-of-5 deployment made
  under pressure is a permanent weakening decided by an outage.
- Do **not** reconstruct the key "temporarily". Master-prompt rule 99: never
  reconstruct a complete private key for convenience. An incident is not an
  exception; it is when the temptation is strongest.

## 5. Afterwards

- Record which participant, why, and how long recovery took.
- If recovery needed a procedure not written here, write it here.
- If the repair path had never been exercised before this incident, schedule a
  drill. ADR-0015 requires resharing to be built **before it is needed**, and an
  untested path is not built.
