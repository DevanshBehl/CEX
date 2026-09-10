# Phase 2 Prompt — Custody Primitives & Money-In

> **Parent spec:** [`master-prompt.md`](./master-prompt.md) · **Plan:** [`report.md`](./report.md) §5 Phase 2
> **Predecessor:** [`prompt_phase1.md`](./prompt_phase1.md) — complete, all 30 exit criteria met
> **Goal statement:** *SOL sent to a user's deposit address appears in their balance, exactly once, and the books balance.*
> **Covers master-prompt rules:** 91–100, 111–130, 177, 181, 189–190
> **Sizing:** ~4 weeks

---

## 0. How To Read This Document

1. This is the implementation contract for Phase 2 only.
2. Every numbered line is a directive, in the same style as `master-prompt.md` and `prompt_phase1.md`.
3. Where this document and `master-prompt.md` disagree, `master-prompt.md` wins and the conflict must be reported rather than silently resolved.
4. Do not begin Phase 3 work. Do not write withdrawal, risk, policy, signing, or MPC code.
5. Phase 2 is finished only when every box in §14 is checked.

---

## 1. Why Deposits Come Before Withdrawals

6. Deposits require no signing, so the ledger can be proven correct before any key material exists.
7. Building withdrawals first would mean debugging accounting bugs and signing bugs at the same time, with no way to tell which layer is wrong.
8. Phase 2 therefore ends with money that can arrive and be accounted for, but cannot leave.
9. Funds remain in per-user deposit addresses for the whole of Phase 2; sweeping them requires signing and belongs to Phase 4.
10. Treat the absence of a withdrawal path as a feature of this phase, not an omission.

---

## 2. Blocking Decisions

11. The following must be settled and written as ADRs in `docs/adr/` **before** any Phase 2 code is written.
12. ADR-0004 — deposit address model. Per-user derived addresses (recommended) versus an omnibus account with a payment reference.
13. ADR-0005 — deposit key custody class. Confirm deposit keys are a distinct, lower-privilege class from treasury keys.
14. ADR-0006 — confirmation policy. `finalized` for crediting (recommended); document the drift risk of anything weaker.
15. ADR-0007 — indexer transport. RPC polling (recommended for this scope) versus Geyser/Yellowstone gRPC versus a webhook provider.
16. ADR-0008 — asset allowlist. SOL only for Phase 2; which SPL tokens, if any, are deferred to Phase 4.
17. Rule 12 determines indexer design, sweep economics, and the eventual MPC key count; deciding it late means rework across two phases.
18. Rule 13 exists because per-user addresses with per-user MPC keys make the Phase 4 key ceremony cost unbounded.
19. Each ADR must record the alternatives that were genuinely close and why they lost, per the template in `docs/adr/0000-template.md`.

---

## 3. Phase Scope

### In scope
20. `packages/ledger` — double-entry accounting domain, pure and infrastructure-free.
21. `packages/blockchain` — chain-agnostic interfaces only.
22. `packages/solana` — the Solana implementation of those interfaces.
23. Ledger persistence, migrations, and immutability enforcement in `packages/db`.
24. Wallet, address, and deposit records.
25. Deterministic deposit-address derivation and assignment.
26. The indexer worker: watch, detect, confirm, attribute, credit.
27. Deposit API endpoints and the deposit/balance UI.
28. Reconciliation v0 — internal liabilities against chain-controlled assets.
29. A queue abstraction backed by Redis, sufficient for the indexer's needs.

### Explicitly out of scope
30. Do not create `packages/risk` or `services/mpc` in Phase 2.
31. Do not implement any `Signer`, mock or otherwise — the interface is declared, nothing implements it (see §7).
32. Do not implement withdrawals, fund locking, risk rules, or policy evaluation.
33. Do not implement sweeps from deposit addresses to a hot wallet.
34. Do not implement SPL token support; SOL only (see rule 16).
35. Do not implement hot/warm/cold operational segregation — model the role as a column, implement nothing behind it.
36. Do not add a second chain. `packages/blockchain` is written to make one possible later, not to have one now.
37. Do not build an admin or operator UI beyond the reconciliation report.

