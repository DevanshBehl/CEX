# Phase 4 Prompt — Real MPC, SPL Tokens & Operational Hardening

> **Parent spec:** [`master-prompt.md`](./master-prompt.md) · **Plan:** [`report.md`](./report.md) §5 Phase 4
> **Predecessors:** [`prompt_phase1.md`](./prompt_phase1.md), [`prompt_phase2.md`](./prompt_phase2.md), [`prompt_phase3.md`](./prompt_phase3.md) — all complete
> **Goal statement:** *The mock is gone. Signing happens in Rust behind a threshold, tokens work, the books reconcile, and operations are observable.*
> **Covers master-prompt rules:** 19–24, 96–98, 101–110 (in full), 124, 144, 166–175, 185–187, 193–200
> **Sizing:** ~5 weeks
>
> **Decided already:** [ADR-0015](./docs/adr/0015-threshold-parameters.md) — 3-of-5 FROST-Ed25519, participants on separate hosts.

---

## 0. How To Read This Document

1. This is the implementation contract for Phase 4, the final phase.
2. Every numbered line is a directive, in the same style as `master-prompt.md` and its predecessors.
3. Where this document and `master-prompt.md` disagree, `master-prompt.md` wins and the conflict must be reported rather than silently resolved.
4. Phase 4 is finished only when every box in §16 is checked.
5. Finishing Phase 4 does not make this system production-safe. See §18.

---

## 1. Why This Comes Last

6. This is the highest-risk, highest-expertise work in the project, and it drops into a slot whose shape three phases of use have already proven.
7. Sequenced first, every MPC design decision would have been made blind — against an interface nobody had used, a lifecycle nobody had exercised, and failure paths nobody had provoked.
8. Phase 3 built the withdrawal lifecycle against a signer that could be made to fail, hang, or return garbage on demand. Those paths are now tested.
9. Phase 4 changes what is behind the `Signer` interface and nothing else.
10. **If replacing the mock requires editing anything above that interface, the abstraction leaked and that leak is the bug** (master-prompt rule 102). Fix the leak; do not work around it.

---

## 2. The Split — 4a Before 4b, Not Both At Once

11. Phase 4 is two sub-phases and they are done in order.
12. **4a** stands up `services/mpc` as a real Rust process holding a **single key**.
13. **4b** replaces that single key with **t-of-n threshold signing**.
14. Rule 11 exists because 4a and 4b fail for entirely different reasons: 4a is a process-boundary and deployment problem, 4b is distributed-systems-plus-cryptography. Attempting both at once means debugging them together.
15. 4a delivers most of the architectural value on its own: key material in a separate process, a real trust boundary, and an auditable signing path.
16. **Timebox 4b.** If it stalls, ship 4a plus everything in §§8–13 rather than blocking tokens, sweeps, reconciliation and observability behind it.
17. Rule 16 is a scheduling instruction, not permission to skip 4b. Record the decision if it is taken.

---

## 3. What Phase 3 Left Ready

18. `Signer`, `KeyRef`, `SignRequest`, `AuthorizationProof` and `SignResult` are declared in `packages/blockchain` and have one implementation.
19. `MockSigner` refuses to construct when `NODE_ENV=production`, and config refuses `SIGNER_KIND=mock` there. Both guards stay until the mock is deleted.
20. `SIGNER_KIND=real` already exists in the config schema and **throws at construction**, because nothing implements it. 4a is what makes it stop throwing.
21. `signing_requests` records every request and outcome and contains no key material. It is the audit trail master-prompt rule 110 asks for, and it already works.
22. The nonce pool, lease mechanism, and the ambiguous-broadcast recovery path all exist and are tested.
23. `custody_role` is an enum of `deposit`, `hot`, `warm`, `cold`. Only `deposit` has ever been written, and nothing behaves differently per role.
24. `house_rent` and `house_fees` exist, and `house_fees` is a prepaid balance the platform funds itself.
25. The asset allowlist is config-validated with `SOL` as its only member. The ledger, the account key, and `TransferEvent` are already asset-parametric.
26. Reconciliation exists as a script. It is not scheduled, does not alert, and does not observe nonce accounts or the treasury.
27. There is no operator role model; the review queue is gated by a configured list of user ids plus a step-up.
28. `packages/ledger` and `packages/risk` have never imported a chain, a database, or a framework, and `scripts/verify-boundaries.mjs` proves it on every run.

