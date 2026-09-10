# Phase 1 Prompt — Foundation & Identity

> **Parent spec:** [`master-prompt.md`](./master-prompt.md) · **Plan:** [`report.md`](./report.md) §5 Phase 1
> **Goal statement:** _A real user can create an account, authenticate with a passkey, and hit a typed, observable, tested API._ > **Covers master-prompt rules:** 16–18, 26–70, 81–90, 156–168, 176
> **Sizing:** ~3 weeks

---

## 0. How To Read This Document

1. This is the implementation contract for Phase 1 only.
2. Every numbered line is a directive, in the same style as `master-prompt.md`.
3. Where this document and `master-prompt.md` disagree, `master-prompt.md` wins and the conflict must be reported rather than silently resolved.
4. Do not begin Phase 2 work. Do not write ledger, deposit, withdrawal, Solana, risk, or MPC code.
5. Phase 1 is finished only when every box in §12 is checked.

---

## 1. Phase Scope

### In scope

6. pnpm workspace and Turborepo pipeline configuration.
7. TypeScript strict-mode baseline across every package.
8. `packages/config` — validated configuration.
9. `packages/logger` — structured logging with correlation IDs and redaction.
10. `packages/errors` — typed error hierarchy and HTTP mapping.
11. `packages/types` — shared domain types and Zod API contracts.
12. `packages/db` — Prisma schema, migrations, client, transaction helper.
13. `packages/auth` — WebAuthn, sessions, optional password + TOTP, step-up authentication.
14. `apps/api` — Fastify server, auth routes, health checks, error handling, rate limiting.
15. `apps/web` — Next.js app shell, auth pages, security/profile pages, typed API client.
16. `infra/docker-compose.yml` — PostgreSQL and Redis for local development.
17. CI pipeline gating lint, typecheck, tests, and migration integrity.
18. `docs/` seeded with the README, the ADR template, and the first ADRs.

### Explicitly out of scope

19. Do not create `packages/ledger`, `packages/blockchain`, `packages/solana`, `packages/risk`, or `services/mpc` in Phase 1.
20. Do not create empty placeholder packages of any kind — an unused package rots and lies about the architecture.
21. Do not add any Solana dependency, RPC client, keypair, or address handling.
22. Do not model wallets, addresses, balances, deposits, or withdrawals in the database.
23. Do not build a matching engine, trading UI, or anything from the parent CEX README beyond the wallet pillar.
24. Do not implement KYC, email delivery infrastructure, or push notifications.
25. Redis is provisioned and health-checked in Phase 1 but is used only for rate limiting and challenge storage; do not build the queue abstraction yet.

---

## 2. Repository Layout To Produce

```
wallet/
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── routes/          HTTP shape only — parse, delegate, serialize
│   │   │   ├── controllers/     translate validated requests into commands
│   │   │   ├── services/        application use cases
│   │   │   ├── plugins/         fastify plugins: cookie, cors, helmet, rate-limit, request-context
│   │   │   ├── middleware/      auth guards, step-up guard
│   │   │   ├── errors/          centralized error handler + HTTP mapping
│   │   │   └── server.ts        composition root — the only place wiring happens
│   │   └── test/
│   └── web/
│       ├── app/                 Next.js app router
│       ├── features/            feature-based folders: auth, security, profile
│       ├── components/          presentation-only, reusable
│       ├── hooks/               client-side stateful behaviour
│       ├── lib/api/             typed API client — the only place fetch() is called
│       └── e2e/                 Playwright
├── packages/
│   ├── types/
│   ├── config/
│   ├── logger/
│   ├── errors/
│   ├── db/
│   └── auth/
├── infra/
│   └── docker-compose.yml
├── docs/
│   ├── adr/
│   └── runbooks/
├── .github/workflows/ci.yml
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── tsconfig.base.json
```

26. Every package exposes a single `src/index.ts` barrel as its public surface.
27. Anything not exported from that barrel is package-private and must not be deep-imported by another package.
28. Every package has its own `package.json`, `tsconfig.json`, and test setup.
29. Package names use the `@wallet/` scope: `@wallet/config`, `@wallet/logger`, and so on.

---

## 3. Toolchain Requirements

