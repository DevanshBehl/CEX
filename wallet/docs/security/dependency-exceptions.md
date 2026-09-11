# Dependency audit exceptions

prompt_phase4.md rule 164: an audit needs a policy, or it becomes a job people
re-run until it passes.

## Policy

| Severity         | CI behaviour                                                      |
| ---------------- | ----------------------------------------------------------------- |
| high or critical | **fails the build**, unless listed below with a reason and a date |
| moderate or low  | reported, does not fail                                           |

A blanket `|| true` is never acceptable. An advisory that cannot be fixed today
is listed here with **why** and **what would fix it** — so the next person
inherits a decision rather than a mystery.

`scripts/audit.mjs` enforces this: anything high or critical that is **not** on
this list fails CI. Adding a dependency with a new critical still breaks the
build.

## Current exceptions

**Reviewed: 2026-09-11.** All of these are resolved by major-version upgrades
that have not been performed. They are **not** judged harmless.

### `next` — 11 advisories (4 critical)

- **Installed:** 15.1.4 · **Fixed in:** 16.x
- **Why not fixed:** Next 16 is a major upgrade with app-router breaking
  changes. It needs its own change with the E2E suite as the check, not a
  drive-by bump inside Phase 4.
- **Exposure:** the web app renders the dashboard and forms. It holds no key
  material and no signing capability (master-prompt rules 22–23). Several of the
  advisories are Windows-specific or require configurations this app does not
  use (image optimisation, custom rewrites, middleware-based authorisation —
  authorisation here is server-side in the API).
- **Still real:** the DoS advisories apply. The threat model already records
  that availability is not defended.
- **Fix:** upgrade to Next 16.

### `vitest` / `vite` — 3 advisories (2 critical)

- **Installed:** 2.1.9 · **Fixed in:** vitest 3.x+
- **Why not fixed:** a major upgrade across every package's test config.
- **Exposure:** **test-only, never shipped.** Both criticals require the Vitest
  UI server to be listening; it is never started, in CI or locally. The `vite`
  advisory is a Windows path bypass.
- **Fix:** upgrade to vitest 3+.

### `sharp` — 2 advisories (high)

- **Pulled by:** `next`. Not a direct dependency.
- **Exposure:** image processing. This application serves no user-supplied
  images.
- **Fix:** follows the Next upgrade.

### `postcss` — 2 advisories (high)

- **Pulled by:** the build toolchain. Build-time only, never at runtime.
- **Fix:** follows the Next/vitest upgrades. An override is in place and does
  not reach every nested copy.

### `playwright` — 1 advisory (high)

- **Exposure:** E2E tooling. Browsers are downloaded in CI from a controlled
  runner.
- **Fix:** follows the Next upgrade (it is a transitive dependency of it here).

### `bigint-buffer` — 1 advisory (high)

- **Pulled by:** `@solana/web3.js`. **The only one on this list that is in the
  server-side path.**
- **Exposure:** a buffer overflow in `toBigIntLE()`. Reachable only with input
  the Solana SDK parses. The application never calls it directly.
- **Why not fixed:** no patched version exists; the advisory has no fix. An
  override to 1.1.5 is in place, which is the latest published.
- **Fix:** upstream, or moving off `@solana/web3.js` — which ADR-0019 already
  lists as a thing a second chain would force a look at.

## On re-review

Anything here that is still listed after the next upgrade cycle needs a fresh
decision, not a copied date. If an entry's "fix" has shipped and the upgrade has
not happened, that is a backlog item, not an exception.