---

## 4. Carried Forward — The Lessons That Recur

29. Every rule from the earlier phases still applies. These are the ones that have already bitten twice.

### Database
30. **Prisma does not propagate a COMMIT-time failure.** `withTransaction` issues `SET CONSTRAINTS ALL IMMEDIATE` to compensate. Do not remove it, and do not add a transaction path that bypasses it.
31. **Never catch a constraint violation inside a transaction and continue.** The statement aborts the transaction and everything after returns `25P02`. Use `ON CONFLICT DO NOTHING`.
32. Rule 31 has now had to be applied in Phase 2 and again in Phase 3. Assume it will be tempting a third time — SPL token deposits are where.
33. **A serialization conflict is `P2034`, not SQLSTATE `40001`.** The retry predicate handles both.
34. **Create ledger accounts before opening the serializable transaction.** Token accounts multiply this: a user gains one `user_available` per mint.

### Accounting
35. **The house pre-funds its own costs.** ATA creation, rent, and sweep fees are all paid from the pooled on-chain balance, and debiting a house account that was never funded means paying operating costs out of customer money.
36. Rule 35 is not theoretical: the `liabilities_covered` invariant caught exactly this the first time a withdrawal paid a fee.
37. Every new house expense in this phase needs a funding path before it needs a spending path.

### Operational
38. Rate limits are per-endpoint and are configuration, never a literal in code.
39. Integration suites share one database and are run serially. Test data accumulates, because history is append-only and cannot be deleted — that is the system working.
40. The logger allowlist stays an allowlist. **A key share, a participant identity, a mint address, and a token amount are all things someone will want to log.** None of them may be, without a deliberate edit.

---

## 5. Blocking Decisions

41. Written as ADRs before the code they govern.
42. **ADR-0013 — the MPC trust boundary.** Transport, authentication, and what the API is permitted to ask the signer for. Governs 4a.
43. **ADR-0014 — key material at rest.** How the single key, and later the shares, are stored, encrypted, and recovered. Governs 4a.
44. **ADR-0015 — threshold parameters.** The `t` and `n`, and what a participant *is*: a process, a host, an operator, or an organisation. Governs 4b.
45. Rule 44 matters more than the numbers suggest. `2-of-3` across three processes on one machine provides almost nothing; across three operators it provides a great deal. The value is in what the split makes independent.
46. **ADR-0016 — the SPL token allowlist**, its decimals, and who may add a mint.
47. **ADR-0017 — sweep policy.** When a deposit address is swept, to which tier, and how fee funding is provisioned.
48. **ADR-0018 — custody tiers.** What hot, warm and cold mean operationally, and which signing policy each requires.
49. **ADR-0019 — the second chain, design only.** What adding one would touch, written without adding one.

---

## 6. Phase 4a — The Rust Service, Single Key

50. Create `services/mpc` as a Rust binary with its own `Cargo.toml`, its own tests, and its own build in CI.
51. It is a **separate process with a separate trust boundary** (master-prompt rules 21, 24, 167). Not a library the API links, and not a module.
52. Rule 51 is the whole point of 4a. A library shares the API's memory, its crash, and its attack surface; a process does not.

### The boundary
53. The API and the signer communicate over an authenticated channel: mutual TLS, or signed requests with a pre-shared verifying key.
54. The signer authenticates the caller on every request. A request from an unauthenticated source is refused and logged.
55. The signer has its **own datastore**, separate from the application database (master-prompt rule 95).
56. Rule 55 means a dump of the application database contains no key material. That property must be true by construction, not by remembering not to write it.
57. **Key material never leaves the service.** Not in a response, not in a log, not in an error, not in a metric.
58. The service never reconstructs a complete private key for convenience (master-prompt rule 99), and in 4b it must not be able to.
59. Apply least privilege: the service's database role can read and write its own tables and nothing else.

### The implementation
60. Implement `RustSingleKeySigner` in TypeScript as a client of the service, satisfying the existing `Signer` interface unchanged.
61. Key generation, storage, and signing happen in Rust. The TypeScript side is transport.
62. Use a vetted Ed25519 implementation. **Do not write curve arithmetic** (master-prompt rule 106).
63. Honour the idempotency contract: the same `requestId` returns the same signature and starts no second signing operation.
64. Rule 63 is enforced in the Rust service, not only in the caller. A client that retries must not be able to cause a second signing operation.
65. Record every request and outcome in the service's own audit log, in the shape `signing_requests` already uses: what was asked, by whom, under what authorization, and what happened — never the secret (master-prompt rule 110).
66. The service validates the `AuthorizationProof` it is given but **does not decide policy** (master-prompt rule 109). Authorising and signing stay separate.