30. Use pnpm workspaces with Turborepo for task orchestration and caching.
31. Use TypeScript with `strict: true`, `noUncheckedIndexedAccess: true`, and `exactOptionalPropertyTypes: true`.
32. Set `"type": "module"` and use ESM throughout.
33. Use Node.js 22 LTS or newer and pin the version in `.nvmrc` and `package.json#engines`.
34. Use Fastify for the API.
35. Use Zod as the single schema-first validator.
36. Use `fastify-type-provider-zod` so route schemas and TypeScript types come from one source.
37. Use Prisma as the ORM.
38. Use PostgreSQL 16 or newer.
39. Use Redis 7 or newer.
40. Use `@simplewebauthn/server` and `@simplewebauthn/browser` for WebAuthn.
41. Use `argon2id` for password hashing if passwords are enabled.
42. Use a maintained TOTP library for 2FA; do not implement RFC 6238 by hand.
43. Use Next.js with the app router, React, and Tailwind CSS for the frontend.
44. Use Vitest for unit and integration tests.
45. Use Playwright for end-to-end tests.
46. Use ESLint and Prettier with a shared config package or a shared root config.
47. Pin all dependency versions; do not use floating ranges for anything security-relevant.

---

## 4. `packages/types` — Shared Contracts

48. Define every API request and response shape as a Zod schema in this package.
49. Derive TypeScript types from the schemas with `z.infer`; never declare a type and a schema separately.
50. The API validates against these schemas and the web client imports the same schemas — one source of truth.
51. Define branded primitive types now: `UserId`, `SessionId`, `CredentialId`, `CorrelationId`.
52. Define a branded `BaseUnits` type as a decimal string, with no arithmetic helpers yet.
53. Rule 52 exists so Phase 2 inherits a money type that cannot be accidentally assigned from a JavaScript `number`.
54. Define the canonical error-code union used by `packages/errors` and returned to clients.
55. This package must have zero runtime dependencies other than Zod.

---

## 5. `packages/config` — Validated Configuration

56. Read `process.env` in exactly one file in the entire monorepo, inside this package.
57. Add an ESLint rule banning `process.env` access everywhere else, with this package as the sole exception.
58. Parse the environment through a Zod schema at module load.
59. On a validation failure, exit the process immediately with a non-zero code.
60. The failure message must name every missing or invalid variable.
61. The failure message must never print the value of any variable.
62. Export a frozen, fully typed config object.
63. Separate the config schema per surface: API config, web public config, and shared config.
64. Anything exposed to the browser must live in an explicitly named `publicConfig` object and must never contain a secret.
65. Required variables for Phase 1: `NODE_ENV`, `DATABASE_URL`, `REDIS_URL`, `API_PORT`, `WEB_ORIGIN`, `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME`, `WEBAUTHN_ORIGIN`, `SESSION_COOKIE_NAME`, `SESSION_SECRET`, `SESSION_IDLE_TTL_SECONDS`, `SESSION_ABSOLUTE_TTL_SECONDS`, `STEP_UP_MAX_AGE_SECONDS`, `LOG_LEVEL`.
66. Commit a complete `.env.example` containing every variable with placeholder values.
67. Never commit a real `.env`; add it to `.gitignore` in the first commit.

---

## 6. `packages/logger` — Structured Logging

68. Emit structured JSON logs only; no `console.log` anywhere in application code.
69. Use `AsyncLocalStorage` to propagate a request context containing `correlationId`, `userId` when authenticated, and `route`.
70. Every log line must carry the correlation ID automatically without the call site passing it.
71. Accept an inbound `x-correlation-id` header when present and generate one otherwise.
72. Return the correlation ID on every response so a user-reported failure is traceable.
73. **Use an allowlist for logged fields, never a denylist.** Log only fields explicitly declared loggable.
74. Rule 73 is non-negotiable: a denylist fails open the first time a developer adds a new sensitive field, which violates master-prompt rule 90.
75. Provide typed log-event helpers rather than free-form message strings for security-relevant events.
76. Never log request bodies, response bodies, headers, or cookies wholesale.
77. Never log passwords, session tokens, WebAuthn challenges, TOTP secrets or codes, recovery codes, or any key material.
78. Provide a test helper that captures log output so redaction can be asserted in tests.

---

## 7. `packages/errors` — Typed Errors

79. Define a base `AppError` carrying a stable machine-readable `code`, an HTTP status, a safe client message, and optional internal detail.
80. Implement at minimum: `ValidationError`, `AuthenticationError`, `AuthorizationError`, `NotFoundError`, `ConflictError`, `RateLimitError`, `StepUpRequiredError`, `InternalError`.
81. Define the placeholder domain errors the later phases require so their codes are reserved: `InsufficientFundsError`, `PolicyDeniedError`, `ChainError`.
82. Rule 81 reserves codes only; do not implement the logic behind those errors in Phase 1.
83. Error codes are part of the public API contract and must be declared in `packages/types`.
84. Internal detail on an error must never reach the client response body.
85. Implement one centralized Fastify error handler; no route may format its own error response.
86. An unrecognized thrown value becomes an `InternalError` with a correlation ID and is logged at error level.
87. Never leak stack traces, SQL text, or driver messages to clients in any environment.

