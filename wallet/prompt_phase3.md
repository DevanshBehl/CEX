# Phase 3 Prompt — Money-Out, Risk & the Mock Signer

> **Parent spec:** [`master-prompt.md`](./master-prompt.md) · **Plan:** [`report.md`](./report.md) §5 Phase 3
> **Predecessors:** [`prompt_phase1.md`](./prompt_phase1.md), [`prompt_phase2.md`](./prompt_phase2.md) — both complete
> **Goal statement:** *A user withdraws SOL to an external address through risk checks, fund locking, a mock signature, a real broadcast, and ledger settlement.*
> **Covers master-prompt rules:** 101–110 (interface and mock only), 117–119, 131–155, 178–184, 191–192
> **Sizing:** ~4 weeks

---

## 0. How To Read This Document

1. This is the implementation contract for Phase 3 only.
2. Every numbered line is a directive, in the same style as `master-prompt.md` and its predecessors.
3. Where this document and `master-prompt.md` disagree, `master-prompt.md` wins and the conflict must be reported rather than silently resolved.
4. Do not begin Phase 4 work. Do not write Rust, threshold cryptography, SPL-token, or sweep code.
5. Phase 3 is finished only when every box in §15 is checked.

---

## 1. Why The Mock Signer Comes Before The Real One

6. Phase 3 builds the entire withdrawal lifecycle while the signer stays trivially controllable.
7. A mock signer can be made to fail, hang, return garbage, or return a valid signature twice, on demand and in a test.
8. The retry, timeout, expiry, and ambiguous-broadcast paths are where withdrawals actually go wrong, and they are nearly impossible to exercise against real MPC.
9. Building those paths against real cryptography would mean debugging distributed signing and state-machine bugs simultaneously, with no way to tell which layer is wrong.
10. Phase 4 replaces the mock. **If that replacement requires editing anything above the `Signer` interface, the abstraction leaked and that leak is the bug** (master-prompt rule 102).
11. Treat the mock as scaffolding with a demolition date, not as a component.

---

## 2. What Phase 2 Left Ready

12. `user_locked` exists as a full ledger account and has never been used. Phase 3 is what it was built for.
13. A lock is therefore a **balanced transfer** between two accounts, not a column update — the structure is already proven by property tests.
14. `Signer`, `KeyRef`, `SignRequest`, and `AuthorizationProof` are declared in `packages/blockchain` with nothing implementing them.
15. `AddressValidator.isSafeDestination` exists, rejects off-curve addresses, and has no caller. Phase 3 is its caller.
16. `requireStepUp(maxAgeSeconds)` exists and gates credential changes. Phase 3 puts it in front of withdrawal submission.
17. `InsufficientFundsError` and `PolicyDeniedError` have reserved codes in the public contract and no emitter. Phase 3 gives both a meaning.
18. `ChainAdapter` implements only the read half; Phase 3 adds the send half.
19. Reconciliation currently treats a negative residual as "impossible, escalate immediately" because Phase 2 cannot send. **Update that runbook** — from Phase 3 it has a legitimate transient cause.

---

## 3. Blocking Decisions

20. The following must be settled and written as ADRs before any Phase 3 code.
21. **ADR-0009 — transaction lifetime: durable nonce accounts versus recent blockhashes.** See §4; this is the single most consequential chain decision in the project.
22. **ADR-0010 — risk policy baseline.** The initial limits, velocity windows, and the value threshold above which a human must approve.
23. **ADR-0011 — step-up tiering.** Which withdrawal values demand how fresh an assertion, and why that is the right currency of friction.
24. **ADR-0012 — retry and expiry budgets.** How many times each failure edge retries, over what window, and what happens when the budget is exhausted.
25. Rule 24 exists because "retry forever" and "give up immediately" are both wrong, and the number in between is a policy decision that belongs in a document rather than in a constant someone guessed at.

---

## 4. Transaction Lifetime — Read This First

