# Master Prompt — MPC Custodial Solana Wallet

## 1. Project Identity
1. Build a production-style educational custodial crypto wallet platform.
2. The product is a web application, not a browser extension.
3. The first supported blockchain is Solana.
4. Users must never receive or manage a traditional seed phrase.
5. Private-key material must be represented through an MPC/threshold custody architecture.
6. The project must teach centralized custody, internal accounting, transaction authorization, risk controls, and blockchain settlement.
7. This is an engineering and learning project, not a production custody service.
8. Never claim the implementation is production-safe without independent security audits.

## 2. High-Level Purpose
9. Provide users with a familiar wallet experience for depositing, holding, and withdrawing digital assets.
10. Keep the user-facing experience simple while custody is handled by backend infrastructure.
11. Maintain an internal financial ledger separate from on-chain wallet balances.
12. Treat blockchain state and internal accounting as related but distinct sources of truth.
13. Require authorization and risk evaluation before withdrawals.
14. Isolate cryptographic signing from ordinary application business logic.
15. Design the system so additional chains can be added later without rewriting the core ledger.

## 3. Core Architecture
16. Use a modular service-oriented monorepo architecture.
17. Structure the flow as Web App -> API -> Domain Services -> Database/Queues -> Blockchain/MPC.
18. Frontend communicates with the backend through typed HTTP APIs and WebSockets where appropriate.
19. Backend owns business rules, authentication, authorization, ledger operations, and orchestration.
20. Blockchain adapters own chain-specific RPC, transaction, address, token, and confirmation logic.
21. MPC service owns signing-related cryptographic operations.
22. Never place private keys, key shares, or signing secrets in frontend code.
23. Never expose signing capabilities directly to the browser.
24. Keep security-sensitive modules isolated and auditable.
25. Use dependency inversion so domain logic does not depend directly on Solana SDK details.

## 4. Recommended Tech Stack
26. Frontend: Next.js, React, TypeScript, and Tailwind CSS.
27. Backend: Node.js, TypeScript, and Fastify.
28. Database: PostgreSQL.
29. ORM: Prisma.
30. Cache and ephemeral coordination: Redis.
31. Background processing: a queue abstraction initially backed by Redis.
32. Blockchain: Solana.
33. Solana client: current maintained Solana TypeScript tooling appropriate to the chosen SDK version.
34. MPC/security service: Rust.
35. Internal service communication: REST initially, with gRPC as a future option.
36. API validation: Zod or an equivalent schema-first validator.
37. Authentication: passkeys/WebAuthn plus optional email and 2FA.
38. Testing: Vitest for TypeScript and cargo test for Rust.
39. E2E testing: Playwright.
40. Local infrastructure: Docker Compose for PostgreSQL and Redis.

## 5. Monorepo Structure
41. Use a pnpm workspace/Turborepo-style monorepo.
42. Keep applications and reusable packages separate.
43. Use `apps/web` for the frontend.
44. Use `apps/api` for the backend API.
45. Use `services/mpc` for the Rust MPC service.
46. Use `packages/db` for Prisma schema, migrations, and database client.
47. Use `packages/ledger` for accounting domain logic.
48. Use `packages/blockchain` for chain-independent interfaces.
49. Use `packages/solana` for Solana-specific implementation.
50. Use `packages/auth` for authentication and session abstractions.
51. Use `packages/risk` for risk and withdrawal policy logic.
52. Use `packages/types` for shared domain types and API contracts.
53. Use `packages/config` for validated configuration.
54. Use `packages/logger` for structured logging.
55. Use `packages/errors` for shared typed errors.