---

## 8. `packages/db` — Persistence

88. Own the Prisma schema, migrations, generated client, and transaction helpers here.
89. No other package may import `@prisma/client` directly.
90. Expose a `withTransaction` helper that every future ledger mutation will use; build it in Phase 1 even though Phase 1 has no ledger.
91. `withTransaction` must support an explicit isolation level and must default to `Serializable`.
92. Every table has `id`, `created_at`, and `updated_at`, except append-only tables which omit `updated_at`.
93. Use UUIDv7 or ULID primary keys, not auto-increment integers.
94. Every migration must be reversible or must document why it is not.
95. Migrations are checked into Git and applied in CI; never use `prisma db push` outside a scratch database.

### Phase 1 schema

96. `users` — `id`, `email` (unique, nullable if passkey-only), `email_verified_at`, `status`, `created_at`, `updated_at`.
97. `credentials` — `id`, `user_id`, `type` (`webauthn` | `password` | `totp`), `created_at`, `last_used_at`, `revoked_at`, plus type-specific columns.
98. WebAuthn credential columns: `credential_id` (unique, bytes), `public_key` (bytes), `sign_count`, `transports`, `aaguid`, `backed_up`, `device_name`.
99. Password credential column: `password_hash` — argon2id only, never a reversible encoding.
100.  TOTP credential column: `totp_secret_encrypted` — encrypted at rest, never stored in plaintext.
101.  `sessions` — `id`, `user_id`, `token_hash`, `created_at`, `last_seen_at`, `expires_at`, `revoked_at`, `ip`, `user_agent`, `step_up_at`.
102.  Store only a SHA-256 hash of the session token; the raw token exists solely in the cookie.
103.  `auth_challenges` — short-lived WebAuthn challenges, keyed and TTL-expired; Redis is acceptable instead of a table if TTL and single-use are enforced.
104.  A challenge must be single-use: consuming it deletes it, and replay must fail.
105.  `audit_log` — `id`, `actor_user_id`, `event`, `target_type`, `target_id`, `metadata` (JSON, allowlisted fields only), `correlation_id`, `ip`, `created_at`.
106.  `audit_log` is append-only.
107.  Enforce rule 106 at the database level by revoking `UPDATE` and `DELETE` on `audit_log` from the application role.
108.  Rule 107 establishes the immutability pattern that `ledger_entries` will reuse in Phase 2; prove it works now.
109.  Create a least-privilege application database role that is not the migration owner.

---

## 9. `packages/auth` — Identity

### WebAuthn / passkeys

110. Implement the registration ceremony: issue options with a fresh challenge, verify the attestation response, persist the credential.
111. Implement the authentication ceremony: issue options, verify the assertion, resolve the user, create a session.
112. Bind `rpId` and `origin` strictly to validated config; never derive them from a request header.
113. Rule 112 is the most common WebAuthn failure and the most dangerous one — get it wrong and verification either breaks everywhere or accepts the wrong origin.
114. Verify `signCount` where the authenticator provides one and treat a non-increasing counter as possible credential cloning.
115. On a suspected clone, reject the assertion, write an audit event, and do not create a session.
116. Support multiple passkeys per user; a user with one credential and one device is one lost device away from lockout.
117. Support listing and revoking individual credentials.
118. Refuse to revoke a user's last remaining authentication factor without an explicit confirmed flow.
119. Support discoverable credentials (resident keys) so login needs no prior identifier.
120. Set `userVerification` to `preferred` for login and `required` for step-up.

### Sessions

121. Sessions are server-side and opaque; do not use a self-contained JWT for the session.
122. Rule 121 exists because master-prompt rule 165 requires revocability, and a stateless token cannot be revoked before expiry.
123. Generate the session token from at least 32 bytes of cryptographically secure randomness.
124. Deliver the session in a cookie that is `HttpOnly`, `Secure`, `SameSite=Strict`, path-scoped, and without a JavaScript-readable duplicate.
125. Enforce both an idle timeout and an absolute lifetime.
126. Rotate the session token on every privilege change: login, 2FA completion, step-up, and credential change.
127. Support listing active sessions and revoking any one of them, including the current one.
128. Revoke all other sessions when a credential is added or removed.
129. Verify request `Origin` or `Sec-Fetch-Site` on every state-changing request as CSRF defence, in addition to `SameSite`.