26. A Solana recent blockhash expires after roughly 150 slots, which is about 60–90 seconds.
27. A withdrawal in this system passes through risk evaluation, possibly a human approval queue, a signing round, and a broadcast.
28. In Phase 4 that signing round is threshold MPC across several participants. It will not reliably complete inside 90 seconds, and a manual review certainly will not.
29. A blockhash that expires mid-flight produces the **ambiguous broadcast**: a signed transaction was submitted, and nobody can say whether it landed.
30. Rule 29 is the highest-consequence failure in the whole system. Re-signing risks a double-spend; not re-signing risks funds locked forever with a user waiting.
31. **Use durable nonce accounts.** A transaction built on a durable nonce stays valid indefinitely until that nonce advances.
32. Rule 31 gives three properties that nothing else gives:
33. Re-broadcasting the *same signed bytes* is always safe — identical signature, deduplicated by the network.
34. The nonce advancing exactly once is proof the transaction landed exactly once.
35. Signing latency stops being a correctness concern and becomes merely a latency concern.
36. Provision, track, and advance nonce accounts as first-class records. A nonce account is custody infrastructure, not an implementation detail.
37. A nonce account is itself an on-chain account with a rent-exempt minimum. Account for that minimum in `house_rent`, exactly as Phase 2 does for deposit addresses.
38. Never reuse a nonce account for two in-flight withdrawals. Model the pool, and lease from it.
39. If ADR-0009 concludes otherwise, document precisely how rules 29–30 are mitigated instead, because they do not go away.

---

## 5. Phase Scope

### In scope
40. `packages/risk` — pure, deterministic policy engine.
41. The withdrawal state machine, its persistence, and its transition audit trail.
42. Fund locking, release, and settlement as balanced ledger transactions.
43. `MockSigner` behind the existing `Signer` interface.
44. Durable nonce account management (subject to ADR-0009).
45. The send half of `ChainAdapter`: build, sign, broadcast, confirm.
46. Signer, broadcast, and confirmation workers.
47. Step-up authentication, rate limiting, and idempotency keys on withdrawal submission.
48. The withdrawal UI, showing every lifecycle state explicitly.
49. A minimal internal operator queue for manual review.

### Explicitly out of scope
50. Do not create `services/mpc`. No Rust, no threshold cryptography, no distributed key generation.
51. Do not implement real cryptography of any kind (master-prompt rule 106).
52. Do not implement SPL tokens, sweeps, or hot/warm/cold segregation. Those are Phase 4.
53. Do not build an address allowlist feature. Master-prompt rule 150 calls it a *future* feature; design the policy engine so it can be added without restructuring, and add nothing.
54. Do not build a general admin console. The operator surface is a queue with approve and deny, and nothing else.
55. Do not add a second chain.

---

## 6. Carried Forward — Phase 2's Hard-Won Lessons

56. Every rule from the earlier phases still applies. These are the ones Phase 3 will break if nobody says them again.

### Database behaviour that cost real debugging time
57. **Prisma does not propagate a COMMIT-time failure.** `$transaction` resolves with the callback's value even when PostgreSQL rejected the commit. `withTransaction` compensates with `SET CONSTRAINTS ALL IMMEDIATE`; do not remove it, and do not write a transaction path that bypasses it.
58. **Never catch a constraint violation inside a transaction and continue.** The failed statement aborts the transaction and every later command returns `25P02`. Use `ON CONFLICT DO NOTHING` and check the returned rows.
59. Rule 58 applies directly to withdrawal idempotency keys, which are the next place someone will reach for a `try/catch`.
60. **Prisma reports a serialization conflict as `P2034`, not as SQLSTATE `40001`.** The retry predicate already handles it. Under Serializable a conflict is a normal outcome and retrying is what makes the isolation level usable.
61. **Create ledger accounts before opening the serializable transaction, not inside it.** Account creation is idempotent and not balance-affecting; doing it inside made it the dominant source of write conflicts.
62. Rule 61 applies to `user_locked`, which for most users will not exist until their first withdrawal.

### Everything else
63. `process.env` is read in exactly two files. New settings go through `packages/config`, validated at boot.
64. The logger allowlist stays an allowlist. **Amounts, addresses, and transaction signatures are not loggable** — and a withdrawal has all three.
65. Every new API contract is a Zod schema in `packages/types`, used by both the server and the typed web client.
66. Guards run at `preValidation`, before schema validation, so an unauthenticated caller gets a 401 rather than a description of the endpoint.
67. Every new architectural boundary gets a case in `scripts/verify-boundaries.mjs`. Add the `packages/risk` cases before writing the rules they test.
68. `packages/risk` must be as chain-free and database-free as `packages/ledger`. The ESLint config already lists it in `CHAIN_FREE_PACKAGES`; the rule has never been exercised because the package did not exist.
69. Turbo filters the environment. Declare every new variable in `turbo.json` or the integration suites will silently see nothing.
70. Integration tests run against real PostgreSQL. A mock cannot prove a constraint, a trigger, or an isolation level.