### The proof it worked
67. **The entire Phase 3 test suite must pass against `RustSingleKeySigner` with no changes above the `Signer` interface.**
68. Rule 67 is the single most important exit criterion in 4a. It is the evidence the abstraction held.
69. If a test needs editing, first establish whether the test was wrong or the interface was. Changing the test to fit is only correct in the first case.
70. The mock's fault-injection tests do not apply to the real signer; they continue to run against the mock, which stays for development.
71. Add an equivalent fault suite for the real signer: unreachable, slow, authentication rejected, malformed response.
72. Add `services/mpc` to `/health/ready` as another entry in the existing array (the shape was designed for this in Phase 1).
73. Add `cargo test` to CI as a required check.
74. Once `RustSingleKeySigner` works, `SIGNER_KIND=real` stops throwing and becomes the production value.

---

## 7. Phase 4b — Threshold Signing

> **Parameters decided: 3-of-5. See [ADR-0015](./docs/adr/0015-threshold-parameters.md).**

75. Replace the single key with **3-of-5 threshold Ed25519**.
76. Use **FROST-Ed25519 (RFC 9591)** via the Zcash Foundation's `frost-ed25519` crate.
77. **Do not invent, adapt, or hand-roll a threshold scheme** (master-prompt rule 106). This is not a place for original work, and choosing a less-reviewed scheme is a soft version of the same mistake.
78. FROST produces an ordinary Ed25519 signature, so nothing on-chain, in `packages/solana`, or in the withdrawal lifecycle changes.
79. Rule 78 is why FROST was chosen over a scheme producing a different signature shape, and over on-chain multisig: the blast radius of this change is one service.

### Participants
80. Model participants as entities **distinct from application users** (master-prompt rule 107). A participant is not a person with an account.
81. A participant is a **separate host** with its own datastore and its own credentials.
82. Rule 81 is the security, and the threshold is only the arithmetic. Five processes on one machine, five schemas in one PostgreSQL instance, or five containers from one pipeline are five copies of one blast radius.
83. Separate cloud accounts are recommended; separate operators are out of scope for this project and are recorded in ADR-0015 as a known limit rather than quietly omitted.
84. Implement distributed key generation. **No participant ever holds the complete key** — not at any point, not transiently, not during generation.
85. Design for threshold signing rather than single-server key storage (master-prompt rule 108). The architecture must not degrade to "one server holds everything" under any failure.
86. Monitor participant availability and **alert when only `t` remain**. At three of five, the next failure is an outage, and that is the moment to act rather than the moment after.

### The coordinator
87. FROST requires a coordinator to collect commitments, distribute the signing package, and aggregate the shares. **The API is the coordinator.**
88. The coordinator **cannot forge a signature**: it holds no share, and aggregation is not privileged — an incorrect aggregation simply produces an invalid signature.
89. A compromised coordinator can **censor**, which is a liveness failure and not a safety one: funds stay locked and recoverable.
90. Treat and monitor the coordinator as a **liveness dependency, not a security one**, and say so in the threat model.

### Participants validate the authorization
91. **This is the decision that determines whether the threshold is worth building.**
92. A participant that blindly signs whatever bytes the coordinator hands it protects against **key theft and nothing else**. A compromised API could ask for a signature over a transaction paying an attacker, and five honest participants would produce it.
93. Each participant therefore **independently verifies the `AuthorizationProof`** before contributing a signature share.
94. Verify the proof is signed by the approval authority, against a key the participant holds **independently of the coordinator**.
95. Verify the proof binds to **this exact payload hash**, so a proof for one withdrawal cannot be replayed onto another.
96. Verify the proof has not already been used for a different `requestId`.
97. A participant **does not re-run the risk rules**. That would violate master-prompt rule 109 and put policy in five places. It checks the attestation, not the policy.
98. Rules 93–97 are what give custody tiers their meaning (rules 136–137 below): a cold-tier movement requires a proof carrying a human operator's signature, not just the risk engine's.