### Password and 2FA (optional path)

130. Password authentication is optional; passkey-only accounts must be fully supported.
131. Hash passwords with argon2id using parameters recorded in config, and support rehashing on parameter change.
132. When a password is present, allow TOTP as a second factor.
133. Generate single-use recovery codes on 2FA enrollment, display them exactly once, and store only their hashes.
134. Never log, email, or return a TOTP secret after the enrollment response that provisions it.

### Step-up authentication

135. Implement `requireStepUp(maxAgeSeconds)` as a reusable guard.
136. A step-up is a fresh WebAuthn assertion with `userVerification: required` that stamps `sessions.step_up_at`.
137. When the guard fails, return `StepUpRequiredError` with the required max age so the client can prompt.
138. Phase 1 exposes step-up on a demonstration endpoint and on credential management.
139. Rule 138 exists because Phase 3 gates withdrawal submission on this exact primitive — it must be proven working before money moves.

### Anti-abuse

140. Rate-limit every authentication endpoint by both IP and account identifier.
141. Make registration and login responses non-enumerating: an unknown account must be indistinguishable from a known one in status code, body, and timing.
142. Write an audit event for every authentication success, failure, credential change, session revocation, and step-up.

---

## 10. `apps/api` — HTTP Surface

143. Layer strictly: routes → controllers → application services → repositories.
144. Routes contain no business logic and no direct database access.
145. Validate every request body, query, param, and response against a Zod schema from `packages/types`.
146. Wire all dependencies in `server.ts` as the single composition root; use dependency injection so services receive their collaborators.
147. Rule 146 exists so Phase 3 can inject a mock signer and Phase 4 a real one without touching call sites.
148. Register the request-context plugin first so every downstream log carries a correlation ID.
149. Register `@fastify/helmet`, `@fastify/cors` restricted to `WEB_ORIGIN`, `@fastify/cookie`, and `@fastify/rate-limit`.
150. Never enable permissive CORS, and never reflect an arbitrary request origin.

### Endpoints

| Method | Path                     | Purpose                                 | Auth              |
| ------ | ------------------------ | --------------------------------------- | ----------------- |
| POST   | `/auth/register/options` | begin passkey registration              | none / session    |
| POST   | `/auth/register/verify`  | complete passkey registration           | none / session    |
| POST   | `/auth/login/options`    | begin passkey authentication            | none              |
| POST   | `/auth/login/verify`     | complete authentication, create session | none              |
| POST   | `/auth/logout`           | revoke current session                  | session           |
| GET    | `/auth/session`          | current session and user summary        | session           |
| POST   | `/auth/step-up/options`  | begin step-up assertion                 | session           |
| POST   | `/auth/step-up/verify`   | complete step-up, stamp session         | session           |
| GET    | `/auth/credentials`      | list registered credentials             | session           |
| DELETE | `/auth/credentials/:id`  | revoke a credential                     | session + step-up |
| GET    | `/auth/sessions`         | list active sessions                    | session           |
| DELETE | `/auth/sessions/:id`     | revoke a session                        | session           |
| POST   | `/auth/2fa/enroll`       | begin TOTP enrollment                   | session + step-up |
| POST   | `/auth/2fa/verify`       | confirm TOTP enrollment                 | session           |
| DELETE | `/auth/2fa`              | disable TOTP                            | session + step-up |
| GET    | `/me`                    | profile                                 | session           |
| PATCH  | `/me`                    | update profile                          | session           |
| GET    | `/health/live`           | process liveness                        | none              |
| GET    | `/health/ready`          | PostgreSQL + Redis readiness            | none              |

151. `/health/live` must not touch the database.
152. `/health/ready` must report each dependency's status individually, not a single boolean.
153. Structure `/health/ready` so Phase 4 can add Solana RPC and the MPC service as additional entries without changing its shape.
154. Return `503` from `/health/ready` when any dependency is unhealthy.

---

## 11. `apps/web` — Frontend Shell

155. Build pages for login, register, dashboard, wallet, activity, security, and profile.
156. Dashboard, wallet, and activity are deliberately empty shells in Phase 1 with honest empty states.
157. Never display fake balances, mock transactions, or placeholder numbers that could be mistaken for real data.
158. The security page is fully functional in Phase 1: passkey list, add passkey, revoke passkey, active sessions, revoke session, 2FA enrollment.
159. Call `fetch` in exactly one place — the typed API client under `lib/api/`.
160. Add an ESLint rule banning `fetch` and `axios` outside `lib/api/`.
161. Derive client types and runtime parsing from the same `packages/types` schemas the API uses.
162. Parse every API response at the boundary; never cast an untyped response into a domain type.
163. Separate presentation components from data-fetching hooks.
164. Validate input on the client for user experience only, and never treat client validation as a security control.
165. Never store a session token, credential, or secret in `localStorage`, `sessionStorage`, or a JavaScript-readable cookie.
166. Build reusable status, empty-state, modal, and form primitives now so Phase 2 and 3 UI composes rather than duplicates.
167. Show the correlation ID on error screens so a user can report a traceable failure.