---

## 4. Carried Forward From Phase 1

38. Every Phase 1 rule that describes how to work still applies; this section names the ones Phase 2 will be tempted to break.
39. `process.env` is read in exactly two files. New configuration goes into `packages/config`'s schema, validated at boot.
40. The logger allowlist stays an allowlist. New fields require editing `packages/logger/src/allowlist.ts` deliberately.
41. Do not add an amount, balance, address, or transaction signature to the log allowlist without justifying it in the pull request.
42. Every new API contract is a Zod schema in `packages/types`, used by both the server and the typed web client.
43. Every error is an `AppError` subclass with a stable code declared in `packages/types`.
44. `InsufficientFundsError` already exists with its code reserved (Phase 1 rule 81); Phase 2 gives it its meaning.
45. Every route validates request and response; guards run at `preValidation`, before schema validation.
46. Every new architectural boundary gets a case in `scripts/verify-boundaries.mjs`.
47. Add the case proving `packages/ledger` cannot import `packages/solana` or `@solana/*` before writing the rule it tests.
48. Integration tests run against real PostgreSQL. A mock cannot prove a constraint, a trigger, or an isolation level.
49. Turbo caches aggressively and will replay a stale success. If a result looks impossible, clear `.turbo` before believing it.

---

## 5. The Three Invariants

50. Phase 2 exists to make three statements true and keep them true.
51. **Invariant A — every ledger transaction balances.** The signed sum of its entries is exactly zero.
52. **Invariant B — every blockchain transfer credits at most once.** Replaying the same on-chain event is a no-op, not a second credit.
53. **Invariant C — internal liabilities never exceed chain-controlled assets.** Reconciliation reports the difference, and the difference is explainable.
54. Each invariant must be enforced by the database or by a total function, never by a convention or a code review habit.
55. Each invariant must have a test that fails if the enforcement is removed.

---

## 6. `packages/ledger` — The Accounting Domain

56. This package contains pure functions and types. No database import, no HTTP, no chain, no clock, no randomness.
57. Rule 56 is what makes the invariants testable exhaustively rather than by example.
58. Nothing in this package may import `packages/solana`, `packages/blockchain`, or `@solana/*`.

### Amounts
59. Represent every amount as an integer count of an asset's smallest indivisible unit.
60. Use `bigint` in memory and the branded `BaseUnits` decimal string at every boundary — API, database, and log.
61. `BaseUnits` already exists in `packages/types` from Phase 1; give it arithmetic here, not there.
62. Never use `number` for an amount, in any position, including a test fixture.
63. Never use a floating-point type in the database for an amount.
64. An asset's decimal precision is metadata for display only and must never participate in arithmetic.

### Accounts
65. An account is identified by the triple `(owner, asset, type)` and holds no balance column.
66. Define account types: `user_available`, `user_locked`, `chain_assets`, `house_fees`, `house_rent`, `external`.
67. `user_available` and `user_locked` are liabilities: what the platform owes a specific user.
68. **`user_locked` is a separate ACCOUNT, not a column on `user_available`.**
69. Rule 68 is the single most important structural decision in this package: it makes a lock a balanced transfer between two accounts, which is auditable and reversible, rather than a mutation, which is neither.
70. Phase 2 creates `user_locked` and never moves anything into it. Phase 3 does, on withdrawal approval.
71. `chain_assets` is an asset account: what the platform actually controls on-chain.
72. `house_rent` records SOL locked in rent-exemption minimums, which is real, ours, and not user-withdrawable.
73. `house_fees` records network fees paid or collected.
74. `external` is the contra account representing the outside world, and is the only account permitted to hold an unbounded balance of either sign.
75. Every non-`external` account must have a defined normal sign, and a projection that violates it is a bug, not a state.