### The rounds
99. Implement the two FROST rounds: commitment, then signature share, then aggregation.
100. Handle participant unavailability explicitly. Fewer than `t` available means the request fails cleanly, with the funds still locked and recoverable.
101. Handle round timeouts explicitly. A round that does not complete must not leave a participant believing it is still in progress.
102. **A nonce must never be reused across signing rounds.** In FROST this is not a performance concern — it recovers the participant's secret share.
103. Each participant persists its nonce state **before** publishing a commitment, and refuses to produce a second share for a nonce it has already used.
104. **Enforce rule 124 in the participant, not in the coordinator.** A retrying client, a duplicated queue message, or a hostile coordinator must not be able to cause a second round on one nonce.
105. Rules 102–104 are why `SignRequest.requestId` has been an idempotency key since Phase 2 rather than a convenience.
106. Record each round's participants and outcome in the audit log. Never the shares, never the nonces.

### Share refresh
107. Implement share refresh using `frost-core`'s repair support, and **build it before it is needed**.
108. Losing a participant with no recovery path means running a full key ceremony under pressure, against a live treasury — which is exactly the circumstance in which ceremonies go wrong.
109. Refresh rotates shares **without changing the group public key**, so the treasury address is stable across it.
110. Test refresh by actually losing a participant and recovering it, not by reading the library's documentation.

### Honesty
111. Get external review before treating any of this as more than educational (master-prompt rule 8).
112. Until that review exists, the README, the UI, and every document say plainly that the cryptography is unaudited.
113. Record in ADR-0015 what 3-of-5 does **not** protect against — a compromised deploy pipeline, a vulnerability in the participant binary itself, and coordinator censorship. A threshold scheme whose limits are unwritten invites the belief that it has none.

---

## 8. SPL Tokens

114. Add SPL token support for an allowlisted set of mints (master-prompt rules 124, 194, ADR-0016).
115. A mint's decimals are metadata for display and are **never used in arithmetic** — the same rule that has governed SOL since Phase 2.
116. Amounts stay integer base units in `NUMERIC(38,0)` and base-unit strings on the wire.
117. Implement Associated Token Account derivation, and account for ATA creation.
118. An ATA has its own rent-exempt minimum, per user per mint. It is real, ours, and not user-withdrawable, so it goes to `house_rent` — exactly as a deposit address's minimum does.
119. **An SPL transfer cannot pay its own fee.** The account needs SOL before it can move a token, so a fee-funding step must precede any token movement out of a deposit address.
120. Rule 119 is the thing that makes tokens a *sweep and withdrawal* problem rather than a deposit problem, and it is why ADR-0008 deferred them to this phase.
121. Fee funding is a house expense with its own funding path (rule 37).
122. Detect token deposits through the same indexer, producing the same `TransferEvent` shape.
123. The uniqueness key stays `(chain, tx_signature, instruction_index)`. A transaction moving SOL and a token to the same address is two deposits.
124. Reject a transfer of a mint that is not allowlisted. Do not credit it, and do not silently discard it — record it as `ignored` with a reason.
125. Rule 124 exists because an unrecognised token arriving is common and a user will ask about it.
126. Token withdrawals reuse the withdrawal state machine unchanged. If they cannot, the state machine was chain-specific and that is a defect.
127. The risk engine's limits are per-asset. A daily limit denominated in SOL must not silently apply to a token.

---

## 9. Sweeps and Custody Tiers

128. Implement sweeps from deposit addresses into a hot wallet (ADR-0017).
129. A sweep is a withdrawal in every respect that matters: it signs, it broadcasts, it settles, and it must be idempotent and recoverable.
130. Rule 129 means a sweep uses the same lifecycle and the same recovery paths. A parallel implementation is a second set of bugs.
131. A sweep moves platform funds between platform addresses, so it produces **no change in user liabilities** — the ledger entries move value between `chain_assets` positions, not between user accounts.
132. Fee-fund a deposit address before sweeping a token from it (rule 119).
133. Never sweep the rent-exempt minimum. The account must continue to exist.
134. Give `hot`, `warm` and `cold` their operational meaning (master-prompt rules 96–98, ADR-0018).
135. Implement threshold-based rebalancing: when hot exceeds a ceiling, move the excess to warm; when it falls below a floor, request a top-up.
136. **Different tiers require different signing policies.** A hot-wallet withdrawal is automated; a cold-wallet movement requires more participants, or a human, or both.
137. Rule 136 is the point of tiers. Tiers that all sign the same way are labels, not segregation.
138. Deposit keys remain a lower-privilege class that can only sweep to one hardcoded destination (ADR-0005). Phase 4 is where that commitment is honoured.
139. The sweep destination is hardcoded in the signing boundary, not passed in by a caller. A configurable destination gives back exactly the authority that decision removed.

