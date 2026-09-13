# Atlas Wallet — architecture

A custodial Solana wallet (SOL + allowlisted SPL tokens) where every user's
deposit address is their **own 3-of-5 FROST-Ed25519 threshold key**, generated
by distributed key generation. No server, process or coordinator ever holds a
private key.

---

## 1. System architecture

```mermaid
flowchart LR
    user(["User<br/>browser + passkey"])
    operator(["Operator<br/>approver role"])

    subgraph web["apps/web · Next.js 15"]
        ui["Dashboard · Deposit · Withdraw<br/>Activity · Security · Operator queue"]
    end

    subgraph api["apps/api · Fastify 5 (TypeScript)"]
        direction TB
        routes["REST routes<br/>auth · custody · withdrawals · portfolio · operations"]
        subgraph domain["Domain packages"]
            auth["@wallet/auth<br/>WebAuthn + TOTP<br/>server-side sessions · step-up"]
            risk["@wallet/risk<br/>limits · velocity<br/>new-destination review"]
            ledger["@wallet/ledger<br/>double-entry, append-only"]
            chain["@wallet/solana<br/>tx builders · SPL · durable nonces"]
        end
        subgraph workers["Background workers (per cluster)"]
            indexer["Deposit indexer"]
            wflow["Withdrawal workers<br/>signer → broadcast → confirm"]
            recon["Reconciliation<br/>ledger vs chain"]
            pricer["Pricer"]
        end
        mpcclient["MPC client<br/>Ed25519-signed requests"]
    end

    subgraph data["State"]
        pg[("PostgreSQL<br/>ledger · withdrawals · audit log<br/>append-only via REVOKE + triggers")]
        redis[("Redis<br/>rate limits · WebAuthn challenges")]
    end

    subgraph mpc["services/mpc · Rust (axum) — the signing boundary"]
        coord["Coordinator<br/>holds NO key material<br/>runs DKG + signing rounds"]
        p1["Participant 1<br/>share sealed (AES-256-GCM)<br/>own SQLite · own KEK"]
        p2["Participant 2"]
        p3["Participant 3"]
        p4["Participant 4"]
        p5["Participant 5"]
    end

    solana[("Solana RPC<br/>localnet · devnet · mainnet-beta")]
    prices[("Price feed<br/>CoinGecko / Pyth")]

    user --> ui
    operator --> ui
    ui -->|HTTPS · cookie session| routes
    routes --> auth & risk & ledger
    auth --> redis
    routes --> pg
    ledger --> pg
    wflow --> chain
    wflow --> mpcclient
    routes -->|provision user key| mpcclient
    mpcclient -->|POST /v1/sign · /v1/frost/dkg/init| coord
    coord <-->|authenticated rounds| p1 & p2 & p3 & p4 & p5
    indexer -->|finalized transfers| solana
    chain -->|broadcast| solana
    recon --> solana
    indexer --> ledger
    pricer --> prices
```

**Trust boundary:** the TypeScript API can *ask* for a signature but can never
produce one. Each participant independently verifies a payload-bound approval
proof and the custody-tier policy before contributing a signature share.

---

## 2. Key generation — distributed, no trusted dealer

```mermaid
sequenceDiagram
    autonumber
    participant API as API
    participant C as Coordinator (no key)
    participant P as Participants 1..5 (each on its own store + KEK)

    API->>C: POST /v1/frost/dkg/init {keyRef: user:id, idempotencyKey}
    Note over C: per-keyRef lock · existing key? return it, run no rounds

    C->>P: Round 1
    P-->>C: Feldman commitments C(i,k) + Schnorr proof of knowledge
    Note over P: secret polynomial sealed under KEK before replying

    C->>P: Round 2 (all 5 commitment sets)
    Note over P: verify every proof · hash the round-1 transcript
    P-->>C: 4 shares per participant, each sealed peer-to-peer<br/>X25519 + HKDF-SHA256 + ChaCha20-Poly1305<br/>bound to session + transcript
    Note over C: sees only ciphertext — cannot read or forge a share

    C->>P: Round 3 / finalize (route each participant its envelopes)
    Note over P: verify share · G = Σ i^k · C(j,k)<br/>bad share ⇒ abort + wipe session
    P-->>C: group key Y, verification share Y(i), package hash
    Note over C: recompute Y = Σ C(j,0) from public data<br/>all 5 must agree

    C->>P: Commit
    P-->>C: share installed (never overwrites)
    C-->>API: address = base58(Y) + verification shares
```

---

## 3. Deposit and withdrawal lifecycle

```mermaid
flowchart TB
    subgraph deposit["Deposit"]
        d1["User sends SOL / SPL<br/>to their own 3-of-5 address"] --> d2["Indexer polls address<br/>+ token accounts"]
        d2 --> d3{"finalized?<br/>mint allowlisted?"}
        d3 -->|yes| d4["Ledger credit<br/>idempotent on tx + instruction"]
        d3 -->|unknown mint| d5["Recorded as ignored<br/>never credited"]
    end

    subgraph withdraw["Withdrawal state machine"]
        w1["REQUESTED<br/>passkey step-up"] --> w2["RISK_EVALUATING"]
        w2 -->|new destination / large| w3["MANUAL_REVIEW<br/>operator approves"]
        w2 -->|within policy| w4["APPROVED"]
        w3 --> w4
        w2 -->|limit breached| wr["REJECTED"]
        w4 --> w5["FUNDS_LOCKED<br/>user_available → user_locked"]
        w5 --> w6["SIGNING<br/>2 threshold rounds:<br/>house = fee payer + nonce authority<br/>user group = source"]
        w6 --> w7["SIGNED"] --> w8["BROADCAST<br/>durable nonce"] --> w9["CONFIRMED"] --> w10["SETTLED<br/>ledger posted"]
        w6 -.->|budget exhausted| wf["SIGN_FAILED / FAILED<br/>lock released"]
        w8 -.-> wx["BROADCAST_FAILED / EXPIRED"]
    end
```

---

## Stack

| Layer          | Technology                                                                 |
| -------------- | -------------------------------------------------------------------------- |
| Frontend       | Next.js 15, React, WebAuthn (`@simplewebauthn/browser`)                    |
| API            | Fastify 5, TypeScript, Zod-validated config, Prisma 6                      |
| Data           | PostgreSQL (double-entry ledger, append-only audit), Redis                 |
| Signing        | Rust, axum, `frost-ed25519` 3-of-5, `x25519-dalek`, ChaCha20-Poly1305      |
| Chain          | Solana — SOL + allowlisted SPL, durable nonces, per-cluster ledger keys    |
| Monorepo       | pnpm + Turborepo, Vitest, Playwright, Cargo                                |

Verified end to end on **Solana devnet**: DKG-generated per-user address,
deposit, operator-approved withdrawal signed by two 3-of-5 threshold rounds,
settled on-chain.

> Educational project — not audited, not for real funds.