### Entries and transactions
76. A ledger transaction groups two or more entries and carries the reason it exists.
77. An entry identifies account, asset, signed amount, direction, and the transaction that contains it (master-prompt rule 114).
78. Entries are immutable. There is no update and no delete, at any layer.
79. A transaction's entries must sum to zero across all accounts, per asset.
80. Reject a transaction that mixes assets within one entry; a cross-asset movement is two transactions plus an explicit exchange, which Phase 2 does not have.
81. Provide a single `buildTransaction` function that returns either a valid balanced transaction or a typed error, and make it the only way one is constructed.
82. Provide `projectBalance(entries)` returning available, locked, and total, computed from entries alone.
83. **There is no balance column anywhere in Phase 2.** A balance is always a projection.
84. Rule 83 is checked by inspection at review time and by a test asserting no such column exists in the schema.
85. If projection performance becomes a problem, the answer is a derived cache that is provably reconstructible from entries — not an authoritative column. Do not build one in Phase 2.

### Invariant checks
86. Provide `assertBalanced(transaction)` — total debits equal total credits.
87. Provide `assertNoNegativeAvailable(projection)` — a user's available balance may never be negative.
88. Provide `assertLiabilitiesCovered(projections)` — total user liabilities do not exceed `chain_assets` less `house_rent`.
89. Test all three with property-based tests over generated operation sequences, not only worked examples (master-prompt rule 177).
90. Rule 89 must include sequences containing duplicates, reorderings, and zero-amount entries.

---

## 7. `packages/blockchain` — Chain-Agnostic Interfaces

91. This package contains interfaces and types. It must contain no implementation and no chain dependency.
92. Define `ChainAdapter` — the operations the domain needs from any chain.
93. Define `AddressValidator` — is this string a valid address on this chain, and is it a safe destination.
94. Define `TransferEvent` — a normalized incoming transfer: asset, amount in base units, destination address, transaction reference, index within the transaction, slot or height, confirmation state.
95. Define `Signer` as a type declaration only, matching master-prompt rule 101.
96. Rule 95 exists so `ChainAdapter`'s transaction-building signatures are complete. **Nothing implements `Signer` in Phase 2** — the mock arrives in Phase 3 and the real one in Phase 4.
97. Define `ConfirmationPolicy` as a named, configurable value rather than a literal scattered through the adapter.
98. No type in this package may name Solana, a lamport, a slot-specific concept, or an SPL construct.
99. Rule 98 is the seam that master-prompt rule 196 depends on; a leak here costs a rewrite when a second chain arrives.
100. Express chain-specific concepts through a generic parameter or an opaque metadata field, never by widening the interface.

---

## 8. `packages/solana` — The Solana Implementation

101. This is the only package permitted to import a Solana SDK.
102. Implement `ChainAdapter` and `AddressValidator` for Solana.
103. Wrap the RPC client so that timeouts, retries, and rate limits are handled in one place.
104. Treat every RPC failure as a `ChainError`; never let a driver error escape this package.
105. Implement deterministic deposit-address derivation from a single master seed plus a per-user index.
106. The derivation must be reproducible from the seed and the index alone, so addresses can be recovered without the database.
107. Record the derivation path with each address so rule 106 is actionable rather than theoretical.
108. Validate an address by decoding it, checking length, and confirming it is a valid Ed25519 point.
109. Reject off-curve addresses as destinations: a Program Derived Address cannot sign, so funds sent there may be unrecoverable.
110. Rule 109 is written now because Phase 3 will validate withdrawal destinations with this same function.
111. Parse SOL transfers out of a confirmed transaction into `TransferEvent` values.
112. Include the instruction index in each event, because one transaction may contain several transfers to the same address.
113. Model rent exemption explicitly: an account requires a minimum balance to exist, and that minimum is not user-withdrawable.
114. Obtain the rent-exempt minimum from the RPC rather than hardcoding it.
115. Expose the network's commitment levels but let the caller choose, so the confirmation policy stays a configuration value.

---

## 9. Persistence

116. All schema, migrations, and repositories live in `packages/db`, as in Phase 1.
117. Continue the Phase 1 conventions: snake_case columns, `timestamptz`, UUIDv7 primary keys generated in application code.