---

## 10. Reconciliation As A Product

140. Turn the reconciliation script into a scheduled job (master-prompt rules 120, 172).
141. Extend it to observe **every** platform-owned address: deposit addresses, nonce accounts, and each custody tier.
142. Rule 141 closes the gap Phase 3 recorded — nonce accounts and the treasury were outside the comparison, so the residual was approximate.
143. Reconcile per asset and per mint.
144. Alert on drift that persists across cycles, not on a single reading. A single positive residual is usually a deposit mid-finality.
145. Distinguish an explainable residual from an unexplainable one, and make the report say which (the existing `explanation` field).
146. Build the internal reconciliation report as an operator-facing view.
147. Keep reading from ledger entries, never from a cache or a derived value.
148. Add an alert for a **negative** residual with no withdrawals in flight. That is the condition that means a credit exists for money that never arrived, or funds left without an entry.

---

## 11. Observability

149. Metrics for deposits, withdrawals, failures, latency, and queue depth (master-prompt rule 171).
150. Health checks for API, PostgreSQL, Redis, Solana RPC, and the MPC service (master-prompt rule 170). The `/health/ready` array shape already accommodates this.
151. Correlation IDs already span request, deposit, withdrawal, ledger and signing. Extend them across the MPC service boundary so one identifier covers the whole path.
152. Rule 151 is what makes a signing failure diagnosable. Without it the Rust service's logs are a separate, unjoinable story.
153. Implement a dead-letter queue for failed background jobs, with a retry surface (master-prompt rule 173).
154. **Never silently retry a financial operation without idempotency** (master-prompt rule 174). Every retryable job carries an idempotency key, and the DLQ's retry uses it.
155. Every long-running workflow exposes an operational status (master-prompt rule 175): deposits, withdrawals, sweeps, rebalancing, reconciliation, and key ceremonies.
156. Metrics must not carry user identifiers or amounts as labels. A metric with unbounded cardinality is an outage; a metric with a user id in it is a privacy leak.

---

## 12. Security Hardening

157. Write a **threat model** document: what this system protects, from whom, and what it does not protect against.
158. Rule 157 is a deliverable, not an exercise. It is what makes the phrase "not production-safe" specific rather than a disclaimer.
159. TLS for all network communication (master-prompt rule 160), including between the API and the MPC service.
160. A separate least-privilege database role per service (master-prompt rule 156). The MPC service's role must not reach application tables.
161. Move secrets to a **secret manager**; `.env` is development only (master-prompt rule 157).
162. The deposit master seed and any key-encryption key move first. They are the values that can regenerate everything else.
163. Review audit-log coverage: every security-sensitive operation, every operator action, every key ceremony (master-prompt rule 166).
164. Add a dependency audit to CI, and a policy for what to do when it fires.
165. Re-verify the log allowlist against everything Phase 4 adds: shares, participant identities, mint addresses, token amounts, sweep destinations.
166. Build a real operator role model, replacing Phase 3's configured list of user ids.
167. Rotate what can be rotated, and **document what cannot**. `TOTP_ENCRYPTION_KEY` still has no re-encryption path; either build one or record it as accepted.

---

## 13. Multichain Seams — Design Only

168. **Do not add a second chain** (master-prompt rule 195).
169. Verify `packages/ledger` and `packages/risk` still have zero chain, database and framework imports. `scripts/verify-boundaries.mjs` already proves this; confirm it still covers every case.
170. Write ADR-0019 describing exactly what adding a second chain would touch: which packages, which tables, which config, which interfaces.
171. Identify anything in `packages/blockchain` that has quietly become Solana-shaped. The no-chain-names test in that package guards the vocabulary; read the interfaces against a genuinely different chain and see whether they still fit.
172. Rule 150 is the real test of master-prompt rule 196. An EVM chain has no rent, no nonce accounts, and a different address format — an interface that cannot express that is already broken and nobody has noticed.
173. Record what would have to change, and change nothing.