---

## 7. `packages/risk` — The Policy Engine

71. Pure functions and types. No database, no HTTP, no chain, no clock, no randomness, no configuration reading.
72. The engine takes a decision input and returns a decision. Everything it needs is an argument.
73. Rule 72 is what makes rule 153 (deterministic and testable) achievable: the same input always produces the same decision, so a decision can be replayed years later to explain itself.
74. Time is an argument, never `Date.now()`. A velocity window that reads the clock cannot be tested and cannot be replayed.

### The decision
75. A decision is one of `approve`, `deny`, or `review`.
76. Every decision carries **reason codes** — a list, not a string (master-prompt rule 152).
77. A code is a stable enum member, part of the public contract, and never repurposed.
78. `deny` must carry at least one reason code. A denial without a reason is not auditable and cannot be explained to the user or to an operator.
79. `review` carries the reason codes that triggered it, so the operator sees what the engine saw rather than re-deriving it.
80. `approve` may also carry codes — a clean approval that says which limits were checked is more useful than a bare yes.
81. The client is told a denial happened and a generic reason. It is not told which limit it hit or by how much, because that turns the engine into an oracle for probing thresholds.
82. The full reason codes go to the persisted decision and to the operator, never to the API response body.

### The rules
83. Per-transaction limit: a maximum single withdrawal value per asset (master-prompt rule 146).
84. Rolling daily limit: a maximum total over a trailing window (rule 147).
85. Rule 84 is a **rolling** window, not a calendar day. A calendar reset lets an attacker take two full limits ninety seconds apart at midnight.
86. Velocity: a maximum count over a short window, independent of value (rule 148).
87. Destination controls: the address must be well-formed, on-curve, and not a known-bad or internal address (rule 149).
88. New-destination cooldown: a first-time destination is treated as higher risk than a repeated one.
89. Manual-review threshold: above a configured value, or on a configured combination of codes, the decision is `review` rather than `approve` (rule 151).
90. Account-state checks: a suspended or closed account cannot withdraw, whatever the amount.
91. Every rule is an independent function with its own tests. Adding a rule must not require editing an existing one (rule 155).
92. The engine composes rules in a declared order and evaluates **all** of them, rather than short-circuiting on the first denial.
93. Rule 92 exists so a decision records everything that was wrong, not just the first thing. An operator resolving a review needs the whole picture.

### Balance is not a risk rule
94. Sufficient-funds checking belongs to the ledger, not to the risk engine.
95. Rule 94 matters because the risk engine is pure and has no view of a balance, and a balance can change between evaluation and locking. The lock is what proves the funds exist, and it proves it atomically.

---

## 8. The Withdrawal State Machine

96. Implement exactly the states in `report.md` §2.3, with no additions that are not written down here.

```
REQUESTED → RISK_EVALUATING → { REJECTED | MANUAL_REVIEW | APPROVED }
MANUAL_REVIEW    → { REJECTED | APPROVED }
APPROVED         → FUNDS_LOCKED
FUNDS_LOCKED     → SIGNING
SIGNING          → { SIGNED | SIGN_FAILED }
SIGNED           → BROADCAST
BROADCAST        → { CONFIRMED | BROADCAST_FAILED | EXPIRED }
CONFIRMED        → SETTLED
SIGN_FAILED      → FUNDS_LOCKED   (bounded retry)
BROADCAST_FAILED → FUNDS_LOCKED   (bounded retry)
EXPIRED          → FUNDS_LOCKED   (re-sign with a fresh nonce)
REJECTED         → terminal, locks released
SETTLED          → terminal
```

97. Define the legal transitions as an explicit table, in one place, in code.
98. Reject an illegal transition through the type system **and** a database check constraint (master-prompt rule 137).
99. Rule 98 is belt and braces on purpose: the type system stops the code that goes through the domain, and the constraint stops everything else.
100. Every transition writes a row to `withdrawal_transitions`, recording from, to, reason, actor, and correlation ID.
101. `withdrawal_transitions` is append-only, enforced the same way `ledger_entries` and `audit_log` are.
102. A withdrawal's current state is a column; its history is the transition table. Both, because the current state must be queryable and the history must be complete.
103. **Only `APPROVED` may enter the signing queue** (master-prompt rule 138).
104. Every worker re-reads and re-validates state inside the transaction that claims the job. A queue payload is a hint, never a fact.
105. Rule 104 is what stops a stale message resurrecting a withdrawal that was cancelled while it sat in the queue.
106. Every failure edge in the diagram is a state, not an exception that unwinds. A withdrawal that fails must be *somewhere*, with a reason.
107. Retry edges are bounded by ADR-0012 and must record the attempt count.
108. When a retry budget is exhausted, the withdrawal moves to a terminal failed state, releases its lock, and surfaces to an operator. It does not sit in a retry loop forever.