## 6. Code Organization Rules
56. Never put the entire application into one file.
57. Never create giant components containing UI, API calls, state, validation, and business logic together.
58. Each module must have one clear responsibility.
59. Components should focus on presentation and user interaction.
60. Hooks should contain reusable client-side stateful behavior.
61. API clients should be separate from React components.
62. Controllers/routes should translate HTTP requests into application commands.
63. Services should contain orchestration and domain use cases.
64. Domain modules should contain business invariants and rules.
65. Repositories should encapsulate persistence access.
66. Blockchain adapters should encapsulate RPC and transaction details.
67. Utility functions should be small, pure, reusable, and independently testable.
68. Export reusable functions from dedicated files and import them where required.
69. Avoid circular dependencies.
70. Avoid duplicated business logic across routes or components.

## 7. Frontend Architecture
71. Create pages for dashboard, wallet, deposit, withdrawal, activity, security, and profile.
72. Use feature-based frontend organization where practical.
73. Separate presentation components from data-fetching hooks.
74. Create reusable balance, transaction, address, status, modal, and form components.
75. Use typed API clients rather than manually constructing requests throughout components.
76. Validate user input on the client for UX and again on the server for security.
77. Never trust client-side balances, transaction status, or authorization state.
78. Display transaction lifecycle states clearly.
79. Show pending, approved, rejected, submitted, confirmed, and failed states.
80. Never display secret key material in the interface.

## 8. Backend Architecture
81. Use layered architecture: routes -> controllers -> application services -> domain -> repositories.
82. Keep HTTP-specific concerns out of domain logic.
83. Define explicit use cases such as CreateWallet, CreateDepositAddress, RequestWithdrawal, ApproveWithdrawal, and GetBalance.
84. Use dependency injection for repositories and infrastructure services.
85. Make important commands idempotent.
86. Use database transactions for ledger mutations.
87. Use request IDs and idempotency keys for financial operations.
88. Implement centralized error handling.
89. Use structured logs with correlation IDs.
90. Never log passwords, tokens, private keys, MPC shares, or sensitive secrets.

## 9. Wallet and Custody Model
91. A user has an account and one or more wallet records.
92. A wallet represents custody infrastructure, not a browser-held private key.
93. Maintain blockchain addresses separately from internal user balances.
94. Store public addresses and metadata only in ordinary application databases.
95. Keep signing material outside the normal application database.
96. Model custody roles such as hot, warm, and cold conceptually.
97. Begin implementation with a development custody environment.
98. Add real operational segregation only after the core architecture works.
99. Never reconstruct a complete private key merely for convenience.
100. Never send key shares to the frontend.

## 10. MPC Boundary
101. Define a clean `Signer` interface in TypeScript.
102. The application should request a signature without knowing the underlying cryptographic implementation.
103. The Rust service implements the secure signing boundary.
104. Begin development with a clearly labeled mock signer for local testing.
105. Replace the mock with a vetted threshold/MPC implementation.
106. Do not invent or implement production cryptography without expert review.
107. Model MPC participants/nodes independently from application users.
108. Design for threshold signing rather than single-server key storage.
109. Keep signing authorization separate from cryptographic signing.
110. Record signing requests and outcomes in an auditable manner without storing secret material.

## 11. Ledger Design
111. Implement a double-entry internal ledger.
112. Do not treat a mutable user balance field as the sole accounting mechanism.
113. Every balance-changing operation must produce immutable ledger entries.
114. Ledger entries must identify account, asset, amount, direction, and transaction context.
115. Use integer base units rather than floating-point amounts.
116. Define clear invariants for debits, credits, and total liabilities.
117. Separate available balance from locked balance.
118. Lock funds when a withdrawal is approved.
119. Release or settle locks according to the withdrawal state machine.
120. Reconciliation must compare internal liabilities with blockchain-controlled assets.

## 12. Deposit Flow
121. User requests a Solana deposit address.
122. Backend assigns or creates a custody address according to the wallet model.
123. Blockchain indexer monitors relevant addresses.
124. Detect incoming SOL and supported SPL-token transfers.
125. Wait for the configured confirmation/finality policy.
126. Attribute the deposit to the correct user.
127. Create the corresponding ledger transaction atomically.
128. Make deposit processing idempotent.
129. Store blockchain transaction signatures for audit and reconciliation.
130. Never credit the same blockchain transaction twice.