---

## 14. Deleting The Mock

174. `MockSigner` stays. It is how development and the fault-injection suite work.
175. **It must remain impossible to select in production.** Both existing guards stay: config refuses `SIGNER_KIND=mock`, and the mock refuses to construct.
176. Add a third: a startup assertion that the configured signer is not the mock whenever the process is reachable from a public origin.
177. The README, the dashboard, and the withdrawal page currently say signing is not real. **Update all three when it becomes real**, and not before.
178. Rule 177 is a correctness requirement. Leaving it stale after 4a would be a false statement in the opposite direction from the usual one.

---

## 15. Testing

179. `cargo test` for the Rust components, run in CI (master-prompt rule 185).
180. Test the Rust service's idempotency directly: the same `requestId` signs once, whatever the client does.
181. Test the authentication boundary: an unauthenticated request is refused.
182. Test that key material appears in no response, log, error, or metric — a leak test in the shape of the existing one.
183. **Run the entire Phase 3 suite against the real signer** and require it to pass unmodified above the interface (rule 67).
184. For 4b, test that no single participant can produce a valid signature alone.
185. Test that `t` available participants sign successfully, and that `t-1` fails cleanly with funds locked and recoverable.
186. Test a participant that disappears mid-round, and a round that times out.
187. Test SPL deposits and withdrawals end to end on a local validator, including ATA creation and its rent attribution.
188. Test a deposit of a non-allowlisted mint: ignored, recorded, not credited.
189. Test that a sweep is idempotent and recoverable, using the same failure injections as a withdrawal.
190. Test that a sweep does not change user liabilities.
191. Test that reconciliation detects injected drift on every address class, including nonce accounts.
192. Test the DLQ: a failed job lands there, is retryable, and retrying is idempotent.
193. Keep every earlier test passing. A regression in Phase 1's auth or Phase 2's ledger is a Phase 4 failure.

---

## 16. Definition Of Done

### 4a — the Rust service
194. - [ ] `services/mpc` runs as a separate process with an authenticated channel.
195. - [ ] Key material exists only inside the service, provably absent from the application database.
196. - [ ] `RustSingleKeySigner` satisfies the existing `Signer` interface with no changes above it.
197. - [ ] **The entire Phase 3 test suite passes against it, unmodified above the interface.**
198. - [ ] The same `requestId` signs once, enforced in the service.
199. - [ ] An unauthenticated signing request is refused and audited.
200. - [ ] No key material appears in any response, log, error, or metric.
201. - [ ] `services/mpc` appears in `/health/ready`, and `cargo test` runs in CI.
202. - [ ] `SIGNER_KIND=real` no longer throws.

### 4b — threshold signing
203. - [ ] 3-of-5 FROST-Ed25519 via `frost-ed25519`; no hand-rolled cryptography.
204. - [ ] No single participant can produce a valid signature, proven by test.
205. - [ ] Any 3 participants sign; any 2 fail cleanly with funds locked and recoverable.
206. - [ ] Each participant independently verifies the `AuthorizationProof` before contributing a share, against a key it holds independently of the coordinator.
207. - [ ] A participant refuses to reuse a nonce, enforced in the participant and proven by test.
208. - [ ] Share refresh is implemented and proven by actually losing and recovering a participant.
209. - [ ] Monitoring alerts when only 3 of 5 participants remain available.
210. - [ ] Distributed key generation completes without any participant holding the whole key.
211. - [ ] Participant unavailability and round timeouts are handled explicitly and tested.
212. - [ ] Participants are modelled as entities distinct from application users.

### Tokens, sweeps, tiers
213. - [ ] An allowlisted SPL token can be deposited and withdrawn end to end.
214. - [ ] ATA rent is attributed to `house_rent` and is never credited to a user.
215. - [ ] Fee funding precedes any token movement out of a deposit address.
216. - [ ] A non-allowlisted mint is ignored with a recorded reason.
217. - [ ] Sweeps are idempotent, recoverable, and change no user liability.
218. - [ ] Hot, warm and cold have genuinely different signing policies.
219. - [ ] A deposit key can still only sweep to one hardcoded destination.