---

## 9. Fund Locking

109. A lock is a balanced ledger transaction moving value from `user_available` to `user_locked` (master-prompt rule 118).
110. **A lock is never a column update, never a computed "available minus pending" figure, and never a row-level flag.**
111. Locking happens at `APPROVED → FUNDS_LOCKED`, inside one database transaction with the state transition.
112. Rule 111 means the lock and the state can never disagree. A locked withdrawal that is not `FUNDS_LOCKED`, or the reverse, is not a state this system can reach.
113. The lock is what proves sufficient funds. If the ledger cannot move the amount, the withdrawal is rejected with `INSUFFICIENT_FUNDS` and never reaches the signing queue.
114. Rule 113 is why the balance check is not in the risk engine: the check and the reservation must be the same atomic act, or two concurrent withdrawals can each pass a check and both proceed.
115. On `REJECTED` or an exhausted retry budget, release the lock: `user_locked → user_available`, balanced, in one transaction with the transition.
116. On `SETTLED`, retire the lock: `user_locked` is debited and `chain_assets` is credited, because the money has left the platform.
117. Rule 116 is the only place in this system where `chain_assets` decreases. Phase 2 could not do it at all.
118. Network fees are debited from `house_fees`, not from the user, unless the product deliberately passes them on — and if it does, that is a separate entry with its own reason, not a silent reduction of the user's amount.
119. Settlement happens only after the appropriate confirmation state (master-prompt rule 143). See §11.
120. Every one of these transactions goes through `withTransaction` and balances. There are no exceptions and no "just this once" raw writes.

---

## 10. The Signer Boundary

121. Implement `MockSigner` against the `Signer` interface already declared in `packages/blockchain`.
122. Do not change that interface to suit the mock. If it does not fit, the interface is wrong and Phase 4 will suffer for it.
123. The mock is deterministic: the same `requestId` yields the same signature, always.
124. Rule 123 mirrors the real contract. Under threshold signing a duplicate signing round is not merely wasteful — it is a nonce-reuse hazard.
125. **The mock must refuse to start when `NODE_ENV=production`**, and the refusal must be a hard failure at construction, not a warning.
126. The mock logs a loud, unmistakable banner on every call. Nobody should be able to run this system and be unsure whether signing is real.
127. Provide configurable fault injection: fail, hang, time out, return a malformed signature, return a valid signature twice.
128. Rule 127 is the whole reason the mock exists. A mock that only succeeds tests nothing that a real signer would not have tested better.
129. Record every signing request and its outcome in a `signing_requests` table (master-prompt rule 110).
130. **That record must never contain key material, a share, or the signature's private inputs.** It records that a request was made, by whom, under what authorization, and what came back.
131. Authorization and signing stay separate (master-prompt rule 109). The signer receives an `AuthorizationProof` and does not decide whether to sign.
132. Rule 131 is what makes Phase 4's process boundary possible. A signer that evaluates policy cannot be moved into a separate trust domain.
133. The `Signer` interface must not learn what a Solana transaction is. It signs bytes.

---

## 11. Broadcast and Confirmation

134. Build the transaction in `packages/solana`, using a durable nonce (subject to ADR-0009).
135. **Persist the transaction signature BEFORE awaiting confirmation** (master-prompt rule 141).
136. Rule 135 is not an optimisation. A crash between broadcast and persistence leaves a transaction in flight that this system cannot recognise when it restarts, and cannot safely re-sign.
137. Broadcast, then poll for confirmation. Never treat a successful submission as a confirmation.
138. Settle only at `finalized`, the same commitment Phase 2 credits at (ADR-0006).
139. Rule 138 matters more for withdrawals than deposits: settling at `confirmed` and then seeing the transaction dropped means the user's funds were released from the lock and never left.
140. On an ambiguous broadcast, **re-broadcast the identical signed bytes**. Do not re-sign.
141. Rule 140 is safe precisely because of the durable nonce: the same bytes are either already on-chain and deduplicated, or still valid.
142. Never re-sign a withdrawal without positive proof the previous attempt is dead — the nonce has advanced without the transaction landing, or the transaction is confirmed failed.
143. A re-sign that is not proven safe is a double-spend, and it is the most expensive bug this system can have.
144. Handle `BROADCAST_FAILED` (the RPC rejected it) separately from `EXPIRED` (it was accepted and never landed). They look similar and need different responses.
145. Persist the nonce used, so a recovery path can check whether it advanced.