## 13. Withdrawal Flow
131. User submits an asset, amount, and destination address.
132. Authenticate the request and apply session security.
133. Validate the asset, amount, destination, and account state.
134. Run withdrawal risk checks.
135. Run policy checks and limits.
136. Lock the requested funds.
137. Create a withdrawal record with a deterministic state machine.
138. Only approved withdrawals may enter the signing queue.
139. Ask the MPC signer to produce the required blockchain signature.
140. Broadcast through the Solana blockchain adapter.
141. Persist the transaction signature.
142. Track confirmation/finality.
143. Finalize the ledger only after the appropriate settlement state.
144. Handle rejection, expiration, retry, and failed-broadcast states explicitly.

## 14. Risk and Policy Engine
145. Keep risk evaluation separate from MPC signing.
146. Implement configurable per-transaction limits.
147. Implement daily withdrawal limits.
148. Implement velocity checks.
149. Implement destination-address controls.
150. Support address allowlisting as a future feature.
151. Support manual approval for high-risk or high-value transactions.
152. Record every risk decision with reason codes.
153. Make policy decisions deterministic and testable.
154. Never allow the frontend to override risk decisions.
155. Design the policy engine so rules can evolve independently.

## 15. Security Requirements
156. Apply least privilege to every service.
157. Keep secrets in environment variables only during local development and use a proper secret manager later.
158. Never commit secrets to Git.
159. Encrypt sensitive data at rest where appropriate.
160. Use TLS for network communication.
161. Apply authentication and authorization to every protected API.
162. Rate-limit authentication and withdrawal endpoints.
163. Protect against replay and duplicate transaction requests.
164. Validate destination addresses server-side.
165. Use secure session handling.
166. Add audit logs for security-sensitive operations.
167. Treat the MPC service as a high-security trust boundary.

## 16. Observability and Operations
168. Use structured JSON logging.
169. Track request, withdrawal, deposit, ledger, signing, and blockchain correlation IDs.
170. Add health checks for API, database, Redis, Solana RPC, and MPC service.
171. Add metrics for deposits, withdrawals, failures, latency, and queue depth.
172. Build an internal reconciliation report.
173. Make failed background jobs observable and retryable.
174. Never silently retry financial operations without idempotency.
175. Provide an operational status model for every long-running workflow.

## 17. Testing Strategy
176. Unit-test domain functions independently.
177. Test ledger invariants extensively.
178. Test every withdrawal state transition.
179. Test risk rules independently from HTTP.
180. Test Solana adapters against local/devnet environments.
181. Test deposit idempotency.
182. Test withdrawal idempotency.
183. Test authorization failures.
184. Test MPC interface behavior with the mock signer.
185. Test Rust cryptographic components independently.
186. Add integration tests for database transactions.
187. Add end-to-end tests for deposit and withdrawal user journeys.

## 18. Development Sequence
188. First build repository structure, configuration, database, authentication, and user accounts.
189. Next build wallet records, Solana address management, and the internal double-entry ledger.
190. Next build the Solana indexer and deposit lifecycle.
191. Next build withdrawal requests, risk checks, policies, and fund locking.
192. Next integrate a mock signer and complete the withdrawal lifecycle.
193. Next isolate and implement the Rust MPC service behind the signer interface.
194. Next add SPL tokens, reconciliation, hot/warm/cold concepts, and operational controls.
195. Only after the Solana system is stable should multichain adapters be introduced.
196. When adding chains, preserve the same ledger, risk, authorization, and custody abstractions.
197. Every feature must include tests, typed interfaces, error handling, logging, and documentation.
198. Prefer simple explicit architecture over premature distributed complexity.
199. Optimize for correctness, auditability, security boundaries, and maintainability before performance.
200. Treat the final system as a serious educational CeFi custody platform whose architecture can later evolve toward institutional-grade infrastructure.