### Tables

118. `wallets` — `id`, `user_id`, `chain`, `status`, timestamps. A wallet is custody infrastructure, not a key (master-prompt rule 92).
119. `addresses` — `id`, `wallet_id`, `chain`, `address`, `derivation_index`, `derivation_path`, `custody_role`, `status`, timestamps.
120. `addresses` requires `UNIQUE(chain, address)`.
121. `addresses` stores public data only. No secret key material, no share, no seed (master-prompt rules 94–95, 100).
122. `custody_role` is an enum of `deposit`, `hot`, `warm`, `cold`. Phase 2 writes only `deposit` and implements no behaviour for the others.
123. `ledger_accounts` — `id`, `owner_id` (nullable for house accounts), `asset`, `type`, timestamps, with `UNIQUE(owner_id, asset, type)`.
124. `ledger_transactions` — `id`, `kind`, `reference_type`, `reference_id`, `created_at`. No `updated_at`; a transaction is never edited.
125. `ledger_entries` — `id`, `transaction_id`, `account_id`, `asset`, `amount` as `NUMERIC(38,0)`, `direction`, `created_at`.
126. `deposits` — `id`, `address_id`, `user_id`, `asset`, `amount`, `chain`, `tx_signature`, `instruction_index`, `slot`, `status`, `ledger_transaction_id`, timestamps.
127. `deposits` requires **`UNIQUE(chain, tx_signature, instruction_index)`**.
128. Rule 127 *is* the idempotency mechanism (master-prompt rule 130). A duplicate is a caught constraint violation and a no-op — never a read-then-write check, which has a race between the read and the write.
129. `indexer_cursors` — `id`, `chain`, `address_id` or scope key, `last_signature`, `last_slot`, `updated_at`.
130. Store amounts as `NUMERIC(38,0)`. Never `float`, `double precision`, `real`, or `money`.

### Immutability
131. `ledger_entries` and `ledger_transactions` are append-only, enforced by the database.
132. Reuse the mechanism proven on `audit_log` in Phase 1: revoke `UPDATE`, `DELETE`, and `TRUNCATE` from `wallet_app`, then add `BEFORE UPDATE` and `BEFORE DELETE` triggers so the schema owner is also stopped.
133. Rule 132 is why that mechanism was built in Phase 1 against a table where a mistake cost an audit trail rather than someone's balance. Apply it verbatim.
134. Add a deferred constraint trigger enforcing that entries within a transaction sum to zero per asset at commit time.
135. Rule 134 must be deferred, because entries are inserted one at a time and the intermediate states are legitimately unbalanced.
136. Put every grant and every trigger in a migration, never in the container init script.
137. Rule 136 is a Phase 1 lesson: schema-scoped grants are dropped by `prisma migrate reset`, and the failure surfaces much later as "relation does not exist".

### Concurrency
138. Every balance-affecting write goes through `withTransaction`, which already defaults to `Serializable`.
139. Do not lower the isolation level for a ledger write. If a serialization failure is frequent, fix the access pattern, not the guarantee.
140. Assume `withTransaction` may retry the callback, so the callback must be free of side effects outside the transaction.

---

## 10. Deposit Flow