---

## 12. API and Frontend

146. Add use cases `RequestWithdrawal`, `ApproveWithdrawal`, `RejectWithdrawal`, `GetWithdrawal`, `ListWithdrawals`.
147. Withdrawal submission requires an idempotency key, and `UNIQUE(user_id, idempotency_key)` enforces it (master-prompt rule 87).
148. Rule 147 uses `ON CONFLICT`, not `try/catch` — see rule 58.
149. Withdrawal submission requires a fresh step-up assertion, per ADR-0011.
150. Rate-limit withdrawal endpoints by user and by IP (master-prompt rule 162).
151. Validate the destination server-side with `isSafeDestination` (master-prompt rule 164). A client-side check is a courtesy, not a control.
152. **The client cannot influence a risk decision.** Not by a field, not by a header, not by omitting something (master-prompt rule 154).
153. Rule 152 needs an explicit test that crafts a request designed to look pre-approved and asserts the server evaluates it anyway.
154. Amounts cross the wire as base-unit strings, as in Phase 2.
155. Show every lifecycle state from §8 explicitly (master-prompt rules 78–79).
156. Do not collapse states into "pending". A user whose withdrawal is in manual review is owed a different message than one whose broadcast failed.
157. Never show a withdrawal as complete before it is `SETTLED`.
158. Show the locked balance distinctly from the available balance. The account model has supported this since Phase 2 and the UI has never used it.
159. When a withdrawal is denied, show the generic reason only, matching rule 81.
160. The operator queue lists `MANUAL_REVIEW` withdrawals with the risk decision and its reason codes, and offers approve and deny with a required note.
161. An operator action is an audited event with the operator's identity, written to `audit_log`.
162. Phase 3 has no operator role model. Gate the queue behind configuration and a step-up, and record in the ADR that a real role model is Phase 4.

---

## 13. Testing

163. Every transition in §8, including every failure edge, has a passing test (master-prompt rule 178).
164. Test that every illegal transition is rejected — by the type system where possible, and by the database constraint in all cases.
165. Test every risk rule in isolation, with zero HTTP and zero database (master-prompt rule 179).
166. Property-test the risk engine: no input produces a decision without reason codes, and no `deny` produces an empty code list.
167. Test that submitting the same idempotency key 50 times concurrently creates exactly one withdrawal and moves funds once (master-prompt rule 182).
168. Test that two concurrent withdrawals that would together exceed the balance result in exactly one lock succeeding.
169. Rule 168 is the test that justifies rules 113–114. Run it against real PostgreSQL.
170. Test that killing the signer worker between `SIGNED` and `BROADCAST` recovers with no double-spend and no lost funds.
171. Test the ambiguous broadcast: a submission whose outcome is unknown, followed by recovery. Assert the identical bytes are re-broadcast and never re-signed.
172. Test every fault the mock signer can inject, and assert the withdrawal lands in a defined state with its lock accounted for.
173. Test that a client cannot bypass risk evaluation (rule 153).
174. Test that the ledger balances after every state transition, not only at the end.
175. Rule 174 is the invariant that catches a half-applied lock, which is the failure mode that loses money quietly.
176. Test that a withdrawal that exhausts its retry budget releases its lock and reaches a terminal state.
177. Test the full lifecycle against a local validator: request → risk → lock → sign → broadcast → finalized → settled.
178. Add an end-to-end test covering the withdrawal journey through the UI.
179. Test that `MockSigner` refuses to construct when `NODE_ENV=production`.
180. Test that no amount, address, or signature reaches the logs.

---

## 14. Observability

181. Every withdrawal carries a correlation ID from submission through settlement, across every worker.
182. Rule 181 is what makes a support question answerable. A withdrawal touches four processes, and without one identifier spanning them the logs are four unrelated stories.
183. Log a typed security event at every state transition, carrying identifiers and reason codes only.
184. Every long-running withdrawal exposes an operational status (master-prompt rule 175).
185. Update the reconciliation runbook: a negative residual now has a legitimate transient cause — a withdrawal broadcast and not yet settled. Distinguish that from the case that still means a compromised key.
186. Rule 185 is a correctness change to an existing document, not an addition. Leaving it stale would train an operator to ignore the alarm that matters.