---

## 12. Definition Of Done

### Functional

168. - [ ] A new user registers with a passkey and lands authenticated.
169. - [ ] That user logs out, logs back in with the passkey, and reaches the dashboard.
170. - [ ] The session survives an API process restart.
171. - [ ] Revoking a session from another device invalidates it immediately.
172. - [ ] A second passkey can be added and either can authenticate.
173. - [ ] Revoking a credential requires a successful step-up assertion.
174. - [ ] TOTP enrollment, verification, and disablement all work, including recovery codes.

### Security

175. - [ ] An automated test asserts no secret value appears in captured log output.
176. - [ ] An automated test asserts a replayed WebAuthn challenge is rejected.
177. - [ ] An automated test asserts a non-increasing `signCount` is rejected and audited.
178. - [ ] An automated test asserts a cross-origin state-changing request is rejected.
179. - [ ] An automated test asserts unknown and known accounts are indistinguishable on failed login.
180. - [ ] Rate limits are enforced and covered by tests on every auth endpoint.
181. - [ ] `UPDATE` and `DELETE` on `audit_log` fail for the application database role.
182. - [ ] No secret is present anywhere in Git history.

### Engineering

183. - [ ] Booting with a missing environment variable exits immediately and names the variable.
184. - [ ] Every route validates request and response through Zod; a contract violation is a test failure.
185. - [ ] Every error response carries a stable code from the declared union and a correlation ID.
186. - [ ] `process.env` appears in exactly one file, enforced by lint.
187. - [ ] `fetch` appears only under `apps/web/lib/api/`, enforced by lint.
188. - [ ] The dependency-boundary lint rule passes and is proven by a deliberate violation failing CI.
189. - [ ] Unit tests cover config validation, logger redaction, error mapping, and session lifecycle.
190. - [ ] Integration tests run against a real PostgreSQL instance, not a mock or SQLite.
191. - [ ] Playwright covers register → logout → login → revoke session end to end.
192. - [ ] A fresh clone reaches a working app via `docker compose up && pnpm install && pnpm dev` following the README alone.
193. - [ ] CI runs lint, typecheck, unit tests, integration tests, and a migration check, and blocks merge on failure.

### Documentation

194. - [ ] `README.md` documents setup, architecture, and the layering rules.
195. - [ ] `docs/adr/` contains an ADR template plus ADR-001 (session strategy) and ADR-002 (authentication model).
196. - [ ] `.env.example` lists every variable required by rule 65.
197. - [ ] A short runbook covers rotating `SESSION_SECRET` and revoking all sessions.

---

## 13. Traps To Avoid

198. Do not skip the correlation ID plumbing because Phase 1 has little to trace — retrofitting it across a money-moving codebase is far more expensive.
199. Do not weaken the log allowlist to a denylist for developer convenience; that decision is what leaks a key share in Phase 4.
200. Do not scaffold packages Phase 1 does not use; an empty `packages/ledger` invites Phase 2 to start before its design is settled.
201. Do not store the session as a JWT because it is faster to implement; revocability is a requirement, not a preference.
202. Do not derive the WebAuthn `rpId` or `origin` from request headers under any circumstance.
203. Do not let a single passkey be a user's only factor without a documented recovery path.
204. Do not put authorization checks in the frontend; the client is a rendering surface, never a gate.
205. Do not introduce a `balance` column, a `float` money type, or any monetary field in Phase 1 — Phase 2 defines money, and a shortcut here becomes an accounting bug there.
206. Do not begin Phase 2 until §12 is fully checked and the ADRs in `report.md` §7 are written.

---

## 14. Standing Rules

207. Every feature ships with tests, typed interfaces, error handling, structured logging, and documentation (master-prompt rule 197).
208. Prefer simple explicit architecture over premature distributed complexity (master-prompt rule 198).
209. Optimize for correctness, auditability, and security boundaries before performance (master-prompt rule 199).
210. This is an educational project; never describe any part of it as production-safe without an independent security audit (master-prompt rules 7 and 8).