141. Implement the flow as: request address → watch → detect → confirm → attribute → credit → observe.
142. `CreateDepositAddress` assigns an existing unused address for the user and asset, or derives the next one.
143. Assigning the same user the same address twice is correct; deriving a second address for the same user without cause is not.
144. Register every assigned address with the indexer's watch set atomically with its creation.
145. The indexer polls each watched address for signatures, ordered, using a persisted cursor.
146. Persist the cursor only after the batch it describes has been fully committed.
147. Rule 146 is what makes a restart safe: re-processing a committed batch is a no-op by rule 128, whereas skipping one loses a deposit.
148. Handle pagination explicitly and test it; `getSignaturesForAddress` returns a bounded page and the boundary is where cursor bugs hide.
149. **Credit only at the `finalized` commitment.** Solana forks below it, so crediting at `confirmed` is a real double-credit vector.
150. Make the commitment a single configuration value, validated at boot, so it cannot be weakened in one code path only.
151. Attribute a transfer to a user by its destination address, through `addresses.wallet_id`.
152. A transfer to an address the platform does not own is not an error and must be ignored without a log at warn level or above.
153. Write the deposit row and its ledger transaction in **one database transaction**.
154. On a unique-constraint violation for `(chain, tx_signature, instruction_index)`, treat it as already-processed and return success.
155. Never let rule 154 be implemented as "select, then insert if absent".
156. A deposit credits `user_available` and debits `chain_assets`, and the two amounts are equal.
157. If the deposit funds a new account's rent-exempt minimum, record that portion against `house_rent`, not against the user.
158. Rule 157 exists because crediting a user with SOL they cannot withdraw creates an obligation the platform cannot meet.
159. Store the transaction signature on the deposit row for audit and reconciliation (master-prompt rule 129).
160. Emit a structured event on credit, carrying identifiers only — never an amount or an address, unless the allowlist is deliberately extended.

---

## 11. Reconciliation

161. Implement a reconciliation routine comparing internal liabilities against chain-controlled assets, per asset.
162. Report, for each asset: total user liabilities, total `chain_assets`, `house_rent`, `house_fees`, and the residual.
163. A non-zero residual is not automatically an error; it must be *explainable*, and the report must show what explains it.
164. Run reconciliation as a script in Phase 2. Scheduling, alerting, and an operator UI are Phase 4.
165. Reconciliation must read from ledger entries, never from any cache or derived value.
166. Test reconciliation against a deliberately injected discrepancy and assert it is detected and quantified.

---

## 12. API and Frontend

167. Add use cases `CreateDepositAddress`, `GetBalance`, `ListDeposits`, `GetDeposit`.
168. Every endpoint is session-guarded and scoped to the calling user; an address or deposit belonging to another user is reported as not found, never as forbidden.
169. Return amounts as base-unit strings, never as numbers, and never pre-formatted for display.
170. Rule 169 keeps rounding decisions in one place, in the client, where the asset's decimals are known.

| Method | Path | Purpose |
|---|---|---|
| POST | `/wallets/:id/addresses` | assign or derive a deposit address |
| GET | `/wallets/:id/addresses` | list the caller's deposit addresses |
| GET | `/balances` | projected balances per asset |
| GET | `/deposits` | the caller's deposit history |
| GET | `/deposits/:id` | one deposit, with its chain reference |

171. Build the deposit page: address, QR code, explicit asset and network labels, and copy-to-clipboard.
172. State the network unambiguously on the deposit screen; sending an asset on the wrong network is the most common way users lose funds.
173. Show deposit lifecycle states honestly: detected, confirming, credited (master-prompt rule 78).
174. Never show a deposit as credited before its ledger transaction has committed.
175. Replace the Phase 1 dashboard empty state with real balances, and only once they are real.
176. Keep the Phase 1 discipline: no fabricated numbers, ever, including during loading.
177. Push balance updates over WebSocket where it improves the experience; polling is acceptable and simpler.
178. Never trust a balance, a deposit status, or an address ownership claim asserted by the client (master-prompt rule 77).

---

## 13. Testing

179. Property-test the ledger invariants over generated operation sequences (master-prompt rule 177).
180. Test that no sequence of operations produces unbalanced totals or a negative available balance.
181. Test deposit idempotency by replaying the same event 100 times concurrently against real PostgreSQL and asserting exactly one credit (master-prompt rule 181).
182. Test indexer restart at every stage: mid-page, after commit but before cursor persistence, and after cursor persistence.
183. Test that a fork below `finalized` cannot produce a credit.
184. Test that `UPDATE` and `DELETE` on `ledger_entries` fail for the application role and for the schema owner.
185. Test that the deferred sum-to-zero constraint rejects an unbalanced transaction at commit.
186. Test address derivation determinism: same seed and index yield the same address, across process restarts.
187. Test address validation against known-good addresses, known-bad strings, and off-curve PDAs.
188. Test the full path against a local `solana-test-validator`: airdrop, detect, credit, and read back through the API (master-prompt rule 180).
189. Add an end-to-end test covering the deposit journey through the UI.
190. Test that reconciliation detects an injected discrepancy.
191. Every test that asserts an amount must assert an exact base-unit value, never an approximation.