---

## 15. Definition Of Done

### The state machine
187. - [ ] Every transition in §8 has a passing test, including every failure edge.
188. - [ ] Illegal transitions are rejected by the database, proven by a raw SQL attempt.
189. - [ ] `withdrawal_transitions` is append-only for both the application role and the schema owner.
190. - [ ] A withdrawal that exhausts its retry budget releases its lock and reaches a terminal state.

### Money
191. - [ ] The same idempotency key submitted 50× concurrently creates one withdrawal and moves funds once.
192. - [ ] Two concurrent withdrawals exceeding the balance result in exactly one lock.
193. - [ ] The ledger balances after every state transition, asserted in the tests, not only at the end.
194. - [ ] A lock is a balanced transfer; no balance, locked, or pending column exists anywhere.
195. - [ ] Settlement debits `user_locked` and credits `chain_assets`, and fees are attributed explicitly.

### Signing and broadcast
196. - [ ] `MockSigner` refuses to construct when `NODE_ENV=production`.
197. - [ ] Every injectable fault leaves the withdrawal in a defined state with its lock accounted for.
198. - [ ] Killing the signer worker between `SIGNED` and `BROADCAST` recovers with no double-spend and no lost funds.
199. - [ ] An ambiguous broadcast re-broadcasts identical bytes and never re-signs.
200. - [ ] The transaction signature is persisted before confirmation is awaited.
201. - [ ] `signing_requests` records every request and outcome and contains no key material.

### Risk
202. - [ ] Every risk rule is tested with zero HTTP and zero database involvement.
203. - [ ] Every denial carries at least one reason code, property-tested.
204. - [ ] A client cannot influence a risk decision, proven by an explicit test.
205. - [ ] Risk decisions are persisted and replayable from their inputs.
206. - [ ] `packages/risk` importing a chain, a database, or a framework fails lint, proven by `verify-boundaries.mjs`.

### End to end
207. - [ ] Against a local validator: request → risk → lock → sign → broadcast → finalized → settled.
208. - [ ] Playwright covers the withdrawal journey, including a denial and a manual review.
209. - [ ] No amount, address, or transaction signature appears in the logs.
210. - [ ] CI runs every suite and blocks merge on failure.

### Documentation
211. - [ ] ADR-0009 through ADR-0012 are written and accepted.
212. - [ ] The README documents the withdrawal state machine and the locking model.
213. - [ ] A runbook covers a stuck withdrawal, per state.
214. - [ ] A runbook covers the ambiguous-broadcast recovery procedure.
215. - [ ] The reconciliation runbook is updated for withdrawals in flight.

---

## 16. Traps To Avoid

216. Do not implement a lock as a column, a flag, or an "available minus pending" calculation. Phase 2 built `user_locked` for this and property-tested the structure.
217. Do not put the sufficient-funds check in the risk engine. The check and the reservation must be one atomic act.
218. Do not let a worker trust its queue payload. Re-read and re-validate inside the claiming transaction.
219. Do not re-sign a withdrawal without proof the previous attempt is dead. This is the double-spend.
220. Do not treat a successful broadcast as a confirmation.
221. Do not settle at `confirmed`. A dropped transaction after settlement means funds released from the lock that never left.
222. Do not let risk logic leak into a controller or a route. It belongs in `packages/risk` alone (master-prompt rule 70).
223. Do not return the specific limit a user hit. It is an oracle for probing thresholds.
224. Do not collapse lifecycle states into "pending" in the UI.
225. Do not `try/catch` a constraint violation inside a transaction — see rule 58.
226. Do not add amounts, addresses, or signatures to the logger allowlist without a deliberate, reviewed decision.
227. Do not let `MockSigner` reach a production configuration, and do not soften rule 125 to "log a warning".
228. Do not leave the reconciliation runbook saying a negative residual is impossible.
229. Do not begin Phase 4 until §15 is fully checked.

---

## 17. Standing Rules

230. Every feature ships with tests, typed interfaces, error handling, structured logging, and documentation (master-prompt rule 197).
231. Prefer simple explicit architecture over premature distributed complexity (master-prompt rule 198).
232. Optimize for correctness, auditability, and security boundaries before performance (master-prompt rule 199).
233. This is an educational project; never describe any part of it as production-safe without an independent security audit (master-prompt rules 7 and 8).