### Operations
220. - [ ] Reconciliation runs on a schedule, covers every platform-owned address, and alerts on persistent drift.
221. - [ ] A negative residual with no withdrawals in flight raises an alert.
222. - [ ] Metrics exist for deposits, withdrawals, failures, latency and queue depth, with no user identifiers or amounts as labels.
223. - [ ] Health checks cover API, PostgreSQL, Redis, Solana RPC and MPC.
224. - [ ] A failed background job lands in a DLQ and can be retried idempotently.
225. - [ ] Every long-running workflow exposes an operational status.

### Security
226. - [ ] A threat model document exists and is specific.
227. - [ ] TLS everywhere, including API to MPC.
228. - [ ] A least-privilege database role per service.
229. - [ ] Secrets are in a secret manager; `.env` is development only.
230. - [ ] The log allowlist has been re-reviewed against everything Phase 4 added.
231. - [ ] A real operator role model replaces the configured user-id list.
232. - [ ] A dependency audit runs in CI.

### Architecture
233. - [ ] `packages/ledger` and `packages/risk` still import no chain, database or framework.
234. - [ ] ADR-0019 describes what a second chain would touch, and no second chain exists.
235. - [ ] `packages/blockchain` has been read against a genuinely different chain, and what did not fit is recorded.

### Honesty
236. - [ ] The README, dashboard and withdrawal page reflect what signing actually is.
237. - [ ] Nothing anywhere claims this system is production-safe without an independent audit.
238. - [ ] ADR-0013 through ADR-0019 are written and accepted.
239. - [ ] Runbooks cover a signing outage, a participant loss, a stuck sweep, and a key ceremony.

---

## 17. Traps To Avoid

240. Do not attempt 4a and 4b at once. They fail for different reasons and debugging them together is the trap this phase is most likely to fall into.
241. Do not link the MPC service as a library because a process boundary is inconvenient. The boundary IS the feature.
242. Do not hand-roll threshold cryptography, adapt a scheme, or "simplify" one. Use a vetted implementation or do not ship 4b.
243. Do not let any participant hold the complete key, even transiently during generation.
244. Do not reuse a nonce across signing rounds. In FROST that recovers the key.
245. Do not edit a Phase 3 test to make it pass against the real signer without first establishing that the test was wrong.
246. Do not credit an ATA's rent-exempt minimum to a user.
247. Do not move a token out of an account that cannot pay the fee, and do not fund that fee from a house account that was never funded.
248. Do not build sweeps as a parallel implementation of the withdrawal lifecycle.
249. Do not give the tiers the same signing policy and call it segregation.
250. Do not let the sweep destination become a caller-supplied parameter.
251. Do not add a mint address, a token amount, a share, or a participant identity to the log allowlist without a deliberate, reviewed decision.
252. Do not alert on a single positive reconciliation residual; do alert on a negative one.
253. Do not add a second chain.
254. Do not leave the README saying signing is a mock after it stops being one — and do not let it say signing is real before it is.
255. Do not describe any of this as production-ready. Finishing Phase 4 means the architecture is complete, not that it is safe.

---

## 18. What Finishing This Does Not Mean

256. Completing Phase 4 produces a system whose architecture is complete and whose invariants are enforced. It does not produce a custody service.
257. The cryptography is unaudited. Master-prompt rule 127 was honoured by using vetted libraries, but composition and operation are where custody systems actually fail.
258. There is no account recovery. Losing every passkey still means losing the account, and that has been an open limitation since Phase 1.
259. There is no key ceremony procedure, no disaster recovery plan, and no tested restore.
260. There is no regulatory, compliance, or KYC/AML layer. Master-prompt rule 6 lists compliance among the things this project teaches *about*, not things it implements.
261. The operational load of running threshold signing — participant availability, share rotation, ceremony discipline — is real and is not addressed by having built it.
262. **State every one of these plainly** in the README rather than letting the completed checklist imply otherwise (master-prompt rules 7–8).

---

## 19. Standing Rules

263. Every feature ships with tests, typed interfaces, error handling, structured logging, and documentation (master-prompt rule 197).
264. Prefer simple explicit architecture over premature distributed complexity (master-prompt rule 198).
265. Optimize for correctness, auditability, and security boundaries before performance (master-prompt rule 199).
266. Treat the final system as a serious educational CeFi custody platform whose architecture can later evolve toward institutional-grade infrastructure (master-prompt rule 200).
267. Never claim the implementation is production-safe without independent security audits (master-prompt rules 7–8).
