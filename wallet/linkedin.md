# Atlas Wallet — architecture

A custodial Solana wallet (SOL + SPL tokens) where every user's deposit address
is their **own 3-of-5 FROST-Ed25519 threshold key**, created by distributed key
generation. No server, process or coordinator ever holds a private key.

Rendered, high-resolution PNGs of each diagram are in `linkedin-diagrams/`.

---

## 1. System architecture

```mermaid
%%{init: {"theme": "dark", "themeVariables": {"fontSize": "28px", "fontFamily": "Helvetica, Arial, sans-serif"}, "flowchart": {"nodeSpacing": 60, "rankSpacing": 80, "padding": 24}}}%%
flowchart TB
    user(["👤 User<br/>browser + passkey"])
    web["🖥️ Web app<br/>Next.js"]
    api["⚙️ API + workers<br/>Fastify · TypeScript"]
    db[("🗄️ PostgreSQL<br/>double-entry ledger")]
    redis[("⚡ Redis<br/>rate limits")]
    sol[("◎ Solana<br/>devnet · mainnet")]
    coord["🔐 MPC Coordinator<br/>Rust · holds NO key"]
    parts["🧩 5 Participants<br/>1 sealed key share each<br/>any 3 can sign"]

    user --> web
    web --> api
    api --> db
    api --> redis
    api -->|"deposits · broadcast"| sol
    api -->|"sign request"| coord
    coord <-->|"threshold rounds"| parts
```

---

## 2. Key generation — no trusted dealer

```mermaid
%%{init: {"theme": "dark", "themeVariables": {"fontSize": "26px", "fontFamily": "Helvetica, Arial, sans-serif"}, "sequence": {"actorFontSize": 26, "messageFontSize": 24, "noteFontSize": 22, "boxMargin": 14, "actorMargin": 120, "width": 260}}}%%
sequenceDiagram
    participant C as Coordinator
    participant P as 5 Participants

    C->>P: Round 1 · start
    P-->>C: commitments + proof of knowledge
    C->>P: Round 2 · share exchange
    P-->>C: shares, end-to-end encrypted
    Note over C: sees only ciphertext
    C->>P: Round 3 · verify
    P-->>C: all 5 agree on group key
    C->>P: Commit
    Note over P: each keeps its own share
    Note over C,P: address = group public key
```

---

## 3. Withdrawal lifecycle

```mermaid
%%{init: {"theme": "dark", "themeVariables": {"fontSize": "28px", "fontFamily": "Helvetica, Arial, sans-serif"}, "flowchart": {"nodeSpacing": 50, "rankSpacing": 60, "padding": 22}}}%%
flowchart TB
    a["📝 Request<br/>passkey step-up"]
    b{"🛡️ Risk engine"}
    c["👮 Manual review<br/>operator approves"]
    d["🔒 Funds locked"]
    e["🔐 3-of-5 signing<br/>house pays fee · user key signs"]
    f["📡 Broadcast<br/>durable nonce"]
    g["✅ Settled<br/>ledger posted"]
    x["❌ Rejected"]

    a --> b
    b -->|"new address"| c
    b -->|"within policy"| d
    b -->|"over limit"| x
    c --> d
    d --> e --> f --> g
```

---

## 4. Deposit flow

```mermaid
%%{init: {"theme": "dark", "themeVariables": {"fontSize": "28px", "fontFamily": "Helvetica, Arial, sans-serif"}, "flowchart": {"nodeSpacing": 50, "rankSpacing": 60, "padding": 22}}}%%
flowchart TB
    a["💸 User sends SOL / USDC<br/>to their own 3-of-5 address"]
    b["🔎 Indexer watches<br/>address + token accounts"]
    c{"Finalized?<br/>Token allowlisted?"}
    d["✅ Balance credited<br/>exactly once"]
    e["🚫 Recorded, never credited"]

    a --> b --> c
    c -->|"yes"| d
    c -->|"unknown token"| e
```

---

## Stack

| Layer    | Technology                                                            |
| -------- | --------------------------------------------------------------------- |
| Frontend | Next.js 15, React, WebAuthn passkeys                                  |
| API      | Fastify 5, TypeScript, Prisma 6, Zod                                  |
| Data     | PostgreSQL (append-only double-entry ledger), Redis                   |
| Signing  | Rust, axum, `frost-ed25519` 3-of-5, X25519 + ChaCha20-Poly1305        |
| Chain    | Solana — SOL + allowlisted SPL tokens, durable nonces                 |
| Tooling  | pnpm + Turborepo, Vitest, Playwright, Cargo                           |

Verified end to end on **Solana devnet**: DKG-generated user address, deposit,
operator-approved withdrawal signed by 3-of-5 threshold rounds, settled on-chain.

> Educational project — not audited, not for real funds.