---

## 14. Definition Of Done

### Correctness
192. - [ ] Property tests show no operation sequence makes total debits ≠ total credits.
193. - [ ] Property tests show no operation sequence drives an available balance negative.
194. - [ ] Replaying one deposit 100× concurrently credits exactly once.
195. - [ ] An indexer restart at each of the three stages loses nothing and double-credits nothing.
196. - [ ] Balance is computed from entries, verified by the absence of any balance column in the schema.
197. - [ ] Crediting happens only at `finalized`, and the commitment is a single validated config value.
198. - [ ] Rent-exempt minimums are attributed to `house_rent` and are not creditable to a user.

### Enforcement
199. - [ ] `UPDATE` and `DELETE` on `ledger_entries` and `ledger_transactions` fail for both the application role and the schema owner.
200. - [ ] An unbalanced transaction is rejected by the database at commit, not only by application code.
201. - [ ] Amounts are `NUMERIC(38,0)` in the database and base-unit strings on the wire; no float type appears anywhere.
202. - [ ] `packages/ledger` importing `packages/solana` or `@solana/*` fails lint, proven by `scripts/verify-boundaries.mjs`.
203. - [ ] `packages/blockchain` contains no chain-specific type and no implementation.

### End to end
204. - [ ] Against `solana-test-validator`: airdrop → detected → credited → visible in the UI.
205. - [ ] Reconciliation reports zero residual after a mixed deposit run, and quantifies an injected discrepancy.
206. - [ ] A deposit to an address the platform does not own is ignored cleanly.
207. - [ ] Playwright covers the deposit journey.
208. - [ ] CI runs unit, integration, and E2E suites and blocks merge on failure.

### Documentation
209. - [ ] ADR-0004 through ADR-0008 are written and accepted.
210. - [ ] The README describes the accounting model, the account types, and the direction convention.
211. - [ ] A runbook covers investigating a missing deposit.
212. - [ ] A runbook covers responding to a non-zero reconciliation residual.

---

## 15. Traps To Avoid

213. Do not add a `balance` column "temporarily for performance". It becomes the source of truth within a sprint, and then it disagrees with the entries and nobody knows which is right.
214. Do not implement `user_locked` as a column on the available balance; Phase 3's entire withdrawal state machine depends on it being a separate account.
215. Do not credit at `confirmed` because `finalized` feels slow. The latency is the cost of not double-crediting a forked transaction.
216. Do not implement deposit idempotency as a read followed by a conditional write; the race between them is exactly the case that matters.
217. Do not let a `number` touch an amount anywhere, including in a test fixture — 2^53 lamports is only about 9 million SOL.
218. Do not persist the indexer cursor before the batch it describes has committed.
219. Do not put chain-specific types in `packages/blockchain` because it is momentarily convenient; that seam is the whole reason the package exists.
220. Do not credit a user with SOL that is locked in a rent-exempt minimum.
221. Do not skip the ADRs in §2 and decide the address model implicitly through the first implementation that compiles.
222. Do not derive a new address for a user on every request; assignment is idempotent.
223. Do not log amounts, addresses, or transaction signatures by weakening the logger allowlist without a deliberate, reviewed decision.
224. Do not begin Phase 3 until §14 is fully checked.

---

## 16. Standing Rules

225. Every feature ships with tests, typed interfaces, error handling, structured logging, and documentation (master-prompt rule 197).
226. Prefer simple explicit architecture over premature distributed complexity (master-prompt rule 198).
227. Optimize for correctness, auditability, and security boundaries before performance (master-prompt rule 199).
228. This is an educational project; never describe any part of it as production-safe without an independent security audit (master-prompt rules 7 and 8).
